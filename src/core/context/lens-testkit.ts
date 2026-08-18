/**
 * In-memory test double builders for the context lens.
 *
 * New-core module unit tests construct `HostMessage` fixtures through
 * these builders.  Regions are backed by real mutable memory: `set()`
 * rewrites the underlying text in place, so tests can assert read-back.
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
 */
class MemoryRegion implements TextRegion {
  readonly tool: ToolMeta | undefined;

  constructor(
    readonly kind: RegionKind,
    private text: string,
    tool?: ToolMeta,
  ) {
    this.tool = tool;
  }

  get(): string {
    return this.text;
  }

  set(next: string): void {
    this.text = next;
  }
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
    };
    regions.push(new MemoryRegion("tool-input", call.input, tool));
    regions.push(new MemoryRegion("tool-output", call.output, tool));
  }
  return {
    role: "assistant",
    hidden: options.hidden ?? false,
    regions,
    usage: options.usage,
  };
}
