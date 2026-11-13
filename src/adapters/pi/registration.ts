/**
 * Pi registration boundary.
 *
 * The module that turns a host-agnostic `ComposedResult` into the three
 * inputs pi consumes when it registers the extension:
 *
 *  - `commands` — the composed slash-command contributions become pi
 *    `registerCommand` registrations (`buildPiCommandRegistrationPlan`).
 *  - `tools` — the composed `tool.definition` contributions run at the
 *    registration boundary (`applyToolDefinitionContributions`), enriching
 *    the tool arguments' descriptions (e.g. the subagent-prompt hint)
 *    before pi registers the tools.  pi has no native `tool.definition`
 *    event, so the OpenCode chain is applied here instead.  The delegation
 *    gate is enforced separately on pi's native `tool_call` event (see
 *    `event keys`), so the tools stay policy-free (the gate belongs to the
 *    path, not the mechanism).
 *  - `event keys` — the resident, gate and settle event keys this
 *    extension registers, each paired with the handler the wiring produced
 *    (`registerPiHandlers`).  The gate keys register only when the
 *    composition contributes a delegation gate, and the settle keys only
 *    when it contributes a settle handler.
 *
 * @module
 */

import type { ComposedResult } from "../../core/compose.js";
import type { WorkPermit } from "../../core/lifecycle/index.js";
import {
  collectToolDefinitionChanges,
  createToolDefinitionView,
  runToolDefinitionContributions,
} from "../../core/tool-definition.js";
import type {
  ToolContribution,
  ToolDefinitionContribution,
} from "../../core/unit.js";
import { log } from "../../utils/logger.js";
import type {
  ExtensionAPI,
  PiCommandContext,
  PiEventHandlers,
} from "./types.js";

// ---------------------------------------------------------------------------
// Tool-definition application
// ---------------------------------------------------------------------------

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
 * The enhancement is asynchronous because a contributor's `handle` may
 * return a promise; the host awaits the whole chain before writing back.
 *
 * @param tools - The composed tool contributions keyed by name.
 * @param contributions - The composed `tool.definition` enhancers.
 * @returns The tools with their argument descriptions enriched.
 */
export async function applyToolDefinitionContributions(
  tools: Record<string, ToolContribution>,
  contributions: ToolDefinitionContribution[],
): Promise<Record<string, ToolContribution>> {
  // No enhancers (a profile without the subagent-prompt hook unit) → pass
  // the tools through unchanged.
  if (contributions.length === 0) return tools;

  const enriched: Record<string, ToolContribution> = {};
  for (const [key, tool] of Object.entries(tools)) {
    const view = createToolDefinitionView(
      tool.name,
      tool.description,
      tool.args,
    );
    await runToolDefinitionContributions(view, contributions);
    const changes = collectToolDefinitionChanges(
      view,
      tool.description,
      tool.args,
    );

    // Write the mutated per-argument descriptions back into a fresh tool
    // only when something changed; untouched arguments keep their exact
    // identity.
    const argsChanged = Object.keys(changes.args).length > 0;
    let args = tool.args;
    if (argsChanged) {
      const originalArgs = tool.args ?? {};
      const nextArgs: Record<string, unknown> = {};
      for (const [argName, schema] of Object.entries(originalArgs)) {
        nextArgs[argName] =
          argName in changes.args
            ? {
                ...(schema as Record<string, unknown>),
                description: changes.args[argName],
              }
            : schema;
      }
      args = nextArgs;
    }

    const { description } = changes;
    if (!argsChanged && description === undefined) {
      enriched[key] = tool;
    } else {
      enriched[key] = {
        ...tool,
        ...(description !== undefined ? { description } : {}),
        ...(argsChanged ? { args } : {}),
      };
    }
  }
  return enriched;
}

// ---------------------------------------------------------------------------
// Command slot assembly
// ---------------------------------------------------------------------------

/** One pi `registerCommand` registration assembled from a contribution. */
interface PiCommandRegistration {
  /** Command name (invocation name, e.g. `"go"`). */
  name: string;
  /** Command description surfaced by pi's command list. */
  description: string;
  /**
   * Whether the command replaces the current pi session, carrying the
   * contribution's own `replacesSession` claim.  The entry point admits
   * such a command as a control operation.
   */
  replacesSession: boolean;
  /** The `(args, ctx, permit)` handler pi invokes for the command. */
  handler(
    args: string,
    ctx: PiCommandContext,
    permit?: WorkPermit,
  ): Promise<void>;
}

/**
 * Assemble the pi `registerCommand` registrations from the composed
 * commands slot.
 *
 * The handler resolves the session id from pi's command context
 * (`ctx.sessionManager.getSessionId()`) and forwards the raw arguments
 * string into the host-agnostic `CommandInput`, mirroring the OpenCode
 * adapter's command routing.  Binding the command context to the session
 * contexts is the wiring layer's job, inside the permit.
 *
 * @param commands - The composed command contributions, keyed by name.
 * @returns The pi command registrations (empty for an empty slot).
 */
export function buildPiCommandRegistrationPlan(
  commands: ComposedResult["commands"],
): PiCommandRegistration[] {
  return Object.values(commands).map((contribution) => ({
    name: contribution.name,
    description: contribution.description,
    replacesSession: contribution.replacesSession === true,
    handler: async (args, ctx, permit) => {
      const sessionID = ctx?.sessionManager?.getSessionId() ?? "";
      await contribution.handle(
        {
          command: contribution.name,
          sessionID,
          arguments: args,
        },
        permit,
      );
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
const PI_RESIDENT_EVENT_KEYS = [
  "session_start",
  "session_shutdown",
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
const PI_SETTLE_EVENT_KEYS = [
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
const PI_GATE_EVENT_KEYS = ["tool_call"] as const;

/** Any pi event key this extension registers. */
type PiEventKey =
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
  session_shutdown: (handlers) => handlers.sessionShutdown,
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
 * The handlers come from the prepared start (`preparePiStart`); this
 * function owns the key → handler pairing and the registration order.  A
 * profile that composes no delegation gate registers no gate key, and a
 * profile that composes no settle handler registers no settle key, so
 * each feature stays fully inert on its own.  Registration is deliberately
 * not error-tolerant: pi's event surface is the extension's only
 * attachment point, so a broken registration must surface at load time
 * rather than leave the session silently unwired.
 *
 * @param pi - pi ExtensionAPI instance.
 * @param handlers - The handlers of the prepared start.
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
    log.info({
      hook: "subagent-tool",
      event: "events_registered",
      events: [...PI_GATE_EVENT_KEYS],
    });
    for (const event of PI_GATE_EVENT_KEYS) {
      on(event, GATE_HANDLERS[event](handlers));
    }
  } else {
    log.info({
      hook: "subagent-tool",
      event: "events_skipped",
      reason: "feature-disabled",
    });
  }
  if (!handlers.hasSettledHandlers) {
    log.info({
      hook: "loop",
      event: "events_skipped",
      reason: "feature-disabled",
    });
    return;
  }
  log.info({
    hook: "loop",
    event: "events_registered",
    events: [...PI_SETTLE_EVENT_KEYS],
  });
  for (const event of PI_SETTLE_EVENT_KEYS) {
    on(event, SETTLE_HANDLERS[event](handlers));
  }
}
