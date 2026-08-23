/**
 * Message / part builders for pi golden scenarios.
 *
 * Emits pi `AgentMessage` shapes (the duck types in
 * `src/adapters/pi/types.ts`): user messages with string or part-array
 * content, assistant messages with text / thinking / toolCall blocks and
 * usage, and tool-result messages with a toolCallId.  Real pi messages
 * carry extra wire fields (`timestamp`, `api`, `provider`, `model`,
 * `stopReason`) that the adapter ignores; the builders accept them as
 * optional options so fixtures stay faithful to the wire shape.
 *
 * Fixtures may attach a synthetic `id` field to a message.  pi messages
 * have no native ids, but the `create-block` plan action addresses
 * messages by id, so the golden fixtures use `id` the way the opencode
 * fixtures use `info.id`.  The pi adapter reads only `role` / `content` /
 * `usage`, so the extra field is structurally harmless.
 *
 * @module
 */

import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiContentPart,
  PiTextPart,
  PiThinkingPart,
  PiToolCallPart,
  PiToolResultMessage,
  PiUsage,
  PiUserMessage,
} from "../../../../src/adapters/pi/types.js";

/** A pi user message carrying the golden fixture extras. */
export interface FixtureUserMessage extends PiUserMessage {
  /** Synthetic id for plan landing (pi messages carry none natively). */
  id?: string;
  timestamp?: number;
}

/** A pi assistant message carrying the golden fixture extras. */
export interface FixtureAssistantMessage extends PiAssistantMessage {
  id?: string;
  api?: string;
  provider?: unknown;
  model?: string;
}

/** A pi tool-result message carrying the golden fixture extras. */
export interface FixtureToolResultMessage extends PiToolResultMessage {
  id?: string;
}

/** Union of the fixture message kinds. */
export type FixtureAgentMessage =
  | FixtureUserMessage
  | FixtureAssistantMessage
  | FixtureToolResultMessage;

/** Build a text content block. */
export function textPart(text: string): PiTextPart {
  return { type: "text", text };
}

/** Build a reasoning (thinking) block. */
export function thinkingPart(thinking: string): PiThinkingPart {
  return { type: "thinking", thinking };
}

/** Build a tool-call block. */
export function toolCallPart(
  id: string,
  name: string,
  args: Record<string, unknown>,
): PiToolCallPart {
  return { type: "toolCall", id, name, arguments: args };
}

/** Optional fields for `userMsg`. */
export interface UserMessageOptions {
  id?: string;
  timestamp?: number;
}

/**
 * Build a pi user message.
 *
 * String content is kept as a string (the wire format pi emits for plain
 * text); part-array content is shallow-copied so later mutation of a
 * shared parts array cannot leak between fixtures.
 *
 * @param content - String or content-part array.
 * @param opts - Optional fixture extras.
 * @returns The user message.
 */
export function userMsg(
  content: string | PiContentPart[],
  opts: UserMessageOptions = {},
): FixtureUserMessage {
  const message: FixtureUserMessage = {
    role: "user",
    content: typeof content === "string" ? content : [...content],
  };
  if (opts.id !== undefined) message.id = opts.id;
  if (opts.timestamp !== undefined) message.timestamp = opts.timestamp;
  return message;
}

/** Optional fields for `assistantMsg`. */
export interface AssistantMessageOptions {
  /** API-reported token usage (needed for the release / nudge gates). */
  usage?: PiUsage;
  /** Defaults to `"stop"` (the common wire value). */
  stopReason?: string;
  timestamp?: number;
  id?: string;
  api?: string;
  provider?: unknown;
  model?: string;
}

/**
 * Build a pi assistant message.
 *
 * Content blocks are shallow-copied; the default `stopReason` is `"stop"`.
 *
 * @param content - The assistant content blocks.
 * @param opts - Optional wire fields / usage.
 * @returns The assistant message.
 */
export function assistantMsg(
  content: PiAssistantMessage["content"],
  opts: AssistantMessageOptions = {},
): FixtureAssistantMessage {
  const message: FixtureAssistantMessage = {
    role: "assistant",
    content: content.map((block) => ({ ...block })),
    ...(opts.usage !== undefined ? { usage: { ...opts.usage } } : {}),
    ...(opts.stopReason !== undefined
      ? { stopReason: opts.stopReason }
      : { stopReason: "stop" }),
  };
  if (opts.timestamp !== undefined) message.timestamp = opts.timestamp;
  if (opts.id !== undefined) message.id = opts.id;
  if (opts.api !== undefined) message.api = opts.api;
  if (opts.provider !== undefined) message.provider = opts.provider;
  if (opts.model !== undefined) message.model = opts.model;
  return message;
}

/** Optional fields for `toolResultMsg`. */
export interface ToolResultMessageOptions {
  /** Whether the tool call failed (default false). */
  isError?: boolean;
  timestamp?: number;
  id?: string;
}

/**
 * Build a pi tool-result message.
 *
 * Content parts are shallow-copied.
 *
 * @param toolCallId - The id of the tool call this result answers.
 * @param toolName - The tool that produced the result.
 * @param content - The result content parts.
 * @param opts - Optional wire fields.
 * @returns The tool-result message.
 */
export function toolResultMsg(
  toolCallId: string,
  toolName: string,
  content: PiContentPart[],
  opts: ToolResultMessageOptions = {},
): FixtureToolResultMessage {
  const message: FixtureToolResultMessage = {
    role: "toolResult",
    toolCallId,
    toolName,
    content: content.map((part) => ({ ...part })),
    isError: opts.isError ?? false,
  };
  if (opts.timestamp !== undefined) message.timestamp = opts.timestamp;
  if (opts.id !== undefined) message.id = opts.id;
  return message;
}

/**
 * Deep-clone a message array (used when a later round must replay an
 * earlier view with fresh object identity).
 *
 * @param messages - The messages to clone.
 * @returns A deep clone.
 */
export function cloneMessages(messages: FixtureAgentMessage[]): FixtureAgentMessage[] {
  return JSON.parse(JSON.stringify(messages)) as FixtureAgentMessage[];
}

/** Re-export the pi message union as the lane's default message type. */
export type { PiAgentMessage };
