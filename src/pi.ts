/**
 * ZooKeeper Pi extension — profile-driven hooks composed from the unit
 * registry.
 *
 * This extension registers five hooks, all driven by the active mode
 * profile (`[zoo.mode.<name>]`, parsed by `parseModeProfile`):
 * 1. `before_agent_start` — prepends the dolphin orchestrator prompt to
 *    the chainable system prompt when the profile's agents list names
 *    `dolphin`.
 * 2. `resources_discover` — contributes the profile-listed skill
 *    directories from core/skills/ so pi can load them via
 *    loadSkillsFromDir; an empty profile skills list contributes none.
 * 3. `tool_result` — runs the composed after-exec contributions against
 *    the tool-result text (handler built by `buildPiToolResultHandler`).
 * 4. `context` — runs the composed transform contributions against the
 *    native pi message list and returns the pruned replacement.
 * 5. `message_end` — strips model-imitated `[mN] ` line-start ref
 *    prefixes from finalized assistant text parts (handler built by
 *    `buildPiMessageEndHandler`).
 * 6. commands — the composed slash commands (e.g. `/dcp`) are registered
 *    with pi via `registerCommand`; their chat notifications route
 *    through pi's in-session `appendEntry` channel (persistent in the
 *    session, rendered by the `zoo-dcp` entry renderer, never entering
 *    the LLM context) instead of the tool toast.
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
 * the SDK session-prompt API.  With a dolphin-enabled profile the
 * `sessionAgentMap` resolves the agent to "dolphin" and the missing
 * API is caught and logged as `dedup_notify_failed` (warn); without
 * dolphin the map is empty and the notification is suppressed as
 * `dedup_notify_suppressed`.  The pruning transform runs and returns
 * the pruned replacement to pi.  The direct-work nudge's dolphin gate
 * is satisfied by a `sessionAgentMap` whose lookups always resolve to
 * "dolphin" (a pi session is the orchestrator); without a
 * dolphin-enabled profile the map is empty and the nudge stays silent.
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
  parseContextConfig,
  parseLimits,
  parseModeProfile,
} from "./core/config-parse.js";
import type { ModeProfile } from "./core/config-types.js";
import type { HostAdapter } from "./core/context/lens.js";
import type { ComposedResult, Deps } from "./core/slots.js";
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
 * Load the `zoo` section of config.toml.
 *
 * pi's Node/jiti runtime cannot import TOML (see module doc), so the
 * file is read and parsed with the vendored smol-toml `parse` parser.
 * A missing or unreadable file yields an empty zoo section, which every
 * profile-driven contribution skips (null profile).
 *
 * @returns The `zoo` section object (empty when absent/unreadable).
 */
function loadZooConfig(): any {
  try {
    const text = readFileSync(CONFIG_PATH, "utf-8");
    return parse(text).zoo ?? {};
  } catch {
    // config.toml missing or unreadable — behave as an absent section.
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
 * so when the profile enables dolphin the map resolves every lookup to
 * "dolphin" (the direct-work nudge's gate).  A profile without dolphin
 * yields an empty map and the nudge stays silent.
 *
 * @param profile - The active mode profile, or `null` when absent.
 * @returns A map resolving to "dolphin", or an empty map.
 */
function sessionAgentMapFor(profile: ModeProfile | null): Map<string, string> {
  if (profile?.agents?.includes("dolphin")) {
    return new (class extends Map<string, string> {
      get(_key: string): string {
        return "dolphin";
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
 * `sessionAgentMap` resolves to "dolphin" when the profile enables
 * dolphin, and the host adapter / tool host are taken from `hostDeps`
 * when provided (the entry point supplies the live context holder so
 * event handlers can update it).
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
  },
): {
  profile: ModeProfile | null;
  composed: ComposedResult;
  limits: ValidationLimits;
} {
  const limits = parseLimits(zooConfig);
  const contextConfig = parseContextConfig(zooConfig);
  const modeProfile = parseModeProfile(zooConfig);

  const deps: Deps = {
    limits,
    contextConfig,
    // pi has no SDK client — the context-pruning transform runs and
    // returns the pruned replacement to pi.  With dolphin enabled the
    // dedup-release notification resolves the agent ("dolphin") and fails
    // on the missing session-prompt API as `dedup_notify_failed` (warn);
    // without dolphin the empty map suppresses it as `dedup_notify_suppressed`.
    client: {},
    directory: process.cwd(),
    sessionAgentMap: sessionAgentMapFor(modeProfile),
    toolHost: hostDeps?.toolHost,
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

  return { profile: modeProfile, composed, limits };
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
 * `before_agent_start` prepends the composed dolphin prompt when the
 * profile's agents list names `dolphin`; otherwise the system prompt is
 * returned untouched.  `resources_discover` returns the profile-listed
 * skill paths, an empty array when the profile has none.  `toolResult`
 * and `contextHandler` wrap the composed after-exec / transform
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
 * @returns The five hook handlers.
 */
export function buildPiHandlers(
  zooConfig: any,
  piApi?: ExtensionAPI,
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
  const { profile, composed, limits } = buildPiContributions(zooConfig, {
    adapter,
    toolHost,
    commandToolHost,
  });

  // Startup anchor: mirror the OpenCode host's `plugin_init` event so a
  // pi log records which profile-driven composition was loaded.  Sessionless
  // (load-time) entry: it buffers and flushes into the first pi session's
  // file once that session materialises.
  log("plugin", "plugin_init", "", undefined, "info", {
    agents: composed.agents.map((agent) => agent.name),
    skills: composed.skills.map((skill) => skill.name),
    limits,
  });

  const dolphinPrompt = composed.agents.find(
    (agent) => agent.name === "dolphin",
  )?.prompt;
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
      return {
        systemPrompt:
          dolphinPrompt === undefined
            ? evt.systemPrompt
            : `${dolphinPrompt}\n\n${evt.systemPrompt}`,
      };
    },
    async resourcesDiscover(_evt?, ctx?) {
      if (ctx) contextHolder.current = ctx as PiToolHostContext;
      return { skillPaths: collectSkillPaths(profileSkills) };
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
 * All five hooks are profile-driven: a `null` profile (absent or
 * invalid) yields an empty composition, so every handler no-ops
 * (fail-closed, aligned with the OpenCode host).  The `tool_result`
 * and `context` handlers are always registered — their actual
 * contributions come from the profile's hooks list (after-exec and
 * transform units).  The `message_end` handler is always registered
 * and strips model-imitated line-start ref echoes from finalized
 * assistant text when the profile is active.  Profile commands (e.g.
 * `/dcp`) are registered with pi and the `zoo-dcp` entry renderer is
 * wired so appended reports draw a card in the TUI transcript.
 *
 * Strategy for `before_agent_start`:
 *   **Prepend** the dolphin prompt rather than replacing the chainable
 *   system prompt.  This keeps the orchestrator identity dominant while
 *   preserving pi's native coding-assistant prompt and tool
 *   descriptions.  Replacing outright would lose pi's tool-injection
 *   and built-in instructions.
 *
 * @param pi - pi ExtensionAPI instance (provided at runtime by pi).
 */
export function zookeeperPi(pi: ExtensionAPI): void {
  const zooConfig = loadZooConfig();
  initPluginLogger(zooConfig, "pi");
  const handlers = buildPiHandlers(zooConfig, pi);
  pi.on("before_agent_start", handlers.beforeAgentStart);
  pi.on("resources_discover", handlers.resourcesDiscover);
  pi.on("tool_result", handlers.toolResult);
  pi.on("context", handlers.contextHandler);
  pi.on("message_end", handlers.messageEnd);
}

export default zookeeperPi;
