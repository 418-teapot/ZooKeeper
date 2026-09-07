/**
 * Pi host adapter — maps pi AgentMessages to host-agnostic lens messages.
 *
 * This module is the only layer that knows both the pi message duck types
 * (`src/adapters/pi/types.ts`) and the core lens types
 * (`HostMessage`, `TextRegion`).  The mapping is read/write: the regions
 * returned by `history` carry a `set` implementation that writes back into
 * the backing pi message, so the render path can apply `RegionEdit`s without
 * unpacking host structures.
 *
 * Mapping table (pi block → region kind):
 *
 * - `text` content block → `content` region (injection target).
 * - `image` content block → `content` region for estimation parity, never
 *   an injection target.
 * - `thinking` block → `thinking` region.
 * - `toolCall` block → `tool-input` region.
 * - `toolResult` message → one `tool-output` region.
 * - `compactionSummary` / `branchSummary` message → one `content` region
 *   over `message.summary` (estimation parity, never an injection target);
 *   only the compaction kind sets the lens `compaction` flag.
 * - `custom` message → mapped like a user message (its `content` is
 *   user-shaped).
 * - `bashExecution` message and any undeclared role → zero regions: their
 *   model-visible text is derived from several fields (or unknown), so no
 *   region can round-trip an edit.  The message still occupies its ordinal
 *   and reaches the model untouched.
 *
 * Tool-call pairing spans two messages on pi: the assistant message
 * holds the `toolCall` block and a separate `toolResult` message holds
 * the result.  `history` indexes the result messages by call id once and
 * pairs each call with its result **at projection time**, emitting a
 * first-class invocation table (`Invocation`) alongside the region view.
 * The call's name, its status resolved from the linked result
 * (`"error"`/`"completed"`, the core vocabulary purge-errors and
 * sweep/dedup interpret), and the positional addresses of both halves
 * live on the table entry — never on the regions.  A call without a
 * linked result (still in flight) has no status and no output address;
 * a result whose call id matches no `toolCall` block is left unpaired
 * and producers abstain from it (fail-closed).
 *
 * Message-level mapping: role passes through unchanged; assistant usage is
 * already flat and maps directly to `TokenUsage`; `hidden` is false for
 * every shaped message because pi has no ignored-message concept (only an
 * entry that is not a message at all is hidden — see `toHostMessage`).
 *
 * @module
 */

import type {
  HostMessage,
  Invocation,
  Projection,
  RegionKind,
  TextRegion,
} from "../../core/context/lens.js";
import { project } from "../../core/context/lens.js";
import { log } from "../../utils/logger.js";
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiBranchSummaryMessage,
  PiCompactionSummaryMessage,
  PiContentPart,
  PiCustomMessage,
  PiTextPart,
  PiThinkingPart,
  PiToolCallPart,
  PiToolResultMessage,
  PiUserMessage,
} from "./types.js";

/**
 * Origin of a pi-derived lens region, used to decide which regions may
 * receive the per-round `[mN] ` line-number prefix.
 *
 * `summary` covers host-authored summary text (pi compaction / branch
 * summaries): it is counted for estimation but must never be rewritten
 * with a line ref, because the prefix would corrupt the host's own
 * summary block.
 */
type RegionProvenance = "text" | "image" | "thinking" | "tool" | "summary";

/**
 * Side table that records each region's provenance without polluting the
 * public `TextRegion` interface.
 */
const regionProvenance = new WeakMap<TextRegion, RegionProvenance>();

/**
 * Linked tool-result facts resolved for a tool-call block.
 *
 * pi splits one tool call across two messages; the `toolCall` block's
 * result message is found by matching `toolCallId` within the same
 * history array.  `ordinal` is the message position of the result; the
 * result message always maps to a single `tool-output` region at index
 * 0 (see `toolResultMessageRegions`).
 */
interface LinkedResult {
  /** Ordinal of the linked toolResult message. */
  ordinal: number;
  /** Whether the tool result reports an error. */
  isError: boolean;
}

/**
 * Roles already reported as unknown, so a host that keeps carrying one logs
 * once per process instead of once per turn (the projection runs every turn).
 */
const reportedRoles = new Set<string>();

/**
 * Warn once about a message role the adapter's union does not declare.
 *
 * The projection never throws for such a message — it maps to the minimal
 * safe shape — so this is a diagnostic, not an error path.
 *
 * @param value - The message whose role the union does not declare.
 */
function warnUnknownRole(value: unknown): void {
  const role =
    value !== null && typeof value === "object"
      ? String((value as { role?: unknown }).role)
      : typeof value;
  if (reportedRoles.has(role)) {
    return;
  }
  reportedRoles.add(role);
  log("pi-history", "unknown_role", "", undefined, "warn", { role });
}

/**
 * Index pi tool-result messages by call id.
 *
 * @param messages - The pi conversation.
 * @returns A map from toolCallId to the linked result facts.
 */
function buildResultIndex(
  messages: PiAgentMessage[],
): Map<string, LinkedResult> {
  const index = new Map<string, LinkedResult>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role === "toolResult") {
      index.set(message.toolCallId, { ordinal: i, isError: message.isError });
    }
  }
  return index;
}

/**
 * Map a pi tool-result error flag to the core-expected status string.
 *
 * Core producers enumerate `"error"` (purge-errors) and `"completed"`
 * (sweep / dedup); pi's only call-state signal is the boolean `isError`
 * flag on the toolResult message, so the flag maps to the core
 * vocabulary verbatim: failed → `"error"`, otherwise `"completed"`.
 *
 * @param isError - The pi tool-result error flag.
 * @returns The status string core producers interpret.
 */
function statusOf(isError: boolean): string {
  return isError ? "error" : "completed";
}

/**
 * A lens region whose text the adapter may rewrite in place.
 *
 * The core `TextRegion` contract is read-only; this adapter-internal
 * extension adds the write side used by the render path.  Core modules
 * never reference it.
 */
export interface WritableRegion extends TextRegion {
  /** Rewrite the region's text in place. */
  set(text: string): void;
}

/**
 * Lens region bound to a pi message object.
 *
 * The region reads from and writes back into the same backing message, so
 * edits applied through the lens mutate a *copy* of the original message in
 * the pure render path.  The provenance side table is populated at
 * construction.
 */
class PiTextRegion implements WritableRegion {
  constructor(
    readonly kind: RegionKind,
    private readonly read: () => string,
    private readonly write: (text: string) => void,
    provenance: RegionProvenance,
  ) {
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
 * Serialize a tool-call arguments value for lens reads.
 *
 * `null`/`undefined` become the empty string; objects are `JSON.stringify`ed
 * so the lens-visible text is what the token estimator counts (it applies
 * the same normalization to non-string values).
 */
function serializeArguments(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Write edited text back into a tool-call arguments object.
 *
 * Parsing text as JSON keeps arguments an object; non-parsing placeholder
 * text is wrapped in `{ pruned: text }` so the outbound tool call stays
 * schema-valid.  Re-writing the same placeholder is idempotent.
 */
function writeArguments(block: PiToolCallPart, text: string): void {
  const wasObject =
    block.arguments != null && typeof block.arguments === "object";
  if (!wasObject) {
    block.arguments = { input: text };
    return;
  }
  try {
    block.arguments = JSON.parse(text) as Record<string, unknown>;
  } catch {
    block.arguments = { pruned: text };
  }
}

/**
 * Extract the joined text of all text parts, ignoring image parts.
 */
function extractText(parts: PiContentPart[] | undefined): string {
  return (parts ?? [])
    .filter((part): part is PiTextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Coerce a message content field to an array of blocks.
 *
 * pi declares every content-bearing message field as an array (or a string,
 * handled by the caller), but the projection must stay a total function over
 * whatever the host delivers: a missing or non-array content projects as "no
 * blocks" instead of throwing, so the message keeps its ordinal and simply
 * contributes no regions.
 *
 * @param content - The raw content field.
 * @returns The blocks, or an empty list for non-array shapes.
 */
function asBlocks<T>(content: unknown): T[] {
  return Array.isArray(content) ? (content as T[]) : [];
}

/** An assistant-message content block (text, thinking, or tool call). */
type PiAssistantBlock = PiTextPart | PiThinkingPart | PiToolCallPart;

/**
 * Map a pi user-shaped message to lens regions.
 *
 * Both `user` and `custom` messages carry user-shaped content (a string or
 * text/image parts), so they share this mapping.
 */
function userMessageRegions(
  message: PiUserMessage | PiCustomMessage,
): TextRegion[] {
  const regions: TextRegion[] = [];
  const content = message.content;
  if (typeof content === "string") {
    if (content.length > 0) {
      regions.push(
        new PiTextRegion(
          "content",
          () => content,
          (text) => {
            message.content = text;
          },
          "text",
        ),
      );
    }
    return regions;
  }

  const parts = asBlocks<PiContentPart>(content);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part?.type === "text") {
      regions.push(
        new PiTextRegion(
          "content",
          () => part.text,
          (text) => {
            part.text = text;
          },
          "text",
        ),
      );
    } else {
      regions.push(
        new PiTextRegion(
          "content",
          () => "",
          (text) => {
            // Replace the image part with a text part carrying the edit.
            parts[i] = { type: "text", text };
          },
          "image",
        ),
      );
    }
  }
  return regions;
}

/**
 * Map the content blocks of a pi assistant message to lens regions.
 *
 * Each `toolCall` block resolves its linked `toolResult` message (by
 * call id, via the prebuilt index) and is paired into the invocation
 * table: the entry carries the tool name, the status resolved from the
 * linked result, and the positional addresses of both halves.  A call
 * without a linked result — still in flight when the conversation was
 * projected — gets an entry with no status and no output half: pi
 * provides no state signal for an unanswered call.
 *
 * @param message - The assistant message to map.
 * @param resultIndex - Prebuilt call-id to linked-result index.
 * @param ordinal - Transcript position of this message (input address).
 * @param invocations - Output parameter: entries are appended in
 *   message order.
 * @returns The mapped regions.
 */
function assistantMessageRegions(
  message: PiAssistantMessage,
  resultIndex: Map<string, LinkedResult>,
  ordinal: number,
  invocations: Invocation[],
): TextRegion[] {
  const regions: TextRegion[] = [];
  const content = asBlocks<PiAssistantBlock>(message.content);
  for (const block of content) {
    if (block.type === "text") {
      regions.push(
        new PiTextRegion(
          "content",
          () => block.text,
          (text) => {
            block.text = text;
          },
          "text",
        ),
      );
    } else if (block.type === "thinking") {
      regions.push(
        new PiTextRegion(
          "thinking",
          () => block.thinking,
          (text) => {
            block.thinking = text;
          },
          "thinking",
        ),
      );
    } else {
      const input: Invocation["input"] = {
        ordinal,
        regionIndex: regions.length,
      };
      const result = resultIndex.get(block.id);
      invocations.push({
        name: block.name,
        input,
        ...(result
          ? {
              status: statusOf(result.isError),
              // A toolResult message maps to exactly one tool-output
              // region, at index 0 (see `toolResultMessageRegions`).
              output: { ordinal: result.ordinal, regionIndex: 0 },
            }
          : {}),
      });
      regions.push(
        new PiTextRegion(
          "tool-input",
          () => serializeArguments(block.arguments),
          (text) => {
            writeArguments(block, text);
          },
          "tool",
        ),
      );
    }
  }
  return regions;
}

/**
 * Map a pi summary message (compaction or branch) to a single content
 * region.
 *
 * The message carries its text in `summary` rather than in a content array.
 * The region reads and writes that field so estimation counts the summary
 * and an edit lands back on the host message; the `summary` provenance keeps
 * it out of the line-ref injection targets, so the host-authored block is
 * never prefixed with `[mN] `.
 *
 * @param message - The summary message (only its `summary` field is read).
 * @returns The mapped regions (empty when there is no text to count).
 */
function summaryMessageRegions(
  message: PiCompactionSummaryMessage | PiBranchSummaryMessage,
): TextRegion[] {
  if (typeof message.summary !== "string" || message.summary.length === 0) {
    return [];
  }
  return [
    new PiTextRegion(
      "content",
      () => message.summary,
      (text) => {
        message.summary = text;
      },
      "summary",
    ),
  ];
}

/**
 * Map a pi tool-result message to a single tool-output region.
 *
 * The message maps to exactly one region, at index 0 — the address
 * every linked `toolCall` block points its output half at (see
 * `assistantMessageRegions`).  The call's name and status live on the
 * invocation table, not on this region.
 */
function toolResultMessageRegions(message: PiToolResultMessage): TextRegion[] {
  const content = asBlocks<PiContentPart>(message.content);
  let textIndex = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i].type === "text") {
      textIndex = i;
      break;
    }
  }

  return [
    new PiTextRegion(
      "tool-output",
      () => extractText(content),
      (text) => {
        if (textIndex >= 0) {
          (content[textIndex] as PiTextPart).text = text;
        } else {
          content.length = 0;
          content.push({ type: "text", text });
        }
      },
      "tool",
    ),
  ];
}

/**
 * Build the minimal safe projection for a value that is not a shaped
 * message at all.
 *
 * Mirrors how the OpenCode v1 adapter treats nullish entries: the ordinal
 * is still
 * occupied but the message is hidden, so estimation, numbering and injection
 * all skip it and no core path reads text out of it.
 *
 * @param value - The unrecognisable transcript entry.
 * @returns The minimal safe lens message.
 */
function hiddenEmptyProjection(value: unknown): HostMessage {
  warnUnknownRole(value);
  return { role: "unknown", hidden: true, regions: [] };
}

/**
 * Build the minimal safe projection for a message of an undeclared role.
 *
 * The parameter is typed `never`: every declared pi role is handled by an
 * explicit branch in `toHostMessage`, so adding a role to `PiAgentMessage`
 * without a mapping is a compile error at that call site. At runtime the
 * branch is still reachable — a newer host may deliver a role the union does
 * not declare — so the projection stays total: the ordinal is occupied, no
 * region is offered to producers, nothing throws.
 *
 * A shaped but unrecognised message stays visible (it is part of the model
 * context) with zero regions; an entry that is not shaped at all hides.
 *
 * @param message - The value the role dispatch could not map.
 * @returns The minimal safe lens message.
 */
function unknownMessageProjection(message: never): HostMessage {
  const value = message as { role?: unknown } | null | undefined;
  const role =
    value !== null && typeof value === "object" ? value.role : undefined;
  if (typeof role !== "string") return hiddenEmptyProjection(value);
  warnUnknownRole(value);
  return { role, hidden: false, regions: [] };
}

/**
 * Map one pi message to a host-agnostic lens message.
 *
 * Assistant tool-call blocks resolve their linked tool-result message
 * through the prebuilt call-id index and are paired into the
 * invocation table as they map (see `assistantMessageRegions`).
 *
 * The dispatch is total over `PiAgentMessage`: every declared role has an
 * explicit branch, so TypeScript flags the union member a later pi release
 * adds (the final `else` narrows to `never`), while the branch itself keeps
 * the projection a total function at runtime — an undeclared role maps to
 * the minimal safe shape instead of throwing.
 */
function toHostMessage(
  message: PiAgentMessage,
  resultIndex: Map<string, LinkedResult>,
  ordinal: number,
  invocations: Invocation[],
): HostMessage {
  let regions: TextRegion[];
  let compaction = false;
  if (message === null || message === undefined) {
    // Not a message at all: occupy the ordinal and stay invisible to the
    // core producers (the render path pushes the original entry back).
    return hiddenEmptyProjection(message);
  } else if (message.role === "user") {
    regions = userMessageRegions(message);
  } else if (message.role === "assistant") {
    regions = assistantMessageRegions(
      message,
      resultIndex,
      ordinal,
      invocations,
    );
  } else if (message.role === "toolResult") {
    regions = toolResultMessageRegions(message);
  } else if (message.role === "compactionSummary") {
    // Host-native compaction: the transcript before it is historical, so
    // the lens `compaction` flag marks the report's category boundary
    // (same mapping the opencode adapter applies to its summary message).
    regions = summaryMessageRegions(message);
    compaction = true;
  } else if (message.role === "branchSummary") {
    // A branch summary adds context rather than replacing history, so it
    // is counted but is not a compaction boundary.
    regions = summaryMessageRegions(message);
  } else if (message.role === "custom") {
    regions = userMessageRegions(message);
  } else if (message.role === "bashExecution") {
    // Its model-visible text is derived from command / output / exitCode
    // by pi itself; no single field round-trips an edit, so producers
    // abstain and the message is rendered back untouched.
    regions = [];
  } else {
    // Unreachable for every declared role (`message` narrows to `never`
    // here, which is what keeps the dispatch exhaustive); a newer host
    // delivering another role lands on the minimal safe projection.
    return unknownMessageProjection(message);
  }

  return {
    role: message.role,
    hidden: false,
    regions,
    usage: message.role === "assistant" ? message.usage : undefined,
    ...(compaction ? { compaction: true } : {}),
  };
}

/**
 * Project a pi conversation into a host-agnostic lens snapshot.
 *
 * Ordinals align 1:1 with the input array: every message — whatever its
 * role, and including an entry the adapter cannot recognise — maps to
 * exactly one projected message, so the render path can always address the
 * original message by ordinal.  pi has no ignored-message concept, so every
 * shaped message is visible.  The result messages are indexed by call id
 * first, so each tool-call block pairs its linked result into the
 * invocation table within the same pass that builds the region view.
 *
 * @param messages - The pi AgentMessage list.
 * @returns The projection snapshot (region view + invocation table).
 */
export function history(messages: PiAgentMessage[]): Projection {
  const resultIndex = buildResultIndex(messages);
  const invocations: Invocation[] = [];
  const mapped = messages.map((message, ordinal) =>
    toHostMessage(message, resultIndex, ordinal, invocations),
  );
  return project(mapped, invocations);
}

/**
 * Report whether a lens region may receive the line-number prefix.
 *
 * Only text-derived `content` regions and `tool-output` regions are
 * injection targets; image blocks, thinking traces, tool inputs and
 * host-authored summary text are never rewritten with line refs.
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
