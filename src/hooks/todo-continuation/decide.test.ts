/**
 * Tests for the todo-continuation strategy (`decide.ts`).
 *
 * Locks the strategy's short-circuit gate order and each silence reason
 * (`empty` / `no-active`), the wake text format (fixed directive with the
 * blocked contract, status summary, remaining-task lines with block
 * reasons), and the purity contract.  The engine-level interlocks
 * (not-settled, budget-exhausted, awaiting-progress lock) are covered at
 * the core layer (`src/core/loop/engine.test.ts`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TodoItemView, TodoStatus } from "../../core/todo/types.js";
import { CONTINUATION_PROMPT, decide } from "./decide.js";

/** Build a task view from a status, a content label, and an optional blocker. */
function item(
  status: TodoStatus,
  content = `task-${status}`,
  blocker?: string,
): TodoItemView {
  return blocker === undefined
    ? { content, status }
    : { content, status, blocker };
}

describe("decide — gate order", () => {
  it("silences an empty list with empty", () => {
    assert.deepEqual(decide([]), { kind: "silence", reason: "empty" });
  });

  it("silences an all-completed list with no-active", () => {
    assert.deepEqual(decide([item("completed"), item("completed")]), {
      kind: "silence",
      reason: "no-active",
    });
  });

  it("silences an all-abandoned list with no-active", () => {
    assert.deepEqual(decide([item("abandoned"), item("abandoned")]), {
      kind: "silence",
      reason: "no-active",
    });
  });

  it("silences an all-blocked list with no-active: blocked is the agent's own wait declaration", () => {
    assert.deepEqual(
      decide([item("blocked", "needs approval", "user approval")]),
      { kind: "silence", reason: "no-active" },
    );
  });

  it("silences a blocked-plus-completed list with no-active", () => {
    assert.deepEqual(decide([item("blocked"), item("completed")]), {
      kind: "silence",
      reason: "no-active",
    });
  });

  it("wakes a list with an active task", () => {
    assert.equal(decide([item("pending")]).kind, "wake");
  });

  it("wakes while any active task remains even alongside blocked ones", () => {
    assert.equal(
      decide([
        item("blocked", "await key", "user credentials"),
        item("pending", "wire the gate"),
      ]).kind,
      "wake",
    );
  });
});

describe("decide — wake text", () => {
  it("leads with the fixed directive", () => {
    const decision = decide([item("pending", "wire the gate")]);
    assert.equal(decision.kind, "wake");
    if (decision.kind !== "wake") return;
    assert.ok(decision.text.startsWith(CONTINUATION_PROMPT));
  });

  it("the directive carries the blocked contract", () => {
    assert.ok(
      CONTINUATION_PROMPT.includes("mark the affected tasks blocked"),
      CONTINUATION_PROMPT,
    );
    assert.ok(CONTINUATION_PROMPT.includes("not asking permission"));
    assert.ok(CONTINUATION_PROMPT.includes("never stay in_progress"));
  });

  it("renders the status summary and every remaining task line", () => {
    const tasks: TodoItemView[] = [
      item("completed", "scaffold module"),
      item("in_progress", "write decide"),
      item("pending", "add tests"),
      item("abandoned", "drop legacy path"),
      item("blocked", "wait on API"),
    ];
    const decision = decide(tasks);
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

  it("renders the waiting-on reason for a blocked task carrying a blocker", () => {
    const tasks: TodoItemView[] = [
      item("pending", "keep going"),
      item("blocked", "await approval", "user sign-off on the schema"),
    ];
    const decision = decide(tasks);
    assert.equal(decision.kind, "wake");
    if (decision.kind !== "wake") return;
    assert.ok(
      decision.text.includes(
        "- [blocked] await approval (waiting on: user sign-off on the schema)",
      ),
      decision.text,
    );
  });

  it("omits the waiting-on suffix for a blocked task without a blocker", () => {
    const tasks: TodoItemView[] = [
      item("pending", "keep going"),
      item("blocked", "await approval"),
    ];
    const decision = decide(tasks);
    assert.equal(decision.kind, "wake");
    if (decision.kind !== "wake") return;
    assert.ok(decision.text.includes("- [blocked] await approval"));
    assert.ok(!decision.text.includes("waiting on:"));
  });

  it("omits the waiting-on suffix for a blocker on a non-blocked task", () => {
    const tasks: TodoItemView[] = [item("pending", "stale note", "leftover")];
    const decision = decide(tasks);
    assert.equal(decision.kind, "wake");
    if (decision.kind !== "wake") return;
    assert.ok(decision.text.includes("- [pending] stale note"));
    assert.ok(!decision.text.includes("waiting on:"));
  });

  it("counts only non-completed, non-abandoned tasks as remaining", () => {
    const tasks: TodoItemView[] = [
      item("completed", "a"),
      item("abandoned", "b"),
      item("in_progress", "c"),
    ];
    const decision = decide(tasks);
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
    assert.deepEqual(decide(tasks), decide(tasks));
  });

  it("does not mutate its inputs", () => {
    const tasks: TodoItemView[] = [item("pending", "one")];
    decide(tasks);
    assert.deepEqual(tasks, [item("pending", "one")]);
  });
});
