/**
 * ZooKeeper Pi extension — profile-driven hooks composed from the unit
 * registry.
 *
 * This extension registers six event hooks plus slash commands, all
 * driven by the active mode profile (`[zoo.mode.<name>]`, parsed by
 * `parseModeProfile`):
 * 1. `session_start` — seeds the `zoo` widget (rendered above the
 *    editor) with the current primary at session startup / resume, so it
 *    appears immediately without waiting for the first LLM turn (a
 *    `before_agent_start` fallback covers flows that skip it).
 * 2. `before_agent_start` — resolves the current agent identity via the
 *    identity core (`resolveIdentity`) and prepends the matching composed
 *    agent prompt to the chainable system prompt; when no identity is
 *    configured (no primary agent in the profile) the system prompt is
 *    returned untouched (fail-closed).
 * 3. `resources_discover` — contributes the profile-listed skill
 *    directories from core/skills/ so pi can load them via
 *    loadSkillsFromDir; the list is filtered by the active primary's
 *    `[agent.<name>].permission.skill` rules at session-bind time, and an
 *    empty profile skills list contributes none.
 * 4. `tool_result` — runs the composed after-exec contributions against
 *    the tool-result text (handler built by `buildPiToolResultHandler`).
 * 5. `context` — runs the composed transform contributions against the
 *    native pi message list and returns the pruned replacement.
 * 6. `message_end` — strips model-imitated `[mN] ` line-start ref
 *    prefixes from finalized assistant text parts (handler built by
 *    `buildPiMessageEndHandler`).
 * 7. commands — the composed slash commands (e.g. `/dcp`) are registered
 *    with pi via `registerCommand`; their chat notifications go through
 *    the single pi tool host's in-session `appendEntry` channel
 *    (`zoo-notice` custom entries — persistent in the session, rendered
 *    by the `zoo-notice` entry renderer, never entering the LLM context).
 *    The primary-switch unit contributes one `/<agent>` command per
 *    configured primary; each replaces the current session with a fresh
 *    one re-bound to the target identity (setPrimary → newSession with
 *    the post-replacement tool trim + status inside `withSession`).
 *
 * Architecture: units contribute host-agnostic slots (`src/core/slots.ts`)
 * and the pi contact layer (`src/compose-pi.ts`) is the only module that
 * understands pi's event keys — it maps the `ComposedResult` to the
 * event handlers and the command registrations.  The composition feeds
 * the full registry to `composeProfile`; tool units instantiate
 * harmlessly and their slots are not consumed by pi (the command slot
 * is consumed).  Every unit receives the same deps, so commands and
 * tools share the single pi tool host whose `notify` posts in-session
 * `zoo-notice` custom entries through pi's `appendEntry` channel.
 * Every hook and command is profile-driven: a `null` profile (absent or
 * invalid) yields an empty composition, so all hooks no-op and no
 * command is registered — fail-closed, aligned with the OpenCode host.
 *
 * Capability gating: pi passes an empty client object (no SDK client),
 * so context-pruning never touches the SDK session-prompt API.  The
 * only user-visible pruning notification is the release notice, which
 * posts through the unified pi tool host's `notify` port as a
 * `zoo-notice` custom entry (persistent, never part of the LLM context).
 * The pruning transform runs and returns the pruned replacement to pi.
 * Session agent identity (`Deps.resolveAgent`) is resolved per session
 * through the shared session-agent registry: subagent child sessions
 * resolve to their delegated agent via the run registry / async-local
 * identity, the root session to the default primary — so the
 * direct-work nudge's primary gate only fires for the orchestrator
 * session and stays silent without a primary (null profile).
 *
 * Config loading: the OpenCode entry imports config.toml directly with
 * Bun's `import ... with { type: "toml" }`.  pi's extension runtime is
 * Node.js + jiti (verified against pi 0.83.0: Node 24.18.1 and jiti
 * 2.7.0 reject `.toml` imports — `ERR_UNKNOWN_FILE_EXTENSION`), so pi
 * reads config.toml with `readFileSync` and parses it with the vendored
 * smol-toml 1.7.1 parser (`vendor/smol-toml/index.ts`) — an equivalent
 * mechanism that extracts the same `zoo` section object.
 *
 * @module
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../vendor/smol-toml/index.js";
import { createPiAdapter } from "./adapters/pi/adapter.js";
import { loadAgentsJson } from "./adapters/pi/agent-models.js";
import {
  createPiHandoffTarget,
  type PiCommandCtx,
} from "./adapters/pi/handoff-target.js";
import {
  beginHydration,
  hydrationState,
  waitForHydration,
} from "./adapters/pi/hydrate.js";
import { createPiSubagentDriver } from "./adapters/pi/subagent.js";
import {
  type PiHistoryEntry,
  readSessionCwd,
  rebuildSubagentRuns,
} from "./adapters/pi/subagent-scan.js";
import {
  createPiToolHost,
  type PiContextHolder,
  type PiToolHostContext,
} from "./adapters/pi/tool-host.js";
import { buildSubagentCardRenderer } from "./adapters/pi/tui/index.js";
import {
  openTranscriptOverlay,
  TRANSCRIPT_NOT_RECORDED_NOTICE,
  TRANSCRIPT_UNAVAILABLE_NOTICE,
} from "./adapters/pi/tui/transcript.js";
import { createFleetWidget } from "./adapters/pi/tui/widget.js";
import {
  buildPiCommandRegistrationPlan,
  buildPiContextHandler,
  buildPiMessageEndHandler,
  buildPiToolResultHandler,
  type PiCommandContext,
} from "./compose-pi.js";
import type { ToolHost } from "./core/client/tool-host.js";
import { composeProfile } from "./core/compose.js";
import {
  initPluginLogger,
  parseAgentColors,
  parseAgentModes,
  parseAgentPermissions,
  parseContextConfig,
  parseLimits,
  parseModeProfile,
} from "./core/config-parse.js";
import type { AgentModeMap, ModeProfile } from "./core/config-types.js";
import type { HostAdapter } from "./core/context/lens.js";
import {
  isSkillAllowed,
  parseSkillPermissions,
} from "./core/permissions/skill-permissions.js";
import { sessionAgentRegistry } from "./core/session-agent.js";
import type {
  ComposedResult,
  Deps,
  PiSwitchHost,
  PiSwitchNewSessionOps,
} from "./core/slots.js";
import type { SubagentDriver } from "./core/subagent/driver.js";
import {
  derivePrimaries,
  getPrimary,
  resolveIdentity,
  setPrimary,
} from "./core/subagent/identity.js";
import type { SubagentRun } from "./core/subagent/registry.js";
import { findByChildSession, getRun } from "./core/subagent/registry.js";
import type { RunLog } from "./core/subagent/run-log.js";
import type { ValidationLimits } from "./core/validate.js";
import { REGISTRY } from "./registry.js";
import { log } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Local minimal interface — duck-type compatible with pi's ExtensionAPI.
// No external dependency on @earendil-works/pi-coding-agent.
// ---------------------------------------------------------------------------

/**
 * Minimal structural type for pi's ExtensionAPI.
 *
 * Only defines the `on` method with overloaded event signatures that
 * ZooKeeper uses.  pi passes its real ExtensionAPI object at runtime.
 */
interface ExtensionAPI {
  /** Register a tool that the LLM can call. */
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (...args: unknown[]) => Promise<unknown>;
  }): void;

  /** Register a custom slash command with pi. */
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: PiCommandContext) => Promise<void>;
    },
  ): void;

  /** Append a custom entry to the session (persists, no LLM context). */
  appendEntry(customType: string, data?: unknown): void;

  /** Get the list of currently active tool names. */
  getActiveTools(): string[];

  /** Set the active tools by name. */
  setActiveTools(toolNames: string[]): void;

  /** Register a chat-transcript renderer for a custom entry type. */
  registerEntryRenderer(customType: string, renderer: unknown): void;

  /** Register handler for `before_agent_start`. */
  on(
    event: "before_agent_start",
    handler: (
      evt: { systemPrompt: string },
      ctx: unknown,
    ) => { systemPrompt: string } | Promise<{ systemPrompt: string }>,
  ): void;
  /** Register handler for `session_start`. */
  on(
    event: "session_start",
    handler: (evt: unknown, ctx: unknown) => void | Promise<void>,
  ): void;
  /** Register handler for `resources_discover`. */
  on(
    event: "resources_discover",
    handler: (
      evt: unknown,
      _ctx: unknown,
    ) => { skillPaths: string[] } | Promise<{ skillPaths: string[] }>,
  ): void;
  /** Register handler for `tool_result`. */
  on(
    event: "tool_result",
    handler: ReturnType<typeof buildPiToolResultHandler>,
  ): void;
  /** Register handler for `context`. */
  on(event: "context", handler: ReturnType<typeof buildPiContextHandler>): void;
  /** Register handler for `message_end`. */
  on(
    event: "message_end",
    handler: ReturnType<typeof buildPiMessageEndHandler>,
  ): void;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

// realpathSync follows the symlink to the real src/pi.ts location,
// ensuring ../config.toml and ../core/skills resolve to the project
// directory even when loaded via pi's auto-discovery symlink.
const __dirname = dirname(realpathSync(fileURLToPath(import.meta.url)));

/** The project config.toml (sibling of src/). */
const CONFIG_PATH = resolve(__dirname, "../config.toml");

/**
 * Pending post-replacement switch operations for the newest session.
 *
 * The extension factory re-runs on every pi session replacement, so this
 * slot is module-level: the OLD closure (which handled the `/agent`
 * command) writes it from inside `withSession`, and the NEW closure's
 * first `before_agent_start` drains it with its fresh, non-stale API.
 *
 * Only one switch can be pending at a time (each switch creates its own
 * new session; an abandoned intermediate session is simply not drained).
 */
export interface PendingSwitchOps {
  /** The trimmed active tool set to apply in the new session. */
  activeTools?: string[];
}

/** Module-level pending switch ops (shared across factory closures). */
let pendingSwitchOps: PendingSwitchOps | undefined;

/**
 * Reset the module-level pending switch slot (test isolation).
 *
 * The slot is process-global and bun shares one isolate across test
 * files, so tests must clear it deterministically.
 */
export function _resetPendingSwitchOpsForTesting(): void {
  pendingSwitchOps = undefined;
}

/**
 * Load the whole parsed config.toml.
 *
 * pi's Node/jiti runtime cannot import TOML (see module doc), so the
 * file is read and parsed with the vendored smol-toml `parse` parser.
 * The whole root object is returned (it carries the top-level `agent`
 * table alongside `zoo`) — callers extract the `zoo` section and the
 * agent-mode map from it.  A missing or unreadable file yields an empty
 * root object, which every profile-driven contribution skips (null
 * profile) and which parses no agent modes.
 *
 * @returns The whole parsed config.toml root (empty when absent).
 */
function loadConfig(): any {
  try {
    const text = readFileSync(CONFIG_PATH, "utf-8");
    return parse(text);
  } catch {
    // config.toml missing or unreadable — behave as an absent config.
    return {};
  }
}

/**
 * Wrap text in a truecolor ANSI foreground sequence for a `#RRGGBB` hex.
 *
 * `\x1b[38;2;<r>;<g>;<b>m<text>\x1b[39m` — the same escape form the widget
 * `colorizeAgent` uses for agent names, reused here so the transcript
 * overlay border can carry the inspected run's agent color.  pi's Text /
 * widget components preserve ANSI codes and are ANSI-width-aware.
 *
 * @param hex - The normalized uppercase `#RRGGBB` hex color.
 * @param text - The text to wrap.
 * @returns The text wrapped in the truecolor foreground sequence.
 */
function truecolorWrap(hex: string, text: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/**
 * The terminal tool result's persisted `details`.
 *
 * pi writes a tool result's `details` into the session file (a partial's
 * never do), so this is the only durable payload a subagent run leaves
 * behind.  It carries ONLY the fact pointer — the sub-session file path the
 * driver reported mid-run, looked up by run id (the tool-call id) in the
 * process-level run registry — which lets a view re-hydrate the run's facts
 * after a process restart.  Tools without a registry run (compress /
 * decompress, or a call id that is not a subagent delegation) contribute an
 * empty object.
 *
 * @param toolCallId - pi's tool-call id for the finished call.
 * @returns `{ sessionPath }`, or `{}` when there is nothing to point at.
 */
export function terminalToolDetails(
  toolCallId: unknown,
): Record<string, unknown> {
  const sessionPath =
    typeof toolCallId === "string"
      ? getRun(toolCallId)?.sessionPath
      : undefined;
  return sessionPath === undefined ? {} : { sessionPath };
}

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
 * creation); the (b) memo is the ALS answer's only durable record
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
      // Memoize the (b) answer: the ALS scope does not outlive the
      // event callback that queried it, so without the binding every
      // later lookup would fall through to the root-session default.
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
    agentModes,
    agentPermissions,
    piSwitchHost: hostDeps?.piSwitchHost,
    // The pi subagent driver (in-process SDK session execution).  Only the
    // real pi entry point supplies one; unit tests and other hosts omit it
    // so the subagent tool never registers (fail-closed).
    subagentDriver: hostDeps?.subagentDriver,
    // The pi subagent transcript-card renderer.  Only the real pi entry
    // point supplies one; without it the tool stays text-only.
    subagentRenderer: hostDeps?.subagentRenderer,
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
    // pi has no SDK client — the context-pruning transform runs and
    // returns the pruned replacement to pi.  The release notification
    // does not need the client: it posts through the unified pi tool
    // host's `notify` port as a `zoo-notice` appendEntry entry.  The
    // marking producers (dedup / purge-errors / sweep) have no
    // user-visible notification on pi.
    client: {},
    directory: process.cwd(),
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
  const skillsDir = resolve(__dirname, "../core/skills");
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
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Build the chat-transcript renderer for `zoo-notice` custom entries.
 *
 * pi invokes the renderer with the appended `CustomEntry` (the
 * notification text lives in `data.content`), the render options, and
 * the active `Theme`.  The returned duck-typed `Component` (structurally
 * `{ render(width): string[], invalidate() }`) is placed into the TUI
 * chat transcript by pi's `CustomEntryComponent` — no pi package is
 * imported, mirroring the duck-typing discipline of the rest of the
 * module.  A missing or empty payload degrades to `undefined` so the
 * entry renders as nothing.  Renderer errors are caught and surfaced
 * by pi itself (an error box), so no defensive wrapping is needed here.
 *
 * @returns The `EntryRenderer` for the `zoo-notice` custom type.
 */
export function buildPiNoticeEntryRenderer(): (
  entry: unknown,
  _options: unknown,
  theme: unknown,
) => unknown {
  return (entry, _options, theme) => {
    const data = (entry as { data?: { content?: unknown } } | undefined)?.data;
    const content = typeof data?.content === "string" ? data.content : "";
    if (!content.trim()) return undefined;
    const t = theme as
      | { fg?: (color: string, text: string) => string }
      | undefined;
    const label = t?.fg ? t.fg("customMessageLabel", "[zoo]") : "[zoo]";
    const text = `${label}\n${content}`;
    return {
      render(): string[] {
        return text.split("\n");
      },
      invalidate(): void {},
    };
  };
}

/**
 * Build the pi hook handlers from an explicit zoo config.
 *
 * `before_agent_start` resolves the current agent identity via the
 * identity core (`resolveIdentity`) and prepends the matching composed
 * agent's prompt; when no identity is resolved or the agent is not in
 * the profile the system prompt is returned untouched (fail-closed).
 * `resources_discover` returns the profile-listed skill paths (filtered
 * by the active primary's `[agent.<name>].permission.skill` rules when it
 * has any), an empty array when the profile has none.  `toolResult` and
 * `contextHandler` wrap the composed after-exec / transform
 * contributions via the pi contact layer; with a null profile both are
 * empty so the handlers no-op.  When `piApi` is provided, the
 * profile's tool contributions are registered natively through pi's
 * `registerTool`.
 *
 * Every handler refreshes the shared mutable context holder with the
 * latest pi `ExtensionContext` so the native adapter and tool host can
 * resolve the current session.
 *
 * On load the composed profile is recorded as a `plugin_init` log event
 * (mirroring the OpenCode host), carrying the composed agents, skills,
 * and validation limits.
 *
 * Exported for unit testing — `zookeeperPi` wires this with the config
 * loaded from disk.
 *
 * @param zooConfig - The `zoo` section of config.toml.
 * @param piApi - Optional pi ExtensionAPI instance; when provided, the
 *   active profile's tools are registered with `registerTool`.
 * @param overrides - Optional host-dependency overrides.  Only used by
 *   tests: a bridge test injects a fake subagent driver so the registered
 *   tool executes without loading the real pi SDK.
 * @returns The hook handlers.
 */
export function buildPiHandlers(
  zooConfig: any,
  piApi?: ExtensionAPI,
  rawConfig?: any,
  overrides?: {
    /** Subagent driver used in place of the real pi SDK driver. */
    subagentDriver?: SubagentDriver;
  },
): {
  beforeAgentStart: (
    evt: { systemPrompt: string },
    ctx?: unknown,
  ) => Promise<{ systemPrompt: string }>;
  resourcesDiscover: (
    evt?: unknown,
    ctx?: unknown,
  ) => Promise<{ skillPaths: string[] }>;
  toolResult: ReturnType<typeof buildPiToolResultHandler>;
  contextHandler: ReturnType<typeof buildPiContextHandler>;
  messageEnd: ReturnType<typeof buildPiMessageEndHandler>;
  /** Seed the `zoo` widget at session startup / resume. */
  sessionStart: (evt?: unknown, ctx?: unknown) => Promise<void>;
} {
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
  // The pi switch surfaces for the `/<agent>` commands.  Built ONLY when
  // a pi API instance is supplied: without one (test-only or a host
  // without the surfaces) the switch command unit contributes no
  // commands (fail-closed).  `setWidget` reads the latest extension
  // context's `ui` from the shared holder, which the command handler
  // refreshes before running.
  // The untrimmed tool BASELINE is captured ONCE before any switch can
  // trim it, and held on the host: every switch computes
  // `baseline minus deniedTools(target)` from this fixed set, so tool
  // denies never accumulate across switches.  The capture is DEFERRED to
  // the first switch (lazily, then cached) instead of running at
  // extension-load time: pi forbids calling action methods (including
  // `getActiveTools`) during extension loading — the runtime only binds
  // real actions after the extension factory returns.  First switch is
  // still pre-trim, so the lazily-captured set is the same untrimmed
  // universe.  When the API reports no baseline the host returns
  // `undefined` and switches skip the trim (fail-closed).
  let toolBaseline: string[] | undefined;
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

  // The `zoo` fleet widget — the component factory registered above the
  // editor.  It reads the active primary live from the identity core and
  // the run registry for the current session, so a primary switch (or a
  // registry write) only needs to nudge `refresh()`.  The widget is
  // created once per extension closure (pi re-runs the extension factory
  // on every session replacement, so each session gets its own instance
  // bound to its own TUI).
  //
  // `enterRun` wires the expanded list's enter-inspect: pressing enter on a
  // selected run opens a full-screen read-only overlay rendering that run's
  // transcript as a pure projection of the fact log it is given.  While the
  // run is still running new facts stream onto the open overlay through the
  // log's append notifications — event-driven, no session switch.  A run
  // whose registry log is empty is the exception: finished runs (their log
  // is released at finish — the registry keeps metadata only) and post-
  // restart scanner-rebuilt runs are exactly this shape, so their facts have
  // to be restored
  // from the persisted sub-session file first (see the hydration gate in the
  // callback).  The overlay is opened through the pi `ExtensionUIContext.custom`
  // surface, which pi exposes on every event context's `ui`, so the callback
  // reads it from the shared context holder.  When no `ui.custom` is cached,
  // no overlay can open: the callback returns `false` so the widget leaves
  // enter unconsumed (the key falls through to the editor); otherwise the key
  // is always consumed.
  //
  // Runs whose overlay open is deferred on a transcript load: a second enter
  // while that load is in flight must not stack a second overlay.
  const deferredOverlayOpens = new Set<string>();
  const fleetWidget = createFleetWidget({
    getPrimary: () => getPrimary(),
    colorizeAgent,
    getSessionId: sessionIdProvider,
    getEditorText: () => contextHolder.current?.ui?.getEditorText?.() ?? "",
    enterRun: (run) => {
      const ui = contextHolder.current?.ui;
      if (ui?.custom === undefined) return false;
      const openOverlay = ui.custom.bind(ui);
      // Collapse the fleet widget to its one-line stable state BEFORE the
      // overlay opens: pi's overlay compositor line-diffs the base content,
      // and an expanded widget (~10 lines) that collapses mid-overlay (the
      // editor-focus guard on each keypress) would mutate the base length
      // under it, forcing a full re-paint.  `collapse()` is idempotent —
      // an already-collapsed widget is unchanged (and the overlay keeps the
      // collapsed state; ↓ re-expands it after close, as before).
      fleetWidget.collapse();
      // Open the overlay on a chosen fact log (empty-log notice optional).
      const open = (log: RunLog, emptyNotice?: string): boolean =>
        openTranscriptOverlay({
          log,
          title: runTitle(run),
          // The overlay title uses the inspected run's agent color; absent a
          // configured color the overlay falls back to its fixed border color.
          borderColorize: agentBorderColorize(run),
          // The working directory the sub-session ran in — the native tool
          // renderers' render context (see `openTranscriptOverlay`).  Read at
          // open time because `run.sessionPath` is patched mid-run, so a run
          // whose path is still unknown (or whose header cannot be read)
          // leaves `cwd` undefined and the renderers use their non-cwd
          // fallback formats.
          cwd:
            typeof run.sessionPath === "string" && run.sessionPath.length > 0
              ? readSessionCwd(run.sessionPath)
              : undefined,
          ...(emptyNotice === undefined ? {} : { emptyNotice }),
          openOverlay,
        });
      // HYDRATION GATE.  `finishRun` releases a finished run's in-memory log
      // (resident memory tracks active work only), and the post-restart
      // history scanner rebuilds runs from persisted sessions with lifecycle
      // metadata only — so in both cases a terminal run's registry log is
      // empty while its full transcript sits intact in `run.sessionPath`;
      // opening straight on `run.log` would render "(empty transcript)" for
      // a run that clearly produced work.  Restore the facts through the
      // shared hydration cache the inline card already uses (keyed by run id,
      // so the card and this overlay dedupe one load): open on the settled
      // log when it is ready, state `TRANSCRIPT_UNAVAILABLE_NOTICE` when the
      // load failed (a gone or unparseable file — the failure stays cached
      // until eviction, after which the id returns to `missing` and a later
      // open retries the load), and otherwise join the load and open when it
      // settles, which costs a few milliseconds of dead time on the keypress
      // but never shows a transcript that is not there.  A still-RUNNING run
      // is excluded on purpose: its log is the live source, and a file
      // snapshot would both repeat the facts already appended and cut the
      // open overlay off from the driver's later appends.  A finished run
      // with an EMPTY log and no session path at all is the other dead end —
      // nothing to restore from anywhere (a run that failed or was aborted
      // before its prompt reached the host leaves exactly this shape), so it
      // opens on the explicit "nothing was recorded" notice rather than the
      // generic empty line.
      const sessionPath = run.sessionPath;
      if (run.status !== "running" && run.log.facts().length === 0) {
        if (typeof sessionPath !== "string" || sessionPath.length === 0) {
          return open(run.log, TRANSCRIPT_NOT_RECORDED_NOTICE);
        }
        const state = hydrationState(run.id);
        if (state.kind === "ready") return open(state.log);
        if (state.kind === "failed")
          return open(run.log, TRANSCRIPT_UNAVAILABLE_NOTICE);
        if (deferredOverlayOpens.has(run.id)) return true;
        deferredOverlayOpens.add(run.id);
        beginHydration(run.id, sessionPath);
        void waitForHydration(run.id).then(() => {
          deferredOverlayOpens.delete(run.id);
          const settled = hydrationState(run.id);
          if (settled.kind === "ready") {
            open(settled.log);
          } else {
            open(run.log, TRANSCRIPT_UNAVAILABLE_NOTICE);
          }
        });
        return true;
      }
      return open(run.log);
    },
  });
  const piSwitchHost: PiSwitchHost | undefined = piApi
    ? {
        getBaselineTools: () => {
          // Capture once, on first call (which happens inside a command
          // handler — always post-bind).  A `[]` report is cached too:
          // callers treat it as "no baseline" and skip the trim rather
          // than wiping every tool.
          if (toolBaseline === undefined) {
            toolBaseline = piApi.getActiveTools?.();
          }
          return toolBaseline;
        },
        setActiveTools: (names) => piApi.setActiveTools?.(names),
        // For the `zoo` key this is now a "primary changed" notification:
        // the fleet widget reads the active primary live, so the switch
        // only nudges it to re-render.  Every other key passes through
        // plain.  `undefined` content hides the widget.
        setWidget: (key, lines) => {
          if (key === "zoo") {
            fleetWidget.refresh();
            return;
          }
          contextHolder.current?.ui?.setWidget?.(key, lines, {
            placement: "aboveEditor",
          });
        },
        // Replace the current session with a fresh one re-bound to the
        // target identity.  Delegates to the pi command context's
        // `newSession` (the same REPLACE operation the `/go` handoff
        // target uses): the old session is torn down, the new one is
        // created with the target as parent (so its bind-time
        // `session_start`, `resources_discover`, and first
        // `before_agent_start` already resolve the new primary), and the
        // `withSession` callback runs against the fresh session's
        // context.
        //
        // REGRESSION NOTE: pi invalidates the captured extension API and
        // command context after `newSession` — calling the old `piApi`
        // action methods inside `withSession` throws "This extension ctx
        // is stale after session replacement or reload...".  The facade
        // handed to `withSession` therefore binds every operation to the
        // FRESH `ReplacedSessionContext` pi passes there (which
        // structurally inherits the command-context surface):
        //   - `setWidget` runs immediately via `newCtx.ui.setWidget`
        //     (pi exposes `ui` on the replaced-session context).
        //   - `setActiveTools` would touch the OLD session's action
        //     bindings, which pi invalidates on replacement — so it is
        //     deferred (stashed into the module-level pending slot) and
        //     applied at the new session's first `before_agent_start`,
        //     where the fresh closure's API is non-stale.
        newSession: async (options) => {
          const cmdCtx = contextHolder.current as PiCommandCtx | undefined;
          if (!cmdCtx?.newSession) {
            throw new Error(
              "pi session replacement API is not available. " +
                "Ensure the pi command context exposes newSession.",
            );
          }
          // Clear any stale pending ops from a previous replacement so an
          // abandoned intermediate session never leaks its trim into the
          // next one.
          pendingSwitchOps = undefined;
          return cmdCtx.newSession({
            parentSession: options.parentSession,
            withSession: (newCtx) => {
              // All post-replacement work must run against the fresh
              // session's context — the old command context is stale once
              // the session is replaced.
              contextHolder.current = newCtx as PiToolHostContext;
              const ops: PiSwitchNewSessionOps = {
                // The `zoo` widget is a "primary changed" notification: the
                // fleet widget reads the primary live, so the switch only
                // nudges a refresh.  Every other key passes through plain.
                setWidget: (key, lines) => {
                  if (key === "zoo") {
                    fleetWidget.refresh();
                    return;
                  }
                  newCtx.ui?.setWidget?.(key, lines, {
                    placement: "aboveEditor",
                  });
                },
                // Applying the trim here would touch the stale action
                // bindings that pi invalidates on replacement — defer it
                // to the new session's first `before_agent_start`.
                setActiveTools: (names) => {
                  pendingSwitchOps = {
                    ...(pendingSwitchOps ?? {}),
                    activeTools: names,
                  };
                },
              };
              return options.withSession?.(ops);
            },
          });
        },
      }
    : undefined;
  const { profile, composed, limits } = buildPiContributions(
    zooConfig,
    {
      adapter,
      toolHost,
      piSwitchHost,
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
    },
    rawConfig,
  );

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
  // no-op silently (matching the old `seedWidget` fail-closed behaviour).
  const registerFleetWidget = (): void => {
    if (!piApi) return;
    const ui = contextHolder.current?.ui;
    if (!ui) return;
    // Fail-closed: without an active primary (no configured primary agent)
    // no widget is registered — the fleet line is primary-driven and a
    // primary-less session renders nothing (matching the old seedWidget).
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
  if (piApi?.registerTool) {
    const registered = new Set<string>();
    for (const tool of Object.values(composed.tools)) {
      if (registered.has(tool.name)) continue;
      registered.add(tool.name);
      const args = tool.args ?? {};
      const required = tool.required ?? Object.keys(args);
      piApi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        // Forward the tool's custom TUI renderers (the subagent transcript
        // card) so pi draws the animated card instead of a static result.
        // Tools without renderers (compress / decompress) simply omit them.
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
          const text = await tool.execute(params, ctx, {
            ...(typeof toolCallId === "string" && toolCallId.length > 0
              ? { callId: toolCallId }
              : {}),
            ...(signal instanceof AbortSignal ? { signal } : {}),
            ...(onUpdate !== undefined ? { onUpdate } : {}),
          });
          return {
            content: [{ type: "text", text }],
            details: terminalToolDetails(toolCallId),
          };
        },
      });
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
    piApi.registerEntryRenderer("zoo-notice", buildPiNoticeEntryRenderer());
  }

  // The core handlers have no access to the mutable context holder, so
  // every pi-facing handler is wrapped to refresh the holder with the
  // current ExtensionContext before delegating to the core handler.
  const toolResultHandler = buildPiToolResultHandler(composed.afterExec);
  const contextHandler = buildPiContextHandler(composed.transform);
  const messageEndHandler = buildPiMessageEndHandler();

  return {
    async beforeAgentStart(evt, ctx?) {
      if (ctx) contextHolder.current = ctx as PiToolHostContext;
      // Drain any pending post-replacement switch operations.  This
      // handler runs in the NEW session's closure (the factory re-ran on
      // `newSession`), so the `piApi` in scope here is the fresh,
      // non-stale one — unlike the captured API that pi invalidated on
      // replacement.  The tool trim was queued from `withSession`
      // (the tool trim was deferred from `withSession` to avoid touching
      // the stale action bindings) and is applied
      // here exactly once at the new session's first turn.
      if (pendingSwitchOps !== undefined) {
        const ops = pendingSwitchOps;
        pendingSwitchOps = undefined;
        if (ops.activeTools !== undefined) {
          piApi?.setActiveTools?.(ops.activeTools);
        }
      }
      // Fallback seed: covers flows where `session_start` fires before the
      // identity is set, or a session begins without a `session_start` in
      // some flows.  Registration is idempotent — re-running it re-seeds the
      // widget and never stacks a terminal-input listener.
      registerFleetWidget();
      // Resolve the current agent identity: the AsyncLocalStorage store
      // first (a delegated sub-session), falling back to the active
      // primary.  The composed agents list is looked up by the resolved
      // identity's name; when the machinery is off (no primary) or the
      // agent is not in the profile the system prompt is returned
      // unchanged (silent fail-closed).
      const identity = resolveIdentity();
      const agentPrompt = identity
        ? composed.agents.find((agent) => agent.name === identity.name)?.prompt
        : undefined;
      return {
        systemPrompt:
          agentPrompt === undefined
            ? evt.systemPrompt
            : `${agentPrompt}\n\n${evt.systemPrompt}`,
      };
    },
    async sessionStart(_evt?, ctx?) {
      if (ctx) contextHolder.current = ctx as PiToolHostContext;
      // Register the fleet widget at session startup / resume (before any
      // LLM turn), so the current primary shows immediately.
      // `before_agent_start` runs the same registration as a fallback.
      registerFleetWidget();
      // Rebuild the run registry from the session's persisted message
      // history.  The registry is process-level state, so a pi exit wipes
      // it; on restore / resume this rescans the current session's `subagent`
      // tool calls (via `buildContextEntries()`) and rewrites the registry,
      // so the fleet widget keeps showing historical subagent runs.  The
      // rebuild is recursive: each finished run's `details.sessionPath`
      // points at its sub-session file, which is rescanned for nested
      // delegations (beaver → lynx → ...), reconstructing the full
      // parent/child tree.  A missing / unreadable sub-session file skips
      // only that branch (warn).  Idempotent: run ids are the pi run ids
      // and the registry's terminal-immutability rule never duplicates or
      // overwrites an existing entry.  Best-effort: an unavailable session
      // manager / history leaves the registry untouched (fresh session).
      const sessionId = contextHolder.current?.sessionManager?.getSessionId();
      const sessionManager = contextHolder.current?.sessionManager;
      if (
        typeof sessionId === "string" &&
        sessionId.length > 0 &&
        sessionManager?.buildContextEntries !== undefined
      ) {
        try {
          // Call as a method: extracting the function reference unbinds
          // `this`, and pi's SessionManager.buildContextEntries reads
          // `this.getEntries()` — an unbound call crashes at runtime.
          const entries =
            sessionManager.buildContextEntries() as PiHistoryEntry[];
          rebuildSubagentRuns(entries, sessionId);
        } catch (err) {
          log(
            "plugin",
            "registry_rebuild_failed",
            sessionId,
            undefined,
            "warn",
            { error: String(err) },
          );
        }
      }
      fleetWidget.refresh();
    },
    async resourcesDiscover(_evt?, ctx?) {
      if (ctx) contextHolder.current = ctx as PiToolHostContext;
      // Filter the contributed skill directories by the active primary's
      // `[agent.<name>].permission.skill` rules.  The filter applies at
      // session-bind time against the primary active AT THAT MOMENT — pi's
      // `resources_discover` fires once per session bind and its results are
      // merge-only (cannot be retracted mid-session), so a later runtime
      // `/mola` switch does NOT re-filter the already-contributed skills
      // (accepted pi limitation).  When no primary is configured, or the
      // primary has no skill rules, the full profile list is contributed
      // unfiltered (machinery-off behaviour unchanged, consistent with
      // `before_agent_start`).
      const primary = getPrimary();
      const rules =
        primary === undefined ? undefined : skillPermissions[primary];
      if (rules === undefined) {
        return { skillPaths: collectSkillPaths(profileSkills) };
      }
      const kept: string[] = [];
      const dropped: string[] = [];
      for (const name of profileSkills) {
        if (isSkillAllowed(rules, name)) kept.push(name);
        else dropped.push(name);
      }
      log("resources", "skills_filtered", "", undefined, "info", {
        agent: primary,
        kept: kept.length,
        dropped: dropped.length,
      });
      return { skillPaths: collectSkillPaths(kept) };
    },
    toolResult: async (event, ctx) => {
      if (ctx) contextHolder.current = ctx as PiToolHostContext;
      return toolResultHandler(event, ctx);
    },
    contextHandler: async (event, ctx) => {
      if (ctx) contextHolder.current = ctx as PiToolHostContext;
      return contextHandler(event, ctx);
    },
    messageEnd: (event, ctx) => {
      if (ctx) contextHolder.current = ctx as PiToolHostContext;
      if (profile === null) return undefined;
      return messageEndHandler(event, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Register ZooKeeper hooks with pi.
 *
 * All hooks are profile-driven: a `null` profile (absent or invalid)
 * yields an empty composition, so every handler no-ops (fail-closed,
 * aligned with the OpenCode host).  `session_start` seeds the `zoo`
 * widget (rendered above the editor) with the current primary at session
 * startup / resume (the same seed runs as a `before_agent_start`
 * fallback).  The `tool_result` and `context` handlers are always
 * registered — their actual contributions come from the profile's hooks
 * list (after-exec and transform units).  The `message_end` handler is
 * always registered and strips model-imitated line-start ref echoes from
 * finalized assistant text when the profile is active.  Profile commands
 * (e.g. `/dcp` and the config-derived `/<agent>` primary-switch commands)
 * are registered with pi and the `zoo-notice` entry renderer is wired so
 * appended notification cards draw in the TUI transcript.
 *
 * Strategy for `before_agent_start`:
 *   **Prepend** the resolved identity's prompt rather than replacing the
 *   chainable system prompt.  This keeps the orchestrator identity
 *   dominant while preserving pi's native coding-assistant prompt and
 *   tool descriptions.  Replacing outright would lose pi's
 *   tool-injection and built-in instructions.
 *
 * @param pi - pi ExtensionAPI instance (provided at runtime by pi).
 */
export function zookeeperPi(pi: ExtensionAPI): void {
  const config = loadConfig();
  const zooConfig = config.zoo ?? {};
  initPluginLogger(zooConfig, "pi");
  const handlers = buildPiHandlers(zooConfig, pi, config);
  pi.on("session_start", handlers.sessionStart);
  pi.on("before_agent_start", handlers.beforeAgentStart);
  pi.on("resources_discover", handlers.resourcesDiscover);
  pi.on("tool_result", handlers.toolResult);
  pi.on("context", handlers.contextHandler);
  pi.on("message_end", handlers.messageEnd);
}

export default zookeeperPi;
