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
import { _resetPendingSwitchOpsForTesting } from "../adapters/pi/switch-host.js";
import type { ToolHost } from "../core/client/tool-host.js";
import { sessionAgentRegistry } from "../core/session-agent.js";
import { _resetForTesting as resetIdentityForTesting } from "../core/subagent/identity.js";
import { resetRegistry } from "../core/subagent/registry.js";
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
  commands: ["go", "dcp", "switch"],
};

/** A full zoo config carrying the poly profile. */
export const POLY_ZOO = {
  validation: { context_word_limit: 200, prompt_word_limit: 500 },
  context: { protected_messages: 20, released_percent: 10 },
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
 * Reset the process-wide state a pi host test can observe: the log
 * buffer, the identity machinery, the pending switch operations, the
 * subagent run registry, and the registry's lazy session → agent
 * bindings (so memoized identities never leak between tests).
 */
export function resetPiTestState(): void {
  _resetForTesting();
  resetIdentityForTesting();
  _resetPendingSwitchOpsForTesting();
  resetRegistry();
  sessionAgentRegistry.clear();
  delete process.env.ZOO_MODE_FILE;
}

/** The pi host's tool services: a fixed session id and a no-op notify. */
export function fakePiToolHost(): ToolHost {
  return {
    resolveSessionId: () => "sess-tool-host",
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
