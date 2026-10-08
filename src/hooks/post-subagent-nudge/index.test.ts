/**
 * Tests for the post-subagent-nudge hook.
 *
 * Covers all scenarios: subagent tool injection with various todo states,
 * non-subagent tools skipped, null/undefined output skipped, source read
 * failure, empty list, case-insensitive tool names, stateless consecutive
 * calls, and the todo source selected by the unit at composition time.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import type { TodoSource } from "../../core/client/todo.js";
import {
  TODO_DONE_NUDGE,
  TODO_PROGRESS_NUDGE,
  TODO_RESUME_NUDGE,
  VERIFY_REMINDER,
} from "../../core/prompts.js";
import type { Deps } from "../../core/slots.js";
import { fakeStore, mockClient, sourceOf } from "../../testkits/hooks.js";
import { cleanupPlanDir, writePlanFile } from "../../testkits/plans.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import { nudgePostSubagent, unit } from "./index.js";

// The todo nudge text produced for the "progress" tier.
const PROGRESS_MARKER = "TODO UPDATE REQUIRED";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a todo source that always rejects.
 *
 * @returns A `TodoSource` that throws on every read.
 */
function failingSource(): TodoSource {
  return async () => {
    throw new Error("API failure");
  };
}

/**
 * Helper: invoke nudgePostSubagent with the given parameters and return
 * the mutated output.
 */
async function applyNudge(
  source: TodoSource | null,
  tool: string,
  sessionID: string,
  output?: string,
  planDir?: string,
): Promise<{ output?: string }> {
  const result: { output?: string } = { output };
  await nudgePostSubagent(source, { tool, sessionID }, result, planDir ?? "");
  return result;
}

/**
 * Assert that the output contains VERIFY_REMINDER.
 */
function assertHasVerify(obj: { output?: string }, msg?: string): void {
  assert.ok(
    obj.output?.includes("子 agent 声称完成了工作"),
    msg ?? "expected output to contain VERIFY reminder",
  );
}

/**
 * Assert that the output contains TODO_PROGRESS_NUDGE.
 */
function assertHasGeneral(obj: { output?: string }, msg?: string): void {
  assert.ok(
    obj.output?.includes(PROGRESS_MARKER),
    msg ?? "expected output to contain TODO_PROGRESS_NUDGE",
  );
}

/**
 * Assert that the output contains no todo nudge at all.
 */
function assertNoTodoNudge(obj: { output?: string }, msg?: string): void {
  assert.equal(
    obj.output?.includes(PROGRESS_MARKER),
    false,
    msg ?? "expected no TODO_PROGRESS_NUDGE",
  );
  assert.equal(
    obj.output?.includes("last task still in_progress"),
    false,
    msg ?? "expected no TODO_DONE_NUDGE",
  );
  assert.equal(
    obj.output?.includes("TODO LIST DONE"),
    false,
    msg ?? "expected no TODO_RESUME_NUDGE",
  );
}

/**
 * Assert that the output contains TODO_DONE_NUDGE.
 */
function assertHasFinalActive(obj: { output?: string }, msg?: string): void {
  assert.ok(
    obj.output?.includes("last task still in_progress"),
    msg ?? "expected output to contain TODO_DONE_NUDGE",
  );
}

/**
 * Assert that the output contains TODO_RESUME_NUDGE.
 */
function assertHasResumeNudge(obj: { output?: string }, msg?: string): void {
  assert.ok(
    obj.output?.includes("TODO LIST DONE"),
    msg ?? "expected output to contain TODO_RESUME_NUDGE",
  );
}

// ---------------------------------------------------------------------------
// Task + multiple in_progress → VERIFY + GENERAL
// ---------------------------------------------------------------------------

describe("task + multiple in_progress → VERIFY + GENERAL", () => {
  it("appends VERIFY reminder and GENERAL nudge when 2 in_progress, 1 pending", async () => {
    const source = sourceOf([
      { content: "Fix auth", status: "in_progress", priority: "high", id: "1" },
      {
        content: "Add tests",
        status: "in_progress",
        priority: "medium",
        id: "2",
      },
      { content: "Refactor", status: "pending", priority: "low", id: "3" },
    ]);
    const result = await applyNudge(source, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasGeneral(result);
    assert.equal(result.output?.startsWith("Done"), true);
  });

  it("appends GENERAL when 0 in_progress, 2 pending", async () => {
    const source = sourceOf([
      { content: "Task A", status: "pending", priority: "high", id: "1" },
      { content: "Task B", status: "pending", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(source, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasGeneral(result);
  });

  it("appends GENERAL when 1 in_progress, 1 pending", async () => {
    const source = sourceOf([
      { content: "Active", status: "in_progress", priority: "high", id: "1" },
      { content: "Pending", status: "pending", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(source, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasGeneral(result);
  });
});

// ---------------------------------------------------------------------------
// Task + 1 in_progress, 0 pending → VERIFY + FINAL_ACTIVE
// ---------------------------------------------------------------------------

describe("task + 1 in_progress 0 pending → VERIFY + FINAL_ACTIVE", () => {
  it("appends VERIFY reminder and FINAL_ACTIVE nudge", async () => {
    const source = sourceOf([
      {
        content: "Last task",
        status: "in_progress",
        priority: "high",
        id: "1",
      },
    ]);
    const result = await applyNudge(source, "subagent", "s1", "Finished");
    assertHasVerify(result);
    assertHasFinalActive(result);
    assert.equal(result.output?.startsWith("Finished"), true);
  });

  it("still appends FINAL_ACTIVE when completed and cancelled items also exist", async () => {
    const source = sourceOf([
      {
        content: "Last task",
        status: "in_progress",
        priority: "high",
        id: "1",
      },
      {
        content: "Done task",
        status: "completed",
        priority: "medium",
        id: "2",
      },
      { content: "Cancelled", status: "cancelled", priority: "low", id: "3" },
    ]);
    const result = await applyNudge(source, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasFinalActive(result);
  });
});

// ---------------------------------------------------------------------------
// Task + all completed → VERIFY + RESUME
// ---------------------------------------------------------------------------

describe("task + all completed → VERIFY + RESUME", () => {
  it("appends VERIFY reminder and TODO_RESUME_NUDGE when all items are completed", async () => {
    const source = sourceOf([
      { content: "Task 1", status: "completed", priority: "high", id: "1" },
      { content: "Task 2", status: "completed", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(source, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasResumeNudge(result);
  });

  it("appends VERIFY reminder and TODO_RESUME_NUDGE when all items are cancelled", async () => {
    const source = sourceOf([
      { content: "Task 1", status: "cancelled", priority: "high", id: "1" },
      { content: "Task 2", status: "cancelled", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(source, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasResumeNudge(result);
  });

  it("appends VERIFY reminder and TODO_RESUME_NUDGE when todos are mixed completed/cancelled", async () => {
    const source = sourceOf([
      { content: "Task 1", status: "completed", priority: "high", id: "1" },
      { content: "Task 2", status: "cancelled", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(source, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasResumeNudge(result);
  });
});

// ---------------------------------------------------------------------------
// Task + a source that rejects → VERIFY only, no todo nudge
// ---------------------------------------------------------------------------

describe("task + source read failure → VERIFY only", () => {
  it("appends VERIFY but no todo nudge when the source rejects", async () => {
    const result = await applyNudge(failingSource(), "subagent", "s1", "Done");
    assertHasVerify(result);
    assertNoTodoNudge(result);
  });
});

// ---------------------------------------------------------------------------
// Empty todo list → VERIFY only, no todo nudge
// ---------------------------------------------------------------------------

describe("empty todo list → VERIFY only", () => {
  it("appends VERIFY reminder and no todo nudge when the list is empty", async () => {
    const result = await applyNudge(sourceOf([]), "subagent", "s1", "Done");
    assertHasVerify(result);
    assertNoTodoNudge(result);
  });
});

// ---------------------------------------------------------------------------
// Null source → VERIFY + plan nudge, no todo nudge
// ---------------------------------------------------------------------------

describe("null todo source", () => {
  it("still appends VERIFY reminder and skips the todo nudge", async () => {
    const result = await applyNudge(null, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertNoTodoNudge(result);
  });

  it("still appends the plan nudge", async () => {
    const sessionID = `test-null-source-${Date.now()}`;
    const baseDir = tmpDir();
    try {
      writePlanFile(
        baseDir,
        "my-plan.md",
        { status: "executing", slug: "my-plan" },
        "- [ ] Write tests\n",
      );
      const result = await applyNudge(
        null,
        "subagent",
        sessionID,
        "Done",
        baseDir,
      );
      assertHasVerify(result);
      assertNoTodoNudge(result);
      assert.ok(
        result.output?.includes("PLAN PROGRESS"),
        "expected PLAN PROGRESS nudge",
      );
    } finally {
      cleanupPlanDir(baseDir);
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Non-task tools → skip
// ---------------------------------------------------------------------------

describe("non-task tools are skipped", () => {
  const nonTaskTools = [
    "bash",
    "read",
    "write",
    "grep",
    "glob",
    "webfetch",
    "websearch",
    "lynx",
    "beaver",
    "spider",
  ];

  for (const tool of nonTaskTools) {
    it(`skips tool "${tool}"`, async () => {
      const source = sourceOf([
        { content: "Task", status: "in_progress", priority: "high", id: "1" },
      ]);
      const result = await applyNudge(source, tool, "s1", "output");
      assert.equal(result.output, "output");
    });
  }
});

// ---------------------------------------------------------------------------
// Null / undefined output → skip
// ---------------------------------------------------------------------------

describe("null / undefined output is skipped", () => {
  it("skips when output is undefined", async () => {
    const source = sourceOf([
      { content: "Task", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result: { output?: string } = { output: undefined };
    await nudgePostSubagent(
      source,
      { tool: "subagent", sessionID: "s1" },
      result,
      "",
    );
    assert.equal(result.output, undefined);
  });

  it("skips when output is null", async () => {
    const source = sourceOf([
      { content: "Task", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result: { output?: string } = { output: null as unknown as string };
    await nudgePostSubagent(
      source,
      { tool: "subagent", sessionID: "s1" },
      result,
      "",
    );
    assert.equal(result.output, null);
  });

  it("skips when output property is absent", async () => {
    const source = sourceOf([
      { content: "Task", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result: { output?: string } = {};
    await nudgePostSubagent(
      source,
      { tool: "subagent", sessionID: "s1" },
      result,
      "",
    );
    assert.equal(result.output, undefined);
  });
});

// ---------------------------------------------------------------------------
// Stateless consecutive calls
// ---------------------------------------------------------------------------

describe("stateless consecutive calls", () => {
  it("first call with active todos injects VERIFY+GENERAL, second call with completed injects VERIFY + TODO_RESUME_NUDGE", async () => {
    const sessionID = "s1";

    // First call: active todos
    const state1 = [
      { content: "Task 1", status: "in_progress", priority: "high", id: "1" },
      { content: "Task 2", status: "pending", priority: "medium", id: "2" },
    ];
    const result1 = await applyNudge(
      sourceOf(state1),
      "subagent",
      sessionID,
      "First run",
    );
    assertHasVerify(result1);
    assertHasGeneral(result1);

    // Second call: all completed (no shared state)
    const state2 = [
      { content: "Task 1", status: "completed", priority: "high", id: "1" },
      { content: "Task 2", status: "completed", priority: "medium", id: "2" },
    ];
    const result2 = await applyNudge(
      sourceOf(state2),
      "subagent",
      sessionID,
      "Second run",
    );
    assertHasVerify(result2);
    assertHasResumeNudge(result2);
  });
});

// ---------------------------------------------------------------------------
// Case-insensitive tool name
// ---------------------------------------------------------------------------

describe("case-insensitive tool name matching", () => {
  it('handles "Subagent" (capitalized)', async () => {
    const source = sourceOf([
      { content: "Active", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result = await applyNudge(source, "Subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasFinalActive(result);
  });

  it('handles "SUBAGENT" (uppercase)', async () => {
    const source = sourceOf([
      { content: "Active", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result = await applyNudge(source, "SUBAGENT", "s1", "Done");
    assertHasVerify(result);
    assertHasFinalActive(result);
  });
});

// ---------------------------------------------------------------------------
// Original output preserved
// ---------------------------------------------------------------------------

describe("original output is preserved", () => {
  it("prepends original output before all nudges", async () => {
    const source = sourceOf([
      { content: "Active", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result = await applyNudge(
      source,
      "subagent",
      "s1",
      "Original result",
    );
    assert.ok(result.output?.startsWith("Original result"));
    assert.ok(result.output?.includes(VERIFY_REMINDER));
  });
});

// ---------------------------------------------------------------------------
// Constants match expected values
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("TODO_PROGRESS_NUDGE starts with <internal-reminder> tag", () => {
    assert.ok(TODO_PROGRESS_NUDGE.startsWith("<internal-reminder>"));
  });

  it("TODO_DONE_NUDGE includes last task still in_progress", () => {
    assert.ok(TODO_DONE_NUDGE.includes("last task still in_progress"));
  });

  it("TODO_RESUME_NUDGE includes TODO LIST DONE", () => {
    assert.ok(TODO_RESUME_NUDGE.includes("TODO LIST DONE"));
  });
});

// ---------------------------------------------------------------------------
// Integration: tool.execute.after mapping (direct adapter)
// The unit's composed after-exec handler receives the same arguments the
// host adapter unwraps. Here the handler is invoked directly.
// ---------------------------------------------------------------------------

describe("integration: tool.execute.after → nudgePostSubagent", () => {
  it("appends VERIFY + GENERAL for task tool", async () => {
    const source = sourceOf([
      {
        content: "Active task",
        status: "in_progress",
        priority: "high",
        id: "1",
      },
      {
        content: "Pending task",
        status: "pending",
        priority: "medium",
        id: "2",
      },
    ]);
    const output: { output?: string } = { output: "Task completed" };
    await nudgePostSubagent(
      source,
      { tool: "subagent", sessionID: "s1", callID: "c1" },
      output,
      "",
    );
    assertHasVerify(output);
    assertHasGeneral(output);
    assert.ok(output.output?.startsWith("Task completed"));
  });

  it("appends VERIFY + TODO_RESUME_NUDGE when the source serves all completed", async () => {
    const source = sourceOf([
      {
        content: "Done",
        status: "completed",
        priority: "high",
        id: "1",
      },
    ]);
    const output: { output?: string } = { output: "Task completed" };
    await nudgePostSubagent(
      source,
      { tool: "subagent", sessionID: "s1", callID: "c1" },
      output,
      "",
    );
    assertHasVerify(output);
    assertHasResumeNudge(output);
  });

  it("does not modify non-task tool output", async () => {
    const source = sourceOf([
      {
        content: "Active",
        status: "in_progress",
        priority: "high",
        id: "1",
      },
    ]);
    const output: { output?: string } = { output: "grep result" };
    await nudgePostSubagent(
      source,
      { tool: "grep", sessionID: "s1", callID: "c1" },
      output,
      "",
    );
    assert.equal(output.output, "grep result");
  });

  it("does not modify output when output is null", async () => {
    const source = sourceOf([
      {
        content: "Active",
        status: "in_progress",
        priority: "high",
        id: "1",
      },
    ]);
    const output: { output?: string } = {
      output: null as unknown as string,
    };
    await nudgePostSubagent(
      source,
      { tool: "subagent", sessionID: "s1", callID: "c1" },
      output,
      "",
    );
    assert.equal(output.output, null);
  });

  it("handles a rejecting source gracefully (VERIFY only)", async () => {
    const output: { output?: string } = { output: "Task ran" };
    await nudgePostSubagent(
      failingSource(),
      { tool: "subagent", sessionID: "s1", callID: "c1" },
      output,
      "",
    );
    assertHasVerify(output);
    assertNoTodoNudge(output);
  });
});

// ---------------------------------------------------------------------------
// Composition: unit.create(deps) selects the single todo source
// ---------------------------------------------------------------------------

/** Assemble a partial deps object for unit-level tests. */
function makeDeps(partial: Record<string, unknown>): Deps {
  return partial as unknown as Deps;
}

/** An empty activation set — this unit's create() does not consult it. */
const EMPTY_SETS = {
  agents: new Set<string>(),
  skills: new Set<string>(),
  hooks: new Set<string>(),
  tools: new Set<string>(),
  commands: new Set<string>(),
};

/** Invoke the unit's composed nudgePostSubagent after-exec handler. */
async function runComposed(
  deps: Deps,
  output: { output?: string },
): Promise<void> {
  const composed = unit.create(deps, EMPTY_SETS);
  const handler = composed.afterExec.find(
    (h) => h.name === "nudgePostSubagent",
  );
  assert.ok(handler, "nudgePostSubagent must be composed");
  await handler.handle(
    { tool: "subagent", sessionID: "s1", callID: "c1" },
    output,
  );
}

describe("unit.create(deps) todo source selection", () => {
  it("uses the injected state store on a pi-shaped deps", async () => {
    const deps = makeDeps({
      client: {},
      directory: tmpDir(),
      todoStore: fakeStore([
        {
          name: "Implement",
          tasks: [
            { content: "Wire source", status: "in_progress" },
            { content: "Update tests", status: "pending" },
          ],
        },
      ]),
    });
    const output: { output?: string } = { output: "Task completed" };
    await runComposed(deps, output);
    assertHasVerify(output);
    assertHasGeneral(output);
  });

  it("prefers the store over a client that would serve a different list", async () => {
    // The client list is all completed (resume tier); the store list holds
    // active work (progress tier). The store must win.
    const deps = makeDeps({
      client: mockClient([
        { content: "Old", status: "completed", priority: "high", id: "1" },
      ]),
      directory: tmpDir(),
      todoStore: fakeStore([
        {
          name: "Implement",
          tasks: [{ content: "Wire source", status: "in_progress" }],
        },
      ]),
    });
    const output: { output?: string } = { output: "Task completed" };
    await runComposed(deps, output);
    assertHasGeneral(output);
    assert.equal(
      output.output?.includes("TODO LIST DONE"),
      false,
      "client-served list must not be read",
    );
  });

  it("fails closed when neither store nor capable client is supplied", async () => {
    const deps = makeDeps({ client: {}, directory: tmpDir() });
    const output: { output?: string } = { output: "Task completed" };
    await runComposed(deps, output);
    assertHasVerify(output);
    assertNoTodoNudge(output);
  });

  it("serves the todo nudge from the client adapter on OpenCode-shaped deps", async () => {
    const deps = makeDeps({
      client: mockClient([
        {
          content: "Wire source",
          status: "pending",
          priority: "high",
          id: "1",
        },
        { content: "Land it", status: "pending", priority: "low", id: "2" },
      ]),
      directory: tmpDir(),
    });
    const output: { output?: string } = { output: "Task completed" };
    await runComposed(deps, output);
    assertHasVerify(output);
    assertHasGeneral(output);
  });

  it("keeps the unit name and kind stable", () => {
    assert.equal(unit.name, "post-subagent-nudge");
    assert.equal(unit.kind, "hook");
  });
});

// ---------------------------------------------------------------------------
// Plan nudge scenarios
// ---------------------------------------------------------------------------

let _planNudgeCounter = 0;

function tmpDir(): string {
  return makeTmpDir("zoo-post-nudge-test");
}

describe("plan nudge scenarios", () => {
  it("executing plan with open TODOs includes PLAN_PROGRESS_NUDGE", async () => {
    const sessionID = `test-post-nudge-${Date.now()}-${_planNudgeCounter++}`;
    const baseDir = tmpDir();
    try {
      writePlanFile(
        baseDir,
        "my-plan.md",
        { status: "executing", slug: "my-plan" },
        "- [ ] Write tests\n- [x] Implement feature\n",
      );
      const source = sourceOf([
        {
          content: "Some task",
          status: "completed",
          priority: "high",
          id: "1",
        },
      ]);
      const result = await applyNudge(
        source,
        "subagent",
        sessionID,
        "Done",
        baseDir,
      );
      assert.ok(
        result.output?.includes("PLAN PROGRESS"),
        "expected PLAN PROGRESS nudge",
      );
    } finally {
      cleanupPlanDir(baseDir);
    }
  });

  it("executing plan with all TODOs done includes PLAN_DONE_NUDGE", async () => {
    const sessionID = `test-post-nudge-${Date.now()}-${_planNudgeCounter++}`;
    const baseDir = tmpDir();
    try {
      writePlanFile(
        baseDir,
        "my-plan.md",
        { status: "executing", slug: "my-plan" },
        "- [x] Task A\n- [x] Task B\n",
      );
      const source = sourceOf([
        {
          content: "Some task",
          status: "completed",
          priority: "high",
          id: "1",
        },
      ]);
      const result = await applyNudge(
        source,
        "subagent",
        sessionID,
        "Done",
        baseDir,
      );
      assert.ok(
        result.output?.includes("PLAN COMPLETE"),
        "expected PLAN COMPLETE nudge",
      );
    } finally {
      cleanupPlanDir(baseDir);
    }
  });

  it("done plan includes PLAN_RESUME_NUDGE", async () => {
    const sessionID = `test-post-nudge-${Date.now()}-${_planNudgeCounter++}`;
    const baseDir = tmpDir();
    try {
      writePlanFile(
        baseDir,
        "my-plan.md",
        { status: "done", slug: "my-plan" },
        "- [x] All done\n",
      );
      const source = sourceOf([
        {
          content: "Some task",
          status: "completed",
          priority: "high",
          id: "1",
        },
      ]);
      const result = await applyNudge(
        source,
        "subagent",
        sessionID,
        "Done",
        baseDir,
      );
      assert.ok(
        result.output?.includes("PLAN RESURRECTED"),
        "expected PLAN RESURRECTED nudge",
      );
    } finally {
      cleanupPlanDir(baseDir);
    }
  });

  it("no plan file does not include any plan nudge", async () => {
    const sessionID = `test-post-nudge-${Date.now()}-${_planNudgeCounter++}`;
    const baseDir = tmpDir();
    try {
      const source = sourceOf([
        {
          content: "Some task",
          status: "completed",
          priority: "high",
          id: "1",
        },
      ]);
      const result = await applyNudge(
        source,
        "subagent",
        sessionID,
        "Done",
        baseDir,
      );
      assert.ok(result.output, "output should exist");
      assert.equal(
        result.output?.includes("PLAN PROGRESS"),
        false,
        "should not contain PLAN PROGRESS",
      );
      assert.equal(
        result.output?.includes("PLAN COMPLETE"),
        false,
        "should not contain PLAN COMPLETE",
      );
      assert.equal(
        result.output?.includes("PLAN RESURRECTED"),
        false,
        "should not contain PLAN RESURRECTED",
      );
    } finally {
      cleanupPlanDir(baseDir);
    }
  });
});
