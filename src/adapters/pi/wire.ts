/**
 * Pi host wiring — composition, registration, and the loop engine.
 *
 * Turns the `zoo` config into the pi-facing wiring: the profile-driven
 * composition (`buildPiContributions`), the session → agent resolver
 * (`buildPiResolveAgent`), the profile skill-directory lookup
 * (`collectSkillPaths`), and the registration boundary itself
 * (`buildPiHandlers`) — the host services the lifecycle kernel creates (see
 * `services.ts`: the live context, the adapter and tool host built on it,
 * the todo and profile catalogs, the tool baselines, the fleet surface and
 * the switch surface), the composed contributions, the loop engine, and
 * pi's `registerTool` / `registerCommand` / `registerEntryRenderer` calls.
 *
 * The entry point activates the extension scope BEFORE composing, so the
 * composition receives extension-scope ports the kernel owns.  Session
 * scopes come into existence only when an event names a session.
 *
 * The fourteen event handlers themselves are built by
 * `createPiEventHandlers` (see `handlers.ts`); this module only supplies
 * their wiring surfaces.
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
} from "../../compose-pi.js";
import { capabilityBindings } from "../../core/bindings.js";
import {
  configCapabilities,
  parseCommonConfig,
} from "../../core/capabilities.js";
import type { ComposedResult } from "../../core/compose.js";
import { assemble } from "../../core/compose.js";
import { parseAgentColors, parseAskConfig } from "../../core/config-parse.js";
import type { AgentModeMap, ModeProfile } from "../../core/config-types.js";
import type { HostAdapter } from "../../core/context/lens.js";
import { createLoopEngine } from "../../core/loop/index.js";
import { ORCHESTRATOR_AGENT_NAME } from "../../core/orchestrator.js";
import type { AgentPermissionMap } from "../../core/permissions/deny-tools.js";
import { parseSkillPermissions } from "../../core/permissions/skill-permissions.js";
import type { Capabilities } from "../../core/ports/index.js";
import type { SwitchHost } from "../../core/ports/switch.js";
import type { ToolHost } from "../../core/ports/tool-host.js";
import { sessionAgentRegistry } from "../../core/session-agent.js";
import { scanSkillDirectories } from "../../core/skills.js";
import type { SubagentDriver } from "../../core/subagent/driver.js";
import {
  getPrimary,
  resolveIdentity,
  setPrimary,
} from "../../core/subagent/identity.js";
import type { SubagentRun } from "../../core/subagent/registry.js";
import { findByChildSession } from "../../core/subagent/registry.js";
import { todoSourceFromStore } from "../../core/todo/source.js";
import type { ValidationLimits } from "../../core/validate.js";
import { REGISTRY } from "../../registry.js";
import { log } from "../../utils/logger.js";
import { createPiAdapter } from "./adapter.js";
import { loadAgentsJson } from "./agent-models.js";
import { presentAskForm } from "./ask-form.js";
import { createPiEventHandlers } from "./handlers.js";
import { createPiHandoffTarget, type PiCommandCtx } from "./handoff-target.js";
import type { PiLifecycleContext } from "./lifecycle.js";
import { createPiLifecycleWiring } from "./lifecycle-wiring.js";
import type { PiLiveContext } from "./live-context.js";
import { createPiMessageInjector } from "./message-injector.js";
import { createPiHostServices } from "./services.js";
import { createPiSubagentDriver } from "./subagent.js";
import { mergeTerminalToolDetails, truecolorWrap } from "./terminal-details.js";
import {
  buildSubagentCardRenderer,
  buildTodoCardRenderer,
} from "./tui/index.js";
import { buildPiNoticeEntryRenderer } from "./tui/notice.js";
import type { ExtensionAPI, PiEventHandlers } from "./types.js";

// realpathSync follows the symlink to the real module location, so the
// computed skill paths resolve into the project directory even when the
// extension is loaded through pi's auto-discovery symlink.
const __dirname = dirname(realpathSync(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Profile-driven composition
// ---------------------------------------------------------------------------

/**
 * Build the session → agent resolver for the pi host.
 *
 * Resolution order for a session with no existing binding:
 *  (a) reverse lookup in the subagent run registry — a session that is
 *      some run's `childSession` is driven by that run's delegated
 *      agent; the run table covers live and terminal runs (and runs
 *      rebuilt from persisted history), so this is the authoritative
 *      source for subagent sessions;
 *  (b) the async-local identity — a `resolveIdentity()` binding of
 *      kind `subagent` names the delegated agent driving the current
 *      async chain (covers child-session events that precede the run's
 *      first progress report, which is when (a) starts matching);
 *  (c) otherwise the session is the pi root session (pi has a single
 *      root session and every child-session event runs inside the
 *      `runWithIdentity` scope) — it resolves to the orchestrator the
 *      selection resolved.
 *
 * Binding policy: every answer — (a), (b), and (c) alike — is bound
 * into the shared session-agent registry so later lookups hit the
 * binding in O(1).  The (a) memo can never go stale (a childSession
 * belongs to exactly one run and a run's `agent` is fixed at
 * creation); the (b) memo is the AsyncLocalStorage answer's only
 * durable record
 * (the scope does not outlive the event callback that observed it).
 * The (c) root-session binding trades growth for speed: pi offers no
 * session-deletion event to evict bindings, so they accumulate for
 * the process lifetime — but the accumulation is bounded to one root
 * entry plus one per child session, the same order as the run table
 * (itself never pruned), and without the binding every main-session
 * tool event would re-run the (a) reverse scan, guaranteed to miss.
 * A root session with no configured orchestrator (null, invalid or
 * role-agnostic profile) and no identity resolves to `undefined` —
 * fail-closed, still without a binding: without an orchestrator the
 * direct-work nudge's gate never matches and the dedup-release
 * notification stays silent.
 *
 * @param orchestrator - The orchestrator the selection resolved, or
 *   `undefined` when the selection resolved none.
 * @returns The resolver handed to `Capabilities.resolveAgent`.
 */
export function buildPiResolveAgent(
  orchestrator: string | undefined,
): (sessionID: string) => string | undefined {
  return (sessionID: string): string | undefined => {
    const known = sessionAgentRegistry.resolve(sessionID);
    if (known !== undefined) return known;
    const run = findByChildSession(sessionID);
    if (run !== undefined) {
      // Memoize the (a) answer so later lookups hit the registry in
      // O(1) instead of repeating the linear reverse scan.  Safe to
      // bind: every run records a unique `childSession` and its
      // `agent` is fixed at creation, so the memo can never go stale.
      sessionAgentRegistry.bind(sessionID, run.agent);
      return run.agent;
    }
    const identity = resolveIdentity();
    if (identity?.kind === "subagent") {
      // Memoize the (b) answer: the AsyncLocalStorage scope does not
      // outlive the event callback that queried it, so without the
      // binding every later lookup would fall through to the
      // root-session default.
      // The name is safe to bind — `identity.name` and the `agent`
      // the same delegation later records in the run table are both
      // the request's agent (`core/subagent/run.ts` binds
      // `request.agent`; `tools/subagent.ts` starts the run with the
      // same value), so this memo never diverges from the (a)
      // reverse lookup.
      sessionAgentRegistry.bind(sessionID, identity.name);
      return identity.name;
    }
    // (c): the pi root session.  Bound like every other answer — pi
    // has no eviction event, but the accumulation is bounded (one
    // root entry per process, the same order as the never-pruned run
    // table) and skipping the bind would make every main-session tool
    // event repeat the guaranteed-missing (a) scan.  No orchestrator
    // at all (null, invalid or role-agnostic profile) → fail-closed,
    // unbound.
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
 * session-agent registry (subagent child sessions → their delegated
 * agent, the root session → the orchestrator the selection resolved;
 * see `buildPiResolveAgent`), and the host adapter / tool host are taken
 * from `hostDeps` when provided (the entry point supplies the
 * kernel-created adapter and tool host).
 *
 * This host also declares the product's orchestrator role
 * (`ORCHESTRATOR_AGENT_NAME`) to the planner: a profile that cannot
 * provide it as a primary is invalid and loads nothing.  When the
 * selection resolves an orchestrator the identity state is initialised
 * with it via `setPrimary`, so a `before_agent_start` event outside any
 * sub-session scope resolves that agent; an unresolved role leaves the
 * identity machinery off (fail-closed).
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
    adapter?: HostAdapter<unknown>;
    toolHost?: ToolHost;
    switchHost?: SwitchHost;
    getCommandCtx?: () => PiCommandCtx | null | undefined;
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
     * can nudge its fleet widget to re-render (the widget reads the
     * process-level registry directly on render).  Undefined on hosts
     * without a fleet widget.
     */
    onSubagentRunChange?: () => void;
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
): {
  profile: ModeProfile | null;
  composed: ComposedResult;
  limits: ValidationLimits;
  agentModes: AgentModeMap;
  agentPermissions: AgentPermissionMap;
  /**
   * The host's caller resolver, handed to the `tool_call` gate.  pi
   * answers from the identity core (the current primary, or a bound
   * subagent identity) — the same source the subagent tool uses to name
   * the caller — so it needs no session argument.
   */
  resolveCallerAgent: () => Promise<string | undefined>;
} {
  const common = parseCommonConfig(zooConfig, rawConfig);
  const { modeProfile, agentModes, agentPermissions, limits } = common;
  // The ask-tool timeout (seconds), parsed fail to skip.  Injected only
  // here (pi host) — the ask tool is not registered on OpenCode.
  const askConfig = parseAskConfig(zooConfig);

  // The caller resolver.  The delegation gate resolves the CALLER through
  // the identity core (the same source the subagent tool uses): pi's
  // identity is bound per async chain, not per session id, so neither the
  // port's session argument nor the selection is needed here.
  const resolveCallerAgent = async (): Promise<string | undefined> =>
    resolveIdentity()?.name;

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
      directory: hostDeps?.directory ?? process.cwd(),
      resolveCallerAgent,
      toolHost: hostDeps?.toolHost,
      // The `/debug` startup injector: sends a model-visible user message
      // into the current session.  Only the real pi entry point supplies it.
      messageInjector: hostDeps?.messageInjector,
      // Native pi host adapter: the entry point shares a mutable context
      // holder so the session id provider always reads the latest pi event
      // context.  When no adapter is supplied (unit tests that only inspect
      // the composed shape) a default no-op provider is used.
      adapter: hostDeps?.adapter ?? createPiAdapter(() => undefined),
      // The `/go` handoff target.  `getCommandCtx` reads the mutable pi
      // live context, published by the command handler before the handoff
      // target runs.  Built from host facts only — the
      // executor agent travels with each handoff call, so the target is
      // the same for every selection.
      handoffTarget: createPiHandoffTarget({
        getCommandCtx: hostDeps?.getCommandCtx ?? (() => undefined),
      }),
    },
    selected: {
      // The shared session → agent resolver.  Event handlers read it
      // synchronously; the root-session fallback is the orchestrator the
      // selection resolved.
      resolveAgent: (selection) => buildPiResolveAgent(selection.orchestrator),
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

  // Seed the identity machinery with the orchestrator the selection
  // resolved.  An unresolved role leaves the identity state untouched
  // (fail-closed — no `setPrimary` call), so `before_agent_start` stays
  // silent.
  // The seed only applies when NO primary is set yet: the extension
  // factory re-runs on every pi session replacement (`newSession`), so
  // an unconditional re-seed here would clobber a primary the switch
  // just set before calling `newSession` (Bug B).  Seeding only the
  // initial unset state keeps the switch's target primary intact for the
  // replacement session's bind-time handlers.
  const orchestrator = selection.orchestrator;
  if (orchestrator !== undefined && getPrimary() === undefined) {
    setPrimary(orchestrator);
  }

  return {
    profile: modeProfile,
    composed,
    limits,
    agentModes,
    agentPermissions,
    resolveCallerAgent,
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

/**
 * Build the pi handlers and register the profile's pi surfaces.
 *
 * Activates the host services (live context, adapter, tool host, todo
 * catalog, profile catalog, tool baselines, fleet surface, switch surface)
 * through the lifecycle kernel, composes the profile against those
 * extension-scope ports, creates the loop engine when the profile
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
 * @param overrides - Optional host-dependency overrides.  Only used by
 *   tests: a bridge test injects a fake subagent driver so the registered
 *   tool executes without loading the real pi SDK.
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

  // The host service declarations.  Every state owner the composition
  // touches — the live context, the adapter and tool host built on it, the
  // todo catalog, the profile catalog, the tool baselines, the fleet
  // surface and the switch surface — is a lifecycle service, so the kernel
  // creates (and stops) them.  The composition below receives those
  // extension-scope ports, never a session-scoped store.
  const declarations = createPiHostServices({
    piApi,
    appendEntry,
    colorizeAgent,
    titleForRun: runTitle,
    borderColorizeForRun: agentBorderColorize,
  });

  // The session id an event context names; the live context is the fallback
  // for entry points that carry no context.  `live` is filled by the
  // activation below, which runs before any event can be handled.
  let live: PiLiveContext | undefined;
  const resolveSessionID = (ctx?: unknown): string | undefined =>
    (ctx as PiLifecycleContext | undefined)?.sessionManager?.getSessionId?.() ??
    live?.sessionId();

  // The lifecycle wiring of this extension instance: the extension
  // activation, session ensure, the real start notice, and the extension
  // stop pi's `session_shutdown` drives.  Handlers and the tool / command
  // bridges below route through it before touching session resources.
  const lifecycle = createPiLifecycleWiring({
    extensionServices: declarations.extension,
    sessionServices: declarations.session,
    // pi keeps the live session id on the event context's session manager;
    // the live context is the fallback when an event carries no context.
    getSessionID: resolveSessionID,
  });

  // Activate the extension scope BEFORE composing: the profile is composed
  // over services the kernel created, not over objects this function built
  // and then wrapped.  No session exists at this point — the session scopes
  // are created when an event first names one.
  const extension = await lifecycle.activateExtension();
  const {
    liveContext,
    adapter,
    toolHost,
    todo,
    profileCatalog,
    toolBaselines,
    fleet,
    switchHost: switchSurface,
  } = extension.services;
  live = liveContext;

  // The switch surface of this extension instance.  Built by the kernel
  // service, which stays closed without a pi API instance: no API, no
  // `/<agent>` command (fail-closed).  Its pending post-replacement
  // operations ride the explicit process-level handoff store, because a
  // switch spans two factory executions — see `adapters/pi/switch-host.ts`.
  const switchHost: SwitchHost | undefined = switchSurface.host;
  const contributions = buildPiContributions(
    zooConfig,
    {
      adapter,
      toolHost,
      switchHost,
      // Test seams: workspace root and `zdebug` runner for the auto-debug
      // strategy.  Both default to the real host behaviour when omitted.
      directory: overrides?.directory,
      zdebugExec: overrides?.zdebugExec,
      // The `/go` handoff target reads the latest pi command context
      // through this supplier: the command handler publishes its context
      // immediately before the handler body runs.
      getCommandCtx: () => liveContext.current() as PiCommandCtx | undefined,
      // The `/debug` startup injector sends a model-visible user message
      // through pi's `sendUserMessage`.  Only the real pi API instance
      // provides it; test-only compositions stay without one.
      messageInjector: piApi ? createPiMessageInjector(piApi) : undefined,
      // The pi subagent driver — the in-process SDK session executor.  Only
      // wired when a real pi API instance is present (the extension runs
      // inside pi); test-only and driver-less compositions stay closed.
      // A test override replaces the SDK driver with a fake so bridge
      // tests run without loading the pi SDK.  The skill seam is injected
      // from the same config/profile sources the main session's
      // `resources_discover` uses: each sub-session is seeded with the
      // skill directories its OWN `[agent.<name>.permission.skill]` rules
      // allow.  The profile catalog is read lazily, per run, so a delegation
      // that starts after composition sees the published value.
      subagentDriver:
        overrides?.subagentDriver ??
        (piApi
          ? createPiSubagentDriver({
              skillPermissions,
              getProfileSkills: () => profileCatalog.get(),
              collectSkillPaths,
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
      // every call to the store of the session the call names, so the todo
      // tool unit and the `session_tree` handler reach the state of the
      // session they belong to without owning it.  Absent without a pi API
      // instance: the tool unit is then skipped (fail-closed) and `todo`
      // never registers on a host that cannot restore its state from the
      // transcript.
      todoStore: piApi === undefined ? undefined : todo,
      // The subagent capability baseline: pi's full untrimmed active tool
      // set, captured lazily on first subagent execution and cached —
      // mirroring the switch command's baseline capture so tool denies
      // never accumulate across either switches or subagent delegations.
      // The capture is DEFERRED because pi forbids calling action methods
      // (including `getActiveTools`) during extension loading; the first
      // subagent execution always happens post-bind, so the lazily-captured
      // set is the real untrimmed universe.  `undefined` when unavailable
      // (also after the extension stopped) → capability computation yields
      // an empty set (fail-closed).
      subagentBaseline:
        piApi === undefined ? undefined : () => toolBaselines.subagent(),
      // Registry-write notification → the fleet widget re-renders with the
      // latest registry state (start / update / finish all nudge it).
      onSubagentRunChange: () => fleet.refresh(),
      // Native HTML→Markdown converter for the fetch tool.  Wired here (the
      // real pi entry point); the wrapper warns once when the addon is
      // unavailable, the assembly then declares no `htmlConverter` key, and
      // the planner skips the fetch unit (fail-closed).
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
  );
  const { composed, limits, agentPermissions, resolveCallerAgent } =
    contributions;

  // Loop-engine wiring.  The composed strategies judge a stopped turn;
  // each declares its own wake allowance (`maxWakes`) and reads its own
  // config, so the engine needs no configuration of its own.  This host
  // classifies the stop cause at pi's pre-settle boundary and returns a
  // wake as an injected custom message.  The engine is built whenever
  // the profile contributes at least one strategy (fail-closed: no
  // contribution, no engine, no settle events registered).
  //
  // Upper bound on tracked sessions.  pi fires no session-deletion event,
  // so a long-lived process would otherwise retain one budget entry per
  // session ever opened; the engine evicts the oldest-inserted sessions
  // once the bound is exceeded (the budget is only ever a soft reminder
  // ceiling).  The backing map is pluggable so tests can observe and seed
  // it.
  const REMINDER_SESSIONS_CAP = 100;
  const engine =
    composed.onSettled.length > 0
      ? createLoopEngine(composed.onSettled, {
          cap: REMINDER_SESSIONS_CAP,
          store: overrides?.remindersUsed,
        })
      : undefined;

  // Apply the active primary's tool-level denies to the current session's
  // active tool set.
  //
  // pi has no host-level per-agent permission enforcement (unlike
  // OpenCode), so the extension trims pi's process-wide registered tool
  // face per session.  The trim is computed from the SHARED untrimmed
  // baseline (`toolBaselines.primary`) minus the current primary's
  // tool-level denies, so it is idempotent and denies never accumulate
  // across repeated calls or primary switches.  Subagent sessions are
  // skipped: their tool face is already restricted by the driver's
  // capability allowlist, and the process-wide primary is not their
  // identity.  Fails closed: no primary, no denies, or no baseline all
  // leave the active set untouched (an empty filter would wipe every
  // tool).
  const applyPrimaryToolTrim = (): void => {
    const identity = resolveIdentity();
    if (identity !== undefined && identity.kind !== "primary") return;
    const primary = identity?.name ?? getPrimary();
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
  const registerFleetWidget = (ctx?: unknown): void => {
    fleet.register(resolveSessionID(ctx));
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
        execute: async (
          toolCallId: unknown,
          params: unknown,
          signal: unknown,
          onUpdate: unknown,
          ctx: unknown,
        ) => {
          // Publish the tool event's context FIRST: a tool call may be the
          // first event that observes the session (flows without a
          // `session_start`), and every session-scoped reader — the todo
          // transcript scan, the session's fleet ui — resolves the context
          // by session id.  Ensuring the scope before publishing would let
          // the first session-facing read see no context at all.
          liveContext.publish(ctx);
          // Then ensure the session scope, before the contribution touches
          // session resources.  No session id, nothing created.
          await lifecycle.ensureSession(ctx);
          // Forward the native execution surface to the contribution: the
          // abort `signal`, the tool-call `callId` (the run's registry id
          // for the fleet widget), and the `onUpdate` repaint-signal
          // callback, passed through the third hostCtx argument.  `onUpdate`
          // is a content-free repaint trigger for live tool cards — pi
          // re-renders on any partial result, so a tool such as subagent
          // sends an empty partial rather than streaming text.  The
          // sub-session model is NOT forwarded — strict mode reads the
          // agents.json configured model only (never the parent session's
          // model).  compress / decompress ignore the hostCtx and keep
          // working unchanged.
          //
          // `details` is a write-back slot: a contribution that needs to
          // hand renderers a structured payload (the ask tool's
          // per-question results) assigns it here, and the bridge merges a
          // plain object into the host result's details AFTER execute
          // resolves — merged INTO (never replacing) the bridge's own
          // details, so the run's session path survives.
          const hostCtx: {
            signal?: AbortSignal;
            callId?: string;
            onUpdate?: unknown;
            details?: unknown;
          } = {
            ...(typeof toolCallId === "string" && toolCallId.length > 0
              ? { callId: toolCallId }
              : {}),
            ...(signal instanceof AbortSignal ? { signal } : {}),
            ...(onUpdate !== undefined ? { onUpdate } : {}),
          };
          const text = await tool.execute(params, ctx, hostCtx);
          return {
            content: [{ type: "text", text }],
            details: mergeTerminalToolDetails(toolCallId, hostCtx.details),
          };
        },
      } as unknown as Parameters<ExtensionAPI["registerTool"]>[0]);
    }
  }

  // Register profile commands with pi when an API instance is supplied.
  // The handler publishes pi's command context on the live context so the
  // unified tool host can resolve the session / history.
  if (piApi?.registerCommand) {
    const plan = buildPiCommandRegistrationPlan(
      composed.commands,
      (ctx) => {
        liveContext.publish(ctx);
      },
      // The command execution bridge: ensure the session scope of the
      // command's OWN context before the command body touches session
      // resources.  Reading the context from the argument keeps the
      // session resolution on the command that is running instead of on
      // whichever event published last.
      async (ctx) => {
        await lifecycle.ensureSession(ctx);
      },
    );
    for (const registration of plan) {
      piApi.registerCommand(registration.name, {
        description: registration.description,
        handler: registration.handler,
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
    liveContext,
    getSessionId: () => liveContext.sessionId(),
    composed,
    engine,
    skillPermissions,
    getProfileSkills: () => profileCatalog.get(),
    collectSkillPaths,
    applyPrimaryToolTrim,
    registerFleetWidget,
    refreshFleetWidget: () => fleet.refresh(),
    refreshTodoView: fleet.refreshTodoView,
    seedTodoView: fleet.seedTodoView,
    drainPendingSwitchOps: () => switchSurface.drainPendingOps(),
    invalidateTodo: (sessionId) => todo.invalidate(sessionId),
    resolveCallerAgent,
    ensureSession: (ctx) => lifecycle.ensureSession(ctx),
    startSession: (event, ctx) => lifecycle.startSession(event, ctx),
    stopExtension: (event) => lifecycle.stopExtension(event),
  });
}
