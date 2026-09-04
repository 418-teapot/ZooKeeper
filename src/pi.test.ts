/**
 * Tests for the profile-driven pi extension (`src/pi.ts`).
 *
 * Covers: `buildPiContributions` composing the full registry from the
 * active `[zoo.mode.*]` profile (agents/skills/hooks/tools/commands,
 * unconditional pruning contribution, primary-agent Map gating,
 * null/invalid profile → empty composition), `buildPiHandlers` wiring
 * the six hook handlers (session_start widget seeding,
 * identity-dispatch prompt injection, skill discovery, compose-driven
 * `tool_result` nudge gating, native `context` handler returning the
 * pruned replacement, `message_end` ref-stripping), and the thin entry
 * (`zookeeperPi`) against the real config.toml.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  beginHydration,
  resetHydration,
  waitForHydration,
} from "./adapters/pi/hydrate.js";
import { TRANSCRIPT_UNAVAILABLE_NOTICE } from "./adapters/pi/tui/transcript.js";
import {
  DIRECT_WORK_NUDGE,
  JSON_ERROR_REMINDER_MARKER,
} from "./core/prompts.js";
import {
  getPrimary,
  _resetForTesting as resetIdentityForTesting,
  runWithIdentity,
  setPrimary,
} from "./core/subagent/identity.js";
import {
  finishRun,
  getRun,
  resetRegistry,
  startRun,
  topLevelRuns,
  updateRun,
} from "./core/subagent/registry.js";
import {
  _resetPendingSwitchOpsForTesting,
  buildPiContributions,
  buildPiHandlers,
  buildPiNoticeEntryRenderer,
  terminalToolDetails,
  zookeeperPi,
} from "./pi.js";
import { validateCompressArgs } from "./tools/compress.js";
import {
  _flushForTesting,
  _getBufferForTesting,
  _resetForTesting,
  initLogger,
  log,
} from "./utils/logger.js";
import { withModeFile } from "./utils/mode-file.js";

/** The poly profile (mirrors the `[zoo.mode.poly]` lists). */
const POLY_PROFILE = {
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
    "task-prompt",
    "task-delegation",
    "direct-work-nudge",
    "post-task-nudge",
    "json-error-nudge",
    "context-pruning",
  ],
  tools: ["compress", "decompress"],
  commands: ["go", "dcp", "switch"],
};

/** A full zoo config carrying the poly profile. */
const POLY_ZOO = {
  validation: { context_word_limit: 200, prompt_word_limit: 500 },
  context: { protected_messages: 20, released_percent: 10 },
  mode: { poly: POLY_PROFILE },
};

/**
 * Raw config carrying per-agent modes (mirrors the top-level
 * `[agent.<name>].mode` tables of config.toml).  dolphin and mola are
 * primary; the leaf agents are subagents.
 */
const MODES_RAW = {
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
const COLORS_RAW = {
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
const SESSION_CTX = { sessionManager: { getSessionId: () => "sess-1" } };

/** A minimal stand-in for pi's ExtensionAPI that records handlers. */
function mockApi(): {
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
function joinedText(
  result: { content?: { type: string; text?: string }[] } | undefined,
): string {
  return (result?.content ?? [])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

afterEach(() => {
  _resetForTesting();
  resetIdentityForTesting();
  _resetPendingSwitchOpsForTesting();
  resetRegistry();
  delete process.env.ZOO_MODE_FILE;
});

// The official transcript message components render through the coding-agent
// module-level theme singleton; the built-in dark theme ships with the
// package and needs no configuration.  Bun runs each test file in its own
// worker, so the initialization never leaks into other files.
initTheme();
// ---------------------------------------------------------------------------
// Profile-driven selection
// ---------------------------------------------------------------------------

describe("buildPiContributions — profile-driven selection", () => {
  it("poly full profile → 7 agents incl. dolphin prompt, 11 skills", () => {
    const { composed, profile } = buildPiContributions(POLY_ZOO);
    assert.equal(profile?.name, "poly");
    assert.equal(composed.agents.length, 7);
    assert.equal(composed.skills.length, 11);
    const dolphin = composed.agents.find((a) => a.name === "dolphin");
    assert.ok(dolphin, "dolphin must be composed");
    assert.ok(dolphin.prompt.startsWith("<Role>"));
    assert.ok(dolphin.prompt.includes("DELEGATE"));
  });

  it("poly full profile → full-registry composition incl. hooks/tools/commands", () => {
    const { composed } = buildPiContributions(POLY_ZOO);
    // afterExec from the registry's hook units, in registry order.
    assert.deepEqual(
      composed.afterExec.map((h) => h.name),
      [
        "nudgeTaskOutput",
        "recoverJsonError",
        "nudgeDirectWork",
        "nudgePostTask",
      ],
    );
    // context-pruning is no longer gated on client capabilities — the
    // unit contributes unconditionally, so the transform handler
    // appears.
    assert.deepEqual(
      composed.transform.map((h) => h.name),
      ["contextPruning"],
    );
    assert.deepEqual(
      composed.beforeExec.map((h) => h.name),
      ["validateBeforeExec", "validateDelegationTarget"],
    );
    // Tool/command units instantiate but pi never consumes their slots.
    assert.deepEqual(Object.keys(composed.tools).sort(), [
      "compress",
      "decompress",
    ]);
    assert.deepEqual(Object.keys(composed.commands).sort(), ["dcp", "go"]);
  });

  it("agents=[dolphin] → only dolphin, no skills", () => {
    const zoo = {
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, agents: ["dolphin"], skills: [] } },
    };
    const { composed } = buildPiContributions(zoo);
    assert.deepEqual(
      composed.agents.map((a) => a.name),
      ["dolphin"],
    );
    assert.deepEqual(composed.skills, []);
  });

  it("agents=[mola] → no dolphin contribution", () => {
    const zoo = {
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, agents: ["mola"] } },
    };
    const { composed } = buildPiContributions(zoo);
    assert.deepEqual(
      composed.agents.map((a) => a.name),
      ["mola"],
    );
  });

  it("empty agents/skills lists → empty contributions", () => {
    const zoo = {
      mode: { poly: { ...POLY_PROFILE, agents: [], skills: [] } },
    };
    const { composed } = buildPiContributions(zoo);
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(composed.skills, []);
  });

  it("absent zoo.mode → null profile, empty contributions", () => {
    const { composed, profile } = buildPiContributions({});
    assert.equal(profile, null);
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(composed.skills, []);
    assert.deepEqual(composed.afterExec, []);
    assert.deepEqual(composed.transform, []);
  });

  it("poly full profile → no unknown_unit warnings (all names match the registry)", () => {
    // pi composes the full profile against the full registry: every
    // hooks/tools/commands/agents/skills name must match a unit or the
    // selection engine warns.
    buildPiContributions(POLY_ZOO);
    const unknownUnits = _getBufferForTesting().filter(
      (entry) => entry.event === "unknown_unit",
    );
    assert.deepEqual(unknownUnits, []);
  });

  it("unknown hooks/tools profile names reach the unknown_unit warning path", () => {
    // Unlike the old agent/skill-only narrowing, the full-profile
    // composition surfaces unmatched category names to the engine.
    const zoo = {
      mode: {
        poly: {
          ...POLY_PROFILE,
          hooks: [...POLY_PROFILE.hooks, "ghost-hook"],
          tools: [...POLY_PROFILE.tools, "ghost-tool"],
        },
      },
    };
    buildPiContributions(zoo);
    const unknownUnits = _getBufferForTesting().filter(
      (entry) => entry.event === "unknown_unit",
    );
    assert.deepEqual(
      unknownUnits.map((u) => u.name),
      ["ghost-hook", "ghost-tool"],
    );
  });

  it("ambiguous zoo.mode (two tables) → null profile, empty contributions", () => {
    // No mode state file: multi-profile selection must fail closed.
    process.env.ZOO_MODE_FILE = join(
      tmpdir(),
      "zoo-mode-test-nonexistent.json",
    );
    const zoo = {
      mode: { poly: POLY_PROFILE, slim: { agents: [], skills: [] } },
    };
    const { composed, profile } = buildPiContributions(zoo);
    assert.equal(profile, null);
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(composed.skills, []);
  });
});

// ---------------------------------------------------------------------------
// Prompt injection + skill discovery handlers
// ---------------------------------------------------------------------------

describe("buildPiHandlers — prompt injection + skill discovery", () => {
  it("poly full → default primary prompt prepended, all 11 skill dirs discovered", async () => {
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    const result = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.ok(result.systemPrompt.startsWith("<Role>"));
    assert.ok(result.systemPrompt.endsWith("base"));

    // The default primary (first in profile array order) is dolphin:
    // its orchestrator prompt is the prepended one.
    assert.ok(result.systemPrompt.includes("orchestrator"));

    const resources = await handlers.resourcesDiscover();
    assert.equal(resources.skillPaths.length, 11);
    for (const path of resources.skillPaths) {
      assert.ok(fs.existsSync(path), `${path} must exist`);
      assert.ok(
        POLY_PROFILE.skills.some((name) => path.endsWith(name)),
        `${path} must match a profile skill`,
      );
    }
  });

  it("null profile → prompt untouched, no skill paths", async () => {
    const handlers = buildPiHandlers({});
    const result = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.equal(result.systemPrompt, "base");

    const resources = await handlers.resourcesDiscover();
    assert.deepEqual(resources.skillPaths, []);
  });

  it("profile without a primary agent → prompt untouched; skills filtered", async () => {
    // A stale module-level primary from another test must never inject: a
    // profile whose only agent has no valid mode has no primary, so the
    // identity machinery stays off.  Seed a sentinel name outside the
    // profile so the assertion is order-independent.
    setPrimary("ghost");
    const zoo = {
      mode: {
        poly: { ...POLY_PROFILE, agents: ["mola"], skills: ["git-commit"] },
      },
    };
    const handlers = buildPiHandlers(zoo);
    const result = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.equal(result.systemPrompt, "base");

    const resources = await handlers.resourcesDiscover();
    assert.equal(resources.skillPaths.length, 1);
    assert.ok(resources.skillPaths[0].endsWith("git-commit"));
  });
});

// ---------------------------------------------------------------------------
// Skill discovery filtering by the primary's permission.skill rules
// ---------------------------------------------------------------------------

describe("buildPiHandlers — resourcesDiscover skill filtering", () => {
  /** Raw config with skill rules mirroring config.toml's [agent.mola]. */
  const MOLA_SKILLS_RAW = {
    agent: {
      mola: {
        mode: "primary",
        permission: {
          skill: {
            "*": "deny",
            "first-principles": "allow",
            grill: "allow",
            "mola-plan": "allow",
            "wiki-query": "allow",
          },
        },
      },
    },
  };

  /** Raw config with skill rules mirroring config.toml's [agent.dolphin]. */
  const DOLPHIN_SKILLS_RAW = {
    agent: {
      dolphin: {
        mode: "primary",
        permission: {
          skill: {
            "beaver-*": "deny",
            "kiwi-*": "deny",
            "mola-*": "deny",
          },
        },
      },
    },
  };

  it("primary mola → only his allowed skills are contributed", async () => {
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MOLA_SKILLS_RAW);
    // Composition seeds the default primary from the poly agents array
    // (dolphin), but here only mola declares skill rules — so a switch to
    // mola filters by his ruleset.
    setPrimary("mola");
    const resources = await handlers.resourcesDiscover();
    const names = resources.skillPaths.map((p) => p.split("/").pop());
    assert.deepEqual(
      names.sort(),
      ["first-principles", "grill", "mola-plan", "wiki-query"].sort(),
      "only mola's allowed skills pass the catch-all deny",
    );
  });

  it("primary dolphin → his denied globs are excluded, the rest stay", async () => {
    const handlers = buildPiHandlers(POLY_ZOO, undefined, DOLPHIN_SKILLS_RAW);
    // Dolphin is the default primary from the poly agents array.
    assert.equal(getPrimary(), "dolphin");
    const resources = await handlers.resourcesDiscover();
    const names = resources.skillPaths.map((p) => p.split("/").pop() ?? "");
    assert.equal(names.length, 7, "4 of the 11 profile skills are denied");
    assert.ok(!names.some((n) => n.startsWith("beaver-")));
    assert.ok(!names.some((n) => n.startsWith("kiwi-")));
    assert.ok(!names.some((n) => n.startsWith("mola-")));
    assert.ok(names.includes("wiki-query"));
    assert.ok(names.includes("git-commit"));
  });

  it("no primary → full profile list contributed unfiltered", async () => {
    // No rawConfig means no skill rules; a stale sentinel primary from
    // another test is reset so the identity machinery stays off → the
    // handler must contribute exactly as before the filtering change.
    setPrimary("ghost");
    const handlers = buildPiHandlers(POLY_ZOO);
    const resources = await handlers.resourcesDiscover();
    assert.equal(resources.skillPaths.length, 11);
  });

  it("primary without a skill rules entry → unfiltered (machinery-off)", async () => {
    // The primary (dolphin) is set but has no `permission.skill` rules in
    // the raw config → no filtering applies, matching default-allow.
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    assert.equal(getPrimary(), "dolphin");
    const resources = await handlers.resourcesDiscover();
    assert.equal(resources.skillPaths.length, 11);
  });

  it("emits a skills_filtered info event with kept/dropped counts", async () => {
    _resetForTesting();
    const handlers = buildPiHandlers(POLY_ZOO, undefined, DOLPHIN_SKILLS_RAW);
    setPrimary("dolphin");
    await handlers.resourcesDiscover();
    const filtered = _getBufferForTesting().filter(
      (entry) => entry.event === "skills_filtered",
    );
    assert.equal(filtered.length, 1, "exactly one filtering event");
    assert.equal(filtered[0].level, "info");
    assert.equal(filtered[0].agent, "dolphin");
    assert.equal(filtered[0].kept, 7);
    assert.equal(filtered[0].dropped, 4);
  });

  it("emits no filtering event when no filtering applies", async () => {
    _resetForTesting();
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    await handlers.resourcesDiscover();
    const filtered = _getBufferForTesting().filter(
      (entry) => entry.event === "skills_filtered",
    );
    assert.deepEqual(filtered, []);
  });
});

// ---------------------------------------------------------------------------
// Identity-dispatch prompt injection
// ---------------------------------------------------------------------------

describe("buildPiHandlers — identity-dispatch prompt injection", () => {
  it("default primary (first in profile order) prompt is prepended", async () => {
    // buildPiContributions seeds the identity state with the default
    // primary (dolphin, first in the poly agents array); outside any
    // sub-session scope resolveIdentity falls back to that primary.
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    assert.equal(getPrimary(), "dolphin");

    const result = await handlers.beforeAgentStart({ systemPrompt: "base" });
    assert.ok(result.systemPrompt.startsWith("<Role>"));
    assert.ok(
      result.systemPrompt.includes("orchestrator"),
      "dolphin prompt must be prepended",
    );
    assert.ok(result.systemPrompt.endsWith("base"));
  });

  it("setPrimary to the other configured primary switches the injected prompt", async () => {
    // Composition seeds the default primary (dolphin).  A runtime switch
    // (setPrimary after build) must be reflected by the next
    // before_agent_start: the second primary (mola) prompt is injected.
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    setPrimary("mola");
    const result = await handlers.beforeAgentStart({ systemPrompt: "base" });
    assert.ok(result.systemPrompt.startsWith("<Role>"));
    assert.ok(
      result.systemPrompt.includes("planning consultant"),
      "mola prompt must be prepended after setPrimary",
    );
    assert.ok(result.systemPrompt.endsWith("base"));
  });

  it("inside runWithIdentity the subagent's prompt is prepended", async () => {
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    let injected = "";
    await runWithIdentity({ kind: "subagent", name: "beaver" }, async () => {
      const result = await handlers.beforeAgentStart({
        systemPrompt: "base",
      });
      injected = result.systemPrompt;
    });
    assert.ok(injected.startsWith("<Role>"));
    assert.ok(
      injected.includes("You are a code implementation agent"),
      "beaver subagent prompt must be prepended",
    );
    assert.ok(injected.endsWith("base"));
  });

  it("subagent resolves by the same name lookup when not the default primary", async () => {
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    let injected = "";
    await runWithIdentity({ kind: "subagent", name: "lynx" }, async () => {
      const result = await handlers.beforeAgentStart({
        systemPrompt: "base",
      });
      injected = result.systemPrompt;
    });
    assert.ok(injected.startsWith("<Role>"));
    assert.ok(
      injected.includes("You are a codebase exploration agent"),
      "lynx subagent prompt must be prepended",
    );
    assert.ok(injected.endsWith("base"));
  });

  it("empty primary set → zero injection; sessionAgentMap empty", async () => {
    // Pre-seed a primary that is not in the profile: the empty-primary
    // profile must fail closed (no setPrimary call) even when a stale
    // module-level primary exists.
    setPrimary("ghost");
    const zoo = {
      mode: {
        poly: {
          agents: ["beaver"],
          skills: [],
          hooks: ["direct-work-nudge"],
          tools: [],
          commands: [],
        },
      },
    };
    const { composed, agentModes } = buildPiContributions(zoo, undefined, {
      agent: {},
    });
    assert.deepEqual(agentModes, {});
    // beaver is composed (it is in the profile agents list) but no
    // primary is derived from it — the identity machinery stays off.
    assert.deepEqual(
      composed.agents.map((a) => a.name),
      ["beaver"],
    );

    const handlers = buildPiHandlers(zoo, undefined, { agent: {} });
    // resolveIdentity falls back to the stale sentinel, which is not in
    // the profile — zero injection.
    const promptResult = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.equal(promptResult.systemPrompt, "base");

    // The empty sessionAgentMap means the direct-work nudge gate never
    // fires for the primary-only nudge.
    const toolResult = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit",
        content: [{ type: "text", text: "file.ts updated" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.equal(toolResult, undefined);
  });
});

// ---------------------------------------------------------------------------
// Compose-driven tool_result handler
// ---------------------------------------------------------------------------

describe("buildPiHandlers — compose-driven tool_result", () => {
  it("json-error-nudge in hooks → JSON reminder appended to error output", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "browser",
        toolCallId: "call-json",
        content: [{ type: "text", text: "Error: json parse error at line 3" }],
        isError: true,
      },
      SESSION_CTX,
    );
    assert.ok(result, "the reminder must be appended");
    assert.ok(
      joinedText(result).includes(JSON_ERROR_REMINDER_MARKER),
      "output must carry the JSON reminder marker",
    );
  });

  it("hooks without json-error-nudge → tool_result adds no JSON reminder", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: {
          ...POLY_PROFILE,
          hooks: POLY_PROFILE.hooks.filter((h) => h !== "json-error-nudge"),
        },
      },
    };
    const handlers = buildPiHandlers(zoo);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "browser",
        toolCallId: "call-json",
        content: [{ type: "text", text: "Error: json parse error at line 3" }],
        isError: true,
      },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });

  it("direct-work-nudge in hooks + primary agent → edit nudge appended", async () => {
    // The sessionAgentMap resolves to the config-derived default primary
    // (dolphin here), which satisfies the direct-work nudge's gate.
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit",
        content: [{ type: "text", text: "file.ts updated" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.ok(result, "the direct-work nudge must fire");
    assert.ok(
      joinedText(result).includes(DIRECT_WORK_NUDGE),
      "output must carry the delegation reminder",
    );
  });

  it("profile without a primary agent → direct-work nudge skipped", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, agents: ["mola"] } },
    };
    const handlers = buildPiHandlers(zoo);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit",
        content: [{ type: "text", text: "file.ts updated" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });

  it("hooks without direct-work-nudge → no delegation nudge even for a primary", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: {
          ...POLY_PROFILE,
          hooks: POLY_PROFILE.hooks.filter((h) => h !== "direct-work-nudge"),
        },
      },
    };
    const handlers = buildPiHandlers(zoo);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit",
        content: [{ type: "text", text: "file.ts updated" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Compose-driven context handler
// ---------------------------------------------------------------------------

describe("buildPiHandlers — compose-driven context handler", () => {
  it("returns the native pi messages, possibly modified by pruning", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
    const result = (await handlers.contextHandler(
      {
        type: "context",
        messages: [{ role: "user", content: "hello" }],
      },
      SESSION_CTX,
    )) as { messages: Array<{ role: string; content: string }> } | undefined;
    assert.ok(result, "context handler must return a result");
    assert.equal(result.messages.length, 1);
    // The pruning pipeline injects the per-round line-number prefix on pi.
    assert.equal(result.messages[0].content, "[m1] hello");
  });

  it("returns an empty replacement for an empty message array", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
    const result = (await handlers.contextHandler(
      { type: "context", messages: [] },
      SESSION_CTX,
    )) as { messages: unknown[] } | undefined;
    assert.ok(result, "context handler must return a result");
    assert.deepEqual(result.messages, []);
  });
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe("buildPiHandlers — registerTool wiring", () => {
  it("registers compress and decompress with pi when the profile enables them", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const toolNames = api.tools.map((tool: any) => tool.name);
    assert.deepEqual(toolNames.sort(), ["compress", "decompress"]);
  });

  it("sets label to the tool name and wraps parameters in an object schema", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const compress = api.tools.find((tool: any) => tool.name === "compress");
    assert.ok(compress);
    assert.equal((compress as any).label, "compress");
    assert.equal((compress as any).parameters.type, "object");
    assert.deepEqual((compress as any).parameters.required, ["ranges"]);
    assert.ok((compress as any).parameters.properties.ranges);
  });

  it("bridged compress schema accepts what validateCompressArgs accepts", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const compress = api.tools.find((tool: any) => tool.name === "compress") as
      | {
          parameters: {
            properties: Record<string, unknown>;
            required: string[];
          };
        }
      | undefined;
    assert.ok(compress);

    // Valid input must satisfy both the bridged schema and the tool's own
    // validator.
    const validArgs = {
      ranges: [
        {
          fromRef: "m2",
          toRef: "m3",
          title: "summary",
          summary: "body",
        },
      ],
    };
    assert.doesNotThrow(() => validateCompressArgs(validArgs));
    assert.ok(
      compress.parameters.required.includes("ranges"),
      "schema must require ranges",
    );
    assert.ok(
      "ranges" in compress.parameters.properties,
      "schema must declare ranges",
    );

    // Malformed input is rejected by validateCompressArgs and is missing
    // the required ranges field.
    assert.throws(() => validateCompressArgs({}));
    assert.equal(
      (compress.parameters.required as string[]).includes("ranges"),
      true,
    );
  });

  it("execute wrapper delegates to the contribution and propagates errors", async () => {
    const api = mockApi();
    buildPiHandlers(
      {
        mode: {
          poly: {
            ...POLY_PROFILE,
            tools: ["decompress"],
            hooks: POLY_PROFILE.hooks.filter((h) => h !== "context-pruning"),
          },
        },
      },
      api as any,
    );
    const decompress = api.tools.find(
      (tool: any) => tool.name === "decompress",
    );
    assert.ok(decompress);

    // Missing blockId is rejected by the tool's own validator; the pi
    // execute wrapper does not swallow tool errors.
    await assert.rejects(
      async () =>
        (decompress as any).execute("call-1", {}, undefined, undefined, {
          sessionManager: { getSessionId: () => "sess-decompress" },
        }),
      /blockId/,
    );
  });

  it("registers the subagent tool when the profile lists it and a driver is wired", () => {
    const api = mockApi();
    api.activeTools.push("bash", "edit", "subagent", "compress", "decompress");
    buildPiHandlers(
      {
        mode: {
          poly: {
            ...POLY_PROFILE,
            tools: ["compress", "decompress", "subagent"],
          },
        },
      },
      api as any,
      MODES_RAW,
    );
    const names = api.tools.map((tool: any) => tool.name).sort();
    assert.deepEqual(names, ["compress", "decompress", "subagent"]);
    // The registered subagent tool forwards the pi signal into its execute
    // bridge: the registered handler receives (callId, params, signal, ...).
    const subagent = api.tools.find((tool: any) => tool.name === "subagent");
    assert.ok(subagent, "subagent tool must be registered");
    assert.equal(typeof (subagent as any).execute, "function");
    // The pi TUI renderers are attached when the host wired a renderer (the
    // subagent transcript card draws from the structured progress details).
    assert.equal(typeof (subagent as any).renderCall, "function");
    assert.equal(typeof (subagent as any).renderResult, "function");
  });

  it("forwards the pi signal through the bridge to the tool execute", async () => {
    const api = mockApi();
    api.activeTools.push("bash", "edit", "subagent", "compress", "decompress");
    // The profile enables only the subagent tool.
    buildPiHandlers(
      {
        mode: {
          poly: {
            ...POLY_PROFILE,
            tools: ["subagent"],
            hooks: [],
          },
        },
      },
      api as any,
      MODES_RAW,
    );
    const subagent = api.tools.find((tool: any) => tool.name === "subagent") as
      | { execute: (...args: unknown[]) => Promise<unknown> }
      | undefined;
    assert.ok(subagent);

    const controller = new AbortController();
    // The bridge wraps the tool's string return into pi's result shape and
    // forwards the signal into the tool execute; assert the wrapped shape
    // (a pi tool result with a text part) is returned.  The parent model is
    // NOT forwarded — strict mode reads the agents.json configured model
    // only, never the parent session's model.
    const result = await subagent.execute(
      "call-1",
      { agent: "beaver", description: "实现任务", prompt: "t" },
      controller.signal,
      undefined,
      {
        sessionManager: { getSessionId: () => "sess-1" },
        model: { provider: "Dummy", id: "dummy-small" },
      },
    );
    const wrapped = result as { content?: { type?: string; text?: string }[] };
    assert.ok(
      Array.isArray(wrapped.content),
      "bridge must wrap in content parts",
    );
    assert.ok(
      wrapped.content?.some((part) => part.type === "text"),
      "bridge must produce a text part",
    );
  });

  it("terminal details carry only the run's sub-session path pointer", () => {
    // The bridge forwards no structured progress any more: pi never
    // persists a partial's `details`, so the terminal result carries only
    // the fact pointer that lets a view re-hydrate the run after a restart
    // — the sub-session file path the driver reported mid-run, looked up by
    // run id (the pi tool-call id) in the run registry.
    startRun({ id: "call-pointer", agent: "beaver", parentSession: "sess-1" });
    updateRun("call-pointer", {
      sessionPath: "/home/u/.pi/agent/sessions/x/s.jsonl",
    });
    assert.deepEqual(
      terminalToolDetails("call-pointer"),
      { sessionPath: "/home/u/.pi/agent/sessions/x/s.jsonl" },
      "details must carry the session path pointer and nothing else",
    );
  });

  it("terminal details stay empty without a run or a path", () => {
    // A tool with no registry run (compress / decompress) and a run that
    // never reported a path (a host that does not persist sessions) both
    // contribute an empty details object.
    assert.deepEqual(terminalToolDetails("call-unknown"), {});
    assert.deepEqual(terminalToolDetails(undefined), {});
    assert.deepEqual(terminalToolDetails(42), {});
    startRun({ id: "call-no-path", agent: "beaver", parentSession: "s" });
    assert.deepEqual(terminalToolDetails("call-no-path"), {});
  });
});

// ---------------------------------------------------------------------------
// Command registration wiring
// ---------------------------------------------------------------------------

describe("buildPiHandlers — registerCommand wiring", () => {
  it("registers composed commands with pi when the profile enables them", () => {
    const api = mockApi();
    // rawConfig supplies the `[agent.*].mode` table, so the switch unit
    // derives the primaries (dolphin, mola) and contributes a command
    // per primary alongside go/dcp — names are config-derived.
    buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    const names = api.commands.map((c) => c.name).sort();
    assert.deepEqual(names, ["dcp", "dolphin", "go", "mola"]);
  });

  it("preserves description and a handler on each registration", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const dcp = api.commands.find((c) => c.name === "dcp");
    assert.ok(dcp, "dcp must be registered");
    assert.equal(dcp.description, "显示上下文用量与缓存命中率");
    assert.equal(typeof dcp.handler, "function");
  });

  it("null profile registers no commands (fail-closed)", () => {
    const api = mockApi();
    buildPiHandlers({}, api as any);
    assert.deepEqual(api.commands, []);
  });

  it("commands registered for a profile without commands list stay empty", () => {
    const api = mockApi();
    buildPiHandlers(
      {
        mode: {
          poly: { ...POLY_PROFILE, commands: [] },
        },
      },
      api as any,
    );
    assert.deepEqual(api.commands, []);
  });

  it("/dcp context appends a zoo-notice custom entry (persistent, no LLM context)", async () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const dcp = api.commands.find((c) => c.name === "dcp");
    assert.ok(dcp && typeof dcp.handler === "function");

    const ctx = {
      sessionManager: {
        getSessionId: () => "sess-dcp",
        buildContextEntries: () => [
          { type: "message", message: { role: "user", content: "hi" } },
        ],
      },
    };
    await (dcp.handler as (args: string, ctx: unknown) => Promise<void>)(
      "context",
      ctx,
    );

    assert.ok(
      api.appendedEntries.length >= 1,
      "dcp must append a custom entry",
    );
    const entry = api.appendedEntries.find(
      (e) => e.customType === "zoo-notice",
    );
    assert.ok(entry, "dcp report must go through the zoo-notice custom entry");
    assert.equal(typeof (entry.data as any)?.content, "string");
    assert.ok(String((entry.data as any)?.content).includes("上下文报告"));
  });

  it("/dcp errors route through notifySessionError into appendEntry", async () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const dcp = api.commands.find((c) => c.name === "dcp");
    assert.ok(dcp && typeof dcp.handler === "function");

    // "sweep 0" is rejected by the sweep count parser, so the handler
    // surfaces the failure through notifySessionError → appendEntry.
    await (dcp.handler as (args: string, ctx: unknown) => Promise<void>)(
      "sweep 0",
      { sessionManager: { getSessionId: () => "sess-dcp" } },
    );

    const entry = api.appendedEntries.find(
      (e) => e.customType === "zoo-notice",
    );
    assert.ok(entry, "dcp error must be surfaced via appendEntry");
    assert.ok(
      String((entry.data as any)?.content).includes("用法：/dcp sweep"),
    );
  });

  it("registers tools over the unified host; registration itself appends nothing", async () => {
    // The single pi tool host serves both tools and commands with the
    // same appendEntry-backed notify (`zoo-notice`) — one unified
    // in-session channel.  Registering a tool is side-effect free —
    // entries only appear once the tool actually executes and notifies.
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);

    const compress = api.tools.find((t: any) => t.name === "compress");
    assert.ok(compress, "compress tool must be registered");
    assert.equal(api.appendedEntries.length, 0, "no custom entry appended yet");
  });

  it("registers a zoo-notice entry renderer with pi", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const renderer = api.renderers.find((r) => r.customType === "zoo-notice");
    assert.ok(renderer, "zoo-notice entry renderer must be registered");
    assert.equal(typeof renderer.renderer, "function");
  });

  it("registers the zoo-notice renderer even without dcp enabled", () => {
    // The renderer is unconditional: every in-session notification is a
    // zoo-notice entry, so a profile that enables no /dcp command still
    // needs the renderer.
    const api = mockApi();
    buildPiHandlers(
      {
        mode: {
          poly: { ...POLY_PROFILE, commands: [] },
        },
      },
      api as any,
    );
    assert.ok(
      api.renderers.some(
        (r) =>
          r.customType === "zoo-notice" && typeof r.renderer === "function",
      ),
      "zoo-notice renderer must be registered even without /dcp",
    );
  });

  it("non-null profile with dcp enabled still registers the renderer", () => {
    // A profile that registers dcp (but no other command) must register
    // the zoo-notice entry renderer so reports draw a card in the TUI.
    const api = mockApi();
    buildPiHandlers(
      {
        mode: {
          poly: { ...POLY_PROFILE, commands: ["dcp"] },
        },
      },
      api as any,
    );
    const renderer = api.renderers.find((r) => r.customType === "zoo-notice");
    assert.ok(renderer, "zoo-notice entry renderer must be registered");
    assert.equal(typeof renderer.renderer, "function");
  });

  it("null profile still registers the zoo-notice renderer when the API supports it", () => {
    // The renderer is a pure UI helper for any zoo-notice entry: it is
    // registered regardless of the profile (a null profile merely yields
    // no notifications to render).
    const api = mockApi();
    buildPiHandlers({}, api as any);
    assert.ok(
      api.renderers.some(
        (r) =>
          r.customType === "zoo-notice" && typeof r.renderer === "function",
      ),
      "zoo-notice renderer must be registered for a null profile",
    );
  });
});

// ---------------------------------------------------------------------------
// Primary-switch command wiring
// ---------------------------------------------------------------------------

describe("buildPiHandlers — primary-switch command wiring", () => {
  /**
   * A command ctx with the session manager + a ui surface for setWidget
   * and a `newSession` that simulates pi replacing the session and
   * running pi.ts's `newSession` wrapper's `withSession` callback against
   * the fresh `ReplacedSessionContext` (whose `ui.setWidget` forwards to
   * the recording callback).  The wrapper builds the
   * `PiSwitchNewSessionOps` facade: `setWidget` binds to the fresh ui
   * immediately; the tool trim is stashed into the module-level pending
   * slot and applied when the new session's first `before_agent_start`
   * drains it.
   */
  function switchCtx(
    setWidget: (key: string, content: string[] | undefined) => void = () => {},
  ): {
    sessionManager: { getSessionId(): string };
    ui: {
      notify(): void;
      setWidget(
        key: string,
        content: string[] | undefined,
        options?: { placement?: "aboveEditor" | "belowEditor" },
      ): void;
    };
    newSession(options?: {
      parentSession?: string;
      withSession?: (newCtx: unknown) => void | Promise<void>;
    }): Promise<{ cancelled: boolean }>;
  } {
    return {
      sessionManager: { getSessionId: () => "sess-switch" },
      ui: { notify: () => {}, setWidget },
      async newSession(options) {
        // pi passes the fresh ReplacedSessionContext to withSession.
        await options?.withSession?.({
          ui: { setWidget },
          sessionManager: { getSessionId: () => "sess-new" },
        });
        return { cancelled: false };
      },
    };
  }

  it("registers one /<agent> command per configured primary", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    const switchNames = api.commands
      .map((c) => c.name)
      .filter((n) => ["dolphin", "mola"].includes(n))
      .sort();
    assert.deepEqual(switchNames, ["dolphin", "mola"]);
  });

  it("switch command replaces the session: trims denied tools and nudges the fleet widget", async () => {
    const api = mockApi();
    api.activeTools.push("webfetch", "edit", "bash");
    const handlers = buildPiHandlers(POLY_ZOO, api as any, {
      ...MODES_RAW,
      agent: {
        ...MODES_RAW.agent,
        dolphin: {
          mode: "primary",
          permission: { webfetch: "deny", websearch: "deny", bash: {} },
        },
      },
    });
    const dolphin = api.commands.find((c) => c.name === "dolphin");
    assert.ok(dolphin && typeof dolphin.handler === "function");

    // Register the fleet widget first so the switch can nudge it.
    const { calls, ctx } = widgetRecordingCtx();
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );

    // A switch away from the default primary (mola) to dolphin.
    setPrimary("mola");

    // The switch command's `setWidget("zoo", ...)` is now a "primary
    // changed" notification routed to the fleet widget (it reads the primary
    // live), so the mock ui never receives a string-array widget for zoo.
    await (dolphin.handler as (args: string, ctx: unknown) => Promise<void>)(
      "",
      switchCtx(() => {}),
    );
    // The identity switched; the fleet widget (already registered) reads the
    // new primary live on its next render.
    assert.equal(getPrimary(), "dolphin");
    const { lines, dispose } = renderZooWidget(calls);
    assert.ok(lines[0].includes("dolphin"), lines[0]);
    assert.ok(!lines[0].includes("mola"), lines[0]);
    dispose();

    // The tool trim was queued (pi's replaced-session context cannot
    // reach it); the new session's first before_agent_start drains the
    // pending ops with the fresh (non-stale) API.  No confirmation entry
    // is appended: the widget already shows the active primary.
    await handlers.beforeAgentStart(
      { systemPrompt: "base" },
      { sessionManager: { getSessionId: () => "sess-new" } },
    );
    // Tool-level deny (webfetch) removed; bash (fine-grained sub-table)
    // kept in the active set.
    assert.deepEqual(api.activeTools, ["edit", "bash"]);
  });

  it("no rawConfig (no primaries) → no switch commands registered", () => {
    const api = mockApi();
    buildPiHandlers(POLY_ZOO, api as any);
    const switchNames = api.commands
      .map((c) => c.name)
      .filter((n) => ["dolphin", "mola"].includes(n));
    assert.deepEqual(switchNames, []);
  });
});

// ---------------------------------------------------------------------------
// Widget seeding on session start
// ---------------------------------------------------------------------------

/** A theme stub that wraps each colorized string in `<color>` tags. */
const WIDGET_THEME = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

/** A minimal TUI stub (rendering needs no focus inspection). */
const WIDGET_TUI = { requestRender: () => {} };

/** A ui ctx that records setWidget calls (key + content). */
function widgetRecordingCtx(): {
  calls: Array<[string, unknown]>;
  ctx: {
    sessionManager: { getSessionId(): string };
    ui: {
      notify(): void;
      setWidget(key: string, content: unknown): void;
    };
  };
} {
  const calls: Array<[string, unknown]> = [];
  const ctx = {
    sessionManager: { getSessionId: () => "sess-seed" },
    ui: {
      notify: () => {},
      setWidget: (key: string, content: unknown) => calls.push([key, content]),
    },
  };
  return { calls, ctx };
}

/**
 * A ui ctx that records setWidget calls AND captures the terminal-input
 * handler (so tests can drive the fleet widget's keyboard through the pi
 * entry point's `onTerminalInput` wiring end-to-end).  An optional `custom`
 * surface can be supplied to model the pi `ui.custom` overlay opener cached
 * in the shared context holder.
 */
function widgetInputCtx(
  opts: { custom?: (factory: unknown, options: unknown) => unknown } = {},
): {
  calls: Array<[string, unknown]>;
  inputHandler: (data: string) => unknown;
  ctx: {
    sessionManager: { getSessionId(): string };
    ui: {
      notify(): void;
      setWidget(key: string, content: unknown): void;
      onTerminalInput(handler: (data: string) => unknown): () => void;
      custom?: (factory: unknown, options: unknown) => unknown;
    };
  };
} {
  const calls: Array<[string, unknown]> = [];
  let inputHandler: ((data: string) => unknown) | undefined;
  const ctx: {
    sessionManager: { getSessionId(): string };
    ui: {
      notify(): void;
      setWidget(key: string, content: unknown): void;
      onTerminalInput(handler: (data: string) => unknown): () => void;
      custom?: (factory: unknown, options: unknown) => unknown;
    };
  } = {
    sessionManager: { getSessionId: () => "sess-enter" },
    ui: {
      notify: () => {},
      setWidget: (key: string, content: unknown) => calls.push([key, content]),
      onTerminalInput: (handler: (data: string) => unknown) => {
        inputHandler = handler;
        return () => {
          if (inputHandler === handler) inputHandler = undefined;
        };
      },
      ...(opts.custom !== undefined ? { custom: opts.custom } : {}),
    },
  };
  return {
    calls,
    inputHandler: (data: string) => inputHandler?.(data),
    ctx,
  };
}

/**
 * Render the registered `zoo` widget through the recorded factory.
 *
 * The fleet widget registers a component factory under `"zoo"`; this helper
 * invokes it with the stub TUI / theme and returns the rendered lines plus a
 * dispose handle (so per-test timers never leak).  A custom TUI can be passed
 * when a test needs to drive the widget's keyboard (the editor-focus guard
 * inspects `tui.focusedComponent`).
 */
function renderZooWidget(
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

/**
 * A TUI stub with a focused empty editor component, so the fleet widget's
 * keyboard state machine can be driven (the editor-focus guard requires a
 * component exposing render/invalidate/handleInput/getText/setText).
 */
function focusedEditorTui(): unknown {
  return {
    requestRender: () => {},
    focusedComponent: {
      render: () => [],
      invalidate: () => {},
      handleInput: () => {},
      getText: () => "",
      setText: () => {},
    },
  };
}

describe("buildPiHandlers — widget seeding", () => {
  it("first beforeAgentStart registers the fleet widget factory under zoo", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    const { calls, ctx } = widgetRecordingCtx();

    // The first per-session event registers the `zoo` fleet widget (a
    // component factory) with the default primary (dolphin) — even though
    // no switch has happened.
    await handlers.beforeAgentStart({ systemPrompt: "base" }, ctx);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "zoo");
    assert.equal(typeof calls[0][1], "function");
  });

  it("re-registers on later beforeAgentStart events without stacking the listener", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    // Registration is idempotent: every trigger re-seeds the widget (pi's
    // setWidget disposes the prior component) and re-binds the listener only
    // after releasing the previous one — so the subscription count never
    // grows.
    let activeSubscriptions = 0;
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      sessionManager: { getSessionId: () => "sess-bas" },
      ui: {
        notify: () => {},
        setWidget: (key: string, content: unknown) =>
          calls.push([key, content]),
        onTerminalInput: () => {
          activeSubscriptions += 1;
          return () => {
            activeSubscriptions -= 1;
          };
        },
      },
    };

    await handlers.beforeAgentStart({ systemPrompt: "base" }, ctx);
    await handlers.beforeAgentStart({ systemPrompt: "base" }, ctx);
    assert.equal(calls.length, 2, "each trigger re-registers the widget");
    assert.equal(
      activeSubscriptions,
      1,
      "the terminal-input listener must not stack",
    );
  });

  it("session_start registers the fleet widget; a later beforeAgentStart re-registers idempotently", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    // A ui that records setWidget calls and counts live terminal-input
    // subscriptions, so the idempotent re-registration can be asserted to
    // release the previous listener instead of stacking a second one.
    let activeSubscriptions = 0;
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      sessionManager: { getSessionId: () => "sess-seed" },
      ui: {
        notify: () => {},
        setWidget: (key: string, content: unknown) =>
          calls.push([key, content]),
        onTerminalInput: () => {
          activeSubscriptions += 1;
          return () => {
            activeSubscriptions -= 1;
          };
        },
      },
    };

    // session_start fires at startup/resume (before any LLM turn), so the
    // widget must be registered immediately with the default primary.
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    assert.equal(calls.length, 1);
    assert.equal(activeSubscriptions, 1);

    // A later beforeAgentStart (first LLM turn) re-runs the registration
    // (idempotent — re-seeding is safe) without stacking the listener.
    await handlers.beforeAgentStart({ systemPrompt: "base" }, ctx);
    assert.equal(calls.length, 2, "registration re-runs on each trigger");
    assert.equal(
      activeSubscriptions,
      1,
      "the terminal-input listener must not stack",
    );
  });

  it("re-registers the fleet widget after its component is disposed (reload/resume)", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    // A ui that records setWidget calls AND counts live onTerminalInput
    // subscriptions (returning a real unsubscribe), so a re-registration can
    // be asserted to release the previous listener instead of stacking it.
    let activeSubscriptions = 0;
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      sessionManager: { getSessionId: () => "sess-reload" },
      ui: {
        notify: () => {},
        setWidget: (key: string, content: unknown) =>
          calls.push([key, content]),
        onTerminalInput: () => {
          activeSubscriptions += 1;
          return () => {
            activeSubscriptions -= 1;
          };
        },
      },
    };

    // First session_start registers the widget and binds one listener.
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    assert.equal(calls.length, 1);
    assert.equal(activeSubscriptions, 1);

    // Simulate pi destroying the widget component on reload / resume: invoke
    // the registered component's dispose (releases the listener and clears
    // the one-shot flag).
    const { dispose } = renderZooWidget(calls);
    dispose();
    assert.equal(
      activeSubscriptions,
      0,
      "dispose must release the terminal-input listener",
    );

    // The replayed session_start (reason: reload/resume) must re-register the
    // widget instead of leaving it permanently gone, and must not stack a
    // second terminal-input listener.
    await handlers.sessionStart(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    assert.equal(calls.length, 2, "the widget must re-register after disposal");
    assert.equal(
      activeSubscriptions,
      1,
      "re-registration must not stack terminal-input listeners",
    );
  });

  it("session_start stays silent without a ui surface on ctx", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    // A ui-less ctx (e.g. headless / RPC mode) must not crash the seed:
    // the fail-closed no-ui path no-ops silently.
    await assert.doesNotReject(() =>
      handlers.sessionStart(
        { type: "session_start", reason: "startup" },
        { sessionManager: { getSessionId: () => "sess" } },
      ),
    );
  });

  it("session_start stays silent when no primary is configured (no rawConfig)", async () => {
    const api = mockApi();
    // Defensively reset the module-level primary so an order-dependent
    // stale value from a prior test can never seed the widget.
    resetIdentityForTesting();
    // Without rawConfig the agent-mode map is empty → no primaries → the
    // identity machinery stays off and no seed may run.
    const handlers = buildPiHandlers(POLY_ZOO, api as any);
    let widgetCalls = 0;
    const ctx = {
      sessionManager: { getSessionId: () => "sess" },
      ui: {
        notify: () => {},
        setWidget: () => {
          widgetCalls += 1;
        },
      },
    };
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    assert.equal(widgetCalls, 0, "no primary → no seed");
  });

  it("stays silent without a pi switch host (no API)", async () => {
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    let widgetCalls = 0;
    const ctx = {
      sessionManager: { getSessionId: () => "sess" },
      ui: {
        notify: () => {},
        setWidget: () => {
          widgetCalls += 1;
        },
      },
    };
    await handlers.beforeAgentStart({ systemPrompt: "base" }, ctx);
    assert.equal(widgetCalls, 0, "no host → no seed");
  });

  it("stays silent when no primary is configured (no rawConfig)", async () => {
    const api = mockApi();
    // Defensively reset the module-level primary so an order-dependent
    // stale value from a prior test can never seed the widget.
    resetIdentityForTesting();
    // Without rawConfig the agent-mode map is empty → no primaries → the
    // identity machinery stays off and no seed may run.
    const handlers = buildPiHandlers(POLY_ZOO, api as any);
    let widgetCalls = 0;
    const ctx = {
      sessionManager: { getSessionId: () => "sess" },
      ui: {
        notify: () => {},
        setWidget: () => {
          widgetCalls += 1;
        },
      },
    };
    await handlers.beforeAgentStart({ systemPrompt: "base" }, ctx);
    assert.equal(widgetCalls, 0, "no primary → no seed");
  });

  it("session_start rebuilds the run registry from the message history", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    const history = () => [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-hist-1",
              name: "subagent",
              arguments: { agent: "beaver", description: "实现任务" },
            },
          ],
          timestamp: 1000,
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-hist-1",
          toolName: "subagent",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2000,
        },
      },
      // An in-flight call when pi exited → rebuilt as aborted.
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-hist-2",
              name: "subagent",
              arguments: { agent: "lynx" },
            },
          ],
          timestamp: 3000,
        },
      },
    ];
    const ctx = {
      sessionManager: {
        getSessionId: () => "sess-restore",
        buildContextEntries: history,
      },
      ui: { notify: () => {}, setWidget: () => {} },
    };

    // A fresh session_start (pi restore / resume) must seed the registry so
    // the fleet widget renders historical subagent runs.
    await handlers.sessionStart(
      { type: "session_start", reason: "resume" },
      ctx,
    );

    assert.equal(topLevelRuns("sess-restore").length, 2);
    const done = getRun("call-hist-1");
    assert.equal(done?.status, "done");
    assert.equal(done?.agent, "beaver");
    assert.equal(done?.label, "实现任务");
    assert.equal(done?.startedAt, 1000);
    assert.equal(done?.endedAt, 2000);
    const interrupted = getRun("call-hist-2");
    assert.equal(interrupted?.status, "aborted");
    assert.equal(interrupted?.endedAt, 3000);
  });

  it("session_start registry rebuild is idempotent across repeated triggers", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    const history = () => [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-x",
              name: "subagent",
              arguments: { agent: "spider" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-x",
          toolName: "subagent",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        },
      },
    ];
    const ctx = {
      sessionManager: {
        getSessionId: () => "sess-again",
        buildContextEntries: history,
      },
      ui: { notify: () => {}, setWidget: () => {} },
    };

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    await handlers.sessionStart(
      { type: "session_start", reason: "resume" },
      ctx,
    );

    assert.equal(topLevelRuns("sess-again").length, 1, "no duplicate entries");
    assert.equal(getRun("call-x")?.status, "done");
  });

  it("session_start leaves the registry untouched without a session manager history", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    // A ui + session-id-only ctx (no buildContextEntries) must not crash and
    // must not touch the registry (fresh session → nothing to rebuild).
    await assert.doesNotReject(() =>
      handlers.sessionStart(
        { type: "session_start", reason: "startup" },
        { sessionManager: { getSessionId: () => "sess" } },
      ),
    );
    assert.equal(topLevelRuns("sess").length, 0);
  });

  it("session_start rebuilds even when buildContextEntries reads `this`", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    // Regression: pi's real SessionManager.buildContextEntries reads
    // `this.getEntries()`, so the mock must be `this`-dependent too.
    // The old implementation extracted the function reference before calling
    // (`const f = sm.buildContextEntries; f()`), which unbinds `this` and
    // crashes — swallowed by the try/catch as `registry_rebuild_failed`, so
    // the registry stays empty.  Calling `sessionManager.buildContextEntries()`
    // as a method keeps `this` bound and seeds the registry.
    class MockSessionManager {
      private readonly entries = [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-bind-1",
                name: "subagent",
                arguments: { agent: "lynx", description: "搜索代码" },
              },
            ],
            timestamp: 4000,
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-bind-1",
            toolName: "subagent",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 5000,
          },
        },
      ];
      getSessionId(): string {
        return "sess-bind";
      }
      // A `this`-dependent method mirroring pi's SessionManager.
      buildContextEntries(): unknown[] {
        return this.entries;
      }
    }
    const ctx = {
      sessionManager: new MockSessionManager(),
      ui: { notify: () => {}, setWidget: () => {} },
    };

    await handlers.sessionStart(
      { type: "session_start", reason: "resume" },
      ctx,
    );

    // The rebuild must run to completion: the registry is seeded and no
    // exception is surfaced to the caller.
    assert.equal(topLevelRuns("sess-bind").length, 1);
    const run = getRun("call-bind-1");
    assert.equal(run?.status, "done");
    assert.equal(run?.agent, "lynx");
    assert.equal(run?.label, "搜索代码");
    assert.equal(run?.startedAt, 4000);
    assert.equal(run?.endedAt, 5000);
  });
});

// ---------------------------------------------------------------------------
// Fleet widget enter-inspect wiring
// ---------------------------------------------------------------------------

describe("buildPiHandlers — fleet widget enter-inspect wiring", () => {
  it("enter on a selected run opens the transcript overlay via ui.custom", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    let opened = 0;
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f, _options) => {
        opened += 1;
        factory = f;
        return Promise.resolve(undefined);
      },
    });

    // Session start registers the fleet widget + terminal-input listener and
    // caches the command ctx (with ui.custom) in the shared holder.
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    // Attach the widget to a TUI with a focused empty editor so its keyboard
    // state machine can be driven (kept alive for the key sequence).
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());

    startRun({
      id: "run-enter",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });

    // Expand (↓) selects the run; enter must open the read-only overlay.
    inputHandler("\u001b[B");
    const result = inputHandler("\r");
    assert.deepEqual(result, { consume: true }, "enter must be consumed");
    assert.equal(opened, 1, "ui.custom must be called once");
    assert.equal(typeof factory, "function", "a component factory is passed");
    dispose();
  });

  it("collapses the fleet widget to the stable one-line state before opening the overlay", async () => {
    // Root cause regression: the overlay compositor line-diffs the base
    // content.  An expanded widget (~10 lines) that collapses mid-overlay
    // (the editor-focus guard on each keypress) mutates the base length
    // under the open overlay, forcing a full symmetric re-paint.  enterRun
    // must collapse the widget BEFORE the overlay opens.
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    let opened = 0;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: () => {
        opened += 1;
        return Promise.resolve(undefined);
      },
    });

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());

    startRun({
      id: "run-collapse",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });

    // Expand (↓) so the widget is NOT already collapsed — the enter path
    // must collapse it before the overlay opens.
    inputHandler("\u001b[B");
    assert.ok(
      renderZooWidget(calls, 80, focusedEditorTui()).lines.length > 1,
      "precondition: the widget is expanded",
    );
    inputHandler("\r");
    assert.equal(opened, 1, "the overlay must open");
    // After enter, the widget renders the single-line collapsed state.
    const after = renderZooWidget(calls, 80, focusedEditorTui()).lines;
    assert.equal(after.length, 1, "widget must be collapsed for the overlay");
    dispose();
  });

  it("keeps the widget collapsed after the overlay closes; ↓ re-expands", async () => {
    // Overlay close (pi re-renders the base) must find the widget in the
    // stable one-line state the enter path collapsed it into — a length
    // change at close would repaint the whole base again.  The normal ↓
    // path still re-expands afterwards (unchanged semantics).
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    let opened = 0;
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f, _options) => {
        opened += 1;
        factory = f;
        return Promise.resolve(undefined);
      },
    });

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());

    startRun({
      id: "run-close",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });

    inputHandler("\u001b[B"); // expand
    inputHandler("\r"); // open the overlay (collapses the widget)
    assert.equal(opened, 1);
    // Simulate pi closing the overlay: build the overlay component and drive
    // its esc key (the close path routes through the component's `done`).
    let closed = 0;
    const overlay = (
      factory as (
        tui: unknown,
        theme: unknown,
        _keybindings: unknown,
        done: (result: undefined) => void,
      ) => { handleInput(data: string): void }
    )(WIDGET_TUI, WIDGET_THEME, undefined, () => {
      closed += 1;
    });
    overlay.handleInput("\u001b");
    assert.equal(closed, 1, "esc must close the overlay");
    const after = renderZooWidget(calls, 80, focusedEditorTui()).lines;
    assert.equal(after.length, 1, "widget stays collapsed after overlay close");
    // The collapsed state never steals keys; ↓ re-expands as before.
    const result = inputHandler("\u001b[B");
    assert.deepEqual(result, { consume: true });
    assert.ok(
      renderZooWidget(calls, 80, focusedEditorTui()).lines.length > 1,
      "↓ must re-expand after the overlay closed",
    );
    dispose();
  });

  it("does not open an overlay when the cached ctx exposes no ui.custom", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    // No ui.custom on the cached ctx (a host ui surface without the overlay
    // opener).
    const { calls, inputHandler, ctx } = widgetInputCtx();
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());
    startRun({
      id: "run-no-ctx",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });

    inputHandler("\u001b[B");
    const result = inputHandler("\r");
    assert.equal(
      result,
      undefined,
      "enter must fall through when no ui.custom is cached",
    );
    dispose();
  });

  it("opens the overlay for a run with an empty log (empty-transcript line)", async () => {
    // The log is the single data source: a run whose log carries no facts
    // yet still opens (the key is consumed) and explains itself.
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f: unknown) => {
        factory = f;
        return Promise.resolve(undefined);
      },
    });
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());
    startRun({
      id: "run-empty",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });

    inputHandler("\u001b[B");
    const result = inputHandler("\r");
    assert.deepEqual(result, { consume: true }, "enter must be consumed");
    const component = (factory as (tui: unknown, theme: unknown) => unknown)(
      WIDGET_TUI,
      WIDGET_THEME,
    );
    const lines = (component as { render(width: number): string[] }).render(80);
    assert.ok(
      lines.some((l) => l.includes("(empty transcript)")),
      `the empty-log line must render: ${lines.join(" | ")}`,
    );
    dispose();
  });

  it("projects the run's existing facts when the overlay opens", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f: unknown) => {
        factory = f;
        return Promise.resolve(undefined);
      },
    });
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());
    startRun({
      id: "run-projected",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });
    const run = getRun("run-projected");
    assert.ok(run, "the run must be registered");
    run.log.appendMessage([{ type: "text", text: "projected fact" }]);
    finishRun("run-projected", { status: "done" });

    inputHandler("\u001b[B");
    const result = inputHandler("\r");
    assert.deepEqual(result, { consume: true });
    const component = (factory as (tui: unknown, theme: unknown) => unknown)(
      WIDGET_TUI,
      WIDGET_THEME,
    );
    const lines = (component as { render(width: number): string[] }).render(80);
    assert.ok(
      lines.some((l) => l.includes("projected fact")),
      `the pre-existing fact must render: ${lines.join(" | ")}`,
    );
    dispose();
  });

  it("renders facts appended while the overlay is open (live log subscription)", async () => {
    // The composition seam: a running run's log delivers onto the open
    // overlay through the log's single stream subscription — no polling, no
    // bus.
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f: unknown) => {
        factory = f;
        return Promise.resolve(undefined);
      },
    });
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());
    startRun({
      id: "run-running",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });
    inputHandler("\u001b[B");
    const result = inputHandler("\r");
    assert.deepEqual(result, { consume: true });
    const component = (factory as (tui: unknown, theme: unknown) => unknown)(
      WIDGET_TUI,
      WIDGET_THEME,
    );
    const render = (): string[] =>
      (component as { render(width: number): string[] }).render(80);
    let lines = render();
    assert.ok(
      lines.some((l) => l.includes("(empty transcript)")),
      lines.join(" | "),
    );
    // A message fact appended while the overlay is open becomes visible.
    getRun("run-running")?.log.appendMessage([
      { type: "text", text: "live-tail" },
    ]);
    lines = render();
    assert.ok(
      lines.some((l) => l.includes("live-tail")),
      `the live message must render: ${lines.join(" | ")}`,
    );
    dispose();
  });
});
// ---------------------------------------------------------------------------
// Fleet widget enter-inspect — post-restart hydration of rebuilt runs
// ---------------------------------------------------------------------------

describe("buildPiHandlers — fleet widget enter-inspect hydration", () => {
  afterEach(() => {
    resetHydration();
  });

  /** One `message` line of a pi session jsonl. */
  function line(message: unknown): string {
    return JSON.stringify({
      type: "message",
      id: `m${Math.random().toString(36).slice(2)}`,
      parentId: null,
      timestamp: "2026-08-31T00:00:00.000Z",
      message,
    });
  }

  /** Write a minimal pi session jsonl (header + given message records). */
  async function writeSession(messages: unknown[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zoo-enter-hydrate-"));
    const path = join(dir, "session.jsonl");
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "ses-enter-hydrate",
      timestamp: "2026-08-31T00:00:00.000Z",
      cwd: "/tmp",
    });
    await writeFile(path, [header, ...messages.map(line)].join("\n"), "utf-8");
    return path;
  }

  /**
   * Wire a session, register one run, press the selection keys and enter,
   * then hand back the overlay-open counters and a render helper.
   */
  async function openOverlayOn(
    run: { id: string; sessionPath?: string; finish?: boolean },
    presses = 1,
  ): Promise<{
    opened: () => number;
    renderOverlay: () => string[];
    dispose: () => void;
  }> {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    let opened = 0;
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f: unknown) => {
        opened += 1;
        factory = f;
        return Promise.resolve(undefined);
      },
    });
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());
    startRun({
      id: run.id,
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
      ...(run.sessionPath !== undefined
        ? { sessionPath: run.sessionPath }
        : {}),
    });
    if (run.finish === true) finishRun(run.id, { status: "done" });
    inputHandler("\u001b[B"); // expand + select the run
    for (let i = 0; i < presses; i++) inputHandler("\r");
    return {
      opened: () => opened,
      renderOverlay: () => {
        const component = (
          factory as (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: (r: undefined) => void,
          ) => { render(width: number): string[] }
        )(WIDGET_TUI, WIDGET_THEME, undefined, () => {});
        return component.render(80);
      },
      dispose,
    };
  }

  it("opens the overlay on the hydrated facts of a scanner-rebuilt run", async () => {
    // A run rebuilt by the history scanner carries lifecycle metadata and a
    // sessionPath but an EMPTY log; entering it must show the persisted
    // transcript, never "(empty transcript)".
    const path = await writeSession([
      {
        role: "assistant",
        content: [{ type: "text", text: "restored from disk" }],
        timestamp: 100,
      },
    ]);
    const h = await openOverlayOn({
      id: "run-rebuilt",
      sessionPath: path,
      finish: true,
    });
    await waitForHydration("run-rebuilt");
    // The overlay opens from the load's settle continuation — let it run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.opened(), 1, "the settled load must open the overlay");
    const lines = h.renderOverlay();
    assert.ok(
      lines.some((l) => l.includes("restored from disk")),
      `the hydrated fact must render: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("(empty transcript)")),
      lines.join(" | "),
    );
    h.dispose();
  });

  it("opens synchronously when the shared cache already holds the log", async () => {
    // The dedupe the inline card relies on: a warm cache (the card already
    // loaded this run) means enter opens right on the keypress.
    const path = await writeSession([
      {
        role: "assistant",
        content: [{ type: "text", text: "warm cache" }],
        timestamp: 100,
      },
    ]);
    beginHydration("run-warm", path);
    await waitForHydration("run-warm");
    const h = await openOverlayOn({
      id: "run-warm",
      sessionPath: path,
      finish: true,
    });
    assert.equal(h.opened(), 1, "a warm hydration must open on the keypress");
    const lines = h.renderOverlay();
    assert.ok(
      lines.some((l) => l.includes("warm cache")),
      lines.join(" | "),
    );
    h.dispose();
  });

  it("states the unavailable notice when the session file cannot be read", async () => {
    // Hydration failure is terminal for that run (the cache never retries):
    // the overlay still opens and says why there is nothing to show.
    const h = await openOverlayOn({
      id: "run-gone",
      sessionPath: "/nonexistent/zoo-enter-hydrate/none.jsonl",
      finish: true,
    });
    await waitForHydration("run-gone");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.opened(), 1, "the failed load must still open the overlay");
    const lines = h.renderOverlay();
    assert.ok(
      lines.some((l) => l.includes(TRANSCRIPT_UNAVAILABLE_NOTICE)),
      `the unavailable notice must render: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("(empty transcript)")),
      lines.join(" | "),
    );
    h.dispose();
  });

  it("never swaps a still-running run onto a file snapshot", async () => {
    // A running run's log is the live source: hydrating it from the partially
    // written session file would both duplicate facts and cut the overlay off
    // from the driver's appends.  Enter must open the live log immediately.
    const path = await writeSession([
      {
        role: "assistant",
        content: [{ type: "text", text: "stale file snapshot" }],
        timestamp: 100,
      },
    ]);
    const h = await openOverlayOn({ id: "run-live", sessionPath: path });
    assert.equal(h.opened(), 1, "a running run opens on the keypress");
    getRun("run-live")?.log.appendMessage([
      { type: "text", text: "live tail fact" },
    ]);
    const lines = h.renderOverlay();
    assert.ok(
      lines.some((l) => l.includes("live tail fact")),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((l) => l.includes("stale file snapshot")),
      "the file snapshot must not be projected over the live log",
    );
    h.dispose();
  });

  it("opens a single overlay when enter is pressed twice during the load", async () => {
    // The deferred open is async; a second keypress while the load is in
    // flight must not stack a second overlay on the same run.
    const path = await writeSession([
      {
        role: "assistant",
        content: [{ type: "text", text: "once only" }],
        timestamp: 100,
      },
    ]);
    const h = await openOverlayOn(
      { id: "run-twice", sessionPath: path, finish: true },
      2,
    );
    await waitForHydration("run-twice");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.opened(), 1, "exactly one overlay may open per run");
    h.dispose();
  });
});
// ---------------------------------------------------------------------------
// Fleet widget enter-inspect — overlay border + title agent colorization
// ---------------------------------------------------------------------------

describe("buildPiHandlers — transcript overlay border + title agent color", () => {
  /** Open the overlay for a run and render its component with a stub theme. */
  async function renderOverlayFor(
    raw: unknown,
    run: { id: string; agent: string; label?: string },
  ): Promise<string[]> {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, raw as any);
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f: unknown) => {
        factory = f;
        return Promise.resolve(undefined);
      },
    });
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 200, focusedEditorTui());
    startRun({
      id: run.id,
      agent: run.agent,
      parentSession: "sess-enter",
      startedAt: 1000,
      ...(run.label !== undefined ? { label: run.label } : {}),
    });
    inputHandler("\u001b[B");
    inputHandler("\r");
    const component = (factory as (tui: unknown, theme: unknown) => unknown)(
      WIDGET_TUI,
      WIDGET_THEME,
    );
    const lines = (component as { render(width: number): string[] }).render(
      200,
    );
    dispose();
    return lines;
  }

  it("colors the overlay title line with the inspected run's agent color", async () => {
    const lines = await renderOverlayFor(COLORS_RAW, {
      id: "run-color",
      agent: "beaver",
    });
    // beaver's configured color #39C5BB wraps the whole title line in the
    // truecolor sequence; the hint keeps its own dim color.
    const title = lines.find((l) => l.includes("beaver"));
    assert.ok(title, "the title line must be present");
    // The whole title line is wrapped as one colorized unit in beaver's
    // truecolor sequence (#39C5BB = 57,197,187) — the full-screen surface
    // has no border glyphs to colorize separately.  (runTitle pre-wraps the
    // agent name, so the sequence appears twice; padding follows after.)
    const esc = "\x1b[38;2;57;197;187m";
    assert.ok(title.startsWith(esc), title);
    assert.ok(title.includes(`${esc}beaver\x1b[39m`), title);
    assert.ok(
      lines.every((l) => !l.includes("╭") && !l.includes("│")),
      lines.join("\n"),
    );
  });

  it("falls back to the fixed title color when the agent has no configured color", async () => {
    // MODES_RAW declares no agent colors → the overlay title line falls back
    // to the stub theme's `border` color (current default).
    const lines = await renderOverlayFor(MODES_RAW, {
      id: "run-nocolor",
      agent: "beaver",
    });
    const title = lines.find((l) => l.includes("beaver"));
    assert.ok(title, "the title line must be present");
    assert.ok(title.includes("<border>beaver</border>"), title);
    assert.ok(
      lines.every((l) => !l.includes("╭") && !l.includes("│")),
      lines.join("\n"),
    );
  });

  it("colors the title agent name with the run's configured color", async () => {
    // beaver carries #39C5BB in COLORS_RAW → the title's agent name is
    // pre-colorized by `runTitle` (the same `colorizeAgent` source as the
    // widget) before the overlay renders it.  pi's width handling preserves
    // ANSI, so the wrapped name survives verbatim in the rendered title line.
    const lines = await renderOverlayFor(COLORS_RAW, {
      id: "run-title-color",
      agent: "beaver",
      label: "实现任务",
    });
    const esc = "\x1b[38;2;57;197;187m"; // #39C5BB = 57,197,187
    const title = lines.find((l) => l.includes("实现任务"));
    assert.ok(title, lines.join("\n"));
    assert.ok(title.includes(`${esc}beaver\x1b[39m · 实现任务`), title);
  });

  it("keeps the title agent name plain when the agent has no configured color", async () => {
    // MODES_RAW declares no colors → `runTitle` falls back to the plain
    // agent name (fail-closed), so the title carries no agent truecolor
    // foreground sequence.  (The overlay's width padding may still emit a
    // neutral `\x1b[0m` reset — that is pi-tui truncation, not coloring.)
    const lines = await renderOverlayFor(MODES_RAW, {
      id: "run-title-nocolor",
      agent: "beaver",
      label: "实现任务",
    });
    const title = lines.find((l) => l.includes("实现任务"));
    assert.ok(title, lines.join("\n"));
    assert.ok(title.includes("beaver · 实现任务"), title);
    assert.ok(
      !title.includes("\x1b[38;2;"),
      `no agent truecolor sequence in the title: ${JSON.stringify(title)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Zoo widget colorization
// ---------------------------------------------------------------------------

describe("buildPiHandlers — zoo widget colorization", () => {
  /** The truecolor ANSI wrapper for an agent name. */
  function colorize(name: string, hex: string): string {
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    return `\x1b[38;2;${r};${g};${b}m${name}\x1b[39m`;
  }

  it("registers the fleet widget whose collapsed line uses the ANSI-wrapped primary when its color is configured", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, COLORS_RAW);
    const { calls, ctx } = widgetRecordingCtx();
    // The default primary (dolphin) carries #66CCFF → the widget's collapsed
    // line embeds the truecolor-wrapped name (inside the muted status hue).
    await handlers.beforeAgentStart({ systemPrompt: "base" }, ctx);
    const { lines, dispose } = renderZooWidget(calls);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(colorize("dolphin", "#66CCFF")), lines[0]);
    dispose();
  });

  it("leaves the collapsed primary plain when it has no configured color", async () => {
    const api = mockApi();
    // MODES_RAW has no color fields → the colors map is empty, so the
    // primary falls back to the plain agent name (fail-closed).
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    const { calls, ctx } = widgetRecordingCtx();
    await handlers.beforeAgentStart({ systemPrompt: "base" }, ctx);
    const { lines, dispose } = renderZooWidget(calls);
    assert.ok(lines[0].includes("dolphin"), lines[0]);
    assert.ok(!lines[0].includes("\u001b["), "no ANSI when uncolored");
    dispose();
  });

  it("leaves the collapsed primary plain when the color for that agent is malformed", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(POLY_ZOO, api as any, {
      ...MODES_RAW,
      agent: {
        ...MODES_RAW.agent,
        dolphin: { mode: "primary", color: "red" }, // invalid hex
        mola: { mode: "primary", color: "#FFA500" },
      },
    });
    const { calls, ctx } = widgetRecordingCtx();
    // Malformed color is omitted by the parser → the primary stays plain.
    await handlers.beforeAgentStart({ systemPrompt: "base" }, ctx);
    const { lines, dispose } = renderZooWidget(calls);
    assert.ok(lines[0].includes("dolphin"), lines[0]);
    assert.ok(!lines[0].includes("\u001b["), "no ANSI for a malformed color");
    dispose();
  });
});

// ---------------------------------------------------------------------------
// Primary-switch command widget colorization
// ---------------------------------------------------------------------------

describe("buildPiHandlers — primary-switch widget colorization", () => {
  /**
   * A command ctx whose newSession runs withSession against a
   * per-fresh-session facade (mirroring pi.ts's implementation:
   * setWidget binds to the fresh ui, setActiveTools / appendEntry apply
   * to the mock API as the deferred drain would).
   */
  function switchCtx(
    setWidget: (key: string, lines: string[] | undefined) => void = () => {},
  ): {
    sessionManager: { getSessionId(): string };
    ui: {
      notify(): void;
      setWidget(
        key: string,
        lines: string[] | undefined,
        options?: { placement?: "aboveEditor" | "belowEditor" },
      ): void;
    };
    newSession(options?: {
      parentSession?: string;
      withSession?: (newCtx: unknown) => void | Promise<void>;
    }): Promise<{ cancelled: boolean }>;
  } {
    return {
      sessionManager: { getSessionId: () => "sess-switch" },
      ui: { notify: () => {}, setWidget },
      async newSession(options) {
        // pi passes the fresh ReplacedSessionContext to withSession.
        await options?.withSession?.({
          ui: { setWidget },
          sessionManager: { getSessionId: () => "sess-new" },
        });
        return { cancelled: false };
      },
    };
  }

  it("switch command nudges the fleet widget which renders the ANSI-wrapped target name", async () => {
    const api = mockApi();
    api.activeTools.push("webfetch", "edit");
    const handlers = buildPiHandlers(POLY_ZOO, api as any, {
      agent: {
        ...COLORS_RAW.agent,
        mola: { mode: "primary", color: "#FFA500" },
      },
    });
    const mola = api.commands.find((c) => c.name === "mola");
    assert.ok(mola && typeof mola.handler === "function");

    // Register the fleet widget first (session_start), then switch away from
    // the default primary (dolphin) to mola.
    const { calls, ctx } = widgetRecordingCtx();
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    setPrimary("dolphin");

    // The switch no longer writes a string-array widget for zoo — it is a
    // "primary changed" notification the fleet widget turns into a re-render
    // (the widget reads the primary live).
    await (mola.handler as (args: string, ctx: unknown) => Promise<void>)(
      "",
      switchCtx(() => {}),
    );
    assert.equal(getPrimary(), "mola");

    // The registered fleet widget now renders the switched primary with its
    // configured color.
    const { lines, dispose } = renderZooWidget(calls);
    const r = 0xff;
    const g = 0xa5;
    const b = 0x00;
    assert.ok(
      lines[0].includes(`\x1b[38;2;${r};${g};${b}mmola\x1b[39m`),
      lines[0],
    );
    dispose();
  });

  it("switch command leaves the fleet-widget primary plain for an agent without a color", async () => {
    const api = mockApi();
    api.activeTools.push("webfetch", "edit");
    // COLORS_RAW has no color for spider; MODES_RAW has no colors at all.
    // Build with MODES_RAW so the colors map is empty → plain name.
    const handlers = buildPiHandlers(POLY_ZOO, api as any, MODES_RAW);
    const dolphin = api.commands.find((c) => c.name === "dolphin");
    assert.ok(dolphin && typeof dolphin.handler === "function");

    // Register the fleet widget first, then switch away from the default
    // primary (mola) to dolphin.
    const { calls, ctx } = widgetRecordingCtx();
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    setPrimary("mola");

    await (dolphin.handler as (args: string, ctx: unknown) => Promise<void>)(
      "",
      switchCtx(() => {}),
    );
    assert.equal(getPrimary(), "dolphin");

    const { lines, dispose } = renderZooWidget(calls);
    assert.ok(lines[0].includes("dolphin"), lines[0]);
    assert.ok(!lines[0].includes("\u001b["), "no ANSI for an uncolored agent");
    dispose();
  });
});

// ---------------------------------------------------------------------------
// zoo-notice entry renderer
// ---------------------------------------------------------------------------

describe("buildPiNoticeEntryRenderer", () => {
  it("renders the notification text from the entry data content", () => {
    const renderer = buildPiNoticeEntryRenderer();
    const theme = { fg: (_color: string, text: string) => text };
    const component = renderer(
      { data: { content: "上下文报告\ntokens: 100" } },
      { expanded: false },
      theme,
    ) as { render(): string[] } | undefined;
    assert.ok(component, "a component must be returned");
    assert.deepEqual(component.render(), [
      "[zoo]",
      "上下文报告",
      "tokens: 100",
    ]);
  });

  it("uses the themed label when the theme exposes fg", () => {
    const renderer = buildPiNoticeEntryRenderer();
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    };
    const component = renderer(
      { data: { content: "report" } },
      { expanded: false },
      theme,
    ) as { render(): string[] } | undefined;
    assert.ok(component);
    assert.deepEqual(component.render(), [
      "<customMessageLabel>[zoo]</customMessageLabel>",
      "report",
    ]);
  });

  it("returns undefined for an empty or missing payload", () => {
    const renderer = buildPiNoticeEntryRenderer();
    assert.equal(renderer({ data: { content: "" } }, {}, undefined), undefined);
    assert.equal(renderer({ data: undefined }, {}, undefined), undefined);
    assert.equal(
      renderer({ data: { content: "  " } }, {}, undefined),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour
// ---------------------------------------------------------------------------

describe("buildPiHandlers — null profile fail-closed", () => {
  it("all six handlers no-op with a null profile", async () => {
    const handlers = buildPiHandlers({});
    // session_start with a ui ctx must not seed anything without a profile
    // (no pi switch host → fail-closed silent no-op).
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      {
        sessionManager: { getSessionId: () => "sess-null" },
        ui: { notify: () => {}, setWidget: () => {} },
      },
    );
    const prompt = await handlers.beforeAgentStart({ systemPrompt: "base" });
    assert.equal(prompt.systemPrompt, "base");
    assert.deepEqual((await handlers.resourcesDiscover()).skillPaths, []);
    assert.equal(
      await handlers.toolResult(
        {
          type: "tool_result",
          toolName: "edit",
          toolCallId: "call-1",
          content: [{ type: "text", text: "x" }],
          isError: false,
        },
        SESSION_CTX,
      ),
      undefined,
    );
    const contextResult = await handlers.contextHandler(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      SESSION_CTX,
    );
    assert.deepEqual(contextResult, {
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(
      await handlers.messageEnd(
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[m3] hi" }],
          },
        },
        SESSION_CTX,
      ),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// plugin_init load-time event
// ---------------------------------------------------------------------------

describe("buildPiHandlers — plugin_init load-time event", () => {
  it("emits plugin_init once at load with agents/skills/limits fields", () => {
    // Init the logger so the load-time plugin_init is attributed to a
    // temp log dir instead of tripping the one-time used-before-init
    // warning (isolation pattern used across this file).
    const logDir = fs.mkdtempSync(join(tmpdir(), "zoo-pi-log-"));
    try {
      initLogger("pi", { logDir });
      buildPiHandlers(POLY_ZOO);
      const inits = _getBufferForTesting().filter(
        (entry) => entry.event === "plugin_init",
      );
      assert.equal(inits.length, 1, "exactly one plugin_init at load");
      const init = inits[0];
      assert.equal(init.hook, "plugin");
      assert.equal(init.sessionId, "");
      assert.equal(init.level, "info");
      assert.deepEqual(
        init.agents,
        POLY_PROFILE.agents,
        "agents must list the composed agent names",
      );
      assert.deepEqual(
        init.skills,
        POLY_PROFILE.skills,
        "skills must list the composed skill names",
      );
      assert.deepEqual(init.limits, {
        contextWordLimit: 200,
        promptWordLimit: 500,
      });
    } finally {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("null profile → plugin_init with empty agents/skills", () => {
    const logDir = fs.mkdtempSync(join(tmpdir(), "zoo-pi-log-"));
    try {
      initLogger("pi", { logDir });
      buildPiHandlers({});
      const inits = _getBufferForTesting().filter(
        (entry) => entry.event === "plugin_init",
      );
      assert.equal(inits.length, 1);
      assert.deepEqual(inits[0].agents, []);
      assert.deepEqual(inits[0].skills, []);
    } finally {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("buffers plugin_init sessionless; flush into the first pi session's file", () => {
    const logDir = fs.mkdtempSync(join(tmpdir(), "zoo-pi-log-"));
    try {
      initLogger("pi", { logDir });
      buildPiHandlers(POLY_ZOO);

      // Load-time plugin_init is sessionless and no session exists yet:
      // it stays buffered and no pi.log host-level file is created.
      _flushForTesting();
      assert.equal(
        fs.existsSync(join(logDir, "pi.log")),
        false,
        "no host-level pi.log may be created",
      );
      assert.ok(
        _getBufferForTesting().some((e) => e.event === "plugin_init"),
        "plugin_init must remain buffered until a session exists",
      );

      // The first sessioned entry establishes the primary pi session;
      // the buffered plugin_init now flushes into its file.
      log("plugin", "handler", "pi-sess", undefined, "info");
      _flushForTesting();

      const primaryFile = join(logDir, "pi-pi-sess.log");
      assert.ok(
        fs.existsSync(primaryFile),
        "primary pi session file must exist",
      );
      const lines = fs.readFileSync(primaryFile, "utf-8").trimEnd().split("\n");
      const events = lines.map((line) => JSON.parse(line).event);
      assert.ok(
        events.includes("plugin_init"),
        "buffered plugin_init must land in the first pi session's file",
      );
      assert.equal(
        fs.existsSync(join(logDir, "pi.log")),
        false,
        "no host-level pi.log may be created",
      );
    } finally {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Thin entry wiring
// ---------------------------------------------------------------------------

describe("zookeeperPi — thin entry wiring", () => {
  it("registers all six hooks against the real config.toml (poly full)", async () => {
    // The real config.toml carries [zoo.mode.poly] (and a second
    // [zoo.mode.mono] sub-table).  Point the mode state file at poly so
    // the entry selects the full profile.
    await withModeFile(JSON.stringify({ mode: "poly" }), async () => {
      const api = mockApi();
      zookeeperPi(api as any);
      assert.equal(typeof api.handlers.session_start, "function");
      assert.equal(typeof api.handlers.before_agent_start, "function");
      assert.equal(typeof api.handlers.resources_discover, "function");
      assert.equal(typeof api.handlers.tool_result, "function");
      assert.equal(typeof api.handlers.context, "function");
      assert.equal(typeof api.handlers.message_end, "function");

      // The ctrl+tab cyclic primary-switch shortcut is no longer
      // registered: switching is done exclusively through the /<agent>
      // commands, which replace the session.
      assert.deepEqual(
        api.shortcuts.filter((s) => s.shortcut === "ctrl+tab"),
        [],
        "no ctrl+tab shortcut may be registered",
      );

      // The extension load logs a single plugin_init startup anchor with
      // the composed agents/skills/limits (mirrors the OpenCode host).
      const inits = _getBufferForTesting().filter(
        (entry) => entry.event === "plugin_init",
      );
      assert.equal(
        inits.length,
        1,
        "exactly one plugin_init at extension load",
      );
      const init = inits[0];
      assert.equal(init.hook, "plugin");
      assert.equal(init.sessionId, "");
      assert.equal(init.level, "info");
      assert.equal(
        (init.agents as string[]).length,
        7,
        "real poly profile composes 7 agents",
      );
      assert.equal(
        (init.skills as string[]).length,
        12,
        "real poly profile composes 12 skills",
      );
      assert.deepEqual(init.limits, {
        contextWordLimit: 200,
        promptWordLimit: 500,
      });

      // The zoo-notice entry renderer is registered against the real
      // config.toml profile so in-session notifications render in the TUI.
      assert.ok(
        api.renderers.some(
          (r) =>
            r.customType === "zoo-notice" && typeof r.renderer === "function",
        ),
        "zoo-notice renderer must be registered",
      );

      const prompt = (await api.handlers.before_agent_start({
        systemPrompt: "base",
      })) as { systemPrompt: string };
      assert.ok(prompt.systemPrompt.startsWith("<Role>"));

      const resources = (await api.handlers.resources_discover()) as {
        skillPaths: string[];
      };
      // The default primary (dolphin) denies the beaver-*/kiwi-*/mola-*
      // skill globs in config.toml, so 4 of the 12 profile skills are
      // filtered out at session bind.
      assert.equal(resources.skillPaths.length, 8);
      for (const path of resources.skillPaths) {
        assert.ok(
          !/beaver-|kiwi-|mola-/.test(path),
          `${path} must not be a dolphin-denied skill`,
        );
      }

      // tool_result runs the real poly hooks: json-error-nudge is
      // enabled there, so a JSON parse error output gets the reminder.
      const toolResult = (await api.handlers.tool_result(
        {
          type: "tool_result",
          toolName: "browser",
          toolCallId: "call-json",
          content: [
            { type: "text", text: "Error: json parse error at line 3" },
          ],
          isError: true,
        },
        SESSION_CTX,
      )) as { content: { type: string; text?: string }[] } | undefined;
      assert.ok(
        toolResult,
        "json-error-nudge must fire on the real poly profile",
      );
      assert.ok(
        joinedText(toolResult).includes(JSON_ERROR_REMINDER_MARKER),
        "output must carry the JSON reminder marker",
      );

      // message_end strips model-imitated line-start ref echoes from
      // finalized assistant text.
      const messageEnd = (await api.handlers.message_end(
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[m3] hello" }],
          },
        },
        SESSION_CTX,
      )) as
        | {
            message: {
              role: string;
              content: { type: string; text: string }[];
            };
          }
        | undefined;
      assert.ok(messageEnd);
      assert.equal(messageEnd?.message?.content[0]?.text, "hello");
    });
  });
});
