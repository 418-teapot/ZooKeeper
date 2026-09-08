/**
 * Unit tests for the todo state machine core (src/core/todo).
 *
 * Covers all nine operations, their boundary cases (flattened init,
 * duplicate rejection, strict content matching, block without reason,
 * rm clear-all, batch atomicity, normalization), snapshot serialization
 * and recovery, and the summary renderer.
 *
 * Every successful batch exits through normalization (single point), so the
 * earliest pending task is `in_progress` whenever no task is active and
 * pending work exists.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApplyResult } from "./apply.js";
import { applyEntries } from "./apply.js";
import { normalizePhases } from "./normalize.js";
import {
  restoreFromHistory,
  serializeSnapshot,
  type TodoSnapshot,
} from "./serialize.js";
import { formatSummary } from "./summary.js";
import {
  clonePhases,
  isTodoPhase,
  type TodoEntry,
  type TodoPhase,
  type TodoStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a phase object from [content, status] pairs. */
function phase(name: string, ...tasks: Array<[string, TodoStatus]>): TodoPhase {
  return {
    name,
    tasks: tasks.map(([content, status]) => ({ content, status })),
  };
}

/** Apply entries to a state; returns the full result. */
function apply(
  state: readonly TodoPhase[],
  ...entries: TodoEntry[]
): ApplyResult {
  return applyEntries(state, entries);
}

/** Apply one entry; returns the resulting phases (convenience). */
function applied(state: readonly TodoPhase[], entry: TodoEntry): TodoPhase[] {
  return apply(state, entry).phases;
}

/** Status of a task in a state, by exact content. */
function statusOf(state: readonly TodoPhase[], content: string): string {
  const hit = state.flatMap((p) => p.tasks).find((t) => t.content === content);
  assert.ok(hit, `task "${content}" should exist`);
  return hit.status;
}

/** Blocker note of a task in a state, by exact content. */
function blockerOf(
  state: readonly TodoPhase[],
  content: string,
): string | undefined {
  const hit = state.flatMap((p) => p.tasks).find((t) => t.content === content);
  assert.ok(hit, `task "${content}" should exist`);
  return hit.blocker;
}

function contentsOf(state: readonly TodoPhase[]): string[] {
  return state.flatMap((p) => p.tasks.map((t) => t.content));
}

const ENTRY_VIEW: TodoEntry = { op: "view" };

// ---------------------------------------------------------------------------
// types: guards and cloning
// ---------------------------------------------------------------------------

describe("types", () => {
  it("isTodoPhase accepts a structurally valid phase", () => {
    const valid = phase("Build", ["a", "pending"], ["b", "blocked"]);
    assert.equal(isTodoPhase(valid), true);
  });

  it("isTodoPhase rejects malformed values", () => {
    assert.equal(isTodoPhase(null), false);
    assert.equal(isTodoPhase(undefined), false);
    assert.equal(isTodoPhase([]), false);
    assert.equal(isTodoPhase({ name: "Build" }), false);
    assert.equal(isTodoPhase({ name: 7, tasks: [] }), false);
    assert.equal(isTodoPhase({ name: "Build", tasks: "nope" }), false);
    assert.equal(
      isTodoPhase({
        name: "Build",
        tasks: [{ content: "a", status: "flying" }],
      }),
      false,
    );
    assert.equal(
      isTodoPhase({
        name: "Build",
        tasks: [{ content: 42, status: "pending" }],
      }),
      false,
    );
  });

  it("clonePhases produces a structurally independent copy", () => {
    const source = [phase("P", ["a", "in_progress"], ["b", "blocked"])];
    const expected = clonePhases(source);
    expected[0].tasks[1].blocker = "waiting";
    const copy = clonePhases(source);
    copy[0].tasks[0].status = "completed";
    copy[0].tasks[1].blocker = "changed";
    source[0].tasks[1].blocker = "waiting";
    assert.deepEqual(source, expected);
    assert.equal(copy[0].tasks[0].status, "completed");
    assert.equal(source[0].tasks[0].status, "in_progress");
    assert.equal(source[0].tasks[1].blocker, "waiting");
  });
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe("init", () => {
  it("builds phases from the canonical list shape with all tasks pending", () => {
    const result = applied([], {
      op: "init",
      list: [
        { phase: "Foundation", items: ["Scaffold", "Wire"] },
        { phase: "Auth", items: ["Port store"] },
      ],
    });
    // Normalization promotes the earliest pending task right after init.
    assert.deepEqual(result, [
      phase("Foundation", ["Scaffold", "in_progress"], ["Wire", "pending"]),
      phase("Auth", ["Port store", "pending"]),
    ]);
  });

  it("accepts the flattened shape with the default phase name Todos", () => {
    const result = applied([], { op: "init", items: ["a", "b"] });
    assert.deepEqual(result, [
      phase("Todos", ["a", "in_progress"], ["b", "pending"]),
    ]);
  });

  it("accepts the flattened shape with an explicit phase", () => {
    const result = applied([], { op: "init", items: ["a"], phase: "Build" });
    assert.deepEqual(result, [phase("Build", ["a", "in_progress"])]);
  });

  it("rejects duplicate phase names and duplicate contents, state unchanged", () => {
    const before = [phase("Keep", ["x", "pending"])];
    const result = apply(before, {
      op: "init",
      list: [
        { phase: "A", items: ["dup"] },
        { phase: "B", items: ["dup", "dup"] },
        { phase: "A", items: ["z"] },
      ],
    });
    assert.equal(result.errors.length, 3);
    assert.ok(result.errors[0].includes('Duplicate task "dup"'));
    assert.ok(result.errors[1].includes('Duplicate task "dup"'));
    assert.ok(result.errors[2].includes('Duplicate phase "A"'));
    assert.deepEqual(result.phases, before);
  });

  it("rejects an empty phase entry in the canonical list", () => {
    const result = apply([], { op: "init", list: [{ phase: "A", items: [] }] });
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes('Phase "A" contains no items'));
    assert.deepEqual(result.phases, []);
  });

  it("rejects a missing list entirely", () => {
    const result = apply([], { op: "init", items: [] });
    assert.equal(result.errors[0], "Missing list for init operation");
    assert.deepEqual(result.phases, []);
  });

  it("rejects malformed init list entries without throwing", () => {
    const before = [phase("Keep", ["x", "pending"])];
    // Missing items field.
    const missingItems = apply(before, {
      op: "init",
      list: [{ phase: "A" }],
    } as unknown as TodoEntry);
    assert.equal(missingItems.errors.length, 1);
    assert.ok(missingItems.errors[0].includes("Malformed init list entry"));
    assert.deepEqual(missingItems.phases, before);

    // Non-array items.
    const nonArray = apply(before, {
      op: "init",
      list: [{ phase: "A", items: 42 }],
    } as unknown as TodoEntry);
    assert.equal(nonArray.errors.length, 1);
    assert.deepEqual(nonArray.phases, before);

    // Non-string phase: never becomes an unaddressable orphan phase.
    const nonStringPhase = apply(before, {
      op: "init",
      list: [{ phase: 7, items: ["a"] }],
    } as unknown as TodoEntry);
    assert.equal(nonStringPhase.errors.length, 1);
    assert.deepEqual(nonStringPhase.phases, before);

    // Non-string items element.
    const nonStringItem = apply(before, {
      op: "init",
      list: [{ phase: "A", items: ["ok", 42] }],
    } as unknown as TodoEntry);
    assert.equal(nonStringItem.errors.length, 1);
    assert.deepEqual(nonStringItem.phases, before);

    // Flat items must be an array of strings.
    const flatNonArray = apply(before, {
      op: "init",
      items: 42,
    } as unknown as TodoEntry);
    assert.equal(flatNonArray.errors.length, 1);
    assert.deepEqual(flatNonArray.phases, before);
  });

  it("prefers canonical list over a stray flat items field", () => {
    const result = applied([], {
      op: "init",
      list: [{ phase: "A", items: ["a"] }],
      items: ["stray"],
    });
    assert.deepEqual(result, [phase("A", ["a", "in_progress"])]);
  });

  it("treats an empty canonical list as a full clear", () => {
    const before = [phase("Keep", ["x", "pending"])];
    const result = applied(before, { op: "init", list: [] });
    assert.deepEqual(result, []);
  });

  it("repeated init overwrites the whole list (restart semantics)", () => {
    const first = applied([], {
      op: "init",
      list: [{ phase: "A", items: ["old"] }],
    });
    const second = applied(first, {
      op: "init",
      list: [
        { phase: "B", items: ["new1"] },
        { phase: "C", items: ["new2"] },
      ],
    });
    assert.deepEqual(second, [
      phase("B", ["new1", "in_progress"]),
      phase("C", ["new2", "pending"]),
    ]);
  });
});

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

describe("append", () => {
  it("appends to an existing phase", () => {
    const before = [phase("Build", ["a", "pending"])];
    const result = applied(before, {
      op: "append",
      phase: "Build",
      items: ["b"],
    });
    // a was the earliest pending task and becomes active post-batch.
    assert.deepEqual(result, [
      phase("Build", ["a", "in_progress"], ["b", "pending"]),
    ]);
  });

  it("creates a missing phase for append", () => {
    const result = applied([], { op: "append", phase: "New", items: ["a"] });
    assert.deepEqual(result, [phase("New", ["a", "in_progress"])]);
  });

  it("rejects duplicates against existing tasks across all phases", () => {
    const before = [
      phase("P1", ["shared", "pending"]),
      phase("P2", ["other", "pending"]),
    ];
    const result = apply(before, {
      op: "append",
      phase: "P2",
      items: ["shared"],
    });
    assert.equal(result.errors[0], 'Task "shared" already exists');
    assert.deepEqual(result.phases, before);
  });

  it("rejects duplicates within the batch and applies nothing", () => {
    const before = [phase("P", ["a", "pending"])];
    const result = apply(before, {
      op: "append",
      phase: "P",
      items: ["b", "b"],
    });
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.phases, before);
  });

  it("rejects missing phase and missing items", () => {
    const before = [phase("P", ["a", "pending"])];
    const noPhase = apply(before, { op: "append", items: ["b"] });
    assert.equal(noPhase.errors[0], "Missing phase name for append operation");
    const noItems = apply(before, { op: "append", phase: "P" });
    assert.equal(noItems.errors[0], "Missing items for append operation");
    assert.deepEqual(noItems.phases, before);
  });

  it("rejects malformed append items without throwing", () => {
    const before = [phase("P", ["a", "pending"])];
    // Non-array items.
    const nonArray = apply(before, {
      op: "append",
      phase: "P",
      items: 42,
    } as unknown as TodoEntry);
    assert.equal(nonArray.errors.length, 1);
    assert.ok(nonArray.errors[0].includes("Missing items"));
    assert.deepEqual(nonArray.phases, before);

    // A string must not be iterated character-by-character.
    const stringItems = apply(before, {
      op: "append",
      phase: "P",
      items: "abc",
    } as unknown as TodoEntry);
    assert.equal(stringItems.errors.length, 1);
    assert.deepEqual(stringItems.phases, before);

    // Non-string items element.
    const nonString = apply(before, {
      op: "append",
      phase: "P",
      items: ["b", 7],
    } as unknown as TodoEntry);
    assert.equal(nonString.errors.length, 1);
    assert.ok(nonString.errors[0].includes("array of strings"));
    assert.deepEqual(nonString.phases, before);
  });
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe("start", () => {
  it("activates the target and demotes other in-progress tasks", () => {
    const before = [
      phase("P1", ["a", "in_progress"], ["b", "pending"]),
      phase("P2", ["c", "in_progress"]),
    ];
    const result = applied(before, { op: "start", task: "b" });
    assert.equal(statusOf(result, "b"), "in_progress");
    assert.equal(statusOf(result, "a"), "pending");
    assert.equal(statusOf(result, "c"), "pending");
  });

  it("is a no-op on the already-active task", () => {
    const before = [phase("P", ["a", "in_progress"], ["b", "pending"])];
    const result = applied(before, { op: "start", task: "a" });
    assert.equal(statusOf(result, "a"), "in_progress");
    assert.equal(statusOf(result, "b"), "pending");
  });

  it("rejects a missing task with a plain not-found error", () => {
    const result = apply([], { op: "start", task: "ghost" });
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes('Task "ghost" not found'));
    assert.ok(result.errors[0].includes("todo list is empty"));
  });

  it("treats a literal task-N content as addressable", () => {
    // The corrective message only applies to ID-shaped references that fail
    // to match any content; a real task whose content is "task-1" resolves.
    const result = applied([phase("P", ["task-1", "pending"])], {
      op: "start",
      task: "task-1",
    });
    assert.equal(statusOf(result, "task-1"), "in_progress");
  });

  it("rejects unmatched ID-shaped references with the corrective message", () => {
    const before = [phase("P", ["real task", "pending"])];
    const miss = apply(before, { op: "start", task: "task-3" });
    assert.ok(miss.errors[0].includes("not by IDs"));
    assert.ok(miss.errors[0].includes("full content"));
    assert.deepEqual(miss.phases, before);
  });

  it("performs strict verbatim matching: no trim, no case folding", () => {
    const before = [phase("P", ["Fix bug", "pending"])];
    assert.equal(
      apply(before, { op: "start", task: " Fix bug" }).errors.length,
      1,
    );
    assert.equal(
      apply(before, { op: "start", task: "Fix bug " }).errors.length,
      1,
    );
    assert.equal(
      apply(before, { op: "start", task: "fix bug" }).errors.length,
      1,
    );
    assert.equal(
      apply(before, { op: "start", task: "Fix bug" }).errors.length,
      0,
    );
  });

  it("rejects starting a completed, abandoned, or blocked task", () => {
    const before = [
      phase(
        "P",
        ["done1", "completed"],
        ["drop1", "abandoned"],
        ["block1", "blocked"],
        ["open1", "pending"],
      ),
    ];
    const doneHit = apply(before, { op: "start", task: "done1" });
    assert.ok(doneHit.errors[0].includes("completed or abandoned"));
    const dropHit = apply(before, { op: "start", task: "drop1" });
    assert.ok(dropHit.errors[0].includes("completed or abandoned"));
    const blockedHit = apply(before, { op: "start", task: "block1" });
    assert.ok(blockedHit.errors[0].includes("blocked"));
    assert.ok(blockedHit.errors[0].includes("unblock"));
    // Nothing changed for any of the rejected starts.
    assert.equal(statusOf(before, "block1"), "blocked");
    assert.equal(statusOf(before, "done1"), "completed");
    assert.deepEqual(doneHit.phases, before);
  });

  it("rejects a missing task content", () => {
    const result = apply([phase("P", ["a", "pending"])], { op: "start" });
    assert.equal(result.errors[0], "Missing task content");
  });
});

// ---------------------------------------------------------------------------
// done / drop
// ---------------------------------------------------------------------------

describe("done and drop", () => {
  it("done completes a single task, a tasks batch, a phase, or everything", () => {
    const before = [
      phase("P1", ["a", "pending"], ["b", "in_progress"]),
      phase("P2", ["c", "pending"]),
    ];
    assert.deepEqual(
      applied(before, { op: "done", task: "a" }).flatMap((p) => p.tasks),
      [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
      ],
    );
    assert.deepEqual(
      applied(before, { op: "done", tasks: ["a", "c"] }).flatMap(
        (p) => p.tasks,
      ),
      [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "completed" },
      ],
    );
    assert.deepEqual(
      applied(before, { op: "done", phase: "P2" }).flatMap((p) => p.tasks),
      [
        { content: "a", status: "pending" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "completed" },
      ],
    );
    assert.deepEqual(
      applied(before, { op: "done" }).flatMap((p) => p.tasks),
      [
        { content: "a", status: "completed" },
        { content: "b", status: "completed" },
        { content: "c", status: "completed" },
      ],
    );
  });

  it("drop marks targets abandoned", () => {
    const before = [phase("P", ["a", "in_progress"], ["b", "pending"])];
    const result = applied(before, { op: "drop", tasks: ["a"] });
    assert.equal(statusOf(result, "a"), "abandoned");
    // b becomes the active task through normalization.
    assert.equal(statusOf(result, "b"), "in_progress");
  });

  it("done on a blocked task completes it", () => {
    const before = [phase("P", ["a", "blocked"])];
    const result = applied(before, { op: "done", task: "a" });
    assert.equal(statusOf(result, "a"), "completed");
  });

  it("rejects batch targeting with a missing task, applying nothing", () => {
    const before = [phase("P", ["a", "pending"])];
    const result = apply(before, { op: "done", tasks: ["a", "ghost"] });
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes('Task "ghost" not found'));
    assert.deepEqual(result.phases, before);
  });

  it("rejects an empty tasks array and ambiguous targets", () => {
    const before = [phase("P", ["a", "pending"])];
    const empty = apply(before, { op: "done", tasks: [] });
    assert.equal(empty.errors.length, 1);
    const ambiguous = apply(before, { op: "done", task: "a", tasks: ["a"] });
    assert.ok(ambiguous.errors[0].includes("Ambiguous target"));
    const mixed = apply(before, { op: "done", task: "a", phase: "P" });
    assert.ok(mixed.errors[0].includes("Ambiguous target"));
    assert.deepEqual(empty.phases, before);
  });

  it("rejects targeting a missing phase", () => {
    const before = [phase("P", ["a", "pending"])];
    const result = apply(before, { op: "done", phase: "Nope" });
    assert.equal(result.errors[0], 'Phase "Nope" not found');
  });
});

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

describe("rm", () => {
  it("removes a single task, a batch, or a whole phase", () => {
    const before = [
      phase("P1", ["a", "pending"], ["b", "pending"]),
      phase("P2", ["c", "pending"]),
    ];
    assert.deepEqual(contentsOf(applied(before, { op: "rm", task: "a" })), [
      "b",
      "c",
    ]);
    assert.deepEqual(
      contentsOf(applied(before, { op: "rm", tasks: ["a", "c"] })),
      ["b"],
    );
    assert.deepEqual(contentsOf(applied(before, { op: "rm", phase: "P1" })), [
      "c",
    ]);
  });

  it("clears the whole list when no targets are given", () => {
    const before = [
      phase("P1", ["a", "pending"]),
      phase("P2", ["b", "in_progress"]),
    ];
    const result = applied(before, { op: "rm" });
    // Phases remain as empty shells; tasks are gone.
    assert.deepEqual(result, [phase("P1"), phase("P2")]);
  });

  it("rejects removal of a missing task", () => {
    const before = [phase("P", ["a", "pending"])];
    const result = apply(before, { op: "rm", task: "ghost" });
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.phases, before);
  });
});

// ---------------------------------------------------------------------------
// block / unblock
// ---------------------------------------------------------------------------

describe("block and unblock", () => {
  it("blocks a task with a reason and collapses whitespace", () => {
    const before = [phase("P", ["a", "pending"])];
    const result = applied(before, {
      op: "block",
      task: "a",
      reason: "  waiting\n  for review  ",
    });
    assert.equal(statusOf(result, "a"), "blocked");
    assert.equal(blockerOf(result, "a"), "waiting for review");
  });

  it("blocks every eligible task of a phase with one reason", () => {
    const before = [
      phase("P", ["a", "pending"], ["b", "in_progress"], ["c", "completed"]),
    ];
    const result = applied(before, { op: "block", phase: "P", reason: "gate" });
    assert.equal(statusOf(result, "a"), "blocked");
    assert.equal(statusOf(result, "b"), "blocked");
    // Closed work is never reopened by a block.
    assert.equal(statusOf(result, "c"), "completed");
  });

  it("rejects a block without a reason, including whitespace-only", () => {
    const before = [phase("P", ["a", "pending"])];
    for (const reason of [undefined, "", "   \n "]) {
      const entry: TodoEntry = { op: "block", task: "a", reason };
      const result = apply(before, entry);
      assert.equal(result.errors.length, 1);
      assert.ok(result.errors[0].includes("Missing reason"));
      assert.deepEqual(result.phases, before);
    }
  });

  it("rejects block/unblock without any target", () => {
    const before = [phase("P", ["a", "pending"])];
    const blocked = apply(before, { op: "block", reason: "gate" });
    assert.ok(blocked.errors[0].includes("requires a task"));
    const unblocked = apply(before, { op: "unblock" });
    assert.ok(unblocked.errors[0].includes("requires a task"));
  });

  it("unblock restores a blocked task to pending and clears the blocker", () => {
    const before = [phase("P", ["a", "blocked"], ["b", "in_progress"])];
    before[0].tasks[0].blocker = "gate";
    const result = applied(before, { op: "unblock", task: "a" });
    // The active task elsewhere keeps normalization from re-promoting `a`.
    assert.equal(statusOf(result, "a"), "pending");
    assert.equal(blockerOf(result, "a"), undefined);
  });

  it("unblock leaves non-blocked tasks untouched", () => {
    const before = [
      phase("P", ["a", "pending"], ["b", "completed"], ["c", "in_progress"]),
    ];
    const result = applied(before, { op: "unblock", task: "a" });
    assert.deepEqual(result, before);
  });
});

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

describe("view", () => {
  it("is read-only: the state comes back unchanged", () => {
    const before = [
      phase("P1", ["a", "in_progress"]),
      phase("P2", ["b", "completed"]),
    ];
    const result = apply(before, ENTRY_VIEW);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.phases, before);
    assert.notEqual(result.phases, before);
  });

  it("works on an empty list without errors", () => {
    const result = apply([], ENTRY_VIEW);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.phases, []);
  });
});

// ---------------------------------------------------------------------------
// batch atomicity
// ---------------------------------------------------------------------------

describe("batch atomicity", () => {
  it("discards the whole batch and keeps the state when any entry fails", () => {
    const before = [
      phase("P1", ["a", "pending"], ["b", "pending"]),
      phase("P2", ["c", "pending"]),
    ];
    const result = apply(
      before,
      { op: "start", task: "a" },
      { op: "done", task: "ghost" },
      { op: "append", phase: "P1", items: ["new"] },
    );
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.phases, before);
  });

  it("reports every error from the batch, not just the first", () => {
    const result = apply(
      [phase("P", ["a", "pending"])],
      { op: "done", task: "ghost-1" },
      { op: "start", task: "ghost-2" },
      { op: "block", task: "a" },
    );
    assert.equal(result.errors.length, 3);
  });

  it("rejects an unknown operation and keeps the batch atomic", () => {
    const before = [phase("P", ["a", "pending"])];
    const result = apply(before, { op: "frobnicate" } as unknown as TodoEntry, {
      op: "append",
      phase: "P",
      items: ["b"],
    });
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes('Unknown operation "frobnicate"'));
    assert.deepEqual(result.phases, before);
  });

  it("validates later entries against earlier entries' effects", () => {
    const before = [phase("P", ["a", "pending"])];
    const result = apply(
      before,
      { op: "append", phase: "P", items: ["b"] },
      { op: "append", phase: "P", items: ["b"] },
    );
    // The second append duplicates the first's content, so the batch as a
    // whole is invalid and nothing is applied.
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.phases, before);
  });

  it("applies a fully valid batch sequentially", () => {
    const before = [phase("P", ["a", "pending"], ["b", "pending"])];
    const result = apply(
      before,
      { op: "start", task: "a" },
      { op: "done", task: "a" },
    );
    assert.equal(result.errors.length, 0);
    assert.equal(statusOf(result.phases, "a"), "completed");
    // Normalization promotes the earliest remaining pending task.
    assert.equal(statusOf(result.phases, "b"), "in_progress");
  });
});

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

describe("normalize", () => {
  it("keeps only the first in-progress task across phases", () => {
    const state = [
      phase("P1", ["a", "in_progress"], ["b", "pending"]),
      phase("P2", ["c", "in_progress"]),
    ];
    normalizePhases(state);
    assert.equal(statusOf(state, "a"), "in_progress");
    assert.equal(statusOf(state, "c"), "pending");
  });

  it("promotes the earliest pending task when nothing is in progress", () => {
    const state = [
      phase("P1", ["a", "pending"], ["b", "pending"]),
      phase("P2", ["c", "pending"]),
    ];
    normalizePhases(state);
    assert.equal(statusOf(state, "a"), "in_progress");
    assert.equal(statusOf(state, "b"), "pending");
  });

  it("never auto-promotes a blocked task", () => {
    const state = [phase("P", ["a", "blocked"], ["b", "pending"])];
    normalizePhases(state);
    assert.equal(statusOf(state, "a"), "blocked");
    // The earliest pending (b) is promoted instead of the blocked task.
    assert.equal(statusOf(state, "b"), "in_progress");
  });

  it("leaves an all-closed or empty state unchanged", () => {
    const closed = [phase("P", ["a", "completed"], ["b", "abandoned"])];
    const closedCopy = clonePhases(closed);
    normalizePhases(closed);
    assert.deepEqual(closed, closedCopy);

    const empty: TodoPhase[] = [];
    normalizePhases(empty);
    assert.deepEqual(empty, []);
  });

  it("runs as the postcondition even for a no-op batch (single point)", () => {
    const unnormalized = [
      phase("P1", ["a", "in_progress"]),
      phase("P2", ["b", "in_progress"]),
    ];
    const result = apply(unnormalized); // empty batch: normalize still applies
    assert.equal(statusOf(result.phases, "a"), "in_progress");
    assert.equal(statusOf(result.phases, "b"), "pending");
  });
});

// ---------------------------------------------------------------------------
// serialize / restore
// ---------------------------------------------------------------------------

describe("serialize and restore", () => {
  it("round-trips a state through the canonical { op, phases } shape", () => {
    const state = [
      phase("P1", ["a", "in_progress"], ["b", "completed"]),
      phase("P2", ["c", "blocked"]),
    ];
    state[1].tasks[0].blocker = "gate";
    const snapshot = serializeSnapshot("done", state);
    assert.deepEqual(snapshot, {
      op: "done",
      phases: state,
    });
    // No version field is emitted.
    assert.deepEqual(Object.keys(snapshot).sort(), ["op", "phases"]);
    const restored = restoreFromHistory([snapshot]);
    assert.deepEqual(restored, state);
    assert.equal(restored[1].tasks[0].blocker, "gate");
  });

  it("survives a JSON round-trip and deep-clones", () => {
    const state = [phase("P", ["a", "in_progress"])];
    const snapshot = serializeSnapshot("start", state);
    const revived = JSON.parse(JSON.stringify(snapshot)) as TodoSnapshot;
    const restored = restoreFromHistory([revived]);
    assert.deepEqual(restored, state);
    restored[0].tasks[0].status = "completed";
    assert.equal(state[0].tasks[0].status, "in_progress");
  });

  it("returns the newest valid snapshot when several parse", () => {
    const newest = { op: "done", phases: [phase("Newest", ["n", "pending"])] };
    const older = { op: "append", phases: [phase("Older", ["o", "pending"])] };
    const restored = restoreFromHistory([newest, older]);
    assert.equal(statusOf(restored, "n"), "in_progress");
    assert.deepEqual(restored, [phase("Newest", ["n", "in_progress"])]);
  });

  it("recovers from an older snapshot when the newest is structurally broken", () => {
    const broken = {
      op: "done",
      phases: [{ name: "P", tasks: [{ status: 7 }] }],
    };
    const older = { op: "append", phases: [phase("Keep", ["a", "pending"])] };
    const recovered = restoreFromHistory([broken, older]);
    assert.deepEqual(recovered, [phase("Keep", ["a", "in_progress"])]);
  });

  it("returns an empty array when every candidate is invalid", () => {
    const candidates = [
      null,
      "nope",
      42,
      { op: "done" },
      { phases: "nope" },
      { phases: [{ name: 7, tasks: [] }] },
    ];
    assert.deepEqual(restoreFromHistory(candidates), []);
  });

  it("ignores unknown snapshot fields", () => {
    const revived = {
      op: "drop",
      storage: "session",
      version: 3,
      phases: [phase("P", ["a", "pending"])],
    };
    assert.deepEqual(restoreFromHistory([revived]), [
      phase("P", ["a", "in_progress"]),
    ]);
  });

  it("demotes items with an unknown or missing status to pending", () => {
    const revived = {
      op: "view",
      phases: [
        {
          name: "P",
          tasks: [
            { content: "a", status: "flying" },
            { content: "b" },
            { content: "c", status: "completed" },
          ],
        },
      ],
    };
    const restored = restoreFromHistory([revived]);
    assert.equal(statusOf(restored, "a"), "in_progress");
    assert.equal(statusOf(restored, "b"), "pending");
    assert.equal(statusOf(restored, "c"), "completed");
  });

  it("skips a snapshot whose items are structurally invalid", () => {
    const brokenItem = {
      op: "done",
      phases: [{ name: "P", tasks: [{ content: 42, status: "pending" }] }],
    };
    assert.deepEqual(restoreFromHistory([brokenItem]), []);
  });

  it("demotes a blocked task whose blocker is unrecoverable to pending", () => {
    const revived = {
      op: "block",
      phases: [
        {
          name: "P",
          tasks: [
            { content: "z", status: "in_progress" },
            { content: "a", status: "blocked", blocker: 99 },
          ],
        },
      ],
    };
    const restored = restoreFromHistory([revived]);
    assert.equal(statusOf(restored, "a"), "pending");
    assert.equal(blockerOf(restored, "a"), undefined);
    assert.equal(statusOf(restored, "z"), "in_progress");
  });

  it("demotes blocked tasks with blank blockers but keeps a real one", () => {
    const revived = {
      op: "block",
      phases: [
        {
          name: "P",
          tasks: [
            { content: "z", status: "in_progress" },
            { content: "a", status: "blocked", blocker: "" },
            { content: "b", status: "blocked", blocker: "   \n  " },
            { content: "c", status: "blocked", blocker: "  gate\n wait  " },
          ],
        },
      ],
    };
    const restored = restoreFromHistory([revived]);
    assert.equal(statusOf(restored, "a"), "pending");
    assert.equal(blockerOf(restored, "a"), undefined);
    assert.equal(statusOf(restored, "b"), "pending");
    assert.equal(blockerOf(restored, "b"), undefined);
    assert.equal(statusOf(restored, "c"), "blocked");
    assert.equal(blockerOf(restored, "c"), "gate wait");
  });

  it("normalizes a recovered snapshot with multiple in-progress tasks", () => {
    const revived = {
      op: "view",
      phases: [
        phase("P1", ["a", "in_progress"], ["b", "pending"]),
        phase("P2", ["c", "in_progress"]),
      ],
    };
    const restored = restoreFromHistory([revived]);
    assert.equal(statusOf(restored, "a"), "in_progress");
    assert.equal(statusOf(restored, "c"), "pending");
  });

  it("treats an empty phases array as a valid (recovered) empty state", () => {
    const revived = { op: "rm", phases: [] };
    assert.deepEqual(restoreFromHistory([revived]), []);
  });
});

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

describe("formatSummary", () => {
  it("returns the read-only empty message for view", () => {
    assert.equal(formatSummary([], [], true), "Todo list is empty.");
  });

  it("returns the cleared message after a mutating clear", () => {
    assert.equal(formatSummary([], [], false), "Todo list cleared.");
  });

  it("returns only the errors when the list is empty", () => {
    assert.equal(
      formatSummary([], ['Task "x" not found'], false),
      'Errors: Task "x" not found',
    );
  });

  it("echoes only open entries with content, status, and phase", () => {
    const state = [
      phase("P1", ["a", "pending"], ["done1", "completed"]),
      phase("P2", ["b", "in_progress"], ["drop1", "abandoned"]),
    ];
    const text = formatSummary(state, []);
    // A count header naming the open entries precedes the echoed lines.
    assert.ok(text.includes("Remaining items (2):"));
    assert.ok(text.indexOf("Remaining items (2):") < text.indexOf("  - a"));
    assert.ok(text.includes("  - a [pending] (P1)"));
    assert.ok(text.includes("  - b [in_progress] (P2)"));
    assert.ok(!text.includes("done1"));
    assert.ok(!text.includes("drop1"));
  });

  it("reports the counts in the Overall line, with blocked counted separately", () => {
    const state = [
      phase("P1", ["a", "pending"], ["b", "completed"]),
      phase("P2", ["c", "abandoned"], ["d", "blocked"], ["e", "blocked"]),
    ];
    state[1].tasks[0].blocker = "one";
    state[1].tasks[1].blocker = "two";
    const text = formatSummary(state, [], true);
    assert.ok(text.includes("Remaining items (1):"));
    assert.ok(text.includes("Overall: 2/5 done, 1 open, 2 blocked."));
    // Blocked tasks are counted only, never echoed.
    assert.ok(!text.includes("[blocked]"));
  });

  it("omits the blocked suffix when none are blocked", () => {
    const state = [phase("P", ["a", "pending"], ["b", "completed"])];
    const text = formatSummary(state, []);
    assert.ok(text.includes("Remaining items (1):"));
    assert.ok(text.includes("Overall: 1/2 done, 1 open."));
    assert.ok(!text.includes("blocked"));
  });

  it("leads with errors when present", () => {
    const state = [phase("P", ["a", "pending"])];
    const text = formatSummary(state, ["E1", "E2"]);
    assert.equal(
      text,
      "Errors: E1; E2\n" +
        "Remaining items (1):\n" +
        "  - a [pending] (P)\n" +
        "Overall: 0/1 done, 1 open.",
    );
  });

  it("prints the none header when every task is closed", () => {
    const state = [phase("P", ["a", "completed"], ["b", "abandoned"])];
    assert.equal(
      formatSummary(state, []),
      "Remaining items: none.\nOverall: 2/2 done, 0 open.",
    );
    // Blocked work keeps the none header while staying counted.
    const blocked = [phase("P", ["a", "blocked"])];
    blocked[0].tasks[0].blocker = "gate";
    assert.equal(
      formatSummary(blocked, []),
      "Remaining items: none.\nOverall: 0/1 done, 0 open, 1 blocked.",
    );
  });

  it("explains worked-ahead when later phases hold closed work", () => {
    const state = [
      phase("P1", ["a", "pending"], ["b", "pending"]),
      phase("P2", ["c", "completed"]),
    ];
    const text = formatSummary(state, []);
    assert.ok(text.includes("in-progress pointer"));
    assert.ok(text.includes("nothing was reverted"));
  });

  it("omits the worked-ahead note when no later phase has closed work", () => {
    const state = [
      phase("P1", ["a", "in_progress"], ["b", "completed"]),
      phase("P2", ["c", "pending"]),
    ];
    const text = formatSummary(state, []);
    assert.ok(!text.includes("in-progress pointer"));
  });

  it("does not truncate: every open entry of a large list is echoed", () => {
    const items: Array<[string, TodoStatus]> = Array.from(
      { length: 40 },
      (_, i) => [`task ${i}`, "pending"],
    );
    const state = [phase("Big", ...items)];
    const text = formatSummary(state, []);
    const echoed = text.split("\n").filter((line) => line.startsWith("  - "));
    assert.ok(text.includes("Remaining items (40):"));
    assert.equal(echoed.length, 40);
    assert.ok(text.includes("Overall: 0/40 done, 40 open."));
  });
});
