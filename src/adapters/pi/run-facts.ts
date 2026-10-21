/**
 * Projection layer for a run's fact log.
 *
 * A subagent run's facts are observed from two places: live, as the pi
 * session emits events, and after a restart, from the delegation's persisted
 * sub-session messages.  Both observations describe the same activity, so the
 * rules that turn a pi message into run-log content — usage, message parts,
 * tool results, the user instruction, tool-call blocks — live here once, and
 * both sides call them.  Anything derived from a pi message shape stays in
 * this module (the core sees only the host-neutral facts it produces).
 *
 * The module holds two kinds of function and nothing else:
 *
 *  - field-level projections (`projectUsage`, `projectMessageParts`,
 *    `projectTextParts`, `projectMessageText`, `projectToolCalls`) that map a
 *    raw pi field onto the run log's shape, dropping what no projection
 *    renders yet;
 *  - fact constructors (`userMessageFact`, `messageEndFact`, `toolStartFact`,
 *    `toolEndFact`) that assemble one `RunFact` from those projections.
 *
 * Constructors are pure: the caller supplies the timestamp, and nothing here
 * writes to a log or reads ambient state.
 *
 * @module
 */

import { isRecord } from "../../core/records.js";
import type {
  MessageEndFact,
  MessagePart,
  TextPart,
  ToolEndFact,
  ToolStartFact,
  Usage,
  UserMessageFact,
} from "../../core/subagent/run-log.js";

/** One content part of a pi message or tool result (duck-typed). */
interface PiPartLike {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

/** A tool-call block of an assistant message. */
export interface ToolCallBlock {
  /** The host tool-call id, when the block carries one. */
  id?: string;
  /** The tool name (a generic name when the block carries none). */
  name: string;
  /** The full, untruncated call arguments. */
  args: Record<string, unknown>;
}

/** The observed end of one tool execution. */
export interface ToolEndInput {
  /** The host tool-call id, when reported. */
  toolCallId?: string;
  /** The tool name. */
  toolName: string;
  /** The raw result content (parts array or plain string). */
  content: unknown;
  /** Whether the call ended in an error. */
  isError: boolean;
}

/**
 * The finite number a raw value carries.
 *
 * @param value - The raw value.
 * @returns The number, or `undefined` when absent or not finite.
 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Normalize a pi content payload into its object-shaped parts.
 *
 * pi reports message and tool-result content either as a plain string or as
 * an array of typed parts; anything else yields no parts.
 *
 * @param content - The raw content (parts array or plain string).
 * @returns The parts worth inspecting (a string becomes a single text part).
 */
function partsOf(content: unknown): PiPartLike[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is PiPartLike => part !== null && typeof part === "object",
  );
}

/**
 * Map a pi usage envelope onto the run-log usage report.
 *
 * Only finite numbers survive; a report with no usable number yields
 * `undefined` so a run that never reported usage keeps an absent field
 * rather than a misleading zero.
 *
 * @param raw - The raw per-message usage, when the provider reported one.
 * @returns The usage report, or `undefined` when nothing was reported.
 */
export function projectUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  const input = finiteNumber(raw.input);
  const output = finiteNumber(raw.output);
  const cacheRead = finiteNumber(raw.cacheRead);
  const totalTokens = finiteNumber(raw.totalTokens);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/**
 * The content parts (text + thinking) of a pi message.
 *
 * Used for both a finalized `message_end` and the accumulated partial message
 * a streamed update carries, so a streamed message and its finalized fact
 * project through one mapping and can never disagree on shape or order.
 * Tool-call and image parts are dropped (no projection renders them).
 *
 * @param content - The raw content (parts array or plain string).
 * @returns The message parts in order (empty when there are none).
 */
export function projectMessageParts(content: unknown): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const part of partsOf(content)) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      parts.push({ type: "thinking", thinking: part.thinking });
    }
  }
  return parts;
}

/**
 * The text parts of a pi message, or of a pi tool result.
 *
 * Thinking, image, and tool-call parts are dropped: no projection renders
 * them, so the run log records only text for these fact kinds.
 *
 * @param content - The raw content (parts array or plain string).
 * @returns The text parts in order (empty when there are none).
 */
export function projectTextParts(content: unknown): TextPart[] {
  const parts: TextPart[] = [];
  for (const part of partsOf(content)) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    }
  }
  return parts;
}

/**
 * The concatenated text of a pi message's text parts.
 *
 * Thinking, image, and tool-call parts are ignored — only text counts as the
 * message's payload.  A raw string content is already the payload.
 *
 * @param content - The raw content (parts array or plain string).
 * @returns The joined text (empty when there is none).
 */
export function projectMessageText(content: unknown): string {
  const texts: string[] = [];
  for (const part of partsOf(content)) {
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.join("");
}

/**
 * The tool-call blocks of an assistant message.
 *
 * A block with a non-string name projects the generic `tool` name and an
 * empty argument record, so a malformed block still yields a tool fact
 * instead of disappearing from the log.
 *
 * @param content - The raw message content.
 * @returns The tool-call blocks, in message order.
 */
export function projectToolCalls(content: unknown): ToolCallBlock[] {
  const blocks: ToolCallBlock[] = [];
  for (const part of partsOf(content)) {
    if (part.type !== "toolCall") continue;
    const name = typeof part.name === "string" ? part.name : "tool";
    blocks.push({
      ...(typeof part.id === "string" ? { id: part.id } : {}),
      name,
      args: isRecord(part.arguments) ? part.arguments : {},
    });
  }
  return blocks;
}

/**
 * Build the user-message fact of one observed user message.
 *
 * Blank text projects as no fact: an empty instruction renders as an empty
 * transcript box, so both observation paths drop it.
 *
 * @param content - The raw message content (parts array or plain string).
 * @param at - Epoch-millis timestamp of the observation.
 * @returns The fact, or `undefined` when the message carries no text.
 */
export function userMessageFact(
  content: unknown,
  at: number,
): UserMessageFact | undefined {
  const text = projectMessageText(content);
  if (text.trim().length === 0) return undefined;
  return { type: "user_message", at, text };
}

/**
 * Build the message-end fact of one completed assistant message.
 *
 * The fact is produced even when the message carries no renderable part: a
 * tool-call-only turn still counts as a turn, so both observation paths
 * derive the same turn counters.
 *
 * @param content - The raw message content.
 * @param usage - The raw usage report, when the provider gave one.
 * @param at - Epoch-millis timestamp of the observation.
 * @returns The fact.
 */
export function messageEndFact(
  content: unknown,
  usage: unknown,
  at: number,
): MessageEndFact {
  const projected = projectUsage(usage);
  return {
    type: "message_end",
    at,
    content: projectMessageParts(content),
    ...(projected !== undefined ? { usage: projected } : {}),
  };
}

/**
 * Build the tool-start fact of one observed tool call.
 *
 * @param block - The tool-call block (or the observed call's fields).
 * @param at - Epoch-millis timestamp of the observation.
 * @returns The fact.
 */
export function toolStartFact(block: ToolCallBlock, at: number): ToolStartFact {
  return {
    type: "tool_start",
    at,
    ...(block.id !== undefined ? { toolCallId: block.id } : {}),
    toolName: block.name,
    args: block.args,
  };
}

/**
 * Build the tool-end fact of one finished tool execution.
 *
 * @param input - The observed end of the execution.
 * @param at - Epoch-millis timestamp of the observation.
 * @returns The fact.
 */
export function toolEndFact(input: ToolEndInput, at: number): ToolEndFact {
  return {
    type: "tool_end",
    at,
    ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
    toolName: input.toolName,
    content: projectTextParts(input.content),
    isError: input.isError,
  };
}
