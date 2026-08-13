/**
 * Pi event-key adapter (host contact layer).
 *
 * The only module that understands pi's event keys.  Given the
 * host-agnostic `ComposedResult` produced by `composeProfile`, it builds
 * the two handlers pi registers on `tool_result` and `context`:
 *
 *  - `tool_result` — the text content of the event seeds a shared
 *    `AfterExecOutput` object; the after-exec contributions run in
 *    order with per-handler error isolation.  When the final text
 *    extends the seed, the delta is returned as one appended text part
 *    next to the original parts (pi treats the returned `content` as a
 *    full replacement, so the original parts are preserved).  When the
 *    text was rewritten entirely (including a prefix insertion), the
 *    original text parts are replaced by the full final text and image
 *    parts are kept.
 *  - `context` — the pi AgentMessage list is converted to
 *    `ContextMessageEntry[]` (see `toContextMessageEntries`) and handed
 *    to the transform contributions.  Measure-only: the handler always
 *    returns `undefined` because converting modified entries back to pi
 *    messages is not supported yet.  Contributions that rewrite
 *    messages (e.g. context pruning) are excluded by the unit's own
 *    capability check (pi passes an empty client object, so session
 *    introspection is unavailable) and never reach this handler.
 *
 * pi event and message shapes (pi 0.84.x) are declared as local
 * duck-typed interfaces — the pi package is never imported.
 *
 * @module
 */

import type {
  ContextMessageEntry,
  ContextMessageInfo,
  ContextMetricsOutput,
  ContextTextPart,
  ContextTokenInfo,
} from "./core/context/metrics.js";
import type {
  AfterExecInput,
  AfterExecOutput,
  ComposedResult,
} from "./core/slots.js";
import { log } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Pi event / message duck types (structurally compatible with pi 0.84.x)
// ---------------------------------------------------------------------------

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
}

/** Pi tool-result message. */
export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: PiContentPart[];
  isError: boolean;
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
}

/** Result shape a `context` handler may return. */
export interface PiContextResult {
  messages?: PiAgentMessage[];
}

// ---------------------------------------------------------------------------
// Tool part extension
// ---------------------------------------------------------------------------

/**
 * Tool part inside a converted message entry.
 *
 * Extends the base `ContextTextPart` shape with the tool-call identifier
 * and input/output state, so tool parts can be typed without `as`
 * assertions.
 */
interface ContextToolPart extends ContextTextPart {
  type: "tool";
  callID: string;
  state: {
    input?: unknown;
    output?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

/**
 * Concatenate the text of all text parts, ignoring image parts.
 *
 * @param parts - The content parts of a pi message or tool result.
 * @returns The joined text (empty when there are no text parts).
 */
export function extractText(parts: PiContentPart[] | undefined): string {
  return (parts ?? [])
    .filter((part): part is PiTextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

/**
 * Convert a pi `Usage` report to the unified token-info shape.
 *
 * `cacheRead` / `cacheWrite` are top-level fields in pi but nested under
 * `cache` in the unified shape; `reasoning` is preserved when present.
 *
 * @param usage - The usage report of a pi assistant message.
 * @returns The unified token info, or `undefined` without a usage report.
 */
function usageToTokens(
  usage: PiUsage | undefined,
): ContextTokenInfo | undefined {
  if (!usage) return undefined;
  const tokens: ContextTokenInfo = {};
  if (usage.input !== undefined) tokens.input = usage.input;
  if (usage.output !== undefined) tokens.output = usage.output;
  if (usage.reasoning !== undefined) tokens.reasoning = usage.reasoning;
  if (usage.cacheRead !== undefined || usage.cacheWrite !== undefined) {
    tokens.cache = {};
    if (usage.cacheRead !== undefined) tokens.cache.read = usage.cacheRead;
    if (usage.cacheWrite !== undefined) tokens.cache.write = usage.cacheWrite;
  }
  return tokens;
}

/**
 * Convert the content blocks of a pi assistant message to unified parts.
 *
 * Tool-call blocks become tool parts carrying the call ID and parsed
 * arguments; thinking and text blocks become plain text parts.
 *
 * @param content - The content blocks of a pi assistant message.
 * @returns The unified parts array.
 */
function assistantContentToParts(
  content: (PiTextPart | PiThinkingPart | PiToolCallPart)[],
): (ContextTextPart | ContextToolPart)[] {
  const parts: (ContextTextPart | ContextToolPart)[] = [];
  for (const block of content) {
    if (block.type === "toolCall") {
      parts.push({
        type: "tool",
        callID: block.id,
        state: { input: block.arguments },
      });
    } else if (block.type === "thinking") {
      parts.push({ type: "text", text: block.thinking });
    } else {
      parts.push({ type: "text", text: block.text });
    }
  }
  return parts;
}

/**
 * Convert the content of a pi user message to unified text parts.
 *
 * String content becomes a single text part; array content keeps text
 * parts and drops image parts.  An empty string yields no parts.
 *
 * @param content - The content of a pi user message.
 * @returns The unified parts array.
 */
function userContentToParts(
  content: string | PiContentPart[],
): ContextTextPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  const parts: ContextTextPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    }
  }
  return parts;
}

/**
 * Convert pi AgentMessages to unified `ContextMessageEntry` objects.
 *
 * Roles are kept as-is; IDs are synthesised as `pi-<sessionID>-<index>`.
 * Assistant usage maps to `info.tokens`, assistant tool calls and pi
 * tool-result messages map to tool parts, and user content maps to text
 * parts (images dropped).
 *
 * @param messages - The pi AgentMessage list from a `context` event.
 * @param sessionID - The session identifier from the handler context.
 * @returns The unified message entries.
 */
export function toContextMessageEntries(
  messages: PiAgentMessage[],
  sessionID: string,
): ContextMessageEntry[] {
  return messages.map((message, index) => {
    const id = `pi-${sessionID}-${index}`;
    if (message.role === "user") {
      return {
        info: { role: message.role, id, sessionID },
        parts: userContentToParts(message.content),
      };
    }
    if (message.role === "assistant") {
      const tokens = usageToTokens(message.usage);
      const info: ContextMessageInfo = {
        role: message.role,
        id,
        sessionID,
      };
      if (tokens !== undefined) {
        info.tokens = tokens;
      }
      return {
        info,
        parts: assistantContentToParts(message.content),
      };
    }
    // toolResult role — carried over as-is with the output text joined.
    return {
      info: { role: message.role, id, sessionID },
      parts: [
        {
          type: "tool",
          callID: message.toolCallId,
          state: { output: extractText(message.content) },
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Delta computation
// ---------------------------------------------------------------------------

/**
 * Mode describing how the final text relates to the seed text.
 *
 * - `append` — the final text extends the seed; `text` is the trailing
 *   portion to place after the original parts.
 * - `rewrite` — the text was rewritten entirely (including a prefix
 *   insertion); `text` is the full replacement for the original text
 *   parts (image parts are kept).
 */
type DeltaMode = "append" | "rewrite";

/** Text placement result computed by `computeDelta`. */
interface DeltaResult {
  mode: DeltaMode;
  text: string;
}

/**
 * Compute how the final text relates to the seed text.
 *
 * The result carries the trailing portion when the final text extends
 * the original seed (`append`), or the full final text when the
 * contributions rewrote it entirely (`rewrite`).  The caller appends
 * `text` next to the original parts for `append`, and replaces the
 * original text parts with `text` for `rewrite`.
 *
 * @param finalText - The output text after all contributions ran.
 * @param originalText - The seed text extracted from the event.
 * @returns The placement result for the final text.
 */
function computeDelta(finalText: string, originalText: string): DeltaResult {
  if (
    finalText.length > originalText.length &&
    finalText.startsWith(originalText)
  ) {
    return { mode: "append", text: finalText.slice(originalText.length) };
  }
  return { mode: "rewrite", text: finalText };
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

/**
 * Build the pi `tool_result` handler from the composed after-exec
 * contributions.
 *
 * The event's text content seeds a shared `AfterExecOutput` object; each
 * contribution runs in order against the same object with per-handler
 * error isolation (a crash is logged as `handler_crashed` and never
 * blocks the next).  When the final text extends the seed, the delta
 * is returned as one appended text part next to the original parts;
 * when it was rewritten entirely (including a prefix insertion), the
 * original text parts are replaced by the full final text and image
 * parts are kept.  When the final text equals the seed, `undefined`
 * is returned and the event is untouched.
 *
 * @param afterExec - The composed `tool.execute.after` contributions.
 * @returns The `tool_result` event handler.
 */
export function buildPiToolResultHandler(
  afterExec: ComposedResult["afterExec"],
): (
  event: PiToolResultEvent,
  ctx: PiToolResultContext,
) => Promise<PiToolResultResult | undefined> {
  return async (event, ctx) => {
    // `content` is required by the pi contract; the fallback only
    // guards against structurally older events at runtime.
    const originalParts = event.content ?? [];
    const originalText = extractText(originalParts);
    const sessionID = ctx?.sessionManager?.getSessionId() ?? "";

    const input: AfterExecInput = {
      tool: event.toolName,
      sessionID,
      callID: event.toolCallId,
      // Pass the tool arguments through so after-exec contributions
      // can inspect what the tool was invoked with.
      args: event.input,
    };
    const output: AfterExecOutput = { output: originalText };

    for (const contribution of afterExec) {
      try {
        await contribution.handle(input, output);
      } catch (err) {
        log("plugin", "handler_crashed", sessionID, input.callID, "error", {
          handler: contribution.name,
          error: String(err),
        });
      }
    }

    const finalText = output.output;
    if (finalText === undefined || finalText === originalText) {
      return undefined;
    }
    const delta = computeDelta(finalText, originalText);
    if (delta.mode === "rewrite") {
      // The text was rewritten entirely (including a prefix insertion):
      // replace the original text parts with the full final text and
      // keep the image parts.
      return {
        content: [
          { type: "text", text: delta.text },
          ...originalParts.filter(
            (part): part is PiImagePart => part.type === "image",
          ),
        ],
      };
    }
    // The final text extends the seed: append the trailing delta next
    // to the original parts (pi treats the returned content as a full
    // replacement, so the original parts are preserved).
    return {
      content: [...originalParts, { type: "text", text: delta.text }],
    };
  };
}

/**
 * Build the pi `context` handler from the composed transform
 * contributions.
 *
 * The pi AgentMessages are converted to unified entries (see
 * `toContextMessageEntries`) and handed to each transform contribution
 * with per-handler error isolation.  The handler is measure-only: it
 * always returns `undefined`, so modified entries are never written back
 * to pi.
 *
 * @param transform - The composed messages-transform contributions.
 * @returns The `context` event handler.
 */
export function buildPiContextHandler(
  transform: ComposedResult["transform"],
): (
  event: PiContextEvent,
  ctx: PiContextHandlerContext,
) => Promise<PiContextResult | undefined> {
  return async (event, ctx) => {
    const sessionID = ctx?.sessionManager?.getSessionId() ?? "";
    const output: ContextMetricsOutput = {
      messages: toContextMessageEntries(event.messages, sessionID),
    };

    for (const contribution of transform) {
      try {
        await contribution.handle(output);
      } catch (err) {
        log("plugin", "handler_crashed", sessionID, undefined, "error", {
          handler: contribution.name,
          error: String(err),
        });
      }
    }

    // Measure-only: converting modified entries back to pi messages is
    // not supported, so the original message list is never replaced.
    return undefined;
  };
}
