/**
 * Tests for the profile-driven pi extension (`src/pi.ts`).
 *
 * Covers: `buildPiContributions` composing the full registry from the
 * active `[zoo.mode.*]` profile (agents/skills/hooks/tools/commands,
 * unconditional pruning contribution, dolphin Map gating, null/invalid
 * profile → empty composition), `buildPiHandlers` wiring the four hook
 * handlers (dolphin prompt injection, skill discovery, compose-driven
 * `tool_result` nudge gating, measure-only `context` handler), and the
 * thin entry (`zookeeperPi`) against the real config.toml.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  DIRECT_WORK_NUDGE,
  JSON_ERROR_REMINDER_MARKER,
} from "./core/prompts.js";
import { buildPiContributions, buildPiHandlers, zookeeperPi } from "./pi.js";
import { _getBufferForTesting, _resetForTesting } from "./utils/logger.js";
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
    "context-metrics",
  ],
  tools: ["compress", "decompress"],
  commands: ["go", "dcp"],
};

/** A full zoo config carrying the poly profile. */
const POLY_ZOO = {
  validation: { context_word_limit: 200, prompt_word_limit: 500 },
  context: { protected_messages: 20, released_percent: 10 },
  mode: { poly: POLY_PROFILE },
};

/** Session context shared by the handler tests. */
const SESSION_CTX = { sessionManager: { getSessionId: () => "sess-1" } };

/** A minimal stand-in for pi's ExtensionAPI that records handlers. */
function mockApi(): {
  handlers: Record<string, (...args: any[]) => unknown>;
  on(event: string, handler: (...args: any[]) => unknown): void;
} {
  const handlers: Record<string, (...args: any[]) => unknown> = {};
  return {
    on(event, handler) {
      handlers[event] = handler;
    },
    handlers,
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
  delete process.env.ZOO_MODE_FILE;
});

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
    // unit contributes unconditionally, so both transform handlers
    // appear (registry order: pruning before metrics).
    assert.deepEqual(
      composed.transform.map((h) => h.name),
      ["contextPruning", "contextMetrics"],
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
  it("poly full → dolphin prompt prepended, all 11 skill dirs discovered", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
    const result = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.ok(result.systemPrompt.startsWith("<Role>"));
    assert.ok(result.systemPrompt.endsWith("base"));

    const resources = await handlers.resourcesDiscover();
    assert.equal(resources.skillPaths.length, 11);
    for (const path of resources.skillPaths) {
      assert.ok(existsSync(path), `${path} must exist`);
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

  it("profile without dolphin → prompt untouched; skills filtered", async () => {
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

  it("direct-work-nudge in hooks + dolphin agent → edit nudge appended", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
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

  it("profile without dolphin → direct-work nudge skipped", async () => {
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

  it("hooks without direct-work-nudge → no delegation nudge even for dolphin", async () => {
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
  it("context handler is measure-only — always returns undefined", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
    const result = await handlers.contextMetrics(
      {
        type: "context",
        messages: [{ role: "user", content: "hello" }],
      },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });

  it("context handler runs the pruning pipeline too (measure-only)", async () => {
    // context-pruning is in the poly hooks list and the unit is no
    // longer gated on client capabilities, so its transform handler
    // runs on every pi context event.  The handler is measure-only —
    // the result stays undefined either way.
    const handlers = buildPiHandlers(POLY_ZOO);
    const result = await handlers.contextMetrics(
      { type: "context", messages: [] },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour
// ---------------------------------------------------------------------------

describe("buildPiHandlers — null profile fail-closed", () => {
  it("all four handlers no-op with a null profile", async () => {
    const handlers = buildPiHandlers({});
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
    assert.equal(
      await handlers.contextMetrics(
        { type: "context", messages: [{ role: "user", content: "hi" }] },
        SESSION_CTX,
      ),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Thin entry wiring
// ---------------------------------------------------------------------------

describe("zookeeperPi — thin entry wiring", () => {
  it("registers all four hooks against the real config.toml (poly full)", async () => {
    // The real config.toml carries [zoo.mode.poly] (and a second
    // [zoo.mode.mono] sub-table).  Point the mode state file at poly so
    // the entry selects the full profile.
    await withModeFile(JSON.stringify({ mode: "poly" }), async () => {
      const api = mockApi();
      zookeeperPi(api as any);
      assert.equal(typeof api.handlers.before_agent_start, "function");
      assert.equal(typeof api.handlers.resources_discover, "function");
      assert.equal(typeof api.handlers.tool_result, "function");
      assert.equal(typeof api.handlers.context, "function");

      const prompt = (await api.handlers.before_agent_start({
        systemPrompt: "base",
      })) as { systemPrompt: string };
      assert.ok(prompt.systemPrompt.startsWith("<Role>"));

      const resources = (await api.handlers.resources_discover()) as {
        skillPaths: string[];
      };
      assert.equal(resources.skillPaths.length, 11);

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
    });
  });
});
