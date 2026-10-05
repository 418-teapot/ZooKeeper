/**
 * Pi event-key adapter.
 *
 * The only module that understands pi's event keys.  Given the
 * host-agnostic `ComposedResult` produced by `composeProfile`, it builds
 * the handlers and registration inputs pi consumes — the `tool_result`,
 * `context` and `message_end` event handlers, the command registrations,
 * and the tool set after its registration-boundary processing:
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
 *  - `message_end` — assistant text parts run through the composed
 *    text-finalization contributions (`buildPiMessageEndHandler`); a
 *    changed part is returned as a shallow-copied message, an unchanged
 *    message as `undefined`.
 *  - `commands` — the composed slash-command contributions become pi
 *    `registerCommand` registrations (`buildPiCommandRegistrationPlan`).
 *    Command chat notifications flow through the single base pi tool
 *    host's in-session `appendEntry` channel (`zoo-notice` custom
 *    entries) — persistent, rendered by the entry renderer, and never
 *    part of the LLM context.
 *  - `tools` — the composed `tool.definition` contributions run at the
 *    registration boundary (`applyToolDefinitionContributions`),
 *    enriching the tool arguments' descriptions (e.g. the subagent-prompt
 *    hint) before pi registers the tools — pi has no native
 *    `tool.definition` event, so the OpenCode chain is applied here
 *    instead.  The delegation gate is enforced separately on pi's native
 *    `tool_call` event (see `event keys`), so the tools stay policy-free
 *    (the gate belongs to the path, not the mechanism).
 *  - `event keys` — the resident, gate and settle event keys this
 *    extension registers, each paired with the handler the wiring
 *    produced (`registerPiHandlers`); the gate keys register only when
 *    the composition contributes a delegation gate, and the settle keys
 *    only when it contributes a settle handler.
 *
 * pi event and message shapes are type-only imports from the pi package
 * (see `src/adapters/pi/types.ts`); the transcript union and narrowed
 * handler contexts stay local there.  No runtime pi import exists.
 *
 * @module
 */

import type {
  ExtensionAPI,
  PiAgentMessage,
  PiCommandContext,
  PiContentPart,
  PiContextEvent,
  PiContextHandlerContext,
  PiContextResult,
  PiEventHandlers,
  PiImagePart,
  PiMessageEndContext,
  PiMessageEndEvent,
  PiMessageEndResult,
  PiTextPart,
  PiToolResultContext,
  PiToolResultEvent,
  PiToolResultResult,
} from "./adapters/pi/types.js";
import { setModelLimit } from "./core/context/model-limits.js";
import type {
  ComposedResult,
  TextCompleteContribution,
  TextCompleteInput,
  TextCompleteOutput,
  ToolArgDefinition,
  ToolContribution,
  ToolDefinitionContribution,
  ToolDefinitionView,
} from "./core/slots.js";
import { loadHtmlConverter } from "./core/webfetch/native.js";
import type { HtmlConverter } from "./core/webfetch/pipeline.js";
import { log } from "./utils/logger.js";

// Re-export the pi duck types (declared in adapters/pi/types.js) so
// consumers can import the event shapes alongside the builders.
export type {
  PiAgentMessage,
  PiAssistantMessage,
  PiCommandContext,
  PiContentPart,
  PiContextEvent,
  PiContextHandlerContext,
  PiContextResult,
  PiImagePart,
  PiMessageEndContext,
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
// Native fetch converter
// ---------------------------------------------------------------------------

/**
 * Load the native HTML→Markdown converter for the fetch tool.
 *
 * Fail-closed in the pi host adapter: when the addon is unavailable
 * (wrong platform, ABI mismatch, not built) the core loader returns
 * `null`, a single warn is logged (`converter_unavailable`), and the fetch
 * tool unit receives no converter — so `fetch` is not registered at all
 * (matching the null-profile principle: a capability that cannot run
 * contributes nothing).
 *
 * @param loadConverter - Loader for the native converter. Defaults to
 *   {@link loadHtmlConverter}; tests inject a stub.
 * @returns The converter, or `null` when unavailable.
 */
export function loadPiHtmlConverter(
  loadConverter: () => HtmlConverter | null = loadHtmlConverter,
): HtmlConverter | null {
  const converter = loadConverter();
  if (converter === null) {
    log("fetch-tool", "converter_unavailable", "", undefined, "warn", {});
    return null;
  }
  return converter;
}

// ---------------------------------------------------------------------------
// Tool-definition application
// ---------------------------------------------------------------------------

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
  // No enhancers (a profile without the subagent-prompt hook unit) → pass
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
 * Build the pi `message_end` handler from the composed text-finalization
 * contributions.
 *
 * pi fires `message_end` after a message is finalized; the handler
 * inspects assistant messages and runs every text-finalization
 * contribution (in registration order) over each text part, mirroring
 * how the OpenCode adapter consumes the same slot.  Contributions mutate
 * the `output.text` in place (e.g. stripping model-imitated `[mN] `
 * echoes).  Thinking and tool-call parts are left untouched.  When no
 * text part changes, `undefined` is returned so pi keeps the original
 * message; otherwise a shallow copy with the rewritten text parts is
 * returned.  The input message is never mutated.
 *
 * @param textComplete - The composed text-finalization contributions.
 * @returns The `message_end` event handler.
 */
export function buildPiMessageEndHandler(
  textComplete: TextCompleteContribution[],
): (
  event: PiMessageEndEvent,
  ctx: PiMessageEndContext,
) => PiMessageEndResult | undefined {
  return (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") {
      return undefined;
    }

    const sessionID = ctx?.sessionManager?.getSessionId() ?? "";

    let changed = false;
    const newContent = message.content.map((part, index) => {
      if (part.type !== "text") {
        return part;
      }

      const input: TextCompleteInput = {
        sessionID,
        messageID: "",
        partID: String(index),
      };
      const output: TextCompleteOutput = { text: part.text };
      for (const contribution of textComplete) {
        try {
          contribution.handle(input, output);
        } catch (err) {
          log("plugin", "handler_crashed", sessionID, String(index), "error", {
            handler: contribution.name,
            error: String(err),
          });
        }
      }

      if (output.text !== part.text) {
        changed = true;
        return { ...part, text: output.text };
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

// ---------------------------------------------------------------------------
// Event-key registration
// ---------------------------------------------------------------------------

/**
 * The pi event keys registered on every session bind.
 *
 * The keys are the registration contract with pi; holding them here (and
 * not in the extension entry) is what makes this module the single place
 * that knows pi's event names.
 */
export const PI_RESIDENT_EVENT_KEYS = [
  "session_start",
  "before_agent_start",
  "resources_discover",
  "tool_result",
  "context",
  "message_end",
  "session_tree",
] as const;

/**
 * The pi event keys registered only when the profile composes a settle
 * handler (`PiEventHandlers.hasSettledHandlers`).
 */
export const PI_SETTLE_EVENT_KEYS = [
  "agent_end",
  "agent_before_settle",
  "agent_settled",
  "ui_prompt_start",
  "ui_prompt_end",
] as const;

/**
 * The pi event keys registered only when the profile composes a
 * delegation gate (`PiEventHandlers.hasGateHandlers`).
 */
export const PI_GATE_EVENT_KEYS = ["tool_call"] as const;

/** Any pi event key this extension registers. */
export type PiEventKey =
  | (typeof PI_RESIDENT_EVENT_KEYS)[number]
  | (typeof PI_GATE_EVENT_KEYS)[number]
  | (typeof PI_SETTLE_EVENT_KEYS)[number];

/** A handler as `pi.on` receives it; each key's real shape is declared
 * structurally on `ExtensionAPI`. */
type PiEventHandler = (...args: never[]) => unknown;

/**
 * The handler bound to each resident event key.
 *
 * The `Record` over the key union keeps the table complete: adding a key
 * to {@link PI_RESIDENT_EVENT_KEYS} without its handler fails to compile.
 */
const RESIDENT_HANDLERS: Record<
  (typeof PI_RESIDENT_EVENT_KEYS)[number],
  (handlers: PiEventHandlers) => PiEventHandler
> = {
  session_start: (handlers) => handlers.sessionStart,
  before_agent_start: (handlers) => handlers.beforeAgentStart,
  resources_discover: (handlers) => handlers.resourcesDiscover,
  tool_result: (handlers) => handlers.toolResult,
  context: (handlers) => handlers.contextHandler,
  message_end: (handlers) => handlers.messageEnd,
  session_tree: (handlers) => handlers.sessionTree,
};

/** The handler bound to each settle event key. */
const SETTLE_HANDLERS: Record<
  (typeof PI_SETTLE_EVENT_KEYS)[number],
  (handlers: PiEventHandlers) => PiEventHandler
> = {
  agent_end: (handlers) => handlers.agentEnd,
  agent_before_settle: (handlers) => handlers.beforeSettle,
  agent_settled: (handlers) => handlers.agentSettled,
  ui_prompt_start: (handlers) => handlers.uiPromptStart,
  ui_prompt_end: (handlers) => handlers.uiPromptEnd,
};

/** The handler bound to each gate event key. */
const GATE_HANDLERS: Record<
  (typeof PI_GATE_EVENT_KEYS)[number],
  (handlers: PiEventHandlers) => PiEventHandler
> = {
  tool_call: (handlers) => handlers.toolCall,
};

/**
 * Register the built handlers on pi under their event keys.
 *
 * The handlers come from the host wiring (`buildPiHandlers`); this
 * function owns the key → handler pairing and the registration order.  A
 * profile that composes no delegation gate registers no gate key, and a
 * profile that composes no settle handler registers no settle key, so
 * each feature stays fully inert on its own.  Registration is deliberately
 * not error-tolerant: pi's event surface is the extension's only
 * attachment point, so a broken registration must surface at load time
 * rather than leave the session silently unwired.
 *
 * @param pi - pi ExtensionAPI instance.
 * @param handlers - The handlers built by `buildPiHandlers`.
 */
export function registerPiHandlers(
  pi: ExtensionAPI,
  handlers: PiEventHandlers,
): void {
  // `on` is overloaded per event key and cannot resolve a runtime-valued
  // key; the tables above pair every key with its handler, so only this
  // call needs the broader signature.
  const on = (event: PiEventKey, handler: PiEventHandler): void => {
    (pi.on as unknown as (event: string, handler: PiEventHandler) => void)(
      event,
      handler,
    );
  };
  for (const event of PI_RESIDENT_EVENT_KEYS) {
    on(event, RESIDENT_HANDLERS[event](handlers));
  }
  if (handlers.hasGateHandlers) {
    log("subagent-tool", "events_registered", "", undefined, "info", {
      events: [...PI_GATE_EVENT_KEYS],
    });
    for (const event of PI_GATE_EVENT_KEYS) {
      on(event, GATE_HANDLERS[event](handlers));
    }
  } else {
    log("subagent-tool", "events_skipped", "", undefined, "info", {
      reason: "feature-disabled",
    });
  }
  if (!handlers.hasSettledHandlers) {
    log("loop", "events_skipped", "", undefined, "info", {
      reason: "feature-disabled",
    });
    return;
  }
  log("loop", "events_registered", "", undefined, "info", {
    events: [...PI_SETTLE_EVENT_KEYS],
  });
  for (const event of PI_SETTLE_EVENT_KEYS) {
    on(event, SETTLE_HANDLERS[event](handlers));
  }
}
