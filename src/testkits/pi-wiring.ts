/**
 * Shared fixtures for the pi host wiring tests.
 *
 * The pi host's suites — `wire.test.ts` (composition and registration
 * wiring), `handlers.test.ts` (event handler behaviour), and `pi.test.ts`
 * (the thin entry) — all drive the same profiles and the same recording
 * `ExtensionAPI` stand-in, so they live here once.
 *
 * @module
 */

import assert from "node:assert/strict";
import { createPiScope, type PiProcessScope } from "../adapters/pi/config.js";
import {
  _resetPiProcessStateForTesting,
  createPiProcessState,
  type PiProcessState,
} from "../adapters/pi/process.js";
import { createPiRuntime } from "../adapters/pi/publisher.js";

import type { ExtensionAPI } from "../adapters/pi/types.js";
import {
  buildPiCapabilities,
  type PiStartOptions,
  type PiStartPrepared,
} from "../adapters/pi/wire.js";
import type { ComposedResult } from "../core/compose.js";
import { defineCompositionService } from "../core/composition.js";
import type { ModeProfile } from "../core/config-types.js";
import {
  createLifecycleKernel,
  defineExtensionService,
} from "../core/lifecycle/index.js";
import { ORCHESTRATOR_AGENT_NAME } from "../core/orchestrator.js";
import type { ToolHost } from "../core/ports/tool-host.js";
import {
  MAIN_ORIGIN,
  type RuntimeHandle,
  type RuntimeOrigin,
  startRuntime,
} from "../core/runtime.js";
import type { Selection } from "../core/selection.js";
import { REGISTRY } from "../registry.js";
import { _resetForTesting } from "../utils/logger.js";
import { colorTag, makeTheme, stubTui } from "./theme.js";

/** The poly profile (mirrors the `[zoo.mode.poly]` lists). */
export const POLY_PROFILE = {
  agents: ["dolphin", "mola", "beaver", "lynx", "spider", "eagle", "kiwi"],
  skills: [
    "beaver-tdd",
    "code-review",
    "first-principles",
    "git-commit",
    "grill",
    "kiwi-distill",
    "kiwi-verify",
    "mola-plan",
    "wiki-ingest",
    "wiki-query",
    "wiki-verify",
  ],
  hooks: [
    "subagent-prompt",
    "subagent-delegation",
    "direct-work-nudge",
    "post-subagent-nudge",
    "json-error-nudge",
    "context-pruning",
  ],
  tools: ["compress", "decompress"],
  commands: ["go", "switch"],
};

/** A full zoo config carrying the poly profile. */
export const POLY_ZOO = {
  validation: { context_word_limit: 200, prompt_word_limit: 500 },
  context: { active_messages: 20, active_tokens: 20000, released_percent: 10 },
  mode: { poly: POLY_PROFILE },
};

/**
 * Raw config carrying per-agent modes (mirrors the top-level
 * `[agent.<name>].mode` tables of config.toml).  dolphin and mola are
 * primary; the leaf agents are subagents.
 */
export const MODES_RAW = {
  agent: {
    dolphin: { mode: "primary" },
    mola: { mode: "primary" },
    beaver: { mode: "subagent" },
    lynx: { mode: "subagent" },
    spider: { mode: "subagent" },
    eagle: { mode: "subagent" },
    kiwi: { mode: "subagent" },
  },
};

/**
 * Raw config carrying per-agent colors (mirrors the top-level
 * `[agent.<name>].color` tables of config.toml).  Entries carry both
 * `mode` and `color` like the real config, so they can be merged with
 * `MODES_RAW.agent` without losing the primary/subagent roles.
 */
export const COLORS_RAW = {
  agent: {
    dolphin: { mode: "primary", color: "#66CCFF" },
    mola: { mode: "primary", color: "#FFA500" },
    beaver: { mode: "subagent", color: "#39C5BB" },
    lynx: { mode: "subagent", color: "#FFE211" },
    eagle: { mode: "subagent", color: "#961E32" },
    spider: { mode: "subagent" }, // no color
    kiwi: { mode: "subagent" }, // no color
  },
};

/** Session context shared by the handler tests. */
export const SESSION_CTX = { sessionManager: { getSessionId: () => "sess-1" } };

/**
 * The per-agent model map of the fixture profile.
 *
 * Mirrors what the installer materialises into agents.json for the agents
 * of the poly profile.  A generation always starts from an explicit map;
 * no test reads the developer's `~/.pi/agent/agents.json`.
 */
export const PI_AGENT_MODELS: Record<string, string> = {
  dolphin: "MoonShot/k3.1-pro",
  mola: "MoonShot/k3.1-pro",
  beaver: "OpenCodeGo/deepseek-v4.1-flash",
  lynx: "OpenCodeGo/deepseek-v4.1-flash",
  spider: "OpenCodeGo/deepseek-v4.1-flash",
  eagle: "OpenCodeGo/deepseek-v4.1-flash",
  kiwi: "MoonShot/k3.1-pro",
};

/**
 * Build one pi configuration generation for a test.
 *
 * The production entry point parses the config and loads agents.json; a
 * test hands both in, so no test depends on the developer's home.
 *
 * @param zooConfig - The `zoo` section of the generation.
 * @param rawConfig - The whole config root (carries the agent tables).
 * @param subagentModels - The generation's model map (defaults to the
 *   fixture profile).
 * @returns The frozen process scope of the generation.
 */
export function piScope(
  zooConfig: any,
  rawConfig: any = {},
  subagentModels: Record<string, string> = PI_AGENT_MODELS,
): PiProcessScope {
  return createPiScope({ zooConfig, rawConfig, subagentModels });
}

/** The result of composing one pi generation in a test. */
export interface PiComposition {
  /** The host-agnostic contributions the selection produced. */
  readonly composed: ComposedResult;
  /** The selection the composition ran from. */
  readonly selection: Selection;
  /** The mode profile of the generation, or `null` when none was declared. */
  readonly profile: ModeProfile | null;
  /**
   * The session → agent resolver of the provision that was composed.
   *
   * The provision owns it, and its role state follows the selection the
   * composition adopted.
   */
  readonly resolveAgent: (sessionID: string) => string | undefined;
  /** The caller resolver the host reads (the same session resolver). */
  readonly resolveCallerAgent: (
    sessionID: string,
  ) => Promise<string | undefined>;
}

/**
 * Compose one pi generation through the production service graph.
 *
 * The capability provision is the one pi builds in production
 * (`buildPiCapabilities`); the composition is the shared core service.  A
 * test therefore reads exactly what the entry point reads, without the
 * event wiring around it.
 *
 * @param scope - The configuration generation to compose.
 * @param deps - The host ports to provide (none for a bare composition).
 * @param process - The process state the capabilities read; a fresh one by
 *   default.
 * @returns The composed contributions, the selection, and the profile.
 */
export async function composePi(
  scope: PiProcessScope,
  deps?: NonNullable<Parameters<typeof buildPiCapabilities>[2]>,
  process: PiProcessState = createPiProcessState(),
): Promise<PiComposition> {
  const capabilities = defineExtensionService({
    name: "capabilities",
    deps: [],
    create: () => buildPiCapabilities(scope, process, deps),
  });
  const composition = defineCompositionService({
    scope,
    capabilities,
    units: REGISTRY,
    orchestrator: ORCHESTRATOR_AGENT_NAME,
  });
  const kernel = createLifecycleKernel({
    extension: [capabilities, composition],
    session: [],
  });
  const extension = await kernel.ensureExtension();
  assert.ok(extension, "the composition scope is created");
  const provision = extension.services.capabilities;
  return {
    composed: extension.services.composition.composed,
    selection: extension.services.composition.selection,
    profile: scope.snapshot.modeProfile,
    resolveAgent: provision.resolveAgent,
    resolveCallerAgent: provision.resolveCallerAgent,
  };
}

/**
 * Start one pi runtime through the production start protocol.
 *
 * The entry points run the same protocol, so a test gets exactly what pi
 * receives plus the runtime's close handle.  A test that names no API
 * instance prepares the start without any host write (fail-closed),
 * matching a host without pi.
 *
 * @param scope - The configuration generation to start.
 * @param pi - The recording pi API stand-in, or absent.
 * @param overrides - Optional host options and test seams.
 * @param process - The process state the runtime runs over; a fresh one by
 *   default, so every test starts from an isolated owner.
 * @param origin - The runtime origin; the main instance by default.
 * @returns The runtime handle: the publication and the close handle.
 */
export function startPiRuntime(
  scope: PiProcessScope,
  pi?: unknown,
  overrides?: PiStartOptions,
  process: PiProcessState = createPiProcessState(),
  origin: RuntimeOrigin = MAIN_ORIGIN,
): Promise<RuntimeHandle<PiStartPrepared>> {
  return startRuntime({
    scope,
    origin,
    createRuntime: ({ scope: startScope, origin: startOrigin }) =>
      createPiRuntime({
        scope: startScope,
        origin: startOrigin,
        process,
        ...(pi === undefined ? {} : { pi: pi as ExtensionAPI }),
        ...(overrides === undefined ? {} : { overrides }),
      }),
  });
}

/**
 * Start one pi instance and return its publication.
 *
 * @param scope - The configuration generation to start.
 * @param pi - The recording pi API stand-in, or absent.
 * @param overrides - Optional host options and test seams.
 * @param process - The process state the runtime runs over; a fresh one by
 *   default.
 * @returns The publication: the handlers and the registrations pi
 *   received.
 */
export async function startPi(
  scope: PiProcessScope,
  pi?: unknown,
  overrides?: PiStartOptions,
  process: PiProcessState = createPiProcessState(),
): Promise<PiStartPrepared> {
  return (await startPiRuntime(scope, pi, overrides, process)).publication;
}

/** A minimal stand-in for pi's ExtensionAPI that records handlers. */
export function mockApi(): {
  handlers: Record<string, (...args: any[]) => unknown>;
  tools: unknown[];
  commands: Array<{ name: string; description?: string; handler: unknown }>;
  shortcuts: Array<{
    shortcut: string;
    description?: string;
    handler: (ctx: unknown) => unknown;
  }>;
  appendedEntries: Array<{ customType: string; data?: unknown }>;
  renderers: Array<{ customType: string; renderer: unknown }>;
  activeTools: string[];
  on(event: string, handler: (...args: any[]) => unknown): void;
  registerTool(tool: unknown): void;
  registerCommand(name: string, options: unknown): void;
  registerShortcut(shortcut: string, options: unknown): void;
  appendEntry(customType: string, data?: unknown): void;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  registerEntryRenderer(customType: string, renderer: unknown): void;
} {
  const handlers: Record<string, (...args: any[]) => unknown> = {};
  const tools: unknown[] = [];
  const commands: Array<{
    name: string;
    description?: string;
    handler: unknown;
  }> = [];
  const shortcuts: Array<{
    shortcut: string;
    description?: string;
    handler: (ctx: unknown) => unknown;
  }> = [];
  const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
  const renderers: Array<{ customType: string; renderer: unknown }> = [];
  const activeTools: string[] = [];
  return {
    on(event, handler) {
      handlers[event] = handler;
    },
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name, options) {
      const opts = options as { description?: string; handler: unknown };
      commands.push({
        name,
        description: opts.description,
        handler: opts.handler,
      });
    },
    registerShortcut(shortcut, options) {
      const opts = options as {
        description?: string;
        handler: (ctx: unknown) => unknown;
      };
      shortcuts.push({
        shortcut,
        description: opts.description,
        handler: opts.handler,
      });
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(toolNames) {
      activeTools.length = 0;
      activeTools.push(...toolNames);
    },
    registerEntryRenderer(customType, renderer) {
      renderers.push({ customType, renderer });
    },
    handlers,
    tools,
    commands,
    shortcuts,
    appendedEntries,
    renderers,
    activeTools,
  };
}

/** Join the text of the content parts a tool_result handler returns. */
export function joinedText(
  result: { content?: { type: string; text?: string }[] } | undefined,
): string {
  return (result?.content ?? [])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

/**
 * Reset the process-wide state a pi host test can observe: the log buffer
 * and the pi process owner (the session bindings, the run records and the
 * pending switch operations), so one entry test never leaks into the next.
 *
 * A test that drives a runtime through {@link startPiRuntime} passes its own
 * owner instead and needs no reset.
 */
export function resetPiTestState(): void {
  _resetForTesting();
  _resetPiProcessStateForTesting();
  delete process.env.ZOO_MODE_FILE;
}

/** The pi host's tool services: a no-op notify. */
export function fakePiToolHost(): ToolHost {
  return {
    async notify(): Promise<void> {},
  };
}

/** A theme stub that wraps each colorized string in `<color>` tags. */
export const WIDGET_THEME = makeTheme({ fg: colorTag });

/** A minimal TUI stub (rendering needs no focus inspection). */
export const WIDGET_TUI = stubTui();

/**
 * Render the registered `zoo` widget through the recorded factory.
 *
 * The fleet widget registers a component factory under `"zoo"`; this helper
 * invokes it with the stub TUI / theme and returns the rendered lines plus a
 * dispose handle (so per-test timers never leak).  A custom TUI can be passed
 * when a test needs to drive the widget's keyboard (the editor-focus guard
 * inspects `tui.focusedComponent`).
 */
export function renderZooWidget(
  calls: Array<[string, unknown]>,
  width = 80,
  tui: unknown = WIDGET_TUI,
): { lines: string[]; dispose(): void } {
  const entry = calls.find(([k]) => k === "zoo");
  assert.ok(entry, "zoo widget must be registered");
  assert.equal(
    typeof entry[1],
    "function",
    "zoo widget content must be a component factory",
  );
  const factory = entry[1] as (
    tui: unknown,
    theme: unknown,
  ) => { render(width: number): string[]; dispose?(): void };
  const component = factory(tui, WIDGET_THEME);
  return {
    lines: component.render(width),
    dispose: () => component.dispose?.(),
  };
}
