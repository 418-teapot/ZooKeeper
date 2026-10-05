/**
 * Pi host wiring — composition, registration, and the loop engine.
 *
 * Turns the `zoo` config into the pi-facing wiring: the profile-driven
 * composition (`buildPiContributions`), the session → agent resolver
 * (`buildPiResolveAgent`), the profile skill-directory lookup
 * (`collectSkillPaths`), and the registration boundary itself
 * (`buildPiHandlers`) — the mutable context holder, the single tool host,
 * the todo store, the tool baseline, the fleet widget and switch host, the
 * composed contributions, the loop engine, and pi's `registerTool` /
 * `registerCommand` / `registerEntryRenderer` calls.
 *
 * The thirteen event handlers themselves are built by
 * `createPiEventHandlers` (see `handlers.ts`); this module only supplies
 * their wiring surfaces.
 *
 * @module
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyToolDefinitionContributions,
  buildPiCommandRegistrationPlan,
  loadPiHtmlConverter,
} from "../../compose-pi.js";
import type { ToolHost } from "../../core/client/tool-host.js";
import { composeProfile } from "../../core/compose.js";
import {
  parseAgentColors,
  parseAgentModes,
  parseAgentPermissions,
  parseAskConfig,
  parseAutoDebugConfig,
  parseContextConfig,
  parseContinuationConfig,
  parseLimits,
  parseModeProfile,
} from "../../core/config-parse.js";
import type { AgentModeMap, ModeProfile } from "../../core/config-types.js";
import type { HostAdapter } from "../../core/context/lens.js";
import { createLoopEngine } from "../../core/loop/index.js";
import { parseSkillPermissions } from "../../core/permissions/skill-permissions.js";
import { sessionAgentRegistry } from "../../core/session-agent.js";
import type { ComposedResult, Deps, PiSwitchHost } from "../../core/slots.js";
import type { SubagentDriver } from "../../core/subagent/driver.js";
import {
  derivePrimaries,
  getPrimary,
  resolveIdentity,
  setPrimary,
} from "../../core/subagent/identity.js";
import type { SubagentRun } from "../../core/subagent/registry.js";
import { findByChildSession } from "../../core/subagent/registry.js";
import type { FetchCandidates } from "../../core/todo/store.js";
import { createTodoStore } from "../../core/todo/store.js";
import type { ValidationLimits } from "../../core/validate.js";
import { REGISTRY } from "../../registry.js";
import { log } from "../../utils/logger.js";
import { createPiAdapter } from "./adapter.js";
import { loadAgentsJson } from "./agent-models.js";
import { createPiEventHandlers } from "./handlers.js";
import { createPiHandoffTarget, type PiCommandCtx } from "./handoff-target.js";
import { createPiSubagentDriver } from "./subagent.js";
import type { PiHistoryEntry } from "./subagent-scan.js";
import { createPiSwitchHost } from "./switch-host.js";
import { mergeTerminalToolDetails, truecolorWrap } from "./terminal-details.js";
import { scanTodoSnapshots } from "./todo-scan.js";
import {
  createPiToolHost,
  type PiContextHolder,
  type PiToolHostContext,
} from "./tool-host.js";
import {
  buildSubagentCardRenderer,
  buildTodoCardRenderer,
} from "./tui/index.js";
import { buildPiNoticeEntryRenderer } from "./tui/notice.js";
import { createFleetWiring } from "./tui/wiring.js";
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
 *      `runWithIdentity` scope) — it resolves to the default primary,
 *      the first primary in profile array order, derived from the
 *      agent modes map.
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
 * A root session with no configured primary (null or primary-less
 * profile) and no identity resolves to `undefined` — fail-closed,
 * still without a binding: without a primary the direct-work nudge's
 * gate never matches and the dedup-release notification stays
 * silent.
 *
 * @param profile - The active mode profile, or `null` when absent.
 * @param agentModes - Per-agent role map (`[agent.*].mode`), parsed
 *   fail-closed by `parseAgentModes`.
 * @returns The resolver handed to `Deps.resolveAgent`.
 */
export function buildPiResolveAgent(
  profile: ModeProfile | null,
  agentModes: AgentModeMap,
): (sessionID: string) => string | undefined {
  const defaultPrimary = derivePrimaries(profile?.agents ?? [], agentModes)[0];
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
    // event repeat the guaranteed-missing (a) scan.  No primary at
    // all (null or primary-less profile) → fail-closed, unbound.
    if (defaultPrimary === undefined) return undefined;
    sessionAgentRegistry.bind(sessionID, defaultPrimary);
    return defaultPrimary;
  };
}

/**
 * Compose the profile-driven contributions for pi.
 *
 * The full registry is fed to the selection engine — pi composes every
 * category and consumes the agent, skill, after-exec, transform, and
 * command slots (the `unknown_unit` warning fires when a profile name
 * has no matching registry unit).  `Deps` are adapted to the pi host:
 * `client` is empty, `directory` is the process working directory,
 * `resolveAgent` identifies each session through the shared
 * session-agent registry (subagent child sessions → their delegated
 * agent, the root session → the default primary; see
 * `buildPiResolveAgent`), and the host adapter / tool host are taken
 * from `hostDeps` when provided (the entry point supplies the live
 * context holder so event handlers can update it).
 *
 * When the primary set is non-empty the identity state is initialised
 * with the default primary via `setPrimary`, so a `before_agent_start`
 * event outside any sub-session scope resolves that primary; an empty
 * primary set leaves the identity machinery off (fail-closed).
 *
 * Exported for unit testing — `zookeeperPi` wires this with the config
 * loaded from disk.
 *
 * @param zooConfig - The `zoo` section of config.toml.
 * @param hostDeps - Optional host adapter and tool host (used by the entry
 *   point to share the mutable context holder with handlers).
 * @returns The parsed profile (or `null`), the composed result, and the
 *   parsed validation limits.
 */
export function buildPiContributions(
  zooConfig: any,
  hostDeps?: {
    adapter?: HostAdapter<unknown>;
    toolHost?: ToolHost;
    piSwitchHost?: PiSwitchHost;
    getCommandCtx?: () => PiCommandCtx | null | undefined;
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
    subagentRenderer?: Deps["subagentRenderer"];
    /**
     * Per-session todo state store (only on the pi host).  Built by the
     * entry point over its own transcript scan, so each extension instance
     * (main session or subagent child session) owns a separate store.
     * Undefined without it — the todo tool unit contributes no tools
     * (fail-closed, the subagent precedent), so `todo` never registers on
     * a host that cannot restore todo state from its transcript.
     */
    todoStore?: Deps["todoStore"];
    /**
     * Host todo transcript-card renderer (only supplied by the real pi
     * entry point).  Undefined without it — the todo tool stays
     * text-only.
     */
    todoRenderer?: Deps["todoRenderer"];
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
    zdebugExec?: Deps["zdebugExec"];
    /**
     * Native HTML→Markdown converter loader for the fetch tool (only
     * supplied by the real pi entry point).  Undefined without it — the
     * fetch tool unit contributes no tools (fail-closed, matching
     * OpenCode).
     */
    loadHtmlConverter?: Deps["loadHtmlConverter"];
  },
  rawConfig?: any,
): {
  profile: ModeProfile | null;
  composed: ComposedResult;
  limits: ValidationLimits;
  agentModes: AgentModeMap;
  agentPermissions: ReturnType<typeof parseAgentPermissions>;
} {
  const limits = parseLimits(zooConfig);
  const contextConfig = parseContextConfig(zooConfig);
  // The auto-continuation budget, parsed fail to skip.  The owning
  // strategy reads it through deps and declares it as its own wake
  // allowance (`maxWakes`); the engine is never configured with it.
  const continuationConfig = parseContinuationConfig(zooConfig);
  // The auto-debug wake budget, parsed fail to skip.  The owning strategy
  // reads it through deps and contributes no settle handler when the
  // section is absent or invalid.
  const autoDebugConfig = parseAutoDebugConfig(zooConfig);
  // The ask-tool timeout (seconds), parsed fail to skip.  Injected only
  // here (pi host) — the ask tool is not registered on OpenCode.
  const askConfig = parseAskConfig(zooConfig);
  const modeProfile = parseModeProfile(zooConfig);
  // The `agent` table lives at the top level of config.toml, so the
  // fail-closed mode map and tool-level deny map are parsed from the
  // whole parsed root (empty maps when no raw config was supplied).
  const agentModes = parseAgentModes(rawConfig ?? {});
  const agentPermissions = parseAgentPermissions(rawConfig ?? {});

  // The default primary (first in profile array order among the
  // agent-modes-marked primaries), used to seed the identity machinery
  // and to build the `/go` handoff target's executor agent.  An empty
  // primary set leaves the handoff target's default primary undefined
  // (fail-closed at handoff time).
  const primaries = derivePrimaries(modeProfile?.agents ?? [], agentModes);

  const deps: Deps = {
    limits,
    contextConfig,
    continuationConfig,
    autoDebugConfig,
    agentModes,
    agentPermissions,
    askTimeoutSeconds: askConfig?.timeoutSeconds,
    piSwitchHost: hostDeps?.piSwitchHost,
    // The pi subagent driver (in-process SDK session execution).  Only the
    // real pi entry point supplies one; unit tests and other hosts omit it
    // so the subagent tool never registers (fail-closed).
    subagentDriver: hostDeps?.subagentDriver,
    // The pi subagent transcript-card renderer.  Only the real pi entry
    // point supplies one; without it the tool stays text-only.
    subagentRenderer: hostDeps?.subagentRenderer,
    // The per-instance todo state store (pi host only).  Without it the
    // todo tool unit contributes no tools (fail-closed).
    todoStore: hostDeps?.todoStore,
    // The pi todo transcript-card renderer.  Only the real pi entry
    // point supplies one; without it the tool stays text-only.
    todoRenderer: hostDeps?.todoRenderer,
    // The full untrimmed tool baseline for subagent capability computation,
    // read lazily: a getter so the supplier (pi's `getActiveTools`) runs at
    // first subagent execution — which is always post-bind — never at
    // extension-load time (pi forbids action methods then).  The tool unit
    // reads this field only inside its `execute`, so composition itself
    // never triggers the capture.
    get subagentBaseline(): string[] | undefined {
      return hostDeps?.subagentBaseline?.();
    },
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
    // The native HTML→Markdown converter loader (pi host only).  Without it
    // the fetch tool unit contributes no tools (fail-closed); the pi entry
    // point supplies the fail-closed wrapper that warns when the addon is
    // unavailable.
    loadHtmlConverter: hostDeps?.loadHtmlConverter,
    // pi has no SDK client — the context-pruning transform runs and
    // returns the pruned replacement to pi.  The release notification
    // does not need the client: it posts through the unified pi tool
    // host's `notify` port as a `zoo-notice` appendEntry entry.  The
    // marking producers (dedup / purge-errors) have no
    // user-visible notification on pi.
    client: {},
    zdebugExec: hostDeps?.zdebugExec,
    directory: hostDeps?.directory ?? process.cwd(),
    resolveAgent: buildPiResolveAgent(modeProfile, agentModes),
    toolHost: hostDeps?.toolHost,
    // The `/go` handoff target.  `getCommandCtx` reads the mutable pi
    // command-context holder, refreshed by the command handler before
    // the handoff target runs.
    handoffTarget: createPiHandoffTarget({
      getCommandCtx: hostDeps?.getCommandCtx ?? (() => undefined),
      defaultPrimary: primaries[0],
    }),
    // Native pi host adapter: the entry point shares a mutable context
    // holder so the session id provider always reads the latest pi event
    // context.  When no adapter is supplied (unit tests that only inspect
    // the composed shape) a default no-op provider is used.
    adapter: hostDeps?.adapter ?? createPiAdapter(() => undefined),
  };
  const composed = composeProfile(modeProfile, REGISTRY, deps);

  // Seed the identity machinery with the default primary when the
  // profile has any primary agents (first in profile array order).  An
  // empty primary set leaves the identity state untouched (fail-closed
  // — no `setPrimary` call), so `before_agent_start` stays silent.
  // The seed only applies when NO primary is set yet: the extension
  // factory re-runs on every pi session replacement (`newSession`), so
  // an unconditional re-seed here would clobber a primary the switch
  // just set before calling `newSession` (Bug B).  Seeding only the
  // initial unset state keeps the switch's target primary intact for the
  // replacement session's bind-time handlers.
  if (primaries.length > 0 && getPrimary() === undefined) {
    setPrimary(primaries[0]);
  }

  return {
    profile: modeProfile,
    composed,
    limits,
    agentModes,
    agentPermissions,
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
 * `profileSkills` AND the directory actually exists under core/skills/
 * (mirroring the OpenCode adapter's fail-closed `registerSkills`).
 *
 * @param profileSkills - Skill directory names declared by the profile.
 * @returns Absolute paths of the existing, profile-listed directories.
 */
export function collectSkillPaths(profileSkills: string[]): string[] {
  const skillsDir = resolve(__dirname, "../../../core/skills");
  const paths: string[] = [];
  try {
    for (const entry of readdirSync(skillsDir)) {
      if (!profileSkills.includes(entry)) continue;
      const fullPath = resolve(skillsDir, entry);
      if (statSync(fullPath).isDirectory()) {
        paths.push(fullPath);
      }
    }
  } catch {
    // skillsDir does not exist — return empty array
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------------

/**
 * Build the pi handlers and register the profile's pi surfaces.
 *
 * Builds the host wiring (context holder, tool host, todo store, tool
 * baseline, fleet widget, switch host), composes the profile against it,
 * creates the loop engine when the profile contributes a settle strategy,
 * registers the composed tools / commands / notice renderer with pi, and
 * returns the event handlers over those surfaces.
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
 * @returns The thirteen handlers plus the registration gates.
 */
export function buildPiHandlers(
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
    zdebugExec?: Deps["zdebugExec"];
  },
): PiEventHandlers {
  // Mutable holder updated by every event handler so the pi adapter and
  // tool host always see the latest ExtensionContext.
  const contextHolder: PiContextHolder = { current: undefined };
  const sessionIdProvider = () =>
    contextHolder.current?.sessionManager?.getSessionId();
  const adapter = createPiAdapter(sessionIdProvider);
  // The single pi tool host routes every in-session chat notification
  // (tool prompts, /dcp reports, command failures) through pi's
  // `appendEntry` channel as a `zoo-notice` custom entry — persistent,
  // rendered by the entry renderer, never part of the LLM context (the
  // pi equivalent of v1's ignored noReply message).  `appendEntry` is
  // passed as a value, so it is defensively bound to the API object when
  // present (pi's current implementation is closure-based and works
  // unbound, but a future `this`-dependent implementation would silently
  // break otherwise).
  const appendEntry =
    typeof piApi?.appendEntry === "function"
      ? piApi.appendEntry.bind(piApi)
      : undefined;
  const toolHost = createPiToolHost(contextHolder, appendEntry);
  // The todo tool's snapshot candidate source: the newest-first `details`
  // payloads of the session's `todo` tool results.  Built ONLY when a real
  // pi API instance is supplied — without it there is no todo store at all,
  // so the todo tool unit contributes no tools (fail-closed, the subagent
  // precedent) and `todo` never registers on a host that cannot restore its
  // state from the transcript.
  //
  // The scan reads the CURRENT live session through the shared context
  // holder: pi exposes exactly one live session per extension instance, so
  // the store's sessionId argument cannot be resolved to a different
  // session manager here and is deliberately ignored.
  //
  // `getBranch` (not `buildContextEntries`): it returns the raw entries of
  // the active branch INCLUDING pre-compaction ones, so a cache miss after
  // a compaction still finds the last snapshot.  It MUST be called as a
  // method on the session manager (an extracted reference unbinds `this`
  // and crashes), matching the `session_start` rebuild precedent.  An
  // unavailable manager yields an empty candidate list; a THROWING read is
  // logged and rethrown, because the store's no-cache-on-failure policy
  // owns the semantics — a transient error must not be cached as empty.
  const todoHistory: FetchCandidates | undefined = piApi
    ? async () => {
        const sessionManager = contextHolder.current?.sessionManager;
        if (sessionManager?.getBranch === undefined) return [];
        try {
          return scanTodoSnapshots(
            sessionManager.getBranch() as PiHistoryEntry[],
          );
        } catch (err) {
          log("plugin", "todo_history_failed", "", undefined, "warn", {
            error: String(err),
          });
          throw err;
        }
      }
    : undefined;
  // The per-instance todo state store: created here so it lives exactly as
  // long as this extension factory execution (pi re-runs the factory per
  // session, including subagent child sessions).  A process-wide singleton
  // would let a child's compose replace the candidate source and make the
  // main session's cache miss scan the child's transcript.
  const todoStore =
    todoHistory !== undefined ? createTodoStore(todoHistory) : undefined;
  // The untrimmed tool BASELINE is captured ONCE before any trim can
  // mutate the active set, and shared by the session-start primary trim
  // and the switch command: every consumer computes
  // `baseline minus deniedTools(target)` from this fixed set, so tool
  // denies never accumulate across switches.  The capture is DEFERRED to
  // the first post-bind call (lazily, then cached) instead of running at
  // extension-load time: pi forbids calling action methods (including
  // `getActiveTools`) during extension loading — the runtime only binds
  // real actions after the extension factory returns.  When the API
  // reports no baseline the host returns `undefined` and consumers skip
  // the trim (fail-closed).
  let toolBaseline: string[] | undefined;
  // Lazily capture the shared untrimmed baseline.  It is deliberately
  // captured before the first trim (the first session-start or switch
  // handler), so a trim applied at session start can never become the
  // baseline a later switch filters — otherwise a primary switched to
  // afterwards could never restore the tools its predecessor denied
  // (denies would silently accumulate).  A `[]` report is cached too:
  // callers treat it as "no baseline" and skip the trim rather than
  // wiping every tool.
  const captureToolBaseline = (): string[] | undefined => {
    if (toolBaseline === undefined) {
      // Copy the reported names: the baseline must stay frozen even if the
      // host hands back a live array that a later `setActiveTools` mutates.
      toolBaseline = piApi?.getActiveTools?.()?.slice();
    }
    return toolBaseline;
  };
  // The subagent capability baseline, captured lazily once on the first
  // subagent execution and cached (mirrors the switch baseline above).
  let subagentToolBaseline: string[] | undefined;
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

  // The `zoo` fleet widget, its todo column, and the enter-inspect
  // transcript overlay.  The wiring owns the per-session caches (the todo
  // phases, the request sequence, the seed flag, and the deferred overlay
  // opens) and reads every host surface live through the shared context
  // holder, so a primary switch or a registry write only needs to nudge a
  // refresh.  See `adapters/pi/tui/wiring.ts`.
  const { fleetWidget, refreshTodoView, seedTodoView } = createFleetWiring({
    getPrimary: () => getPrimary(),
    colorizeAgent,
    getSessionId: sessionIdProvider,
    getEditorText: () => contextHolder.current?.ui?.getEditorText?.() ?? "",
    titleForRun: runTitle,
    borderColorizeForRun: agentBorderColorize,
    // Read the pi `ui.custom` overlay opener fresh on each enter (pi
    // exposes it on every event context's `ui`).
    getOpenOverlay: () => {
      const ui = contextHolder.current?.ui;
      if (ui?.custom === undefined) return undefined;
      return ui.custom.bind(ui);
    },
    todoStore,
  });
  // The pi switch surfaces for the `/<agent>` commands.  Built ONLY when a
  // pi API instance is supplied: without one (test-only or a host without
  // the surfaces) the switch command unit contributes no commands
  // (fail-closed).  A `zoo` widget write is a "primary changed" nudge to
  // the fleet widget; every other key passes through to the live context's
  // `ui`.  See `adapters/pi/switch-host.ts`.
  const switchController = piApi
    ? createPiSwitchHost({
        getBaselineTools: captureToolBaseline,
        setActiveTools: (names) => piApi.setActiveTools?.(names),
        refreshFleetWidget: () => fleetWidget.refresh(),
        getUi: () => contextHolder.current?.ui,
        getCommandCtx: () => contextHolder.current as PiCommandCtx | undefined,
        setContext: (ctx) => {
          contextHolder.current = ctx as PiToolHostContext;
        },
      })
    : undefined;
  const piSwitchHost: PiSwitchHost | undefined = switchController?.host;
  const { profile, composed, limits, agentPermissions } = buildPiContributions(
    zooConfig,
    {
      adapter,
      toolHost,
      piSwitchHost,
      // Test seams: workspace root and `zdebug` runner for the auto-debug
      // strategy.  Both default to the real host behaviour when omitted.
      directory: overrides?.directory,
      zdebugExec: overrides?.zdebugExec,
      // The `/go` handoff target reads the latest pi command context
      // through this supplier: the command handler refreshes the shared
      // holder immediately before the handler body runs.
      getCommandCtx: () => contextHolder.current as PiCommandCtx | undefined,
      // The pi subagent driver — the in-process SDK session executor.  Only
      // wired when a real pi API instance is present (the extension runs
      // inside pi); test-only and driver-less compositions stay closed.
      // A test override replaces the SDK driver with a fake so bridge
      // tests run without loading the pi SDK.
      subagentDriver:
        overrides?.subagentDriver ??
        (piApi ? createPiSubagentDriver() : undefined),
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
      // The todo state store (pi host only, see its definition).  Owned by
      // this factory execution: the todo tool unit and the `session_tree`
      // handler always reach the same instance through this closure.
      todoStore,
      // The subagent capability baseline: pi's full untrimmed active tool
      // set, captured lazily on first subagent execution and cached —
      // mirroring the switch command's baseline capture so tool denies
      // never accumulate across either switches or subagent delegations.
      // The capture is DEFERRED because pi forbids calling action methods
      // (including `getActiveTools`) during extension loading; the first
      // subagent execution always happens post-bind, so the lazily-captured
      // set is the real untrimmed universe.  `undefined` when unavailable →
      // capability computation yields an empty set (fail-closed).  A `[]`
      // report is cached too: callers treat it as "no baseline" rather than
      // shrinking the subagent tool face to nothing.
      subagentBaseline: piApi
        ? () => {
            if (subagentToolBaseline === undefined) {
              subagentToolBaseline = piApi.getActiveTools?.();
            }
            return subagentToolBaseline;
          }
        : undefined,
      // Registry-write notification → the fleet widget re-renders with the
      // latest registry state (start / update / finish all nudge it).
      onSubagentRunChange: () => fleetWidget.refresh(),
      // Native HTML→Markdown converter for the fetch tool.  Wired here (the
      // real pi entry point); the wrapper warns once when the addon is
      // unavailable and the fetch unit then no-ops (fail-closed).
      loadHtmlConverter: loadPiHtmlConverter,
    },
    rawConfig,
  );

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
  // baseline (`captureToolBaseline`) minus the current primary's
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
    const baseline = captureToolBaseline();
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
      log("permissions", "primary_tools_trimmed", "", undefined, "info", {
        agent: primary,
        removed,
      });
    }
  };

  // The terminal-input unsubscribe handle returned by `ui.onTerminalInput`,
  // released when the widget is disposed (pi re-runs the extension factory
  // on session replacement, so each session's registration cleans up after
  // itself) or re-bound on a re-registration.  Registration is idempotent:
  // every `session_start` / `before_agent_start` trigger re-runs it (pi
  // replays `session_start` after a reload / resume, destroying the previous
  // widget component, so re-running the registration must re-seed it instead
  // of leaving it permanently gone); the listener is released before
  // re-binding, so re-registration never stacks a second one.
  let inputUnsubscribe: (() => void) | undefined;

  // Register the `zoo` fleet widget (component factory) above the editor.
  //
  // The factory reads the active primary and the run registry LIVE on every
  // render, so registration is a setWidget call and all subsequent updates
  // (primary switch, registry write) are `refresh()` nudges.  The keyboard
  // listener is bound to the same `ui` surface so the expanded list responds
  // to `↑↓ / jk` while the editor is empty.
  //
  // Fails closed: no pi API, no active primary, or no `ui` surface all
  // no-op silently.
  const registerFleetWidget = (): void => {
    if (!piApi) return;
    const ui = contextHolder.current?.ui;
    if (!ui) return;
    // Fail-closed: without an active primary (no configured primary agent)
    // no widget is registered — the fleet line is primary-driven and a
    // primary-less session renders nothing.
    if (getPrimary() === undefined) return;
    // Release any previous terminal-input listener before re-binding so a
    // re-registration (pi replays `session_start` after a reload / resume)
    // never stacks a second listener.
    if (inputUnsubscribe !== undefined) {
      inputUnsubscribe();
      inputUnsubscribe = undefined;
    }
    if (typeof ui.setWidget === "function") {
      ui.setWidget(
        "zoo",
        (tui, theme) => {
          fleetWidget.attach(
            tui as Parameters<typeof fleetWidget.attach>[0],
            theme as Parameters<typeof fleetWidget.attach>[1],
          );
          return {
            render: (width: number) => fleetWidget.render(width),
            invalidate: () => fleetWidget.refresh(),
            dispose: () => {
              if (inputUnsubscribe !== undefined) {
                inputUnsubscribe();
                inputUnsubscribe = undefined;
              }
              fleetWidget.dispose();
            },
          };
        },
        { placement: "aboveEditor" },
      );
    }
    if (typeof ui.onTerminalInput === "function") {
      inputUnsubscribe = ui.onTerminalInput((data) =>
        fleetWidget.handleKey(data),
      );
    }
    fleetWidget.refresh();
  };

  // Startup anchor: mirror the OpenCode host's `plugin_init` event so a
  // pi log records which profile-driven composition was loaded.  Sessionless
  // (load-time) entry: it buffers and flushes into the first pi session's
  // file once that session materialises.
  log("plugin", "plugin_init", "", undefined, "info", {
    agents: composed.agents.map((agent) => agent.name),
    skills: composed.skills.map((skill) => skill.name),
    limits,
  });

  const profileSkills = composed.skills.map((skill) => skill.name);

  // Register profile tools with pi when an API instance is supplied.
  // The composed `tool.definition` contributions (the subagent-prompt format
  // hint, when the subagent-prompt hook unit is enabled) run at this
  // registration boundary: pi has no native `tool.definition` event, so
  // the OpenCode chain is applied here instead — enriching the tool
  // arguments' descriptions before pi registers the tools, with the tool
  // itself staying policy-free.  The delegation gate is enforced
  // separately on pi's native `tool_call` event (see `registerPiHandlers`
  // and `handlers.toolCall`).
  const definitionEnrichedTools = applyToolDefinitionContributions(
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
  // The handler refreshes the shared context holder with pi's command
  // context so the unified tool host can resolve the session / history.
  if (profile !== null && piApi?.registerCommand) {
    const plan = buildPiCommandRegistrationPlan(composed.commands, (ctx) => {
      contextHolder.current = ctx as PiToolHostContext;
    });
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
  // The twelve handlers close over the wiring surfaces assembled above;
  // their bodies live in `handlers.ts`.
  return createPiEventHandlers({
    contextHolder,
    getSessionId: sessionIdProvider,
    composed,
    engine,
    skillPermissions,
    profileSkills,
    collectSkillPaths,
    applyPrimaryToolTrim,
    registerFleetWidget,
    refreshFleetWidget: () => fleetWidget.refresh(),
    refreshTodoView,
    seedTodoView,
    drainPendingSwitchOps: () => switchController?.drainPendingOps(),
    invalidateTodo: (sessionId) => todoStore?.invalidate(sessionId),
  });
}
