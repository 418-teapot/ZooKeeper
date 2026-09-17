/**
 * Tests for the todo type helpers (`types.ts`).
 *
 * Locks the active-status predicate over the five known statuses:
 * `pending` and `in_progress` are active work, while `completed`,
 * `abandoned`, and `blocked` are settled and never active.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isActiveTodoStatus } from "./types.js";

describe("isActiveTodoStatus", () => {
  it("treats pending as active", () => {
    assert.equal(isActiveTodoStatus("pending"), true);
  });

  it("treats in_progress as active", () => {
    assert.equal(isActiveTodoStatus("in_progress"), true);
  });

  it("treats completed as inactive", () => {
    assert.equal(isActiveTodoStatus("completed"), false);
  });

  it("treats abandoned as inactive", () => {
    assert.equal(isActiveTodoStatus("abandoned"), false);
  });

  it("treats blocked as inactive", () => {
    assert.equal(isActiveTodoStatus("blocked"), false);
  });
});
