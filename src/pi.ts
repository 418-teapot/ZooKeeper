/**
 * ZooKeeper Pi extension — profile-driven hooks composed from the unit
 * registry.
 *
 * This extension registers six event hooks plus slash commands, all
 * driven by the active mode profile (`[zoo.mode.<name>]`, parsed by
 * `parseModeProfile`):
 * 1. `session_start` — seeds the bottom status-bar `zoo` indicator with
 *    the current primary at session startup / resume, so it appears
 *    immediately without waiting for the first LLM turn (a
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
 *    with pi via `registerCommand`; their chat notifications route
 *    through pi's in-session `appendEntry` channel (persistent in the
 *    session, rendered by the `zoo-dcp` entry renderer, never entering
 *    the LLM context) instead of the tool toast.  The primary-switch
 *    unit contributes one `/<agent>` command per configured primary;
 *    each replaces the current session with a fresh one re-bound to the
 *    target identity (setPrimary → newSession with the post-replacement
 *    tool trim + status inside `withSession`).
 *
 * Architecture: units contribute host-agnostic slots (`src/core/slots.ts`)
 * and the pi contact layer (`src/compose-pi.ts`) is the only module that
 * understands pi's event keys — it maps the `ComposedResult` to the
 * event handlers and the command registrations.  The composition feeds
 * the full registry to `composeProfile`; tool units instantiate
 * harmlessly and their slots are not consumed by pi (the command slot
 * is consumed — the command units are re-composed with the command tool
 * host so their notifications route through pi's `appendEntry`
 * channel).
 * Every hook and command is profile-driven: a `null` profile (absent or
 * invalid) yields an empty composition, so all hooks no-op and no
 * command is registered — fail-closed, aligned with the OpenCode host.
 *
 * Capability gating: pi passes an empty client object (no SDK client),
 * so the dedup-release notification inside context-pruning cannot use
 * the SDK session-prompt API.  With a profile whose primary-agent set is
 * non-empty the `sessionAgentMap` resolves the agent to the default
 * primary (first in profile array order) and the missing API is caught
 * and logged as `dedup_notify_failed` (warn); without a primary the map
 * is empty and the notification is suppressed as
 * `dedup_notify_suppressed`.  The pruning transform runs and returns
 * the pruned replacement to pi.  The direct-work nudge's primary-agent
 * gate is satisfied by a `sessionAgentMap` whose lookups always resolve
 * to the default primary (a pi session is the orchestrator); without a
 * primary the map is empty and the nudge stays silent.
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
import {
  createPiHandoffTarget,
  type PiCommandCtx,
} from "./adapters/pi/handoff-target.js";
import {
  createPiToolHost,
  type PiContextHolder,
  type PiToolHostContext,
} from "./adapters/pi/tool-host.js";
import {
  buildPiCommandRegistrationPlan,
  buildPiContextHandler,
  buildPiMessageEndHandler,
  buildPiToolResultHandler,
  createPiCommandToolHost,
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
import type {
  ComposedResult,
  Deps,
  PiSwitchHost,
  PiSwitchNewSessionOps,
} from "./core/slots.js";
import {
  derivePrimaries,
  getPrimary,
  resolveIdentity,
  setPrimary,
} from "./core/subagent/identity.js";
import {
  isSkillAllowed,
  parseSkillPermissions,
} from "./core/subagent/skill-permissions.js";
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

// ---------------------------------------------------------------------------
// Profile-driven composition
// ---------------------------------------------------------------------------

/**
 * Build the session → agent map for the pi host.
 *
 * pi has no sub-agent sessions: the single session is the orchestrator,
 * so when the profile has a non-empty primary-agent set the map resolves
 * every lookup to the default primary (the first primary in profile
 * array order, derived from the agent modes map) — this satisfies the
 * direct-work nudge's primary gate and the dedup-release notification.
 * A profile with no primary yields an empty map and both stay silent.
 *
 * @param profile - The active mode profile, or `null` when absent.
 * @param agentModes - Per-agent role map (`[agent.*].mode`), parsed
 *   fail-closed by `parseAgentModes`.
 * @returns A map resolving to the default primary, or an empty map.
 */
function sessionAgentMapFor(
  profile: ModeProfile | null,
  agentModes: AgentModeMap,
): Map<string, string> {
  const primaries = derivePrimaries(profile?.agents ?? [], agentModes);
  if (primaries.length > 0) {
    const defaultPrimary = primaries[0];
    return new (class extends Map<string, string> {
      get(_key: string): string {
        return defaultPrimary;
      }
    })();
  }
  return new Map();
}

/**
 * Compose the profile-driven contributions for pi.
 *
 * The full registry is fed to the selection engine — pi composes every
 * category and consumes the agent, skill, after-exec, transform, and
 * command slots (the `unknown_unit` warning fires when a profile name
 * has no matching registry unit).  `Deps` are adapted to the pi host:
 * `client` is empty, `directory` is the process working directory,
 * `sessionAgentMap` resolves to the default primary (first in profile
 * array order among the agent-modes-marked primaries) when the profile
 * has any, and the host adapter / tool host are taken from `hostDeps`
 * when provided (the entry point supplies the live context holder so
 * event handlers can update it).
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
    commandToolHost?: ToolHost;
    piSwitchHost?: PiSwitchHost;
    getCommandCtx?: () => PiCommandCtx | null | undefined;
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
    // pi has no SDK client — the context-pruning transform runs and
    // returns the pruned replacement to pi.  With a non-empty primary
    // set the dedup-release notification resolves the default primary
    // and fails on the missing session-prompt API as
    // `dedup_notify_failed` (warn); without a primary the empty map
    // suppresses it as `dedup_notify_suppressed`.
    client: {},
    directory: process.cwd(),
    sessionAgentMap: sessionAgentMapFor(modeProfile, agentModes),
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

  // Command units are re-composed with the command-specific tool host
  // so slash-command chat notifications (e.g. /dcp reports) route through
  // pi's in-session `appendEntry` channel instead of the tool toast.  The
  // command tool host shares history/session resolution with the base host
  // but replaces `notify`; the tool units keep the base host's toast.
  // `unit.create` is side-effect free (verified against every registry
  // unit — the factories only return contribution objects), so a second
  // `composeProfile` pass with the command host yields identical command
  // contributions without re-implementing the profile filter/collect
  // strategy.  Only the commands slot of the second pass is taken.
  // The pass keeps the full profile (the active set handed to command
  // factories must reflect the real enablement — e.g. `/dcp compress`
  // reads `activeSet.tools`), so its `unknown_unit` warnings are
  // suppressed to avoid duplicating the first pass's.
  if (modeProfile !== null && hostDeps?.commandToolHost) {
    const commandDeps: Deps = { ...deps, toolHost: hostDeps.commandToolHost };
    const commandComposed = composeProfile(modeProfile, REGISTRY, commandDeps, {
      warnUnknownUnits: false,
    });
    composed.commands = commandComposed.commands;
  }

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
 * Build the chat-transcript renderer for `zoo-dcp` custom entries.
 *
 * pi invokes the renderer with the appended `CustomEntry` (the report
 * text lives in `data.content`), the render options, and the active
 * `Theme`.  The returned duck-typed `Component` (structurally
 * `{ render(width): string[], invalidate() }`) is placed into the TUI
 * chat transcript by pi's `CustomEntryComponent` — no pi package is
 * imported, mirroring the duck-typing discipline of the rest of the
 * module.  A missing or empty payload degrades to `undefined` so the
 * entry renders as nothing.  Renderer errors are caught and surfaced
 * by pi itself (an error box), so no defensive wrapping is needed here.
 *
 * @returns The `EntryRenderer` for the `zoo-dcp` custom type.
 */
export function buildPiDcpEntryRenderer(): (
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
    const label = t?.fg ? t.fg("customMessageLabel", "[zoo-dcp]") : "[zoo-dcp]";
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
 * @returns The hook handlers.
 */
export function buildPiHandlers(
  zooConfig: any,
  piApi?: ExtensionAPI,
  rawConfig?: any,
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
  /** Seed the status-bar indicator at session startup / resume. */
  sessionStart: (evt?: unknown, ctx?: unknown) => Promise<void>;
} {
  // Mutable holder updated by every event handler so the pi adapter and
  // tool host always see the latest ExtensionContext.
  const contextHolder: PiContextHolder = { current: undefined };
  const sessionIdProvider = () =>
    contextHolder.current?.sessionManager?.getSessionId();
  const adapter = createPiAdapter(sessionIdProvider);
  const toolHost = createPiToolHost(contextHolder);
  // The command tool host shares the base host's history/session
  // resolution but routes chat notifications through pi's in-session
  // `appendEntry` channel (persistent, no LLM context) — the pi
  // equivalent of v1's ignored noReply message.  The base toast notify
  // stays for the tool units' runtime prompts.
  // `appendEntry` is passed as a value to `createPiCommandToolHost`, so
  // it is defensively bound to the API object when present (pi's current
  // implementation is closure-based and works unbound, but a future
  // `this`-dependent implementation would silently break otherwise).
  const appendEntry =
    typeof piApi?.appendEntry === "function"
      ? piApi.appendEntry.bind(piApi)
      : undefined;
  const commandToolHost = createPiCommandToolHost(toolHost, appendEntry);
  // The pi switch surfaces for the `/<agent>` commands.  Built ONLY when
  // a pi API instance is supplied: without one (test-only or a host
  // without the surfaces) the switch command unit contributes no
  // commands (fail-closed).  `setStatus` reads the latest extension
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
  // The per-agent status-bar colors (`[agent.<name>].color`), parsed
  // fail-closed from the whole config root.  Only the `zoo` indicator is
  // colorized below — the tool / command surfaces stay plain.
  const agentColors = parseAgentColors(rawConfig ?? {});
  // The per-agent skill permission rules (`[agent.<name>].permission.skill`),
  // parsed fail-closed from the whole config root.  `resources_discover`
  // filters the contributed skill directories by the active primary's
  // rules; an agent absent from the map (or no primary) contributes
  // unfiltered (default-allow, machinery-off unchanged).
  const skillPermissions = parseSkillPermissions(rawConfig ?? {});

  // Wrap a name in a truecolor ANSI foreground sequence when the agent
  // has a configured color; otherwise return it unchanged (fail-closed).
  // pi's status-bar sanitizer only strips `[\r\n\t]` and its width
  // truncation is ANSI-aware, so the raw escape codes survive and render.
  const colorizeAgent = (name: string): string => {
    const hex = agentColors[name];
    if (hex === undefined) return name;
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    return `\x1b[38;2;${r};${g};${b}m${name}\x1b[39m`;
  };
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
        // Colorize ONLY the bottom status-bar `zoo` indicator (the
        // active-primary label): every other key passes through plain.
        // A name with no configured color stays plain (fail-closed).
        setStatus: (key, text) =>
          contextHolder.current?.ui?.setStatus?.(
            key,
            key === "zoo" && text !== undefined ? colorizeAgent(text) : text,
          ),
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
        //   - `setStatus` runs immediately via `newCtx.ui.setStatus`
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
                // pi exposes `ui.setStatus` on the replaced-session
                // context, so the status bar updates immediately.
                setStatus: (key, text) =>
                  newCtx.ui?.setStatus?.(
                    key,
                    key === "zoo" && text !== undefined
                      ? colorizeAgent(text)
                      : text,
                  ),
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
      commandToolHost,
      piSwitchHost,
      // The `/go` handoff target reads the latest pi command context
      // through this supplier: the command handler refreshes the shared
      // holder immediately before the handler body runs.
      getCommandCtx: () => contextHolder.current as PiCommandCtx | undefined,
    },
    rawConfig,
  );

  // Whether the bottom status-bar `zoo` indicator has been seeded for
  // this session.  The seed runs once inside the first `session_start`
  // event (see below), with a `before_agent_start` fallback; a flag keeps
  // it from re-firing on later events within the same pi session.
  let statusSeeded = false;

  // Seed the bottom status-bar `zoo` indicator with the active primary.
  // `setStatus` reads the latest extension context's `ui`, so it can only
  // run inside an event handler (never at extension-load time — pi forbids
  // action methods during load, and the `ui` surface is absent then).  Fails
  // closed: no pi switch host, no active primary, or no `ui` surface all
  // no-op silently.  Once seeded, later events do not overwrite the
  // indicator.
  const seedStatus = (): void => {
    if (statusSeeded || !piSwitchHost) return;
    const primary = getPrimary();
    if (primary === undefined) return;
    piSwitchHost.setStatus("zoo", primary);
    statusSeeded = true;
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
        // pi's validateToolArguments accepts plain JSON-Schema parameters.
        parameters: {
          type: "object",
          properties: args,
          ...(required.length > 0 ? { required } : {}),
        } as unknown as object,
        execute: async (
          _toolCallId: unknown,
          params: unknown,
          _signal: unknown,
          _onUpdate: unknown,
          ctx: unknown,
        ) => {
          const text = await tool.execute(params, ctx);
          return {
            content: [{ type: "text", text }],
            details: {},
          };
        },
      });
    }
  }

  // Register profile commands with pi when an API instance is supplied.
  // The handler refreshes the shared context holder with pi's command
  // context so the command tool host can resolve the session / history.
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

  // Register the `zoo-dcp` entry renderer so appended dcp reports draw
  // a card in the TUI chat transcript.  Gated on the composed commands
  // slot rather than the profile's nullness: the renderer is needed only
  // when the `dcp` command is actually registered (fail-closed — a null
  // profile or a profile without dcp in its commands list registers no
  // renderer).  The renderer itself is duck-typed (no pi package import);
  // absent API degrades to nothing.
  if ("dcp" in composed.commands && piApi?.registerEntryRenderer) {
    piApi.registerEntryRenderer("zoo-dcp", buildPiDcpEntryRenderer());
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
      // some flows.  The `statusSeeded` guard keeps it idempotent.
      seedStatus();
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
      // Seed the indicator at session startup / resume (before any LLM
      // turn), so the current primary shows immediately.  `before_agent_start`
      // runs the same seed as a fallback.
      seedStatus();
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
 * aligned with the OpenCode host).  `session_start` seeds the bottom
 * status-bar `zoo` indicator with the current primary at session startup
 * / resume (the same seed runs as a `before_agent_start` fallback).  The
 * `tool_result` and `context` handlers are always registered — their
 * actual contributions come from the profile's hooks list (after-exec and
 * transform units).  The `message_end` handler is always registered and
 * strips model-imitated line-start ref echoes from finalized assistant
 * text when the profile is active.  Profile commands (e.g. `/dcp` and the
 * config-derived `/<agent>` primary-switch commands) are registered with
 * pi and the `zoo-dcp` entry renderer is wired so appended reports draw
 * cards in the TUI transcript.
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
