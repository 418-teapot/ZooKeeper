/**
 * Tests for `extractDeniedTools` in `src/core/subagent/deny-tools.ts`.
 *
 * Covers the tool-level deny extraction contract used by the
 * primary-switch command to trim the pi active tool set: a missing or
 * malformed permission table yields an empty list (fail-closed); only
 * TOP-LEVEL `permission` keys whose value is exactly `"deny"` are
 * collected; sub-tables (`permission.bash` / `permission.edit` /
 * `permission.skill`) and non-deny scalars are never treated as
 * tool-level denies; and the output is sorted deterministically.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractDeniedTools } from "./deny-tools.js";

// ---------------------------------------------------------------------------
// extractDeniedTools
// ---------------------------------------------------------------------------

describe("extractDeniedTools", () => {
  it("returns an empty list for a missing or undefined table", () => {
    assert.deepEqual(extractDeniedTools(undefined), []);
  });

  it("returns an empty list for null / non-object values", () => {
    assert.deepEqual(extractDeniedTools(null), []);
    assert.deepEqual(extractDeniedTools("deny"), []);
    assert.deepEqual(extractDeniedTools(42), []);
    assert.deepEqual(extractDeniedTools(["webfetch"]), []);
  });

  it("collects top-level keys whose value is exactly 'deny'", () => {
    assert.deepEqual(
      extractDeniedTools({ webfetch: "deny", websearch: "deny" }),
      ["webfetch", "websearch"],
    );
  });

  it("sorts the collected deny keys deterministically", () => {
    // TOML key order is not significant; the output must be stable.
    assert.deepEqual(
      extractDeniedTools({ websearch: "deny", webfetch: "deny", bash: "deny" }),
      ["bash", "webfetch", "websearch"],
    );
  });

  it("ignores non-deny scalar values ('ask' / 'allow' / others)", () => {
    assert.deepEqual(
      extractDeniedTools({
        webfetch: "deny",
        edit: "ask",
        task: "allow",
        read: "something-else",
      }),
      ["webfetch"],
    );
  });

  it("does NOT treat sub-tables as tool-level denies", () => {
    // The fine-grained bash/edit/skill rule tables are objects — they
    // must never be collected as tool-level denies.
    assert.deepEqual(
      extractDeniedTools({
        webfetch: "deny",
        bash: { "git checkout *": "ask", "rm *": "deny" },
        edit: { "*": "deny", "**/*.md": "allow" },
        skill: { "*": "deny" },
      }),
      ["webfetch"],
    );
  });

  it("returns an empty list for an empty table", () => {
    assert.deepEqual(extractDeniedTools({}), []);
  });

  it("returns an empty list when every value is a sub-table", () => {
    // mola's permission table is sub-table-only: no tool-level denies.
    assert.deepEqual(
      extractDeniedTools({
        bash: { "git commit *": "deny", "rm *": "deny" },
        edit: { "*": "deny", "**/*.md": "allow" },
        skill: { "*": "deny" },
      }),
      [],
    );
  });

  it("does not mutate the input table", () => {
    const table = { webfetch: "deny", bash: { "rm *": "deny" } };
    extractDeniedTools(table);
    assert.deepEqual(table, { webfetch: "deny", bash: { "rm *": "deny" } });
  });
});
