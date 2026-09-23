/**
 * Tests for the settled-turn fact helpers (`turn.ts`).
 *
 * Locks the execution-mode proof (`resolveWorkActions`) and the bilingual
 * turn-handback heuristic (`isAwaitingUserAnswer`).  The todo strategy's
 * gate order and wake text are covered at the hook layer
 * (`src/hooks/todo-continuation/`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TurnToolCall, WorkVocabulary } from "./turn.js";
import { isAwaitingUserAnswer, resolveWorkActions } from "./turn.js";

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
