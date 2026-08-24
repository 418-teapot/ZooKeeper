/**
 * OpenCode v1 adapter — maps v1 message entries to host-agnostic lens
 * messages.
 *
 * This is the only layer allowed to know both the v1 message shape
 * (`ContextMessageEntry { info, parts }`) and the new core lens types
 * (`HostMessage`, `TextRegion`).  Every v1 part type maps to lens
 * regions with lossless text round-tripping: the adapter's `PartRegion`
 * regions are writable (see `WritableRegion`), so edit application and
 * line-prefix injection mutate the host structure through the lens
 * while the core never unpacks it.
 *
 * Mapping table (v1 part → region kind):
 *
 * - `text` → one `content` region per part (order preserved).
 * - `reasoning` → one `thinking` region.
 * - `tool` with `state` → `tool-input` + `tool-output` regions; the
 *   input/output values are serialized with `JSON.stringify` when not
 *   already strings, matching the legacy estimator's counting.
 * - any other type with a string `text` field (`step-start`,
 *   `step-finish`, `snapshot`, `file`, ...) → `content`, mirroring the
 *   legacy heuristic that counted `part.text` for every non-tool part.
 * - parts without text or tool state contribute no region.
 *
 * Message-level mapping: `info.role` → `role`, `info.tokens` → `usage`
 * (the nested `cache.read`/`cache.write` flatten to `cacheRead`/
 * `cacheWrite`), "ignored" (see `isHidden`) → `hidden` (the message
 * still occupies an ordinal but is skipped by estimation and numbering),
 * `info.summary === true` → `compaction` (the report's category-boundary
 * signal).  `info.synthetic` — ZooKeeper's own fold-block summary — is
 * a distinct concept and is deliberately not mapped.
 *
 * Null and undefined entries map to a hidden empty message: the ordinal
 * is preserved while every core path stays safe — hidden skips
 * estimation, numbering, injection, and the first-user search, and the
 * empty region list lets `canon`/`computeSpanHash`/`fold` project it
 * normally.  The mapped transcript therefore never contains null
 * entries (the new core's canon/span-hash/fold/view-refs layers assume
 * non-null messages; only `measure` tolerates nulls defensively).
 *
 * Write-back semantics of the adapter's writable regions:
 *
 * - content / thinking → rewrites `part.text`.
 * - tool-output → rewrites `part.state.output` as a plain string (the
 *   legacy prune path always wrote the placeholder string).
 * - tool-input → string inputs are rewritten verbatim; object inputs
 *   are `JSON.parse`d back to an object when the new text parses, and
 *   wrapped into a `{ pruned }` object when it does not (prune
 *   placeholders never parse) — a bare string input would make the
 *   outbound `tool_use.input` schema-invalid, so the input field must
 *   always stay an object.
 *
 * Injection provenance: every region records how it was derived from
 * the v1 message (`text` / `reasoning` / `tool` / `other`).  The
 * legacy ref-injection wrote only text parts and tool outputs, so
 * `isInjectableRegion` marks exactly the text-derived content regions
 * and the tool-output regions; the line-number renderer of phase two
 * filters by it.  Parts mapped to content only for estimation parity
 * (step-start/snapshot/file text) are never injection targets.
 *
 * @module
 */

import type {
  HostMessage,
  RegionKind,
  TextRegion,
  TokenUsage,
  ToolMeta,
} from "../../core/context/lens.js";
import type { ContextMessageEntry, ContextTokenInfo } from "./types.js";

/**
 * Tool-part shape beyond the minimal `ContextTextPart`: v1 tool parts
 * carry a name, call identifiers, and a mutable state object.
 */
interface V1ToolPart {
  type: string;
  text?: string;
  tool?: string;
  state?: {
    input?: unknown;
    output?: unknown;
    status?: string;
  };
}

/**
 * Derivation source of a lens region within its v1 message.
 *
 * The legacy ref-injection wrote only text parts and tool outputs, so
 * the injection filter keys off this provenance instead of the region
 * kind alone (content regions also exist for step-start/snapshot/file
 * parts, which are estimation-only and must never receive a line
 * number).
 */
type RegionProvenance = "text" | "reasoning" | "tool" | "other";

/**
 * Provenance registry keyed by region instance.
 *
 * Kept out of the `TextRegion` interface — the lens contract stays
 * `{ kind, get, tool? }`; the adapter's own regions carry their
 * provenance in this side table so `isInjectableRegion` can read it
 * without polluting the core types.
 */
const regionProvenance = new WeakMap<TextRegion, RegionProvenance>();

/**
 * A lens region whose text the adapter may rewrite in place.
 *
 * The core `TextRegion` contract is read-only; this adapter-internal
 * extension adds the write side used by edit application and line-ref
 * injection.  Core modules never reference it.
 */
export interface WritableRegion extends TextRegion {
  /** Rewrite the region's text in place. */
  set(text: string): void;
}

/**
 * A lens region bound to a v1 part: reads serialize the current part
 * value, writes mutate the part in place.  The derivation source is
 * recorded in the provenance side table at construction.
 */
class PartRegion implements WritableRegion {
  readonly tool: ToolMeta | undefined;

  constructor(
    readonly kind: RegionKind,
    private readonly read: () => string,
    private readonly write: (text: string) => void,
    tool: ToolMeta | undefined,
    provenance: RegionProvenance,
  ) {
    this.tool = tool;
    regionProvenance.set(this, provenance);
  }

  get(): string {
    return this.read();
  }

  set(text: string): void {
    this.write(text);
  }
}

/**
 * Serialize a part value for lens reads.
 *
 * `null`/`undefined` become the empty string; objects are
 * `JSON.stringify`ed — the same normalization the legacy
 * `estimateTokenCount` applied, so estimates stay equal.
 *
 * @param value - The raw part value.
 * @returns The lens-visible text.
 */
function serializeValue(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Map a message-level `info.tokens` object to lens `usage`, flattening
 * the legacy nested `cache.read`/`cache.write` into flat components.
 *
 * @param tokens - The v1 token report.
 * @returns The flat usage report, or undefined when absent.
 */
function mapUsage(tokens?: ContextTokenInfo): TokenUsage | undefined {
  if (!tokens) return undefined;
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cache?.read,
    cacheWrite: tokens.cache?.write,
  };
}

/**
 * Write text back into a tool part's input.
 *
 * String inputs are rewritten verbatim.  Object inputs are `JSON.parse`d
 * back to an object when the text parses; non-parsing text (prune
 * placeholders never parse) is wrapped into a `{ pruned }` object
 * instead of being stored as a bare string, so the outbound
 * `tool_use.input` stays a schema-valid object.  Re-writing the same
 * placeholder is idempotent: the wrapped object is stored again
 * unchanged.
 *
 * @param state - The tool part's state object.
 * @param text - The new input text.
 */
function writeInputBack(
  state: NonNullable<V1ToolPart["state"]>,
  text: string,
): void {
  const wasObject = state.input != null && typeof state.input === "object";
  if (!wasObject) {
    state.input = text;
    return;
  }
  try {
    state.input = JSON.parse(text) as unknown;
  } catch {
    // Non-JSON text: keep the input an object and preserve the
    // placeholder semantics verbatim under the `pruned` key.
    state.input = { pruned: text };
  }
}

/**
 * Determine whether a v1 message is "ignored" and maps to `hidden`.
 *
 * Mirrors the legacy `isMessageIgnored` semantics — `info.ignored`
 * truthy, or every part carrying `ignored: true` — but tolerates null
 * part entries (the legacy helper crashes on them).
 *
 * @param entry - The v1 message entry.
 * @returns True when the message should be hidden from estimation.
 */
function isHidden(entry: ContextMessageEntry): boolean {
  const info = entry.info as unknown as Record<string, unknown> | undefined;
  if (info?.ignored) return true;
  const parts = entry.parts;
  if (!parts || parts.length === 0) return false;
  return parts.every(
    (part) => part != null && (part as { ignored?: boolean }).ignored === true,
  );
}

/**
 * Map one v1 message entry to a lens message.
 *
 * @param entry - The v1 message entry (never null here).
 * @returns The mapped host-agnostic message.
 */
function toHostMessage(entry: ContextMessageEntry): HostMessage {
  const regions: TextRegion[] = [];

  for (const part of entry.parts ?? []) {
    if (!part) continue;
    const toolPart = part as V1ToolPart;

    if (toolPart.type === "tool" && toolPart.state) {
      const tool: ToolMeta = {
        name: toolPart.tool ?? "",
        ...(toolPart.state.status !== undefined
          ? { status: toolPart.state.status }
          : {}),
      };
      regions.push(
        new PartRegion(
          "tool-input",
          () => serializeValue(toolPart.state?.input),
          (text) => {
            const state = toolPart.state;
            if (state) writeInputBack(state, text);
          },
          tool,
          "tool",
        ),
        new PartRegion(
          "tool-output",
          () => serializeValue(toolPart.state?.output),
          (text) => {
            const state = toolPart.state;
            if (state) state.output = text;
          },
          tool,
          "tool",
        ),
      );
      continue;
    }

    if (typeof toolPart.text !== "string") continue;
    regions.push(
      new PartRegion(
        toolPart.type === "reasoning" ? "thinking" : "content",
        () => toolPart.text ?? "",
        (text) => {
          toolPart.text = text;
        },
        undefined,
        toolPart.type === "text"
          ? "text"
          : toolPart.type === "reasoning"
            ? "reasoning"
            : "other",
      ),
    );
  }

  return {
    role: entry.info?.role ?? "user",
    hidden: isHidden(entry),
    regions,
    usage: mapUsage(entry.info?.tokens),
    // `info.summary === true` marks a host-native compaction summary
    // message (the report's category-boundary signal).  `info.synthetic`
    // — ZooKeeper's own fold-block summary — is a distinct concept and
    // is deliberately not mapped.
    ...(entry.info?.summary === true ? { compaction: true } : {}),
  };
}

/**
 * Map a v1 messages array to the host-agnostic transcript.
 *
 * Null and undefined entries map to a hidden empty message instead of
 * being preserved as null — every core path (canon, span hashing, fold,
 * line-number injection, first-user search) assumes non-null messages,
 * while hidden + empty is safe everywhere: hidden skips estimation,
 * numbering, and injection, and the empty region list projects normally.
 * A nullish input maps to an empty transcript.
 *
 * @param entries - The v1 message entries from the transform output.
 * @returns The mapped transcript, free of null entries.
 */
export function history(
  entries: ContextMessageEntry[] | null | undefined,
): HostMessage[] {
  if (!entries) return [];
  return entries.map((entry) =>
    entry ? toHostMessage(entry) : { role: "user", hidden: true, regions: [] },
  );
}

/**
 * Report whether a lens region may receive the line-number prefix.
 *
 * Mirrors the legacy ref-injection targets — text parts and tool
 * outputs.  Content regions derived from text parts and tool-output
 * regions are injectable; thinking, tool-input, content derived from
 * step-start/snapshot/file parts (estimation-only), and regions this
 * adapter did not create are not.
 *
 * @param region - The region to test.
 * @returns True when the region is a ref-injection target.
 */
export function isInjectableRegion(region: TextRegion): boolean {
  if (!region) return false;
  const provenance = regionProvenance.get(region);
  if (provenance === "text") return region.kind === "content";
  if (provenance === "tool") return region.kind === "tool-output";
  return false;
}
