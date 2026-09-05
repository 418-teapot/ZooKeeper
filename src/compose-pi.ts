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
 *    `registerCommand` registrations (`buildPiCommandRegistrationPlan`).
 *    Command chat notifications flow through the single base pi tool
 *    host's in-session `appendEntry` channel (`zoo-notice` custom
 *    entries) — persistent, rendered by the entry renderer, and never
 *    part of the LLM context.
 *  - `tools` — the composed tool contributions are gate-wrapped at the
 *    registration boundary (`wrapToolsWithDelegationGate`): the composed
 *    delegation gate (the strategy contributed by hook-unit judges) is
 *    enforced by wrapping the subagent tool's `execute`, so the tool
 *    itself stays policy-free (the gate belongs to the path, not the
 *    mechanism — mirroring the OpenCode host's `tool.execute.before`
 *    enforcement).  The composed `tool.definition` contributions run at
 *    the same boundary (`applyToolDefinitionContributions`), enriching
 *    the tool arguments' descriptions (e.g. the task-prompt hint) before
 *    pi registers the tools — pi has no native `tool.definition` event,
 *    so the OpenCode chain is applied here instead.
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
import { setModelLimit } from "./core/context/model-limits.js";
import { stripLineStartRefs } from "./core/context/reply-strip.js";
import type { DelegationGate } from "./core/gate.js";
import type {
  ComposedResult,
  ToolArgDefinition,
  ToolContribution,
  ToolDefinitionContribution,
  ToolDefinitionView,
} from "./core/slots.js";
import { resolveIdentity } from "./core/subagent/identity.js";
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
// Tool-slot delegation gate wrapping
// ---------------------------------------------------------------------------

/**
 * Resolve a best-effort session id from a pi tool execution context.
 *
 * pi passes its `ExtensionContext` (which carries a session manager) as
 * the tool context of the contributed tool's `execute`.  The wrapper
 * reads the session id off it for logging only; when the surface is
 * absent (test invocations, structural drift) it degrades to an empty
 * string.
 *
 * @param toolCtx - The pi tool execution context (opaque to this layer).
 * @returns The session id, or an empty string when unresolvable.
 */
function toolSessionId(toolCtx: unknown): string {
  const manager =
    toolCtx && typeof toolCtx === "object"
      ? (toolCtx as { sessionManager?: unknown }).sessionManager
      : undefined;
  if (
    !manager ||
    typeof manager !== "object" ||
    typeof (manager as { getSessionId?: unknown }).getSessionId !== "function"
  ) {
    return "";
  }
  // Invoke the method WITH the manager as receiver: a real pi session
  // manager is a class instance whose getSessionId reads `this.sessionId`,
  // so extracting the method and calling it bare would drop `this` and
  // throw.
  const sessionID = (manager as { getSessionId(): unknown }).getSessionId();
  return typeof sessionID === "string" ? sessionID : "";
}

/**
 * Wrap the composed tools so the delegation gate runs at the registration
 * boundary.
 *
 * The strategy gate (contributed by hook-unit judges) belongs to the
 * path, not the mechanism: the subagent tool itself is policy-free, and
 * the composed gate is enforced here — where the tool registers with pi
 * — so the tool never observes the policy (mirroring the OpenCode host,
 * which applies the same gate on `tool.execute.before`).
 *
 * A `null` gate (an empty judge chain — a valid profile that enables no
 * delegation judges) passes the tools through unchanged, as do tool sets
 * that contain no `subagent` entry.  Otherwise the subagent tool's
 * `execute` is wrapped: the request is built from the arguments (a
 * non-string `agent` / `prompt` is left undefined, deferring to the
 * inner tool's own argument validation), the caller comes from
 * `resolveIdentity` only when at least one judge needs it (`needsCaller`,
 * mirroring the OpenCode boundary, which resolves the caller only when
 * `composed.gateNeedsCaller` is set — a judge that needs the caller
 * opts in by declaring `needsCaller`; otherwise the caller is left
 * undefined and the judges skip caller-dependent checks), and a refusal
 * logs a warn (with caller / target / judge / reason, session id
 * best-effort) and returns the reason text (pi tool convention: never
 * throw).  All other tool fields are preserved.
 *
 * @param tools - The composed tool contributions keyed by name.
 * @param gate - The composed delegation gate, or `null` for no strategy.
 * @param needsCaller - Whether at least one judge needs the caller; when
 *   false the caller is left undefined and never resolved.
 * @returns The tools, with the subagent execute gate-wrapped when a gate
 *   applies.
 */
export function wrapToolsWithDelegationGate(
  tools: Record<string, ToolContribution>,
  gate: DelegationGate | null,
  needsCaller: boolean,
): Record<string, ToolContribution> {
  // No strategy (valid config) or no subagent tool → nothing to wrap.
  if (gate === null) return tools;
  const subagent = tools.subagent;
  if (subagent === undefined) return tools;

  return {
    ...tools,
    subagent: {
      ...subagent,
      execute: async (args, toolCtx, hostCtx) => {
        // Build the request.  A non-string field is left undefined so the
        // inner tool's argument validation reports it (preserving the
        // current boundary semantics).
        const raw =
          args && typeof args === "object"
            ? (args as Record<string, unknown>)
            : {};
        const target = typeof raw.agent === "string" ? raw.agent : undefined;
        const prompt = typeof raw.prompt === "string" ? raw.prompt : undefined;
        // The caller comes from the identity core only when at least one
        // judge needs it; otherwise it is left undefined (OpenCode parity).
        const caller = needsCaller ? resolveIdentity()?.name : undefined;

        const refusal = gate({ caller, target, prompt });
        if (refusal !== null) {
          log(
            "subagent-tool",
            "delegation_blocked",
            toolSessionId(toolCtx),
            undefined,
            "warn",
            {
              caller: caller ?? null,
              target: target ?? null,
              judge: refusal.judge,
              reason: refusal.reason,
            },
          );
          return refusal.reason;
        }
        return subagent.execute(args, toolCtx, hostCtx);
      },
    },
  };
}

/**
 * Extract the raw tool arguments onto a neutral per-argument map.
 *
 * Each argument's schema is copied (the entry itself, not the containing
 * map), so a contributor's `description` mutation never reaches the
 * input tool's objects — the boundary function stays pure and the
 * unchanged arguments keep their original identity.
 *
 * @param args - The raw tool argument schemas (or `undefined`).
 * @returns The neutral per-argument map.
 */
function collectArgDefinitions(
  args: Record<string, unknown> | undefined,
): Record<string, ToolArgDefinition> {
  const viewArgs: Record<string, ToolArgDefinition> = {};
  for (const [name, schema] of Object.entries(args ?? {})) {
    if (schema !== null && typeof schema === "object") {
      viewArgs[name] = { ...(schema as Record<string, unknown>) };
    }
  }
  return viewArgs;
}

/**
 * Apply the composed `tool.definition` contributions at the pi tool
 * registration boundary.
 *
 * pi has no native `tool.definition` event (the OpenCode host runs the
 * same chain on its own hook); the composed enhancers run once here,
 * against each tool's host-neutral definition, before the tools are
 * registered with pi.  The strategy stays with the path: the input tool
 * map is never mutated — affected arguments are rebuilt in a fresh tool
 * object, and unaffected tools keep their exact identity (matching the
 * OpenCode adapter, which runs the chain at its own event boundary).
 *
 * @param tools - The composed tool contributions keyed by name.
 * @param contributions - The composed `tool.definition` enhancers.
 * @returns The tools with their argument descriptions enriched.
 */
export function applyToolDefinitionContributions(
  tools: Record<string, ToolContribution>,
  contributions: ToolDefinitionContribution[],
): Record<string, ToolContribution> {
  // No enhancers (a profile without the task-prompt hook unit) → pass
  // the tools through unchanged.
  if (contributions.length === 0) return tools;

  const enriched: Record<string, ToolContribution> = {};
  for (const [key, tool] of Object.entries(tools)) {
    const view: ToolDefinitionView = {
      name: tool.name,
      description: tool.description,
      args: collectArgDefinitions(tool.args),
    };
    for (const contribution of contributions) {
      contribution.handle(view);
    }

    // Write the mutated per-argument descriptions back into a fresh tool
    // only when something changed; untouched arguments keep their exact
    // identity.
    const originalArgs = tool.args ?? {};
    let argsChanged = false;
    const args: Record<string, unknown> = {};
    for (const [argName, schema] of Object.entries(originalArgs)) {
      const argView = view.args?.[argName];
      if (
        argView !== undefined &&
        argView.description !==
          (schema as { description?: unknown }).description
      ) {
        args[argName] = {
          ...(schema as Record<string, unknown>),
          description: argView.description,
        };
        argsChanged = true;
      } else {
        args[argName] = schema;
      }
    }
    const descriptionChanged =
      view.description !== undefined && view.description !== tool.description;
    if (!argsChanged && !descriptionChanged) {
      enriched[key] = tool;
    } else {
      enriched[key] = {
        ...tool,
        ...(descriptionChanged ? { description: view.description } : {}),
        ...(argsChanged ? { args } : {}),
      };
    }
  }
  return enriched;
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
