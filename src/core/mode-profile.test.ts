/**
 * Tests for `parseModeProfile` in `src/core/config-parse.ts`.
 *
 * Covers: absent / empty / ambiguous / non-object `zoo.mode`, valid
 * single-profile parsing with all five category lists, absent categories
 * (empty lists — no defaults), invalid categories (whole-profile discard
 * with exactly one warn), unknown-key tolerance, and empty arrays.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../utils/logger.js";
import { parseModeProfile } from "./config-parse.js";

afterEach(() => {
  _resetForTesting();
});

/** The poly profile with every category populated. */
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

function warnsOf(event: string): Array<Record<string, unknown>> {
  return _getBufferForTesting().filter((e) => e.event === event);
}

// ---------------------------------------------------------------------------
// Absent / malformed zoo.mode
// ---------------------------------------------------------------------------

describe("parseModeProfile — absent or malformed zoo.mode", () => {
  it("returns null when zoo.mode is absent", () => {
    assert.equal(parseModeProfile({}), null);
    assert.equal(parseModeProfile({ validation: {} }), null);
  });

  it("returns null when zoo.mode is null", () => {
    assert.equal(parseModeProfile({ mode: null }), null);
  });

  it("returns null + warn when zoo.mode is empty (no profile declared)", () => {
    assert.equal(parseModeProfile({ mode: {} }), null);
    const warns = warnsOf("mode_config_invalid");
    assert.equal(
      warns.length,
      1,
      "empty zoo.mode warns like other invalid shapes",
    );
    assert.equal((warns[0] as Record<string, unknown>).key, "mode");
  });

  it("returns null + warn when zoo.mode holds multiple profiles (ambiguous)", () => {
    assert.equal(
      parseModeProfile({ mode: { poly: POLY_PROFILE, lite: { agents: [] } } }),
      null,
    );
    const warns = warnsOf("mode_config_invalid");
    assert.equal(warns.length, 1, "exactly one warn for ambiguity");
    assert.equal((warns[0] as Record<string, unknown>).key, "lite");
  });

  it("returns null + warn when zoo.mode is not an object", () => {
    assert.equal(parseModeProfile({ mode: "poly" }), null);
    assert.equal(warnsOf("mode_config_invalid").length, 1);
  });

  it("returns null + warn when zoo.mode is an array", () => {
    assert.equal(parseModeProfile({ mode: ["poly"] }), null);
    assert.equal(warnsOf("mode_config_invalid").length, 1);
  });

  it("returns null + warn when the profile value is not an object", () => {
    assert.equal(parseModeProfile({ mode: { poly: "all" } }), null);
    const warns = warnsOf("mode_config_invalid");
    assert.equal(warns.length, 1);
    assert.equal((warns[0] as Record<string, unknown>).key, "poly");
  });

  it("returns null + warn when the profile value is null", () => {
    assert.equal(parseModeProfile({ mode: { poly: null } }), null);
    assert.equal(warnsOf("mode_config_invalid").length, 1);
  });
});

// ---------------------------------------------------------------------------
// Valid profiles
// ---------------------------------------------------------------------------

describe("parseModeProfile — valid profiles", () => {
  it("parses a full profile with all five category lists", () => {
    const result = parseModeProfile({ mode: { poly: POLY_PROFILE } });
    assert.ok(result !== null);
    assert.equal(result.name, "poly");
    assert.deepEqual(result.agents, POLY_PROFILE.agents);
    assert.deepEqual(result.skills, POLY_PROFILE.skills);
    assert.deepEqual(result.hooks, POLY_PROFILE.hooks);
    assert.deepEqual(result.tools, POLY_PROFILE.tools);
    assert.deepEqual(result.commands, POLY_PROFILE.commands);
    assert.equal(warnsOf("mode_config_invalid").length, 0);
  });

  it("treats absent categories as empty lists — no default lists", () => {
    const result = parseModeProfile({
      mode: { lite: { agents: ["dolphin"] } },
    });
    assert.ok(result !== null);
    assert.equal(result.name, "lite");
    assert.deepEqual(result.agents, ["dolphin"]);
    assert.deepEqual(result.skills, []);
    assert.deepEqual(result.hooks, []);
    assert.deepEqual(result.tools, []);
    assert.deepEqual(result.commands, []);
  });

  it("accepts explicitly empty category arrays", () => {
    const result = parseModeProfile({
      mode: { poly: { ...POLY_PROFILE, tools: [] } },
    });
    assert.ok(result !== null);
    assert.deepEqual(result.tools, []);
  });

  it("ignores unknown keys inside the profile", () => {
    const result = parseModeProfile({
      mode: { poly: { ...POLY_PROFILE, future_key: ["x"] } },
    });
    assert.ok(result !== null);
    assert.equal(result.name, "poly");
    assert.equal(warnsOf("mode_config_invalid").length, 0);
  });
});

// ---------------------------------------------------------------------------
// Invalid categories — whole-profile discard
// ---------------------------------------------------------------------------

describe("parseModeProfile — invalid categories", () => {
  it("returns null + warn when a category is not an array", () => {
    assert.equal(
      parseModeProfile({ mode: { poly: { ...POLY_PROFILE, tools: "all" } } }),
      null,
    );
    const warns = warnsOf("mode_config_invalid");
    assert.equal(
      warns.length,
      1,
      "whole-profile discard logs exactly one warn",
    );
    assert.equal((warns[0] as Record<string, unknown>).key, "tools");
    assert.equal((warns[0] as Record<string, unknown>).value, "all");
  });

  it("returns null + warn when a category is an object", () => {
    assert.equal(
      parseModeProfile({
        mode: { poly: { ...POLY_PROFILE, hooks: { task: true } } },
      }),
      null,
    );
    assert.equal(warnsOf("mode_config_invalid").length, 1);
  });

  it("returns null + warn when a category array holds a non-string element", () => {
    assert.equal(
      parseModeProfile({
        mode: { poly: { ...POLY_PROFILE, agents: ["dolphin", 42] } },
      }),
      null,
    );
    const warns = warnsOf("mode_config_invalid");
    assert.equal(warns.length, 1);
    assert.equal((warns[0] as Record<string, unknown>).key, "agents");
  });
});
