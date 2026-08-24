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
 *  - `context` — the native pi `AgentMessage` array is handed to the
 *    transform contributions; the pruned replacement is returned to pi.
 *  - `commands` — the composed slash-command contributions become pi
 *    `registerCommand` registrations (`buildPiCommandRegistrationPlan`),
 *    and `createPiCommandToolHost` wraps the base pi tool host so a
 *    command's chat notification goes through pi's in-session
 *    `appendEntry` channel instead of the tool toast.  Custom entries
 *    never participate in the LLM context.
 *
 * pi event and message shapes (pi 0.84.x) are declared as local
 * duck-typed interfaces — the pi package is never imported.
 *
 * @module
 */

import type {
  PiAgentMessage,
  PiContentPart,
  PiContextEvent,
  PiContextHandlerContext,
  PiContextResult,
  PiImagePart,
  PiMessageEndEvent,
  PiMessageEndResult,
  PiTextPart,
  PiToolResultContext,
  PiToolResultEvent,
  PiToolResultResult,
} from "./adapters/pi/types.js";
import type { ToolHost } from "./core/client/tool-host.js";
import { setModelLimit } from "./core/context/model-limits.js";
import { stripLineStartRefs } from "./core/context/reply-strip.js";
import type { ComposedResult } from "./core/slots.js";
import { log } from "./utils/logger.js";

// Re-export the duck types so callers (including tests) that previously
// imported them from this module keep working.
export type {
  PiAgentMessage,
  PiAssistantMessage,
  PiContentPart,
  PiContextEvent,
  PiContextHandlerContext,
  PiContextResult,
  PiImagePart,
  PiMessageEndEvent,
  PiMessageEndResult,
  PiTextPart,
  PiThinkingPart,
  PiToolCallPart,
  PiToolResultContext,
  PiToolResultEvent,
  PiToolResultResult,
  PiUsage,
} from "./adapters/pi/types.js";

import type {
  AfterExecInput,
  AfterExecOutput,
  TransformOutput,
} from "./core/slots.js";

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
// Model-limit capture from pi's current model
// ---------------------------------------------------------------------------

/**
 * Capture the active model's context window when pi exposes one.
 *
 * pi's `ExtensionContext.model.contextWindow` is the host-native source
 * of the context limit.  The value is stored per session so the pruning
 * nudge phase can resolve percentage thresholds against the real window.
 * Missing or non-finite values are ignored.
 *
 * @param sessionId - The session identifier.
 * @param model - Duck-typed pi model object from the handler context.
 */
function capturePiModelLimit(sessionId: string, model: unknown): void {
  if (!model || typeof model !== "object") return;
  const ctxModel = model as { id?: unknown; contextWindow?: unknown };
  const contextWindow = ctxModel.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow)) {
    return;
  }
  const modelId = typeof ctxModel.id === "string" ? ctxModel.id : "unknown";
  setModelLimit(sessionId, contextWindow, modelId);
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
 * The native pi `AgentMessage` array is placed directly into the
 * transform output; the pi host adapter and the core pruning pipeline
 * operate on it natively.  Transform contributions run in order with
 * per-handler error isolation.  The handler captures the active model's
 * context window from `ctx.model` so percentage thresholds resolve against
 * the real limit, then returns the modified message list as pi's
 * `ContextEventResult` so pi replaces the turn's LLM context.
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
    const model =
      ctx && typeof ctx === "object"
        ? (ctx as Record<string, unknown>).model
        : undefined;
    capturePiModelLimit(sessionID, model);

    const output: TransformOutput = {
      messages: event.messages,
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

    // Return the transformed messages so pi uses the pruned view for this
    // turn.  The transform output is typed as `unknown`; it is the same
    // pi-shaped array that was supplied in the event.
    return {
      messages: output.messages as PiAgentMessage[],
    };
  };
}

// ---------------------------------------------------------------------------
// Message-end ref stripping
// ---------------------------------------------------------------------------

/**
 * Build the pi `message_end` handler that strips model-imitated
 * line-start ref prefixes from finalized assistant text.
 *
 * pi fires `message_end` after a message is finalized; the handler
 * inspects assistant messages and strips any leading `[mN] ` echoes
 * from text parts.  Thinking and tool-call parts are left untouched.
 * When no text part changes, `undefined` is returned so pi keeps the
 * original message; otherwise a shallow copy with the stripped text
 * parts is returned.  The input message is never mutated.
 *
 * @returns The `message_end` event handler.
 */
export function buildPiMessageEndHandler(): (
  event: PiMessageEndEvent,
  _ctx: unknown,
) => PiMessageEndResult | undefined {
  return (event) => {
    const message = event.message;
    if (message.role !== "assistant") {
      return undefined;
    }

    let changed = false;
    const newContent = message.content.map((part) => {
      if (part.type === "text") {
        const stripped = stripLineStartRefs(part.text);
        if (stripped !== part.text) {
          changed = true;
          return { ...part, text: stripped };
        }
      }
      return part;
    });

    if (!changed) {
      return undefined;
    }

    return {
      message: {
        ...message,
        content: newContent,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Command slot assembly
// ---------------------------------------------------------------------------

/**
 * Minimal duck-type shape of the pi command-handler context.
 *
 * pi passes its `ExtensionCommandContext` (see
 * `createCommandContext` in the pi runner) to a registered command
 * handler; ZooKeeper only reads the session id off it.
 */
export interface PiCommandContext {
  sessionManager?: { getSessionId(): string };
}

/** One pi `registerCommand` registration assembled from a contribution. */
export interface PiCommandRegistration {
  /** Command name (invocation name, e.g. `"dcp"`). */
  name: string;
  /** Command description surfaced by pi's command list. */
  description: string;
  /** The `(args, ctx)` handler pi invokes for the command. */
  handler(args: string, ctx: PiCommandContext): Promise<void>;
}

/**
 * Assemble the pi `registerCommand` registrations from the composed
 * commands slot.
 *
 * The handler resolves the session id from pi's command context
 * (`ctx.sessionManager.getSessionId()`) and forwards the raw arguments
 * string into the host-agnostic `CommandInput`, mirroring the OpenCode
 * adapter's command routing.  An optional `refresh` callback receives
 * the pi context so the entry point can update its shared context
 * holder before the command body runs (the command tool host reads the
 * holder for history / notifications).
 *
 * @param commands - The composed command contributions, keyed by name.
 * @param refresh - Optional callback receiving the raw pi command context.
 * @returns The pi command registrations (empty for an empty slot).
 */
export function buildPiCommandRegistrationPlan(
  commands: ComposedResult["commands"],
  refresh?: (ctx: PiCommandContext) => void,
): PiCommandRegistration[] {
  return Object.values(commands).map((contribution) => ({
    name: contribution.name,
    description: contribution.description,
    handler: async (args, ctx) => {
      refresh?.(ctx);
      const sessionID = ctx?.sessionManager?.getSessionId() ?? "";
      await contribution.handle({
        command: contribution.name,
        sessionID,
        arguments: args,
      });
    },
  }));
}

/**
 * Append a custom entry into the pi session.
 *
 * Structurally compatible with pi's `ExtensionAPI.appendEntry`: the
 * entry persists as a `CustomEntry` (session-visible only when a
 * renderer is registered for `customType`) and — unlike
 * `CustomMessageEntry` — is ignored by `buildSessionContext`, so it
 * never reaches the LLM context.  This is the pi-native equivalent of
 * v1's `ignored` parts.
 */
export type PiAppendEntry = (customType: string, data?: unknown) => void;

/**
 * The data payload carried by a `zoo-dcp` custom entry.
 *
 * `content` holds the report text; the renderer reads it back to draw
 * the chat-transcript card in the TUI.  Kept as a single string field
 * so the payload stays minimal and the entry stays durable JSON.
 */
export interface PiDcpEntryData {
  content: string;
}

/**
 * Wrap the base pi tool host so a command's chat notification goes
 * through pi's in-session `appendEntry` channel.
 *
 * The base host (toast notify) stays untouched and keeps serving the
 * tool units' runtime prompts.  The command host reuses the base
 * `resolveSessionId` / `fetchHistory` and replaces only `notify` with
 * an `appendEntry`-backed implementation — the pi equivalent of v1's
 * ignored `noReply` chat message: persistent in the session, rendered
 * in the TUI by the `zoo-dcp` entry renderer, and never entering the
 * LLM context.  When no `appendEntry` is supplied (e.g. headless or
 * test-only host) the notification is dropped with a debug log,
 * matching the base host's best-effort style.
 *
 * @param toolHost - The base pi tool host (history / session resolution).
 * @param appendEntry - Optional pi `appendEntry` binding (extension API).
 * @returns A tool host whose `notify` appends an in-session custom entry.
 */
export function createPiCommandToolHost(
  toolHost: ToolHost,
  appendEntry?: PiAppendEntry,
): ToolHost {
  return {
    ...toolHost,
    async notify(_sessionId: string, text: string): Promise<void> {
      if (!appendEntry) {
        log("tool-host", "notify_skipped", _sessionId, undefined, "debug", {
          reason: "appendEntry unavailable",
        });
        return;
      }
      try {
        const data: PiDcpEntryData = { content: text };
        appendEntry("zoo-dcp", data);
      } catch (err) {
        log("tool-host", "notify_failed", _sessionId, undefined, "warn", {
          error: String(err),
        });
      }
    },
  };
}
