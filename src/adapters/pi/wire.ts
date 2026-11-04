/**
 * Pi host wiring — composition, registration, and the loop engine.
 *
 * Turns the `zoo` config into the pi-facing wiring: the profile-driven
 * composition (`buildPiContributions`), the session → agent resolver
 * (`buildPiResolveAgent`), the profile skill-directory lookup
 * (`collectSkillPaths`), and the registration boundary itself
 * (`buildPiHandlers`) — the host services the lifecycle kernel creates (see
 * `services.ts`: the session contexts, the adapter, the tool host built on
 * the contexts, the todo and profile catalogs, the tool baselines, the
 * fleet surface and the switch surface), the composed contributions, the
 * loop engine, and pi's `registerTool` / `registerCommand` /
 * `registerEntryRenderer` calls.
 *
 * The entry point activates the extension scope BEFORE composing, so the
 * composition receives extension-scope ports the kernel owns.  Session
 * scopes come into existence only when an event names a session.
 *
 * The fourteen event handlers themselves are built by
 * `createPiEventHandlers` (see `handlers.ts`); this module only supplies
 * their wiring surfaces.
 *
 * The pieces the composition and the loop engine need are lifecycle
 * services too (see `services.ts`): the `composition` service composes the
 * profile over the extension-scope ports, and the `loop` service builds the
 * engine over the composed settle strategies.  Both `buildPiHandlers` and
 * the per-session scopes read them from the extension scope, so no host
 * code has to hand a session its loop resources.
 *
 * @module
 */

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import {
  applyToolDefinitionContributions,
  buildPiCommandRegistrationPlan,
  type HtmlConverterLoader,
  loadPiHtmlConverter,
  registerPiHandlers,
} from "../../compose-pi.js";
import { capabilityBindings } from "../../core/bindings.js";
import {
  configCapabilities,
  parseCommonConfig,
} from "../../core/capabilities.js";
import { assemble } from "../../core/compose.js";
import { parseAgentColors, parseAskConfig } from "../../core/config-parse.js";
import type { HostAdapter } from "../../core/context/lens.js";
import {
  type ContextRuntime,
  createContextRuntime,
} from "../../core/context/runtime.js";
import type { CleanupReport, WorkPermit } from "../../core/lifecycle/index.js";
import { ORCHESTRATOR_AGENT_NAME } from "../../core/orchestrator.js";
import { parseSkillPermissions } from "../../core/permissions/skill-permissions.js";
import type { Capabilities } from "../../core/ports/index.js";
import type { SwitchHost } from "../../core/ports/switch.js";
import type { ToolHost } from "../../core/ports/tool-host.js";
import {
  sessionAgentRegistry,
  sessionAgentResource,
} from "../../core/session/agent.js";
import {
  contextSessionResources,
  createSessionResourceCatalog,
} from "../../core/session/resources.js";
import { scanSkillDirectories } from "../../core/skills.js";
import type { SubagentDriver } from "../../core/subagent/driver.js";
import type { SubagentRun } from "../../core/subagent/registry.js";
import { findByChildSession } from "../../core/subagent/registry.js";
import { todoSourceFromStore } from "../../core/todo/source.js";
import type { ToolContribution } from "../../core/unit.js";
import { REGISTRY } from "../../registry.js";
import { log } from "../../utils/logger.js";
import { createPiAdapter } from "./adapter.js";
import { loadAgentsJson } from "./agent-models.js";
import { presentAskForm } from "./ask-form.js";
import { createPiEventHandlers } from "./handlers.js";
import { createPiHandoffTarget, type PiCommandCtx } from "./handoff-target.js";
import type { PiLifecycleContext } from "./lifecycle.js";
import {
  createPiLifecycleWiring,
  type PiSessionWorkRunner,
  SDK_STOP_REASON,
} from "./lifecycle-wiring.js";
import { createPiMessageInjector } from "./message-injector.js";
import { createPiHostServices, type PiContributions } from "./services.js";
import { createPiSubagentDriver } from "./subagent.js";
import {
  createPiHandoffIdentity,
  pendingSwitchPrimary,
} from "./switch-host.js";
import { mergeTerminalToolDetails, truecolorWrap } from "./terminal-details.js";
import {
  buildSubagentCardRenderer,
  buildTodoCardRenderer,
} from "./tui/index.js";
import { buildPiNoticeEntryRenderer } from "./tui/notice.js";
import type {
  ExtensionAPI,
  PiCommandContext,
  PiEventHandlers,
} from "./types.js";

// realpathSync follows the symlink to the real module location, so the
// computed skill paths resolve into the project directory even when the
// extension is loaded through pi's auto-discovery symlink.
const __dirname = dirname(realpathSync(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Profile-driven composition
// ---------------------------------------------------------------------------

/**
 * The explicit facts the pi identity resolver reads.
 *
 * Every fact names a session-owning scope the host knows directly.  None of
 * them is ambient: the resolver never infers an identity from whichever
 * event happened to run last, so two sessions that interleave cannot
 * exchange identities.
 */
export interface PiAgentSources {
  /**
   * The agent this runtime's factory fixed, or `undefined` in a main
   * runtime.  A sub-session runtime is built for exactly one delegation, so
   * its fixed agent answers every session of that runtime — including
   * events that precede the run's first progress report.
   */
  fixedAgent?: string;
  /**
   * The replacement target a pending switch queued, or `undefined` when no
   * replacement awaits its first turn.  Read lazily: the replacement
   * session's bind-time events run before any later drain clears it.
   */
  pendingPrimary?: () => string | undefined;
  /**
   * The orchestrator the selection resolved, or `undefined` when it
   * resolved none.  Read lazily: the resolver is built before the planner
   * runs.  This is the main-session answer.
   */
  orchestrator: () => string | undefined;
}

/**
 * Build the session → agent resolver for the pi host.
 *
 * The answer comes from explicit sources only, in this order:
 *  (a) the shared session agent registry — an existing binding wins;
 *  (b) the fixed agent of this runtime (a sub-session runtime built for one
 *      delegation) — the answering source for a sub-session's own events;
 *  (c) reverse lookup by session id in the subagent run registry — a
 *      session recorded as some run's `childSession` is driven by that
 *      run's delegated agent;
 *  (d) the pending replacement target of a switch that has not completed
 *      its first turn yet;
 *  (e) the orchestrator the selection resolved — the main-session answer.
 *
 * Every answer except an absent orchestrator is bound into the shared
 * registry, so later lookups hit it in O(1).  A memo never goes stale: a
 * childSession belongs to exactly one run, a run's `agent` is fixed at
 * creation, a runtime's fixed agent outlives the runtime, and a pending
 * replacement target is published by the switch that created the session.
 * With no source answering, the session resolves to `undefined`
 * (fail-closed, unbound).
 *
 * @param sources - The explicit identity facts of this runtime.
 * @returns The resolver handed to `Capabilities.resolveAgent`.
 */
export function buildPiResolveAgent(
  sources: PiAgentSources,
): (sessionID: string) => string | undefined {
  return (sessionID: string): string | undefined => {
    const known = sessionAgentRegistry.resolve(sessionID);
    if (known !== undefined) return known;
    const fixed = sources.fixedAgent;
    if (fixed !== undefined) {
      sessionAgentRegistry.bind(sessionID, fixed);
      return fixed;
    }
    const run = findByChildSession(sessionID);
    if (run !== undefined) {
      sessionAgentRegistry.bind(sessionID, run.agent);
      return run.agent;
    }
    const pending = sources.pendingPrimary?.();
    if (pending !== undefined) {
      sessionAgentRegistry.bind(sessionID, pending);
      return pending;
    }
    const orchestrator = sources.orchestrator();
    if (orchestrator === undefined) return undefined;
    sessionAgentRegistry.bind(sessionID, orchestrator);
    return orchestrator;
  };
}

/**
 * Compose the profile-driven contributions for pi.
 *
 * The full registry is fed to the assembly pipeline — pi composes every
 * category and consumes the agent, skill, after-exec, transform, and
 * command slots (the `unknown_unit` warning fires when a profile name
 * has no matching registry unit).  `Capabilities` are adapted to the pi host:
 * `client` is empty, `directory` is the process working directory,
 * `resolveAgent` identifies each session through the shared
 * session agent registry (subagent child sessions → their delegated
 * agent, the root session → the orchestrator the selection resolved;
 * see `buildPiResolveAgent`), and the host adapter / tool host are taken
 * from `hostDeps` when provided (the entry point supplies the
 * kernel-created adapter and tool host).
 *
 * This host also declares the product's orchestrator role
 * (`ORCHESTRATOR_AGENT_NAME`) to the planner: a profile that cannot
 * provide it as a primary is invalid and loads nothing.  When the
 * selection resolves an orchestrator, the shared session resolver reports
 * it for a session no other explicit source answers; an unresolved role
 * leaves every unbound session unresolved (fail-closed).
 *
 * Exported for unit testing — `zookeeperPi` wires this with the config
 * loaded from disk.
 *
 * @param zooConfig - The `zoo` section of config.toml.
 * @param hostDeps - Optional host adapter and tool host (the entry point
 *   passes the extension-scope services the kernel created).
 * @returns The parsed profile (or `null`), the composed result, and the
 *   parsed validation limits.
 */
export function buildPiContributions(
  zooConfig: any,
  hostDeps?: {
    /**
     * The context records of this extension instance.  The entry point
     * passes the instance's own runtime; a composition built without one
     * (a unit test) gets a private one, so two compositions never share
     * session state.
     */
    contextRuntime?: ContextRuntime;
    adapter?: HostAdapter<unknown>;
    toolHost?: ToolHost;
    switchHost?: SwitchHost;
    /** The command context of one session, or undefined when it has none. */
    getCommandCtx?: (sessionID: string) => PiCommandCtx | null | undefined;
    /**
     * The agent this runtime's factory fixed (a sub-session runtime), or
     * absent in a main runtime.  Every session of a sub-session runtime is
     * the delegation it was built for.
     */
    fixedAgent?: string;
    /**
     * Host user-message injector for the `/debug` command (only supplied
     * by the real pi entry point).  Undefined without it — `/debug`
     * reports the Case was created but could not auto-start.
     */
    messageInjector?: Partial<Capabilities>["messageInjector"];
    /**
     * Host subagent driver (only supplied by the real pi entry point).
     * Undefined without it — the subagent tool unit then contributes no
     * tools (fail-closed, matching OpenCode).
     */
    subagentDriver?: SubagentDriver;
    /**
     * Host subagent transcript-card renderer (only supplied by the real pi
     * entry point).  Undefined without it — the subagent tool stays
     * text-only.
     */
    subagentRenderer?: Partial<Capabilities>["subagentRenderer"];
    /**
     * todo port the composition reads (only on the pi host).  Built by the
     * host's extension-scope service over its own transcript scan; it is a
     * routing catalog, so the todo tool unit and the progress hooks reach
     * the store of the session a call names without holding one session's
     * state.  Undefined without it — the todo tool unit contributes no
     * tools (fail-closed, the subagent precedent), so `todo` never
     * registers on a host that cannot restore todo state from its
     * transcript.
     */
    todoStore?: Partial<Capabilities>["todoStore"];
    /**
     * Host todo transcript-card renderer (only supplied by the real pi
     * entry point).  Undefined without it — the todo tool stays
     * text-only.
     */
    todoRenderer?: Partial<Capabilities>["todoRenderer"];
    /**
     * Lazily supplies the host's full untrimmed tool-name baseline for
     * subagent capability computation.  The baseline cannot be captured at
     * extension-load time (pi forbids calling action methods then), so the
     * supplier is invoked lazily on first subagent execution and cached.
     */
    subagentBaseline?: () => string[] | undefined;
    /**
     * Called after every subagent run-registry mutation so the entry point
     * can nudge the parent session's fleet widget to re-render (the widget
     * reads the process-level registry directly on render).  Undefined on
     * hosts without a fleet widget.
     */
    onSubagentRunChange?: (sessionID: string) => void;
    /**
     * Test seam: workspace root the auto-debug strategy scans for Cases.
     * Defaults to the process working directory on the real host.
     */
    directory?: string;
    /** Test seam: `zdebug` runner for the auto-debug strategy. */
    zdebugExec?: Partial<Capabilities>["zdebugExec"];
    /**
     * Native HTML→Markdown converter loader for the fetch tool (only
     * supplied by the real pi entry point).  The assembly probes it once,
     * before selection, and only for an active profile (a `null` profile
     * selects nothing, so it is never probed); the loaded converter is
     * bound by value, and undefined (or a `null` probe result) declares no
     * `htmlConverter`, so the fetch tool unit is skipped (fail-closed,
     * matching OpenCode).
     */
    loadHtmlConverter?: HtmlConverterLoader;
    /**
     * Host head truncator for the fetch tool (only supplied by the real pi
     * entry point).  Undefined without it — the fetch tool unit is skipped
     * (fail-closed, matching OpenCode).
     */
    truncateHead?: Partial<Capabilities>["truncateHead"];
    /**
     * Host form presentation for the ask tool (only supplied by the real pi
     * entry point).  Undefined without it — the ask tool unit contributes
     * no tools (fail-closed, matching OpenCode).
     */
    askFormHost?: Partial<Capabilities>["askFormHost"];
  },
  rawConfig?: any,
): PiContributions {
  const common = parseCommonConfig(zooConfig, rawConfig);
  const { modeProfile, agentModes, agentPermissions, limits } = common;
  // The ask-tool timeout (seconds), parsed fail to skip.  Injected only
  // here (pi host) — the ask tool is not registered on OpenCode.
  const askConfig = parseAskConfig(zooConfig);

  // The orchestrator the planner resolves, read lazily by the session
  // resolver: the resolver is built before the planning pass runs.
  let selectedOrchestrator: string | undefined;
  // The one session → agent resolver of this runtime.  Event handlers, the
  // subagent tool's caller resolution and the primary trim all read it, so
  // every surface answers a session the same way.
  const resolveAgent = buildPiResolveAgent({
    ...(hostDeps?.fixedAgent === undefined
      ? {}
      : { fixedAgent: hostDeps.fixedAgent }),
    pendingPrimary: pendingSwitchPrimary,
    orchestrator: () => selectedOrchestrator,
  });
  // The caller resolver the delegation gate and the subagent tool read: the
  // same session resolver, attributed by the session id the call names.
  const resolveCallerAgent = async (
    sessionID: string,
  ): Promise<string | undefined> => resolveAgent(sessionID);

  // Probe the native HTML→Markdown converter BEFORE the selection pass,
  // and only for an active profile: a `null` profile selects nothing, so
  // probing there would only emit a spurious `converter_unavailable`
  // warning.  The probe runs once, at assembly time: a `null` result
  // (missing addon, wrong platform, ABI mismatch) declares no
  // `htmlConverter` key, so the fetch tool unit's `needs` are unmet and the
  // planner skips it.  Availability is decided here and never by a runtime
  // fetch failure.
  const htmlConverter =
    modeProfile === null ? null : (hostDeps?.loadHtmlConverter?.() ?? null);

  // The context records of this composition: one runtime per plugin
  // instance, so two instances never share state.
  const contextRuntime = hostDeps?.contextRuntime ?? createContextRuntime();

  const bindings = capabilityBindings({
    values: {
      ...configCapabilities(common),
      askTimeoutSeconds: askConfig?.timeoutSeconds,
      switchHost: hostDeps?.switchHost,
      // The pi subagent driver (in-process SDK session execution).  Only the
      // real pi entry point supplies one; unit tests and other hosts omit it
      // so the subagent tool never registers (fail-closed).
      subagentDriver: hostDeps?.subagentDriver,
      // The pi subagent transcript-card renderer.  Only the real pi entry
      // point supplies one; without it the tool stays text-only.
      subagentRenderer: hostDeps?.subagentRenderer,
      // The todo port (pi host only).  The extension-scope service provides
      // a routing catalog; without it the todo tool unit is skipped
      // (fail-closed).
      todoStore: hostDeps?.todoStore,
      // The todo read port the progress hooks consume.  pi has no SDK client
      // to read todos from, so the port is bound to the same catalog the
      // todo tool uses.  The catalog's session stores are released with
      // their session scopes, so an unbound session is read through the
      // transcript without being cached.  Absent without a catalog: the
      // nudge hooks keep firing without the todo reminder, and the
      // continuation hook degrades to an empty list (fail-closed in both
      // cases).
      todoSource:
        hostDeps?.todoStore === undefined
          ? undefined
          : todoSourceFromStore(hostDeps.todoStore),
      // The pi todo transcript-card renderer.  Only the real pi entry
      // point supplies one; without it the tool stays text-only.
      todoRenderer: hostDeps?.todoRenderer,
      // The full untrimmed tool baseline for subagent capability
      // computation, passed through as a thunk: the unit invokes it inside
      // `execute`, which is always post-load, so the supplier (pi's
      // `getActiveTools`, forbidden during extension loading) never runs at
      // assembly time.
      subagentBaseline: hostDeps?.subagentBaseline,
      // The per-agent model map for subagent sessions, materialised by the
      // installer into `~/.pi/agent/agents.json` as `{provider, model}`
      // pairs (mapped values are concatenated `"provider/model"` strings).
      // Read once at extension-load time (fail-closed to empty when
      // missing/invalid); strict mode: this map is the sole model source —
      // the subagent tool errors (never inherits or falls back) when the
      // target agent's entry is absent.
      subagentModels: loadAgentsJson(),
      // Registry-write notification: the tool layer calls this after every
      // subagent run start/update/finish so the fleet widget re-renders with
      // the latest registry state.
      onSubagentRunChange: hostDeps?.onSubagentRunChange,
      // The probed converter, bound by value.  `null` here means the addon
      // is unavailable or no profile is active; either way no key is
      // declared.
      htmlConverter: htmlConverter ?? undefined,
      // The host head truncator for the fetch pipeline.  Absent without it
      // (fail-closed, paired with the converter).
      truncateHead: hostDeps?.truncateHead,
      // The ask tool's form host.  Without it the ask tool unit is skipped
      // (fail-closed, so `ask` never registers on OpenCode).
      askFormHost: hostDeps?.askFormHost,
      // pi has no SDK client: the context-pruning transform runs and
      // returns the pruned replacement to pi.  The release notification
      // does not need a client: it posts through the unified pi tool
      // host's `notify` port as a `zoo-notice` appendEntry entry.  The
      // marking producers (dedup / purge-errors) have no
      // user-visible notification on pi.
      zdebugExec: hostDeps?.zdebugExec,
      contextRuntime,
      directory: hostDeps?.directory ?? process.cwd(),
      resolveCallerAgent,
      toolHost: hostDeps?.toolHost,
      // The `/debug` startup injector: sends a model-visible user message
      // into the current session.  Only the real pi entry point supplies it.
      messageInjector: hostDeps?.messageInjector,
      // Native pi host adapter.  The pi adapter names no session of its
      // own: the entry paths pass the session id to the transform.  A
      // unit test that only inspects the composed shape gets the same
      // adapter.
      adapter: hostDeps?.adapter ?? createPiAdapter(),
      // The `/go` handoff target.  `getCommandCtx` resolves the command
      // context of the parentage session the command handler bound when it
      // was admitted.  Built from host facts only — the executor agent
      // travels with each handoff call, so the target is the same for
      // every selection.
      handoffTarget: createPiHandoffTarget({
        getCommandCtx: (sessionID) => hostDeps?.getCommandCtx?.(sessionID),
        identity: createPiHandoffIdentity(),
      }),
    },
    selected: {
      // The shared session → agent resolver, built above so the entry
      // point can expose the same function.
      resolveAgent: () => resolveAgent,
    },
  });
  const { selection, composed } = assemble({
    profile: modeProfile,
    units: REGISTRY,
    bindings,
    agentModes,
    // The product's orchestrator role.  The planner decides whether the
    // enabled profile can provide it; this host holds no fallback.
    orchestrator: ORCHESTRATOR_AGENT_NAME,
  });

  // Publish the resolved orchestrator to the shared resolver.  An
  // unresolved role stays `undefined`, so an unbound session fails closed
  // instead of borrowing another agent's prompt.
  selectedOrchestrator = selection.orchestrator;

  return {
    profile: modeProfile,
    composed,
    limits,
    agentModes,
    agentPermissions,
    resolveAgent,
    resolveCallerAgent,
    contextRuntime,
  };
}

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

/**
 * Collect the absolute paths of the profile-listed skill directories.
 *
 * pi's `loadSkillsFromDir` discovers a skill when a directory contains
 * SKILL.md.  A skill registers only when its directory name appears in
 * `profileSkills` AND the directory actually exists under skills/
 * (mirroring the OpenCode adapter's fail-closed `registerSkills`).  The
 * scan itself is shared with OpenCode (`scanSkillDirectories`); this
 * wrapper only supplies the base directory resolved from pi's module
 * location.
 *
 * @param profileSkills - Skill directory names declared by the profile.
 * @returns Absolute paths of the existing, profile-listed directories.
 */
export function collectSkillPaths(profileSkills: string[]): string[] {
  const skillsDir = resolve(__dirname, "../../../skills");
  return scanSkillDirectories(skillsDir, profileSkills);
}

// ---------------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------------

/** The result shape pi's tool bridge returns to the host. */
export interface PiToolBridgeResult {
  /** The tool's model-facing content parts. */
  content: { type: "text"; text: string }[];
  /** The persisted structured payload. */
  details: Record<string, unknown>;
}

/**
 * Build pi's `execute` bridge for one composed tool.
 *
 * Every call is admitted for the session its own tool context names: the
 * whole execution runs under the issued permit, so a call that arrives
 * without a session, after the session stopped, or with a cancelled caller
 * runs no tool at all.  The permit's signal replaces pi's native one in the
 * forwarded host context, so the tool stops when the session or the
 * extension stops, and the permit itself is forwarded for tools that need
 * to inspect it.  The context reaches the session contexts only after
 * admission, under the permit's session id.
 *
 * @param tool - The composed tool contribution.
 * @param run - The lifecycle admission surface.
 * @param publish - Binds a tool call's context under its session id.
 * @returns The bridge pi registers for the tool.
 */
export function buildPiToolExecute(
  tool: ToolContribution,
  run: PiSessionWorkRunner,
  publish: (sessionID: string, ctx: unknown) => void,
): (
  toolCallId: unknown,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<PiToolBridgeResult> {
  return async (toolCallId, params, signal, onUpdate, ctx) => {
    // pi's native signal is this call's caller cancellation; it revokes
    // this call's permit only, never another call's.
    const caller = signal instanceof AbortSignal ? signal : undefined;
    const result = await run.runSession(
      ctx,
      async (permit) => {
        // A tool call may be the first event that observes the session
        // (flows without a `session_start`), and every session-scoped
        // reader — the todo transcript scan, the session's fleet ui —
        // resolves the context by session id.
        publish(permit.sessionID, ctx);
        // Forward the native execution surface to the contribution: the
        // tool-call `callId` (the run's registry id for the fleet widget),
        // the `onUpdate` repaint-signal callback, and the permit whose
        // signal replaces pi's native one.  `onUpdate` is a content-free
        // repaint trigger for live tool cards — pi re-renders on any
        // partial result, so a tool such as subagent sends an empty partial
        // rather than streaming text.  The sub-session model is NOT
        // forwarded — strict mode reads the agents.json configured model
        // only (never the parent session's model).  compress / decompress
        // ignore the hostCtx and keep working unchanged.
        //
        // `details` is a write-back slot: a contribution that needs to hand
        // renderers a structured payload (the ask tool's per-question
        // results) assigns it here, and the bridge merges a plain object
        // into the host result's details AFTER execute resolves — merged
        // INTO (never replacing) the bridge's own details, so the run's
        // session path survives.
        const hostCtx: {
          signal?: AbortSignal;
          callId?: string;
          onUpdate?: unknown;
          details?: unknown;
          permit?: WorkPermit;
        } = {
          ...(typeof toolCallId === "string" && toolCallId.length > 0
            ? { callId: toolCallId }
            : {}),
          signal: permit.signal,
          ...(onUpdate !== undefined ? { onUpdate } : {}),
          permit,
        };
        const text = await tool.execute(params, ctx, hostCtx);
        return {
          content: [{ type: "text" as const, text }],
          details: mergeTerminalToolDetails(toolCallId, hostCtx.details),
        };
      },
      caller,
    );
    // A refused call never runs the tool: it reports an empty result in the
    // host's own shape.
    return result ?? { content: [], details: {} };
  };
}

/**
 * Build the inline extension factory ZooKeeper's sub-sessions load.
 *
 * The factory captures the config snapshot of the composition root that
 * built it — it never reads config.toml again — so a sub-session composes
 * the same profile as its parent.  It builds a full handler set for the
 * child runtime, which means a nested sub-session creates its own inline
 * factory in turn.  `onClose` receives the close handle of the lifecycle
 * wiring the factory created, so the driver that owns the run can stop that
 * scope before it disposes the SDK session.
 *
 * @param zooConfig - The `zoo` section of the captured config snapshot.
 * @param rawConfig - The whole captured config root.
 * @param options - The delegated agent, the host's extension file entry and
 *   the close reporter.
 * @returns The factory pi loads into the sub-session runtime.
 */
export function buildPiSubagentExtension(
  zooConfig: any,
  rawConfig: any,
  options: {
    /**
     * The agent this sub-session runtime is built for.  Every session of
     * the runtime is that delegation, so it answers identity directly.
     */
    agent: string;
    /** The host's extension file entry, left out of the sub-session. */
    entryPath?: string;
    /** Receives the close handle of the wiring the factory creates. */
    onClose?: (close: () => Promise<CleanupReport>) => void;
  },
): (pi: ExtensionAPI) => Promise<void> {
  return async (childPi: ExtensionAPI): Promise<void> => {
    registerPiHandlers(
      childPi,
      await buildPiHandlers(zooConfig, childPi, rawConfig, {
        agent: options.agent,
        ...(options.entryPath !== undefined
          ? { entryPath: options.entryPath }
          : {}),
        ...(options.onClose !== undefined
          ? { onLifecycle: options.onClose }
          : {}),
      }),
    );
  };
}

/**
 * Build the pi handlers and register the profile's pi surfaces.
 *
 * Activates the host services (session contexts, adapter, tool host, todo
 * catalog, profile catalog, tool baselines, fleet surface, switch surface)
 * through the lifecycle kernel, which also composes the profile against
 * those extension-scope ports and builds the loop engine when the profile
 * contributes a settle strategy, registers the composed tools / commands /
 * notice renderer with pi, and returns the event handlers over those
 * surfaces.
 *
 * Asynchronous because the extension activation awaits the kernel and the
 * tool-registration boundary awaits the composed `tool.definition`
 * enhancers (a contributor's `handle` may return a promise), so pi's own
 * async extension factory must wait for the tools to be registered.
 *
 * Exported for unit testing — `zookeeperPi` wires this with the config
 * loaded from disk.
 *
 * @param zooConfig - The `zoo` section of config.toml.
 * @param piApi - Optional pi ExtensionAPI instance; without it the
 *   registration-bound and tool-hosting surfaces stay closed (fail-closed)
 *   and no tool, command, or renderer is registered.
 * @param rawConfig - The whole parsed config root (carries the top-level
 *   `agent` table).
 * @param overrides - Optional host options.  The entry path and the
 *   lifecycle reporter are what a sub-session needs from its composition
 *   root; the remaining fields are test seams (a bridge test injects a fake
 *   subagent driver so the registered tool executes without loading the
 *   real pi SDK).
 * @returns A promise of the fourteen handlers plus the registration gates.
 */
export async function buildPiHandlers(
  zooConfig: any,
  piApi?: ExtensionAPI,
  rawConfig?: any,
  overrides?: {
    /** Subagent driver used in place of the real pi SDK driver. */
    subagentDriver?: SubagentDriver;
    /**
     * The agent this runtime is built for.  Set by the inline factory a
     * sub-session loads; absent in the main runtime.
     */
    agent?: string;
    /**
     * Test seam: the per-(session, strategy) reminder-budget store to
     * observe and seed.  Defaults to a fresh store when omitted.
     */
    remindersUsed?: Map<string, Map<string, number>>;
    /**
     * Test seam: workspace root the auto-debug strategy scans for
     * Cases.  Defaults to the process working directory.
     */
    directory?: string;
    /** Test seam: `zdebug` runner for the auto-debug strategy. */
    zdebugExec?: Partial<Capabilities>["zdebugExec"];
    /**
     * Path of this host's extension file entry.  The sub-session resource
     * loader leaves it out, because the child loads ZooKeeper from the
     * inline factory instead.
     */
    entryPath?: string;
    /**
     * Receives the close handle of this handler instance's lifecycle wiring.
     * The subagent driver passes its per-run reporter here, so it can stop
     * the child's extension scope before disposing the SDK session.
     */
    onLifecycle?: (close: () => Promise<CleanupReport>) => void;
    /** Test seam: the instance's context runtime to inspect in place. */
    contextRuntime?: ContextRuntime;
  },
): Promise<PiEventHandlers> {
  // The single pi tool host routes every in-session chat notification
  // (tool prompts, /dcp reports, command failures) through pi's
  // `appendEntry` channel as a `zoo-notice` custom entry — persistent,
  // rendered by the entry renderer, never part of the LLM context (the
  // pi equivalent of v1's ignored noReply message).  `appendEntry` is
  // passed as a value, so it is defensively bound to the API object when
  // present (pi's current implementation is closure-based and works
  // unbound, but a future `this`-dependent implementation would silently
  // break otherwise).  The tool host service (declared below) reads it.
  const appendEntry =
    typeof piApi?.appendEntry === "function"
      ? piApi.appendEntry.bind(piApi)
      : undefined;
  // The per-agent status-bar colors (`[agent.<name>].color`), parsed
  // fail-closed from the whole config root.  Only the `zoo` widget text
  // is colorized below — the tool / command surfaces stay plain.
  const agentColors = parseAgentColors(rawConfig ?? {});
  // The per-agent skill permission rules (`[agent.<name>].permission.skill`),
  // parsed fail-closed from the whole config root.  `resources_discover`
  // filters the contributed skill directories by the active primary's
  // rules; an agent absent from the map (or no primary) contributes
  // unfiltered (default-allow, machinery-off unchanged).
  const skillPermissions = parseSkillPermissions(rawConfig ?? {});
  // Wrap a name in a truecolor ANSI foreground sequence when the agent
  // has a configured color; otherwise return it unchanged (fail-closed).
  // pi's widget Text component preserves ANSI codes and is
  // ANSI-width-aware, so the raw escape sequences survive and render.
  const colorizeAgent = (name: string): string => {
    const hex = agentColors[name];
    if (hex === undefined) return name;
    return truecolorWrap(hex, name);
  };
  // The overlay title for a run: `<agent> · <label>` (the label when the run
  // carries one, otherwise just the agent).  Mirrors the fleet row body so
  // the inspection overlay reads as the same run the widget selected.  The
  // agent name is pre-colorized with the same `[agent.<name>].color` source
  // as the widget (`colorizeAgent`), so the title carries the run's agent
  // color; pi's Text / truncateToWidth / visibleWidth preserve ANSI codes
  // (only the collapse-preview path strips them), so the wrapped name
  // survives the overlay render verbatim.  Unconfigured → the plain name.
  const runTitle = (run: SubagentRun): string => {
    const labelPart =
      run.label !== undefined && run.label.length > 0 ? ` · ${run.label}` : "";
    return `${colorizeAgent(run.agent)}${labelPart}`;
  };
  // Wrap any text in the run's agent truecolor sequence when the agent has a
  // configured color; `undefined` when it does not (the overlay then falls
  // back to its fixed border color — the current default).  Used for the
  // transcript overlay border so it reads as the inspected run's agent color.
  const agentBorderColorize = (
    run: SubagentRun,
  ): ((text: string) => string) | undefined => {
    const hex = agentColors[run.agent];
    if (hex === undefined) return undefined;
    return (text) => truecolorWrap(hex, text);
  };

  // The context records of this extension instance: one runtime per
  // instance, so two instances in one process never share session state, a
  // captured model limit, a published round view, or a
  // pending-view-change flag.  The catalog puts the context records and the
  // explicit session records on the session scope's stop path.
  const contextRuntime = overrides?.contextRuntime ?? createContextRuntime();
  const sessionCatalog = createSessionResourceCatalog([
    ...contextSessionResources(contextRuntime),
    sessionAgentResource,
  ]);

  // The host service declarations.  Every state owner the composition
  // touches — the session contexts, the adapter, the tool host built on
  // the contexts, the todo catalog, the profile catalog, the tool
  // baselines, the fleet surface and the switch surface — is a lifecycle
  // service, so the kernel creates (and stops) them.  The composition itself is a service over
  // those ports, and the loop engine a service over the composition, so no
  // service here receives a session-scoped store.
  const declarations = createPiHostServices({
    contextRuntime,
    sessionCatalog,
    piApi,
    appendEntry,
    colorizeAgent,
    titleForRun: runTitle,
    borderColorizeForRun: agentBorderColorize,
    composeProfile: (ports) =>
      buildPiContributions(
        zooConfig,
        {
          contextRuntime,
          adapter: ports.adapter,
          toolHost: ports.toolHost,
          switchHost: ports.switchHost.host,
          // The agent this runtime is fixed to (a sub-session runtime), so
          // the session resolver answers it without any ambient state.
          ...(overrides?.agent === undefined
            ? {}
            : { fixedAgent: overrides.agent }),
          // Test seams: workspace root and `zdebug` runner for the
          // auto-debug strategy.  Both default to the real host behaviour
          // when omitted.
          directory: overrides?.directory,
          zdebugExec: overrides?.zdebugExec,
          // The `/go` handoff target reads the command context of the
          // session it replaces: the command bridge bound that context when
          // its session admitted the command.
          getCommandCtx: (sessionID) =>
            ports.sessionContexts.commandForSession(sessionID),
          // The `/debug` startup injector sends a model-visible user message
          // through pi's `sendUserMessage`.  Only the real pi API instance
          // provides it; test-only compositions stay without one.
          messageInjector: piApi ? createPiMessageInjector(piApi) : undefined,
          // The pi subagent driver — the in-process SDK session executor.
          // Only wired when a real pi API instance is present (the extension
          // runs inside pi); test-only and driver-less compositions stay
          // closed.  A test override replaces the SDK driver with a fake so
          // bridge tests run without loading the pi SDK.  The skill seam is
          // injected from the same config/profile sources the main session's
          // `resources_discover` uses: each sub-session is seeded with the
          // skill directories its OWN `[agent.<name>.permission.skill]` rules
          // allow.  The profile catalog is read lazily, per run, so a
          // delegation that starts after composition sees the published
          // value.
          subagentDriver:
            overrides?.subagentDriver ??
            (piApi
              ? createPiSubagentDriver({
                  skillPermissions,
                  getProfileSkills: () => ports.profileCatalog.get(),
                  collectSkillPaths,
                  // The child loads ZooKeeper through the inline factory
                  // captured from this composition root, and its own run
                  // reports back the close handle of that runtime.
                  entryPath: overrides?.entryPath,
                  createChildExtension: (onClose, agent) =>
                    buildPiSubagentExtension(zooConfig, rawConfig, {
                      agent,
                      entryPath: overrides?.entryPath,
                      onClose,
                    }),
                })
              : undefined),
          // The pi subagent transcript-card renderer — turns the tool's
          // streamed text into pi TUI components.  Wired only when a real pi
          // API instance is present; the tool contribution then carries
          // renderCall / renderResult so the TUI draws the live card.
          // Without it (OpenCode, test-only compositions) the tool stays
          // text-only.
          subagentRenderer: piApi ? buildSubagentCardRenderer() : undefined,
          // The pi todo transcript-card renderer — turns the tool's summary
          // text into a pi TUI card over the persisted snapshot.  Wired only
          // when a real pi API instance is present; the tool contribution
          // then carries renderCall / renderResult.  Without it (OpenCode,
          // test-only compositions) the tool stays text-only.
          todoRenderer: piApi ? buildTodoCardRenderer() : undefined,
          // The todo port (pi host only).  The extension-scope catalog routes
          // every call to the store of the session the call names, so the
          // todo tool unit and the `session_tree` handler reach the state of
          // the session they belong to without owning it.  Absent without a
          // pi API instance: the tool unit is then skipped (fail-closed) and
          // `todo` never registers on a host that cannot restore its state
          // from the transcript.
          todoStore: piApi === undefined ? undefined : ports.todo,
          // The subagent capability baseline: pi's full untrimmed active tool
          // set, captured lazily on first subagent execution and cached —
          // mirroring the switch command's baseline capture so tool denies
          // never accumulate across either switches or subagent delegations.
          // The capture is DEFERRED because pi forbids calling action
          // methods (including `getActiveTools`) during extension loading;
          // the first subagent execution always happens post-bind, so the
          // lazily-captured set is the real untrimmed universe.  `undefined`
          // when unavailable (also after the extension stopped) → capability
          // computation yields an empty set (fail-closed).
          subagentBaseline:
            piApi === undefined
              ? undefined
              : () => ports.toolBaselines.subagent(),
          // Registry-write notification → the parent session's fleet widget
          // re-renders with the latest registry state (start / update /
          // finish all nudge it).
          onSubagentRunChange: (sessionID) => ports.fleet.refresh(sessionID),
          // Native HTML→Markdown converter for the fetch tool.  Wired here
          // (the real pi entry point); the wrapper warns once when the addon
          // is unavailable, the assembly then declares no `htmlConverter`
          // key, and the planner skips the fetch unit (fail-closed).
          loadHtmlConverter: loadPiHtmlConverter,
          // Host head truncator for the fetch pipeline.  Wired here alongside
          // the converter loader; the fetch unit registers only when both are
          // present.
          truncateHead,
          // The ask tool's form host.  Wired here (the real pi entry point) so
          // the ask unit registers on pi only and stays closed on OpenCode.
          askFormHost: { present: presentAskForm },
        },
        rawConfig,
      ),
    // Test seam: the budget store the loop engine records into.
    ...(overrides?.remindersUsed === undefined
      ? {}
      : { loopStore: overrides.remindersUsed }),
  });

  // The session id one event context names.  Each call resolves its own
  // context: no entry point falls back to a context another event
  // published.
  const resolveSessionID = (ctx: unknown): string | undefined =>
    (ctx as PiLifecycleContext | undefined)?.sessionManager?.getSessionId?.();

  // The lifecycle wiring of this extension instance: the extension
  // activation, session admission, the real start notice, and the
  // extension stop pi's `session_shutdown` drives.  Handlers and the tool /
  // command bridges below route their work through it.
  const lifecycle = createPiLifecycleWiring({
    extensionServices: declarations.extension,
    sessionServices: declarations.session,
    // pi keeps the live session id on the event context's session manager.
    getSessionID: resolveSessionID,
  });

  // A host that owns this runtime (the subagent driver of a parent session)
  // receives the close handle now, while the wiring exists: pi never sends
  // `session_shutdown` for an SDK-created session, so that host stops this
  // scope itself, before it disposes the session.
  overrides?.onLifecycle?.(() =>
    lifecycle.stopExtension({
      type: "session_shutdown",
      reason: SDK_STOP_REASON,
    }),
  );

  // Activate the extension scope BEFORE anything else: the profile is
  // composed over services the kernel created, not over objects this
  // function built and then wrapped.  No session exists at this point — the
  // session scopes are created when an event first names one.
  const extension = await lifecycle.activateExtension();
  const {
    sessionContexts,
    todo,
    profileCatalog,
    toolBaselines,
    fleet,
    switchHost,
    composition,
    loop,
  } = extension.services;

  // The composed profile and the loop engine over its settle strategies
  // are services of this extension scope: the composition reads the
  // extension-scope ports, and the engine is created after it.
  const {
    composed,
    limits,
    agentPermissions,
    resolveAgent,
    resolveCallerAgent,
  } = composition;

  // Loop-engine wiring.  The composed strategies judge a stopped turn; each
  // declares its own wake allowance (`maxWakes`) and reads its own config,
  // so the engine needs no configuration of its own.  This host classifies
  // the stop cause at pi's pre-settle boundary and returns a wake as an
  // injected custom message.  A session's reminder budget and awaiting lock
  // are released by that session's scope.
  const engine = loop.engine;

  // Apply one session's primary tool-level denies to the active tool set.
  //
  // pi has no host-level per-agent permission enforcement (unlike
  // OpenCode), so the extension trims pi's process-wide registered tool
  // face per session.  The trim is computed from the SHARED untrimmed
  // baseline (`toolBaselines.primary`) minus the session's primary denies,
  // so it is idempotent and denies never accumulate across repeated calls
  // or primary switches.  A sub-session runtime is skipped: the driver
  // already restricts its tool face by the capability allowlist.  Fails
  // closed: no primary, no denies, or no baseline all leave the active set
  // untouched (an empty filter would wipe every tool).
  const applyPrimaryToolTrim = (sessionID: string): void => {
    if (overrides?.agent !== undefined) return;
    const primary = resolveAgent(sessionID);
    if (primary === undefined) return;
    const denied = agentPermissions[primary] ?? [];
    if (denied.length === 0) return;
    const baseline = toolBaselines.primary();
    if (baseline === undefined || baseline.length === 0) return;
    const deniedSet = new Set(denied);
    // Always write the FULL `baseline minus denies` set (never a delta):
    // this both removes the current primary's denies and restores tools a
    // previously active primary had denied.  Log only an actual removal so
    // a steady-state turn (denies already absent) stays quiet.
    const next = baseline.filter((tool) => !deniedSet.has(tool));
    piApi?.setActiveTools?.(next);
    const removed = denied.filter((tool) => baseline.includes(tool));
    if (removed.length > 0) {
      log.info({
        hook: "permissions",
        event: "primary_tools_trimmed",
        agent: primary,
        removed,
      });
    }
  };

  // Register the `zoo` fleet widget (component factory) above the editor
  // through the fleet resources of the session the event names.
  //
  // The session scope owns every host write the widget needs — the
  // `setWidget` binding and the terminal-input listener — so a session that
  // stops (or whose extension stops) releases both, and a later registration
  // on a stopped scope writes nothing.  Registration stays idempotent: pi
  // replays `session_start` after a reload / resume, so re-registering
  // re-seeds the widget and releases the previous listener instead of
  // stacking a second one.  The factory reads the active primary and the run
  // registry LIVE on every render, so registration is a `setWidget` call and
  // all subsequent updates are `refresh()` nudges.
  //
  // Fails closed: no session id, no scope for that session, no active
  // primary, or no `ui` surface all no-op silently.
  const registerFleetWidget = (sessionID: string | undefined): void => {
    fleet.register(sessionID);
  };

  // Startup anchor: mirror the OpenCode host's `plugin_init` event so a
  // pi log records which profile-driven composition was loaded.  Sessionless
  // (load-time) entry: it buffers and flushes into the first pi session's
  // file once that session materialises.
  log.info({
    hook: "plugin",
    event: "plugin_init",
    agents: composed.agents.map((agent) => agent.name),
    skills: composed.skills.map((skill) => skill.name),
    limits,
  });

  // Publish the composed profile's skill directory names.  The subagent
  // driver reads them per run and `resources_discover` reads them per bind,
  // so both consume this one publication — no mutable local is handed out.
  profileCatalog.publish(composed.skills.map((skill) => skill.name));

  // Register profile tools with pi when an API instance is supplied.
  // The composed `tool.definition` contributions (the subagent-prompt format
  // hint, when the subagent-prompt hook unit is enabled) run at this
  // registration boundary: pi has no native `tool.definition` event, so
  // the OpenCode chain is applied here instead — enriching the tool
  // arguments' descriptions before pi registers the tools, with the tool
  // itself staying policy-free.  The delegation gate is enforced
  // separately on pi's native `tool_call` event (see `registerPiHandlers`
  // and `handlers.toolCall`).
  const definitionEnrichedTools = await applyToolDefinitionContributions(
    composed.tools,
    composed.toolDefinition,
  );
  if (piApi?.registerTool) {
    const registered = new Set<string>();
    for (const tool of Object.values(definitionEnrichedTools)) {
      if (registered.has(tool.name)) continue;
      registered.add(tool.name);
      const args = tool.args ?? {};
      const required = tool.required ?? Object.keys(args);
      piApi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        // Forward a declared scheduling hint to pi's per-tool execution mode.
        // Tools that guard their own state (todo, ask) serialise inside
        // themselves and declare nothing, so they keep pi's default and stay
        // concurrent with unrelated calls in the same turn.
        ...(tool.executionMode !== undefined
          ? { executionMode: tool.executionMode }
          : {}),
        // Forward the tool's custom TUI renderers (the subagent transcript
        // card) so pi draws the animated card instead of a static result.
        // Tools without renderers (compress / decompress) simply omit them.
        // The renderers are duck-typed in the core tool slot (no pi-TUI
        // import there), so the whole definition is asserted to pi's own
        // `ToolDefinition` at this registration boundary.
        ...(tool.renderCall !== undefined
          ? { renderCall: tool.renderCall }
          : {}),
        ...(tool.renderResult !== undefined
          ? { renderResult: tool.renderResult }
          : {}),
        // pi's validateToolArguments accepts plain JSON-Schema parameters.
        parameters: {
          type: "object",
          properties: args,
          ...(required.length > 0 ? { required } : {}),
        } as unknown as object,
        execute: buildPiToolExecute(tool, lifecycle, (sessionID, ctx) =>
          sessionContexts.bind(sessionID, ctx),
        ),
      } as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
    }
  }

  // Register profile commands with pi when an API instance is supplied.
  // Each handler is admitted for the session its own command context names:
  // a command that arrives without a session or after the session stopped
  // runs nothing.  A command the contribution marks as replacing (`/go` and
  // the `/<agent>` switches) is admitted as a CONTROL operation, because pi
  // tears its session down inside the replacement call and a stop waiting
  // for that call would never return.  Every other command is ordinary
  // session work, so a stop cancels it and waits for it to return.  The
  // context reaches the session contexts only after admission either way.
  if (piApi?.registerCommand) {
    const plan = buildPiCommandRegistrationPlan(composed.commands);
    for (const registration of plan) {
      piApi.registerCommand(registration.name, {
        description: registration.description,
        handler: (args: string, ctx: unknown) => {
          const work = (permit: WorkPermit) => {
            // The command context is the session's own: the handoff target
            // and the switch host resolve it from the command entry by the
            // permit's session id.
            sessionContexts.bindCommand(permit.sessionID, ctx as PiCommandCtx);
            return registration.handler(args, ctx as PiCommandContext, permit);
          };
          return registration.replacesSession
            ? lifecycle.runControl(ctx, work)
            : lifecycle.runSession(ctx, work);
        },
      });
    }
  }

  // Register the `zoo-notice` entry renderer so appended notification
  // entries draw a card in the TUI chat transcript.  Registered
  // unconditionally whenever the renderer API is present (independent of
  // the profile / composed commands): every notify — tool prompts, /dcp
  // reports, command failures — posts a `zoo-notice` entry that needs a
  // renderer.  The renderer itself is duck-typed (no pi package import);
  // absent API degrades to nothing.
  if (piApi?.registerEntryRenderer) {
    piApi.registerEntryRenderer(
      "zoo-notice",
      buildPiNoticeEntryRenderer() as unknown as Parameters<
        ExtensionAPI["registerEntryRenderer"]
      >[1],
    );
  }
  // The fourteen handlers close over the wiring surfaces assembled above;
  // their bodies live in `handlers.ts`.
  return createPiEventHandlers({
    sessionContexts,
    contextRuntime,
    composed,
    engine,
    skillPermissions,
    getProfileSkills: () => profileCatalog.get(),
    collectSkillPaths,
    applyPrimaryToolTrim,
    registerFleetWidget,
    refreshFleetWidget: (sessionID) => fleet.refresh(sessionID),
    refreshTodoView: (sessionID) => fleet.refreshTodoView(sessionID),
    seedTodoView: (sessionID) => fleet.seedTodoView(sessionID),
    // The switch surface's pending post-replacement operations ride the
    // explicit process-level handoff store, because a switch spans two
    // factory executions — see `adapters/pi/switch-host.ts`.
    drainPendingSwitchOps: () => switchHost.drainPendingOps(),
    invalidateTodo: (sessionId) => todo.invalidate(sessionId),
    resolveAgent,
    resolveCallerAgent,
    ...(overrides?.agent === undefined ? {} : { fixedAgent: overrides.agent }),
    runSession: (ctx, work, signal) => lifecycle.runSession(ctx, work, signal),
    startSession: (event, ctx) => lifecycle.startSession(event, ctx),
    stopExtension: (event) => lifecycle.stopExtension(event),
  });
}
