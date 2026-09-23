/**
 * Tests for the todo-continuation strategy (`decide.ts`).
 *
 * Locks the strategy's short-circuit gate order and each silence reason
 * (`empty` / `no-active` / `no-progress`), the wake text format (fixed
 * directive, status summary, remaining-task lines), and the purity
 * contract.  The engine-level interlocks (not-settled, budget-exhausted)
 * are covered at the core layer (`src/core/loop/engine.test.ts`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TodoItemView, TodoStatus } from "../../core/todo/types.js";
import { CONTINUATION_PROMPT, decide } from "./decide.js";

/** Build a task view from a status and a content label. */
function item(status: TodoStatus, content = `task-${status}`): TodoItemView {
  return { content, status };
}

describe("decide — gate order", () => {
  it("silences an empty list with empty", () => {
    assert.deepEqual(decide([], true), {
      kind: "silence",
      reason: "empty",
    });
  });

  it("silences an all-completed list with no-active", () => {
    assert.deepEqual(decide([item("completed"), item("completed")], true), {
      kind: "silence",
      reason: "no-active",
    });
  });

  it("silences an all-abandoned list with no-active", () => {
    assert.deepEqual(decide([item("abandoned"), item("abandoned")], true), {
      kind: "silence",
      reason: "no-active",
    });
  });

  it("silences an all-blocked list with no-active", () => {
    assert.deepEqual(decide([item("blocked"), item("blocked")], true), {
      kind: "silence",
      reason: "no-active",
    });
  });

  it("silences a blocked-plus-completed list with no-active", () => {
    assert.deepEqual(decide([item("blocked"), item("completed")], true), {
      kind: "silence",
      reason: "no-active",
    });
  });

  it("silences a no-progress turn with no-progress", () => {
    assert.deepEqual(decide([item("pending")], false), {
      kind: "silence",
      reason: "no-progress",
    });
  });

  it("orders no-active before no-progress", () => {
    assert.deepEqual(decide([item("completed")], false), {
      kind: "silence",
      reason: "no-active",
    });
  });

  it("wakes an active turn that made progress", () => {
    const decision = decide([item("pending")], true);
    assert.equal(decision.kind, "wake");
  });
});

describe("decide — wake text", () => {
  it("leads with the fixed directive", () => {
    const decision = decide([item("pending", "wire the gate")], true);
    assert.equal(decision.kind, "wake");
    if (decision.kind !== "wake") return;
    assert.ok(decision.text.startsWith(CONTINUATION_PROMPT));
  });

  it("renders the status summary and every remaining task line", () => {
    const tasks: TodoItemView[] = [
      item("completed", "scaffold module"),
      item("in_progress", "write decide"),
      item("pending", "add tests"),
      item("abandoned", "drop legacy path"),
      item("blocked", "wait on API"),
    ];
    const decision = decide(tasks, true);
    assert.equal(decision.kind, "wake");
    if (decision.kind !== "wake") return;

    // completed = 1, total = 5; remaining = in_progress + pending + blocked.
    assert.ok(
      decision.text.includes("[Status: 1/5 completed, 3 remaining]"),
      decision.text,
    );
    assert.ok(decision.text.includes("Remaining tasks:"));
    assert.ok(decision.text.includes("- [in_progress] write decide"));
    assert.ok(decision.text.includes("- [pending] add tests"));
    assert.ok(decision.text.includes("- [blocked] wait on API"));
    // Completed and abandoned tasks are not listed.
    assert.ok(!decision.text.includes("scaffold module"));
    assert.ok(!decision.text.includes("drop legacy path"));
  });

  it("counts only non-completed, non-abandoned tasks as remaining", () => {
    const tasks: TodoItemView[] = [
      item("completed", "a"),
      item("abandoned", "b"),
      item("in_progress", "c"),
    ];
    const decision = decide(tasks, true);
    assert.equal(decision.kind, "wake");
    if (decision.kind !== "wake") return;
    assert.ok(decision.text.includes("[Status: 1/3 completed, 1 remaining]"));
  });
});

describe("decide — purity", () => {
  it("returns deeply equal outputs for identical inputs", () => {
    const tasks: TodoItemView[] = [
      item("pending", "one"),
      item("completed", "two"),
    ];
    assert.deepEqual(decide(tasks, true), decide(tasks, true));
  });

  it("does not mutate its inputs", () => {
    const tasks: TodoItemView[] = [item("pending", "one")];
    decide(tasks, true);
    assert.deepEqual(tasks, [item("pending", "one")]);
  });
});
