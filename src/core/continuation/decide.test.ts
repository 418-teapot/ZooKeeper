/**
 * Tests for the auto-continuation decision (`decide.ts`).
 *
 * Locks the short-circuit gate order and each silence reason (including
 * the `no-progress` execution gate), the wake text format (fixed
 * directive, status summary, remaining-task lines), the purity contract
 * (identical inputs produce deeply equal outputs), the execution-mode
 * proof (`resolveWorkActions`), and the bilingual turn-handback heuristic
 * (`isAwaitingUserAnswer`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TodoItemView, TodoStatus } from "../todo/types.js";
import type { Budget, TurnToolCall, WorkVocabulary } from "./decide.js";
import {
  CONTINUATION_PROMPT,
  decide,
  isAwaitingUserAnswer,
  resolveWorkActions,
} from "./decide.js";

/** A budget with room to spare for the session. */
const OPEN_BUDGET: Budget = { limit: 3, used: 0 };

/** Build a task view from a status and a content label. */
function item(status: TodoStatus, content = `task-${status}`): TodoItemView {
  return { content, status };
}

describe("decide — gate order", () => {
  it("silences awaiting-input with not-settled", () => {
    assert.deepEqual(
      decide([item("pending")], "awaiting-input", OPEN_BUDGET, true),
      { kind: "silence", reason: "not-settled" },
    );
  });

  it("silences aborted with not-settled", () => {
    assert.deepEqual(decide([item("pending")], "aborted", OPEN_BUDGET, true), {
      kind: "silence",
      reason: "not-settled",
    });
  });

  it("settles an empty list with empty", () => {
    assert.deepEqual(decide([], "settled", OPEN_BUDGET, true), {
      kind: "silence",
      reason: "empty",
    });
  });

  it("silences an all-completed list with no-active", () => {
    assert.deepEqual(
      decide(
        [item("completed"), item("completed")],
        "settled",
        OPEN_BUDGET,
        true,
      ),
      { kind: "silence", reason: "no-active" },
    );
  });

  it("silences an all-abandoned list with no-active", () => {
    assert.deepEqual(
      decide(
        [item("abandoned"), item("abandoned")],
        "settled",
        OPEN_BUDGET,
        true,
      ),
      { kind: "silence", reason: "no-active" },
    );
  });

  it("silences an all-blocked list with no-active", () => {
    assert.deepEqual(
      decide([item("blocked"), item("blocked")], "settled", OPEN_BUDGET, true),
      { kind: "silence", reason: "no-active" },
    );
  });

  it("silences a blocked-plus-completed list with no-active", () => {
    assert.deepEqual(
      decide(
        [item("blocked"), item("completed")],
        "settled",
        OPEN_BUDGET,
        true,
      ),
      { kind: "silence", reason: "no-active" },
    );
  });

  it("silences a settled no-progress turn with no-progress", () => {
    assert.deepEqual(decide([item("pending")], "settled", OPEN_BUDGET, false), {
      kind: "silence",
      reason: "no-progress",
    });
  });

  it("orders no-active before no-progress", () => {
    assert.deepEqual(
      decide([item("completed")], "settled", OPEN_BUDGET, false),
      { kind: "silence", reason: "no-active" },
    );
  });

  it("orders no-progress before budget-exhausted", () => {
    assert.deepEqual(
      decide([item("pending")], "settled", { limit: 1, used: 1 }, false),
      { kind: "silence", reason: "no-progress" },
    );
  });

  it("silences a spent budget with budget-exhausted", () => {
    assert.deepEqual(
      decide([item("pending")], "settled", { limit: 2, used: 2 }, true),
      { kind: "silence", reason: "budget-exhausted" },
    );
  });

  it("silences an over-spent budget with budget-exhausted", () => {
    assert.deepEqual(
      decide([item("pending")], "settled", { limit: 2, used: 5 }, true),
      { kind: "silence", reason: "budget-exhausted" },
    );
  });

  it("wakes at the budget boundary used == limit - 1", () => {
    const decision = decide(
      [item("pending")],
      "settled",
      {
        limit: 2,
        used: 1,
      },
      true,
    );
    assert.equal(decision.kind, "wake");
  });

  it("wakes a settled active turn that made progress", () => {
    const decision = decide([item("pending")], "settled", OPEN_BUDGET, true);
    assert.equal(decision.kind, "wake");
  });
});

describe("decide — wake text", () => {
  it("leads with the fixed directive", () => {
    const decision = decide(
      [item("pending", "wire the gate")],
      "settled",
      {
        limit: 3,
        used: 0,
      },
      true,
    );
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
    const decision = decide(tasks, "settled", { limit: 5, used: 0 }, true);
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
    const decision = decide(tasks, "settled", { limit: 3, used: 0 }, true);
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
    const budget: Budget = { limit: 4, used: 1 };
    const first = decide(tasks, "settled", budget, true);
    const second = decide(tasks, "settled", budget, true);
    assert.deepEqual(first, second);
  });

  it("does not mutate its inputs", () => {
    const tasks: TodoItemView[] = [item("pending", "one")];
    const budget: Budget = { limit: 4, used: 1 };
    decide(tasks, "settled", budget, true);
    assert.deepEqual(tasks, [item("pending", "one")]);
    assert.deepEqual(budget, { limit: 4, used: 1 });
  });
});

describe("resolveWorkActions — execution-mode proof", () => {
  /** A host vocabulary: the names that mutate plus the executor check. */
  const VOCAB: WorkVocabulary = {
    mutatingTools: ["bash", "edit", "write"],
    isExecutorAgent: (agent: string): boolean => agent === "beaver",
  };

  it("counts direct bash/edit/write calls by name", () => {
    assert.deepEqual(
      resolveWorkActions(
        [{ name: "bash" }, { name: "edit" }, { name: "write" }],
        VOCAB,
      ),
      ["bash", "edit", "write"],
    );
  });

  it("does not count a todo-only turn", () => {
    assert.deepEqual(resolveWorkActions([{ name: "todo" }], VOCAB), []);
  });

  it("does not count read or search tools", () => {
    assert.deepEqual(
      resolveWorkActions([{ name: "read" }, { name: "grep" }], VOCAB),
      [],
    );
  });

  it("does not count a name outside the host vocabulary", () => {
    assert.deepEqual(resolveWorkActions([{ name: "zap" }], VOCAB), []);
  });

  it("counts a delegation to an executor", () => {
    assert.deepEqual(
      resolveWorkActions([{ name: "subagent", agent: "beaver" }], VOCAB),
      ["subagent"],
    );
  });

  it("does not count a delegation to a read-only agent", () => {
    assert.deepEqual(
      resolveWorkActions([{ name: "subagent", agent: "lynx" }], VOCAB),
      [],
    );
  });

  it("does not count a delegation with an unknown agent", () => {
    assert.deepEqual(
      resolveWorkActions([{ name: "subagent", agent: "unknown" }], VOCAB),
      [],
    );
  });

  it("does not count a delegation with a missing agent", () => {
    assert.deepEqual(resolveWorkActions([{ name: "subagent" }], VOCAB), []);
  });

  it("counts a differently named delegation to an executor", () => {
    // Delegation is detected by the host-set `agent`, not the tool name:
    // each host fills `agent` only on its own delegation tool.
    assert.deepEqual(
      resolveWorkActions([{ name: "task", agent: "beaver" }], VOCAB),
      ["task"],
    );
  });

  it("counts only the mutating calls in a mixed turn", () => {
    const calls: TurnToolCall[] = [
      { name: "read" },
      { name: "todo" },
      { name: "subagent", agent: "lynx" },
      { name: "edit" },
      { name: "subagent", agent: "beaver" },
    ];
    assert.deepEqual(resolveWorkActions(calls, VOCAB), ["edit", "subagent"]);
  });
});

describe("isAwaitingUserAnswer — bilingual handback detection", () => {
  it("fires on a trailing English question mark", () => {
    assert.equal(isAwaitingUserAnswer("Which branch should I use?"), true);
  });

  it("fires on a trailing Chinese question mark", () => {
    assert.equal(isAwaitingUserAnswer("下一步该怎么办？"), true);
  });

  it("fires on an English response cue", () => {
    assert.equal(isAwaitingUserAnswer("Let me know which one."), true);
  });

  it("fires on a Chinese line-start cue", () => {
    assert.equal(isAwaitingUserAnswer("确认后我就开始实施。"), true);
  });

  it("fires on a Chinese line-end cue", () => {
    assert.equal(isAwaitingUserAnswer("这个方案可以吗？"), true);
  });

  it("fires on a Chinese conditional solicitation", () => {
    assert.equal(isAwaitingUserAnswer("要修的话说一声。"), true);
  });

  it("fires on a confirmation word opening a statement (accepted false positive)", () => {
    // The broad suppression bias accepts this report being read as a
    // handback; the cost is one skipped wake.
    assert.equal(isAwaitingUserAnswer("确认订单已创建。"), true);
  });

  it("does not fire on a TypeScript optional-property tail", () => {
    assert.equal(isAwaitingUserAnswer("foo?: string"), false);
  });

  it("does not fire on an ordinary summary line", () => {
    assert.equal(
      isAwaitingUserAnswer("All requested changes are complete."),
      false,
    );
  });

  it("does not fire on empty text", () => {
    assert.equal(isAwaitingUserAnswer(""), false);
  });

  it("does not fire on whitespace-only text", () => {
    assert.equal(isAwaitingUserAnswer("  \n\n  "), false);
  });

  it("inspects only the last non-empty line", () => {
    assert.equal(
      isAwaitingUserAnswer("Done.\n\nShould I proceed?\n\nWrapping up now."),
      false,
    );
  });

  it("ignores trailing blank lines when locating the last line", () => {
    assert.equal(isAwaitingUserAnswer("Which branch?\n\n"), true);
  });

  it("strips a markdown list prefix before detection", () => {
    assert.equal(isAwaitingUserAnswer("- Let me know your preference."), true);
  });
});
