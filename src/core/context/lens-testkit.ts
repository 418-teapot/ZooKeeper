/**
 * In-memory test double builders for the context lens.
 *
 * New-core module unit tests construct `HostMessage` fixtures through
 * these builders.  Regions are backed by real mutable memory, so tests
 * can assert read-back; text replacement goes through the explicit
 * `setRegionText` helper (the core `TextRegion` interface is
 * read-only).
 *
 * Tool metadata travels through the lens contract itself: both the
 * tool-input and the tool-output region of a call carry
 * `tool: { name, status }`, so producers that only scan tool-output
 * still see the tool name and call status.
 *
 * @module
 */

import type {
  HostMessage,
  RegionKind,
  Role,
  TextRegion,
  TokenUsage,
  ToolMeta,
  ToolOutputRef,
} from "./lens.js";

/**
 * Options for `makeMsg`.
 */
export interface MakeMsgOptions {
  /** Mark the message hidden (occupies an ordinal, skipped by estimation). */
  hidden?: boolean;
  /** API exact token report. */
  usage?: TokenUsage;
}

/**
 * Options for `makeToolMsg`.
 */
export interface MakeToolMsgOptions extends MakeMsgOptions {
  /** Host-verbatim call status; defaults to "completed". */
  status?: string;
}

/**
 * One tool call within an assistant message.
 */
export interface ToolCallSpec {
  /** Tool name. */
  name: string;
  /** Tool input arguments text. */
  input: string;
  /** Tool output text. */
  output: string;
  /** Host-verbatim call status; defaults to "completed". */
  status?: string;
  /**
   * Positional address of the call's tool-output region when it lives in
   * a different message (the cross-message pi shape).  When set, the
   * tool-input region's metadata carries the reference and NO sibling
   * tool-output region is emitted in this message.
   */
  outputRef?: ToolOutputRef;
}

/**
 * Options for `makeAssistantMsg`.
 */
export interface MakeAssistantMsgOptions extends MakeMsgOptions {
  /** Content region text. */
  text?: string;
  /** Thinking region text. */
  thinking?: string;
  /** Tool calls; each contributes a tool-input/tool-output pair. */
  toolCalls?: ToolCallSpec[];
}

/**
 * Mutable in-memory region backing the testkit messages.
 *
 * The text lives in the module-scoped backing table so `setRegionText`
 * can rewrite it without widening the core `TextRegion` interface.
 */
const regionText = new WeakMap<TextRegion, string>();

/**
 * A read-only region whose text is held in the backing table.
 *
 * Construction seeds the backing; the read lens observes it.  Text
 * replacement is performed by `setRegionText`, never through this
 * double's public surface.
 */
class MemoryRegion implements TextRegion {
  readonly tool: ToolMeta | undefined;

  constructor(
    readonly kind: RegionKind,
    text: string,
    tool?: ToolMeta,
  ) {
    regionText.set(this, text);
    this.tool = tool;
  }

  get(): string {
    return regionText.get(this) ?? "";
  }
}

/**
 * Rewrite the text of a message region through the testkit backing.
 *
 * The testkit equivalent of a host's edit application: the addressed
 * region's in-memory text is replaced in place, so subsequent `get()`
 * reads return the new text.  Out-of-range ordinals, missing regions,
 * and out-of-range region indices are skipped silently (defensive,
 * mirroring the adapter render loop).
 *
 * @param msg - The message holding the region.
 * @param regionIndex - Index of the region within the message.
 * @param text - The full replacement text.
 */
export function setRegionText(
  msg: HostMessage | undefined,
  regionIndex: number,
  text: string,
): void {
  const region = msg?.regions?.[regionIndex];
  if (!region) return;
  regionText.set(region, text);
}

/**
 * Build a message with content regions, one per given text.
 *
 * @param role - The message role.
 * @param texts - Content region texts, in order.
 * @param options - Optional hidden flag and usage report.
 * @returns The constructed message.
 */
export function makeMsg(
  role: Role,
  texts: string[],
  options?: MakeMsgOptions,
): HostMessage {
  return {
    role,
    hidden: options?.hidden ?? false,
    regions: texts.map((text) => new MemoryRegion("content", text)),
    usage: options?.usage,
  };
}

/**
 * Build an assistant tool-call message.
 *
 * The result carries exactly two regions in order — tool-input then
 * tool-output — both bearing the same `tool: { name, status }` metadata.
 *
 * @param name - The tool name.
 * @param input - The tool input arguments text.
 * @param output - The tool output text.
 * @param options - Optional hidden flag, usage report, and call status.
 * @returns The constructed message.
 */
export function makeToolMsg(
  name: string,
  input: string,
  output: string,
  options?: MakeToolMsgOptions,
): HostMessage {
  const tool: ToolMeta = { name, status: options?.status ?? "completed" };
  return {
    role: "assistant",
    hidden: options?.hidden ?? false,
    regions: [
      new MemoryRegion("tool-input", input, tool),
      new MemoryRegion("tool-output", output, tool),
    ],
    usage: options?.usage,
  };
}

/**
 * Build an assistant message with optional content, thinking, and tool
 * calls.
 *
 * Region order: content, thinking, then one tool-input/tool-output pair
 * per tool call — matching the natural host message layout.  Each tool
 * pair's regions carry the same `tool: { name, status }` metadata.
 *
 * @param options - The message contents and options.
 * @returns The constructed message.
 */
export function makeAssistantMsg(
  options: MakeAssistantMsgOptions = {},
): HostMessage {
  const regions: TextRegion[] = [];
  if (options.text !== undefined) {
    regions.push(new MemoryRegion("content", options.text));
  }
  if (options.thinking !== undefined) {
    regions.push(new MemoryRegion("thinking", options.thinking));
  }
  for (const call of options.toolCalls ?? []) {
    const tool: ToolMeta = {
      name: call.name,
      status: call.status ?? "completed",
      ...(call.outputRef !== undefined ? { output: call.outputRef } : {}),
    };
    regions.push(new MemoryRegion("tool-input", call.input, tool));
    // The cross-message shape (pi) keeps the output half in its own
    // message; only the same-message (v1) shape emits a sibling region.
    if (call.outputRef === undefined) {
      regions.push(new MemoryRegion("tool-output", call.output, tool));
    }
  }
  return {
    role: "assistant",
    hidden: options.hidden ?? false,
    regions,
    usage: options.usage,
  };
}

/**
 * Build a standalone tool-result message: exactly one tool-output region
 * (the pi toolResult shape — the output half of a call lives in its own
 * message, addressed by the input region's positional reference).
 *
 * @param name - The tool name.
 * @param output - The tool output text.
 * @param options - Optional call status.
 * @returns The constructed message.
 */
export function makeToolResultMsg(
  name: string,
  output: string,
  options?: { status?: string },
): HostMessage {
  const tool: ToolMeta = { name, status: options?.status ?? "completed" };
  return {
    role: "toolResult",
    hidden: false,
    regions: [new MemoryRegion("tool-output", output, tool)],
  };
}
