/**
 * Tests for skill-permission parsing and evaluation
 * (`src/core/permissions/skill-permissions.ts`).
 *
 * Covers the `[agent.<name>].permission.skill` extraction contract used by
 * the pi `resources_discover` handler to filter the contributed skill
 * directories: declared-key-order preservation, `ask` → deny treatment,
 * malformed-entry skip + warn, missing sub-table → agent absent (no
 * filtering), and the most-specific-wins evaluation (exact beats glob,
 * longer glob beats shorter, first-declared breaks ties, default allow).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import {
  isSkillAllowed,
  parseSkillPermissions,
  type SkillPermissionRule,
} from "./skill-permissions.js";

afterEach(() => {
  _resetForTesting();
});

/** Filter the log buffer for entries with the given event name. */
function warnsOf(event: string): Array<Record<string, unknown>> {
  return _getBufferForTesting().filter((e) => e.event === event);
}

// ---------------------------------------------------------------------------
// parseSkillPermissions
// ---------------------------------------------------------------------------

describe("parseSkillPermissions", () => {
  it("returns an empty map for an absent or non-object agent table", () => {
    assert.deepEqual(parseSkillPermissions(undefined), {});
    assert.deepEqual(parseSkillPermissions({}), {});
    assert.deepEqual(parseSkillPermissions({ agent: "nope" }), {});
    assert.deepEqual(parseSkillPermissions({ agent: [] }), {});
  });

  it("omits an agent whose entry is not an object", () => {
    const result = parseSkillPermissions({ agent: { mola: "primary" } });
    assert.deepEqual(result, {});
    assert.deepEqual(warnsOf("skill_permission_invalid"), []);
  });

  it("omits an agent without a permission.skill sub-table (no filtering)", () => {
    // dolphin-like config: top-level permission + bash/skill tables where
    // the skill sub-table is absent → no rules, so no filtering applies.
    const result = parseSkillPermissions({
      agent: { dolphin: { permission: { bash: { "rm *": "deny" } } } },
    });
    assert.deepEqual(result, {});
    assert.deepEqual(warnsOf("skill_permission_invalid"), []);
  });

  it("preserves declared key order of the skill sub-table", () => {
    const result = parseSkillPermissions({
      agent: {
        mola: {
          permission: {
            skill: {
              "*": "deny",
              "first-principles": "allow",
              "wiki-query": "allow",
            },
          },
        },
      },
    });
    assert.deepEqual(result.mola, [
      { pattern: "*", action: "deny" },
      { pattern: "first-principles", action: "allow" },
      { pattern: "wiki-query", action: "allow" },
    ]);
    assert.deepEqual(warnsOf("skill_permission_invalid"), []);
  });

  it("keeps multiple agents in the map independently", () => {
    const result = parseSkillPermissions({
      agent: {
        dolphin: { permission: { skill: { "beaver-*": "deny" } } },
        mola: { permission: { skill: { "*": "deny", "wiki-query": "allow" } } },
      },
    });
    assert.deepEqual(result.dolphin, [{ pattern: "beaver-*", action: "deny" }]);
    assert.deepEqual(result.mola, [
      { pattern: "*", action: "deny" },
      { pattern: "wiki-query", action: "allow" },
    ]);
  });

  it("treats ask and other non-allow/deny actions as deny", () => {
    const result = parseSkillPermissions({
      agent: {
        dolphin: { permission: { skill: { "rm-*": "ask" } } },
      },
    });
    assert.deepEqual(result.dolphin, [{ pattern: "rm-*", action: "deny" }]);
  });

  it("skips + warns malformed (non-string) values", () => {
    const result = parseSkillPermissions({
      agent: {
        mola: {
          permission: {
            skill: {
              "*": "deny",
              "wiki-query": "allow",
              "broken-1": 42,
              "broken-2": { nested: true },
              "broken-3": ["x"],
            },
          },
        },
      },
    });
    assert.deepEqual(result.mola, [
      { pattern: "*", action: "deny" },
      { pattern: "wiki-query", action: "allow" },
    ]);
    const warns = warnsOf("skill_permission_invalid");
    assert.equal(warns.length, 3);
    assert.deepEqual(
      warns.map((w) => w.agent),
      ["mola", "mola", "mola"],
    );
    assert.deepEqual(
      warns.map((w) => w.key),
      ["broken-1", "broken-2", "broken-3"],
    );
    assert.deepEqual(
      warns.map((w) => w.value),
      [42, { nested: true }, ["x"]],
    );
  });

  it("records an empty rule list for an empty skill sub-table", () => {
    const result = parseSkillPermissions({
      agent: { mola: { permission: { skill: {} } } },
    });
    assert.deepEqual(result.mola, []);
  });
});

// ---------------------------------------------------------------------------
// isSkillAllowed — most-specific-wins
// ---------------------------------------------------------------------------

describe("isSkillAllowed — most-specific-wins", () => {
  /** A typical mola ruleset: default deny with a few allows. */
  const MOLA_RULES: Array<{ pattern: string; action: "allow" | "deny" }> = [
    { pattern: "*", action: "deny" },
    { pattern: "first-principles", action: "allow" },
    { pattern: "grill", action: "allow" },
    { pattern: "mola-plan", action: "allow" },
    { pattern: "wiki-query", action: "allow" },
  ];

  it("exact-name allow beats a catch-all deny", () => {
    assert.equal(isSkillAllowed(MOLA_RULES, "wiki-query"), true);
    assert.equal(isSkillAllowed(MOLA_RULES, "grill"), true);
  });

  it("catch-all deny blocks everything not explicitly allowed", () => {
    assert.equal(isSkillAllowed(MOLA_RULES, "beaver-tdd"), false);
    assert.equal(isSkillAllowed(MOLA_RULES, "code-review"), false);
    assert.equal(isSkillAllowed(MOLA_RULES, "git-commit"), false);
  });

  it("no match at all → default allow", () => {
    // Empty rules (or rules that never match) fall back to allowing the
    // skill — mirrors OpenCode's default-allow semantics.
    assert.equal(isSkillAllowed([], "wiki-query"), true);
    assert.equal(isSkillAllowed([], "beaver-tdd"), true);
  });

  it("exact-name deny beats a glob allow", () => {
    const rules: SkillPermissionRule[] = [
      { pattern: "beaver-*", action: "allow" },
      { pattern: "beaver-tdd", action: "deny" },
    ];
    assert.equal(isSkillAllowed(rules, "beaver-tdd"), false);
  });

  it("longer glob beats a shorter catch-all glob", () => {
    const rules: SkillPermissionRule[] = [
      { pattern: "*", action: "deny" },
      { pattern: "beaver-*", action: "allow" },
    ];
    assert.equal(isSkillAllowed(rules, "beaver-tdd"), true);
    // The catch-all still denies anything outside the longer glob.
    assert.equal(isSkillAllowed(rules, "wiki-query"), false);
  });

  it("ties → first declared wins", () => {
    // Two equal-length globs both match: the first declared one wins.
    const rules: SkillPermissionRule[] = [
      { pattern: "beaver-*", action: "deny" },
      { pattern: "beav-*", action: "allow" },
    ];
    assert.equal(isSkillAllowed(rules, "beaver-tdd"), false);
  });

  it("dolphin-like ruleset: prefix globs denied, the rest allowed", () => {
    const DOLPHIN_RULES: Array<{ pattern: string; action: "allow" | "deny" }> =
      [
        { pattern: "beaver-*", action: "deny" },
        { pattern: "kiwi-*", action: "deny" },
        { pattern: "mola-*", action: "deny" },
      ];
    // No "*" rule → the unlisted skills stay allowed.
    assert.equal(isSkillAllowed(DOLPHIN_RULES, "beaver-tdd"), false);
    assert.equal(isSkillAllowed(DOLPHIN_RULES, "kiwi-verify"), false);
    assert.equal(isSkillAllowed(DOLPHIN_RULES, "mola-plan"), false);
    assert.equal(isSkillAllowed(DOLPHIN_RULES, "wiki-query"), true);
    assert.equal(isSkillAllowed(DOLPHIN_RULES, "git-commit"), true);
    assert.equal(isSkillAllowed(DOLPHIN_RULES, "grill"), true);
  });

  it("mola-like ruleset: only the explicitly allowed skills pass", () => {
    assert.deepEqual(
      [
        "beaver-tdd",
        "wiki-query",
        "grill",
        "first-principles",
        "code-review",
      ].map((name) => isSkillAllowed(MOLA_RULES, name)),
      [false, true, true, true, false],
    );
  });

  it("globs support '*' wildcard only and are anchored", () => {
    const rules: SkillPermissionRule[] = [
      { pattern: "*", action: "deny" },
      { pattern: "wiki-*", action: "allow" },
    ];
    // The '*' only matches whole names — a plain '*' mid-name matches
    // the whole string (no partial matching outside the wildcard).
    assert.equal(isSkillAllowed(rules, "wiki-query"), true);
    assert.equal(isSkillAllowed(rules, "wiki-ingest"), true);
    assert.equal(isSkillAllowed(rules, "wiki"), false);
    assert.equal(isSkillAllowed(rules, "xwiki-query"), false);
    // A wildcard matches any run of characters after the prefix.
    assert.equal(isSkillAllowed(rules, "wiki-query-x"), true);
  });
});
