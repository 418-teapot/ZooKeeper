/**
 * Pi event / message duck types (structurally compatible with pi 0.84.x).
 *
 * ZooKeeper never imports the pi package; these local interfaces are the
 * single source of truth for pi-shaped values used by the pi adapter and
 * the pi event-key adapter (`src/compose-pi.ts`).
 *
 * @module
 */

/** Text content part of pi messages and tool results. */
export interface PiTextPart {
  type: "text";
  text: string;
}

/** Image content part of pi messages and tool results. */
export interface PiImagePart {
  type: "image";
  data: string;
  mimeType: string;
}

/** Union of the content parts pi attaches to messages and tool results. */
export type PiContentPart = PiTextPart | PiImagePart;

/** Usage report attached to pi assistant messages. */
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

/** Thinking block inside a pi assistant message. */
export interface PiThinkingPart {
  type: "thinking";
  thinking: string;
}

/** Tool-call block inside a pi assistant message. */
export interface PiToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Pi user message. */
export interface PiUserMessage {
  role: "user";
  content: string | PiContentPart[];
}

/** Pi assistant message (usage omitted when the provider reports none). */
export interface PiAssistantMessage {
  role: "assistant";
  content: (PiTextPart | PiThinkingPart | PiToolCallPart)[];
  usage?: PiUsage;
  stopReason?: string;
  timestamp?: number;
}

/** Pi tool-result message. */
export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: PiContentPart[];
  isError: boolean;
  timestamp?: number;
}

/** Union of the three pi LLM message kinds. */
export type PiAgentMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage;

/** The pi `tool_result` event payload. */
export interface PiToolResultEvent {
  type: "tool_result";
  toolName: string;
  toolCallId: string;
  /**
   * The tool arguments from the original tool call.
   *
   * Optional because structurally older pi events may omit it; after-exec
   * contributions then receive no args (see `AfterExecInput.args`).
   */
  input?: Record<string, unknown>;
  content: PiContentPart[];
  isError: boolean;
}

/** Context pi passes to `tool_result` handlers. */
export interface PiToolResultContext {
  sessionManager?: { getSessionId(): string };
}

/** Result shape a `tool_result` handler may return. */
export interface PiToolResultResult {
  content?: PiContentPart[];
}

/** The pi `context` event payload (fired before every LLM request). */
export interface PiContextEvent {
  type: "context";
  messages: PiAgentMessage[];
}

/** Context pi passes to `context` handlers. */
export interface PiContextHandlerContext {
  sessionManager?: { getSessionId(): string };
  model?: { id?: string; contextWindow?: number };
}

/** Result shape a `context` handler may return. */
export interface PiContextResult {
  messages?: PiAgentMessage[];
}

/** The pi `message_end` event payload (fired when a message is finalized). */
export interface PiMessageEndEvent {
  type: "message_end";
  message: PiAgentMessage;
}

/** Result shape a `message_end` handler may return. */
export interface PiMessageEndResult {
  message?: PiAgentMessage;
}
