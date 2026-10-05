/**
 * Pi host types consumed by the pi adapter.
 *
 * The pi extension surfaces ZooKeeper binds to — `ExtensionAPI`, the event
 * payloads and their results, and the boundary drafts — are imported
 * type-only from the installed `@earendil-works/pi-coding-agent` package
 * and re-exported under the adapter's `Pi*` names, so the adapter compiles
 * against the host's published contract instead of a local copy.  This
 * module emits no runtime import.
 *
 * The transcript shapes stay locally declared.  pi does not re-export its
 * `AgentMessage` / content / usage union from the package root, and the
 * adapter's message duck types are deliberately narrower than pi's (no
 * `timestamp`, provider metadata or required usage) because ZooKeeper both
 * reads and constructs them.  The event payloads that embed that union
 * (`context` and `message_end`) stay local for the same reason, and the
 * handler contexts are narrowed too: the adapter reads only the session id
 * (and, for `context`, the model) off the real `ExtensionContext` /
 * `ExtensionCommandContext`, so a duck shape keeps test fixtures honest.
 *
 * @module
 */

import type {
  BoundaryResult,
  CustomMessageEntryDraft,
  CustomToolCallEvent,
  ToolCallEventResult,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

/** pi's `ExtensionAPI`, re-exported under the name the adapter uses. */
export type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

/**
 * Pi bash-execution message.
 *
 * Produced by the built-in `bash` tool's interactive escape hatch.  It has
 * no `content` field: pi derives the model-visible text from `command`,
 * `output`, `exitCode`, `cancelled` and `truncated` at request-build time,
 * so no single field round-trips an edit.
 */
export interface PiBashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
}

/**
 * Pi extension-contributed message.
 *
 * `content` is user-shaped (a string or text/image parts), which is what
 * pi converts into a user message when building the request.
 */
export interface PiCustomMessage {
  role: "custom";
  customType: string;
  content: string | PiContentPart[];
  display: boolean;
  details?: unknown;
  timestamp: number;
}

/**
 * Pi branch-summary message.
 *
 * Injected when the conversation returns from a branched session.  Carries
 * a `summary` string and no `content` field; unlike a compaction summary it
 * does not delimit the historical part of the transcript.
 */
export interface PiBranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

/**
 * Pi compaction-summary message.
 *
 * Injected by pi's own compaction (`/compact`, auto-compaction).  Carries a
 * `summary` string and no `content` field; every transcript message before
 * it is historical, which is the semantics the core lens `compaction` flag
 * expresses.
 */
export interface PiCompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

/**
 * Union of every pi `AgentMessage` role.
 *
 * Mirrors pi's `AgentMessage` union: the three LLM-shaped kinds plus the
 * coding-agent extensions (bash execution, extension-contributed messages,
 * branch and compaction summaries).  Declared locally because pi exports
 * `AgentMessage` from `@earendil-works/pi-agent-core`, not from its own
 * package root.  Keep it exhaustive — the projection in `history.ts`
 * relies on it to type-check its role dispatch, and the `context` /
 * `message_end` events deliver exactly this union.
 */
export type PiAgentMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiBashExecutionMessage
  | PiCustomMessage
  | PiBranchSummaryMessage
  | PiCompactionSummaryMessage;

/**
 * The pi `tool_result` event payload.
 *
 * Declared locally rather than aliased to pi's `ToolResultEvent`: the
 * official union requires `details` and `input` on every variant, while a
 * structurally older pi event may omit `input`, which the after-exec
 * contributions tolerate (see `AfterExecInput.args`).
 */
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
export type PiToolResultResult = ToolResultEventResult;

/**
 * The pi `tool_call` event payload (pi's `CustomToolCallEvent`).
 *
 * Declared as the generic custom-tool event: pi assigns a built-in shape to
 * its own tools, so the extension-registered `subagent` tool arrives with a
 * plain `toolName` string and the raw `input` arguments.  A handler may
 * mutate `input` in place, but this extension only reads it.
 */
export type PiToolCallEvent = CustomToolCallEvent;

/** Context pi passes to `tool_call` handlers. */
export interface PiToolCallContext {
  sessionManager?: { getSessionId(): string };
}

/**
 * Result shape a `tool_call` handler may return (pi's
 * `ToolCallEventResult`).
 *
 * `block: true` prevents the tool from executing and turns `reason` into
 * the text of an error tool result (`isError: true`); `terminate` is
 * deliberately not used.
 */
export type PiToolCallResult = ToolCallEventResult;

/**
 * The pi `context` event payload (fired before every LLM request).
 *
 * `messages` is the full `AgentMessage` union, not just the three
 * LLM-shaped kinds: after a compaction the list also carries
 * `compactionSummary`, and branch returns / bash escapes / extension
 * messages add `branchSummary`, `bashExecution` and `custom`.
 *
 * Declared locally rather than aliased to pi's `ContextEvent`: the payload
 * carries the local `PiAgentMessage` duck union (see its note), which is
 * narrower than pi's `AgentMessage`.
 */
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

/** Context pi passes to `message_end` handlers. */
export interface PiMessageEndContext {
  sessionManager?: { getSessionId(): string };
}

/**
 * Minimal duck-type shape of the pi command-handler context.
 *
 * pi passes its `ExtensionCommandContext` (see `createCommandContext` in
 * the pi runner) to a registered command handler; ZooKeeper only reads the
 * session id off it.
 */
export interface PiCommandContext {
  sessionManager?: { getSessionId(): string };
}

/**
 * A `zoo-loop-wake` custom-message entry draft for the boundary result.
 *
 * pi's `CustomMessageEntryDraft`: pi commits the draft as a persistent
 * custom message that the model reads as a user-role message and the TUI
 * renders when `display` is set.
 */
export type PiCustomMessageEntryDraft = CustomMessageEntryDraft;

/**
 * The pre-settle boundary result this extension returns (pi's
 * `BoundaryResult`).
 *
 * pi's `emitBoundary` hands each handler the drafts accumulated so far via
 * the event's `entries` and adopts the handler's returned array wholesale —
 * there is no runner-side merge — so a handler that appends a draft must
 * re-emit the drafts it received, or it silently drops earlier extensions'
 * boundary contributions.  The last non-undefined `continue` wins, and pi
 * runs the continuation before the enclosing `prompt()` returns.
 */
export type PiBoundaryResult = BoundaryResult;

/**
 * The event handlers this extension registers with pi.
 *
 * Built by `createPiEventHandlers` in `handlers.ts`; the `compose-pi`
 * layer maps each member onto its pi event key (`registerPiHandlers`).
 * `hasSettledHandlers` does not map to an event: it gates whether the
 * settle keys are registered at all.
 */
export interface PiEventHandlers {
  /** `before_agent_start`: inject the resolved identity's agent prompt. */
  beforeAgentStart(
    evt: { systemPrompt: string },
    ctx?: unknown,
  ): Promise<{ systemPrompt: string }>;
  /** `resources_discover`: contribute the profile's skill directories. */
  resourcesDiscover(
    evt?: unknown,
    ctx?: unknown,
  ): Promise<{ skillPaths: string[] }>;
  /** `tool_result`: run the composed after-exec contributions. */
  toolResult(
    event: PiToolResultEvent,
    ctx: PiToolResultContext,
  ): Promise<PiToolResultResult | undefined>;
  /** `context`: run the composed transform contributions. */
  contextHandler(
    event: PiContextEvent,
    ctx: PiContextHandlerContext,
  ): Promise<PiContextResult | undefined>;
  /** `message_end`: run the composed text-finalization contributions. */
  messageEnd(
    event: PiMessageEndEvent,
    ctx: PiMessageEndContext,
  ): PiMessageEndResult | undefined;
  /**
   * `tool_call`: enforce the composed delegation gate on `subagent` calls.
   * A refusal blocks the call and surfaces the reason as an error tool
   * result; every other tool call passes through untouched.
   */
  toolCall(
    event: PiToolCallEvent,
    ctx?: PiToolCallContext,
  ): PiToolCallResult | undefined;
  /** `session_start`: seed the `zoo` widget at startup / resume. */
  sessionStart(evt?: unknown, ctx?: unknown): Promise<void>;
  /** `session_tree`: drop the todo cache after a tree navigation. */
  sessionTree(evt?: unknown, ctx?: unknown): void;
  /**
   * Whether the composition contributes any settle handlers.  The entry
   * point registers the loop settle events only when this is true, so a
   * profile without a settle-contributing hook stays fully inert.
   */
  hasSettledHandlers: boolean;
  /**
   * Whether the composition contributes a delegation gate.  The entry
   * point registers the `tool_call` event only when this is true, so a
   * profile without a delegation judge stays fully inert.
   */
  hasGateHandlers: boolean;
  /**
   * `agent_end`: record a finished run's terminal messages for the
   * boundary judge (the boundary event carries no transcript).
   */
  agentEnd(evt?: unknown, ctx?: unknown): void;
  /**
   * `agent_before_settle`: judge a settled run, returning a
   * `zoo-loop-wake` entry when the composed strategy wakes.
   */
  beforeSettle(evt?: unknown, ctx?: unknown): Promise<PiBoundaryResult>;
  /** `agent_settled`: flush the log once a run has fully settled. */
  agentSettled(evt?: unknown, ctx?: unknown): void;
  /** `ui_prompt_start`: track a blocking user-facing UI prompt span. */
  uiPromptStart(evt?: unknown, ctx?: unknown): void;
  /** `ui_prompt_end`: close a blocking user-facing UI prompt span. */
  uiPromptEnd(evt?: unknown, ctx?: unknown): void;
}
