/**
 * Pi host adapter — maps pi AgentMessages to host-agnostic lens messages.
 *
 * This module is the only layer that knows both the pi message duck types
 * (`src/adapters/pi/types.ts`) and the new core lens types
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
 * already flat and maps directly to `TokenUsage`; `hidden` is always false
 * because pi has no ignored-message concept.
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
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiContentPart,
  PiTextPart,
  PiToolCallPart,
  PiToolResultMessage,
  PiUserMessage,
} from "./types.js";

/**
 * Origin of a pi-derived lens region, used to decide which regions may
 * receive the per-round `[mN] ` line-number prefix.
 */
type RegionProvenance = "text" | "image" | "thinking" | "tool";

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
    if (message.role === "toolResult") {
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
 * so the text round-trips through the legacy counting heuristic.
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
 * Map a pi user message to lens regions.
 */
function userMessageRegions(message: PiUserMessage): TextRegion[] {
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

  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (part.type === "text") {
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
            (content as PiContentPart[])[i] = { type: "text", text };
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
  const content = message.content;
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
 * Map a pi tool-result message to a single tool-output region.
 *
 * The message maps to exactly one region, at index 0 — the address
 * every linked `toolCall` block points its output half at (see
 * `assistantMessageRegions`).  The call's name and status live on the
 * invocation table, not on this region.
 */
function toolResultMessageRegions(message: PiToolResultMessage): TextRegion[] {
  const content = message.content;
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
 * Map one pi message to a host-agnostic lens message.
 *
 * Assistant tool-call blocks resolve their linked tool-result message
 * through the prebuilt call-id index and are paired into the
 * invocation table as they map (see `assistantMessageRegions`).
 */
function toHostMessage(
  message: PiAgentMessage,
  resultIndex: Map<string, LinkedResult>,
  ordinal: number,
  invocations: Invocation[],
): HostMessage {
  let regions: TextRegion[];
  if (message.role === "user") {
    regions = userMessageRegions(message);
  } else if (message.role === "assistant") {
    regions = assistantMessageRegions(
      message,
      resultIndex,
      ordinal,
      invocations,
    );
  } else {
    regions = toolResultMessageRegions(message);
  }

  return {
    role: message.role,
    hidden: false,
    regions,
    usage: message.role === "assistant" ? message.usage : undefined,
  };
}

/**
 * Project a pi conversation into a host-agnostic lens snapshot.
 *
 * Ordinals align 1:1 with the input array; pi has no hidden messages, so
 * every message is visible.  The result messages are indexed by call id
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
 * injection targets; image blocks, thinking traces, and tool inputs are
 * never rewritten with line refs.
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
