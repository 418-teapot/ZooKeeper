/**
 * Tests for the profile-driven pi extension (`src/pi.ts`).
 *
 * Covers: `buildPiContributions` selecting the agent/skill units from the
 * active `[zoo.mode.*]` profile (poly-full parity, dolphin gating, empty
 * lists, null/invalid profile → empty contributions), `buildPiHandlers`
 * wiring the dolphin prompt injection and skill discovery, and the thin
 * entry (`zookeeperPi`) against the real config.toml.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { buildPiContributions, buildPiHandlers, zookeeperPi } from "./pi.js";
import { _getBufferForTesting, _resetForTesting } from "./utils/logger.js";

/** The poly profile (mirrors the `[zoo.mode.poly]` lists). */
const POLY_PROFILE = {
  agents: ["dolphin", "mola", "beaver", "lynx", "spider", "eagle", "kiwi"],
  skills: [
    "beaver-tdd",
    "code-review",
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

afterEach(() => {
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Profile-driven selection
// ---------------------------------------------------------------------------

describe("buildPiContributions — profile-driven selection", () => {
  it("poly full profile → 7 agents incl. dolphin prompt, 10 skills", () => {
    const { composed, profile } = buildPiContributions(POLY_ZOO);
    assert.equal(profile?.name, "poly");
    assert.equal(composed.agents.length, 7);
    assert.equal(composed.skills.length, 10);
    const dolphin = composed.agents.find((a) => a.name === "dolphin");
    assert.ok(dolphin, "dolphin must be composed");
    assert.ok(dolphin.prompt.startsWith("<Role>"));
    assert.ok(dolphin.prompt.includes("DELEGATE"));
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
  });

  it("poly full profile → no unknown_unit warnings for non-consumed categories", () => {
    // pi only consumes the agent/skill slot kinds: the hooks/tools/
    // commands profile names must not reach composeProfile's
    // `unknown_unit` warning path.
    buildPiContributions(POLY_ZOO);
    const unknownUnits = _getBufferForTesting().filter(
      (entry) => entry.event === "unknown_unit",
    );
    assert.deepEqual(unknownUnits, []);
  });

  it("ambiguous zoo.mode (two tables) → null profile, empty contributions", () => {
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
  it("poly full → dolphin prompt prepended, all 10 skill dirs discovered", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
    const result = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.ok(result.systemPrompt.startsWith("<Role>"));
    assert.ok(result.systemPrompt.endsWith("base"));

    const resources = await handlers.resourcesDiscover();
    assert.equal(resources.skillPaths.length, 10);
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
// Thin entry wiring
// ---------------------------------------------------------------------------

describe("zookeeperPi — thin entry wiring", () => {
  it("registers both hooks against the real config.toml (poly full)", async () => {
    const api = mockApi();
    zookeeperPi(api as any);
    assert.equal(typeof api.handlers.before_agent_start, "function");
    assert.equal(typeof api.handlers.resources_discover, "function");

    const prompt = (await api.handlers.before_agent_start({
      systemPrompt: "base",
    })) as { systemPrompt: string };
    assert.ok(prompt.systemPrompt.startsWith("<Role>"));

    const resources = (await api.handlers.resources_discover()) as {
      skillPaths: string[];
    };
    assert.equal(resources.skillPaths.length, 10);
  });
});
