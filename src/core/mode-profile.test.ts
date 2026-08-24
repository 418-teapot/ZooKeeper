/**
 * Tests for `parseModeProfile` in `src/core/config-parse.ts`.
 *
 * Covers: absent / empty / ambiguous / non-object `zoo.mode`, valid
 * single-profile parsing with all five category lists, absent categories
 * (empty lists — no defaults), invalid categories (whole-profile discard
 * with exactly one warn), unknown-key tolerance, empty arrays, and
 * multi-profile selection from the mode state file (`~/.zoo/mode.json`,
 * overridable via `ZOO_MODE_FILE`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../utils/logger.js";
import { withMissingModeFile, withModeFile } from "../utils/mode-file.js";
import { parseModeProfile } from "./config-parse.js";

afterEach(() => {
  _resetForTesting();
  delete process.env.ZOO_MODE_FILE;
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

  it("returns null + warn when multiple profiles exist and no mode file selects one", () => {
    withMissingModeFile(() => {
      assert.equal(
        parseModeProfile({
          mode: { poly: POLY_PROFILE, lite: { agents: [] } },
        }),
        null,
      );
    });
    const warns = warnsOf("mode_file_invalid");
    assert.equal(warns.length, 1, "exactly one warn for failed selection");
    assert.equal((warns[0] as Record<string, unknown>).reason, "unreadable");
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
// Multi-profile selection from the mode state file
// ---------------------------------------------------------------------------

describe("parseModeProfile — multi-profile selection", () => {
  /** Two declared profiles: the full poly one and a slim mono one. */
  const TWO_PROFILES = {
    poly: POLY_PROFILE,
    mono: {
      agents: ["dolphin", "mola"],
      skills: [],
      hooks: [],
      tools: [],
      commands: [],
    },
  };

  it("selects the profile named by a valid mode file", () => {
    withModeFile(JSON.stringify({ mode: "poly" }), () => {
      const result = parseModeProfile({ mode: TWO_PROFILES });
      assert.ok(result !== null);
      assert.equal(result.name, "poly");
      assert.deepEqual(result.agents, POLY_PROFILE.agents);
      assert.equal(warnsOf("mode_config_invalid").length, 0);
      assert.equal(warnsOf("mode_file_invalid").length, 0);
    });
  });

  it("selects a non-first profile when the mode file names it", () => {
    withModeFile(JSON.stringify({ mode: "mono" }), () => {
      const result = parseModeProfile({ mode: TWO_PROFILES });
      assert.ok(result !== null);
      assert.equal(result.name, "mono");
      assert.deepEqual(result.agents, ["dolphin", "mola"]);
    });
  });

  it("still validates the selected profile (whole-profile discard)", () => {
    withModeFile(JSON.stringify({ mode: "mono" }), () => {
      const result = parseModeProfile({
        mode: {
          poly: POLY_PROFILE,
          mono: { agents: ["dolphin", 42] },
        },
      });
      assert.equal(result, null);
      const warns = warnsOf("mode_config_invalid");
      assert.equal(warns.length, 1);
      assert.equal((warns[0] as Record<string, unknown>).key, "agents");
    });
  });

  it("returns null + warn when the mode file holds malformed JSON", () => {
    withModeFile("{ not json", () => {
      assert.equal(parseModeProfile({ mode: TWO_PROFILES }), null);
    });
    const warns = warnsOf("mode_file_invalid");
    assert.equal(warns.length, 1);
    assert.equal((warns[0] as Record<string, unknown>).reason, "malformed");
  });

  it("returns null + warn when the mode file root is not an object", () => {
    withModeFile(JSON.stringify(["poly"]), () => {
      assert.equal(parseModeProfile({ mode: TWO_PROFILES }), null);
    });
    const warns = warnsOf("mode_file_invalid");
    assert.equal(warns.length, 1);
    assert.equal((warns[0] as Record<string, unknown>).reason, "not-object");
  });

  it("returns null + warn when the mode field is not a string", () => {
    withModeFile(JSON.stringify({ mode: 42 }), () => {
      assert.equal(parseModeProfile({ mode: TWO_PROFILES }), null);
    });
    const warns = warnsOf("mode_file_invalid");
    assert.equal(warns.length, 1);
    assert.equal(
      (warns[0] as Record<string, unknown>).reason,
      "mode-not-string",
    );
  });

  it("returns null + warn when the mode file names an unknown profile", () => {
    withModeFile(JSON.stringify({ mode: "nope" }), () => {
      assert.equal(parseModeProfile({ mode: TWO_PROFILES }), null);
    });
    const warns = warnsOf("mode_file_invalid");
    assert.equal(warns.length, 1);
    assert.equal((warns[0] as Record<string, unknown>).reason, "unknown-mode");
  });

  it("single profile ignores the mode file even when it names another mode", () => {
    withModeFile(JSON.stringify({ mode: "mono" }), () => {
      const result = parseModeProfile({ mode: { poly: POLY_PROFILE } });
      assert.ok(result !== null);
      assert.equal(result.name, "poly");
      assert.equal(warnsOf("mode_file_invalid").length, 0);
    });
  });

  it("falls back to ~/.zoo/mode.json when ZOO_MODE_FILE is unset", () => {
    delete process.env.ZOO_MODE_FILE;
    const profiles = {
      poly: POLY_PROFILE,
      mono: { agents: ["dolphin", "mola"] },
    };
    const result = parseModeProfile({ mode: profiles });

    // Mirror the parser's reading of the default file so the assertion
    // is deterministic on any machine: a present valid file selects the
    // profile it names; a missing/malformed one fails closed with a warn.
    let expected: string | null = null;
    try {
      const parsed = JSON.parse(
        readFileSync(join(homedir(), ".zoo", "mode.json"), "utf-8"),
      ) as Record<string, unknown>;
      const name = parsed.mode;
      if (typeof name === "string" && Object.hasOwn(profiles, name)) {
        expected = name;
      }
    } catch {
      expected = null;
    }

    if (expected === null) {
      assert.equal(result, null);
      assert.equal(warnsOf("mode_file_invalid").length, 1);
    } else {
      assert.ok(result !== null);
      assert.equal(result.name, expected);
    }
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
