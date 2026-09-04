/**
 * Tests for the post-task-nudge hook.
 *
 * Covers all scenarios: subagent tool injection with various todo states,
 * non-subagent tools skipped, null/undefined output skipped, API failure
 * fallback, case-insensitive tool names, and stateless consecutive calls.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TinyClient } from "../../core/client/todo.js";
import {
  TODO_DONE_NUDGE,
  TODO_PROGRESS_NUDGE,
  TODO_RESUME_NUDGE,
  VERIFY_REMINDER,
} from "../../core/prompts.js";
import { nudgePostTask } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock client whose `session.todo` resolves to the given items.
 *
 * @param items - Todo items to return.
 * @returns A mock client object.
 */
function mockClient(
  items: Array<{
    content: string;
    status: string;
    priority: string;
    id: string;
  }>,
): TinyClient {
  return {
    session: {
      todo: async () => ({ data: items }),
    },
  };
}

/**
 * Build a mock client whose `session.todo` always rejects.
 *
 * @returns A mock client that throws on any todo call.
 */
function failingClient(): TinyClient {
  return {
    session: {
      todo: async () => {
        throw new Error("API failure");
      },
    },
  };
}

/**
 * Helper: invoke nudgePostTask with the given parameters and return
 * the mutated output.
 */
async function applyNudge(
  client: TinyClient,
  tool: string,
  sessionID: string,
  output?: string,
  planDir?: string,
): Promise<{ output?: string }> {
  const result: { output?: string } = { output };
  await nudgePostTask(client, { tool, sessionID }, result, planDir ?? "");
  return result;
}

/**
 * Assert that the output contains VERIFY_REMINDER.
 */
function assertHasVerify(obj: { output?: string }, msg?: string): void {
  assert.ok(
    obj.output?.includes("PROBABLY LYING"),
    msg ?? "expected output to contain VERIFY reminder",
  );
}

/**
 * Assert that the output contains TODO_PROGRESS_NUDGE.
 */
function assertHasGeneral(obj: { output?: string }, msg?: string): void {
  assert.ok(
    obj.output?.includes("TODO UPDATE REQUIRED"),
    msg ?? "expected output to contain TODO_PROGRESS_NUDGE",
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
function assertHasDoneNudge(obj: { output?: string }, msg?: string): void {
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
    const client = mockClient([
      { content: "Fix auth", status: "in_progress", priority: "high", id: "1" },
      {
        content: "Add tests",
        status: "in_progress",
        priority: "medium",
        id: "2",
      },
      { content: "Refactor", status: "pending", priority: "low", id: "3" },
    ]);
    const result = await applyNudge(client, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasGeneral(result);
    assert.equal(result.output?.startsWith("Done"), true);
  });

  it("appends GENERAL when 0 in_progress, 2 pending", async () => {
    const client = mockClient([
      { content: "Task A", status: "pending", priority: "high", id: "1" },
      { content: "Task B", status: "pending", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(client, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasGeneral(result);
  });

  it("appends GENERAL when 1 in_progress, 1 pending", async () => {
    const client = mockClient([
      { content: "Active", status: "in_progress", priority: "high", id: "1" },
      { content: "Pending", status: "pending", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(client, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasGeneral(result);
  });
});

// ---------------------------------------------------------------------------
// Task + 1 in_progress, 0 pending → VERIFY + FINAL_ACTIVE
// ---------------------------------------------------------------------------

describe("task + 1 in_progress 0 pending → VERIFY + FINAL_ACTIVE", () => {
  it("appends VERIFY reminder and FINAL_ACTIVE nudge", async () => {
    const client = mockClient([
      {
        content: "Last task",
        status: "in_progress",
        priority: "high",
        id: "1",
      },
    ]);
    const result = await applyNudge(client, "subagent", "s1", "Finished");
    assertHasVerify(result);
    assertHasFinalActive(result);
    assert.equal(result.output?.startsWith("Finished"), true);
  });

  it("still appends FINAL_ACTIVE when completed and cancelled items also exist", async () => {
    const client = mockClient([
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
    const result = await applyNudge(client, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasFinalActive(result);
  });
});

// ---------------------------------------------------------------------------
// Task + all completed → VERIFY + DONE
// ---------------------------------------------------------------------------

describe("task + all completed → VERIFY + DONE", () => {
  it("appends VERIFY reminder and TODO_RESUME_NUDGE when all items are completed", async () => {
    const client = mockClient([
      { content: "Task 1", status: "completed", priority: "high", id: "1" },
      { content: "Task 2", status: "completed", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(client, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasDoneNudge(result);
  });

  it("appends VERIFY reminder and TODO_RESUME_NUDGE when all items are cancelled", async () => {
    const client = mockClient([
      { content: "Task 1", status: "cancelled", priority: "high", id: "1" },
      { content: "Task 2", status: "cancelled", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(client, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasDoneNudge(result);
  });

  it("appends VERIFY reminder and TODO_RESUME_NUDGE when todos are mixed completed/cancelled", async () => {
    const client = mockClient([
      { content: "Task 1", status: "completed", priority: "high", id: "1" },
      { content: "Task 2", status: "cancelled", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(client, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasDoneNudge(result);
  });
});

// ---------------------------------------------------------------------------
// Task + all completed → VERIFY + TODO_RESUME_NUDGE (new test block)
// ---------------------------------------------------------------------------

describe("task + all completed → VERIFY + TODO_RESUME_NUDGE", () => {
  it("appends VERIFY reminder and TODO_RESUME_NUDGE when all items completed", async () => {
    const client = mockClient([
      { content: "Task 1", status: "completed", priority: "high", id: "1" },
    ]);
    const result = await applyNudge(client, "subagent", "s1", "Done");
    assertHasVerify(result);
    assert.ok(
      result.output?.includes("TODO LIST DONE"),
      "expected TODO_RESUME_NUDGE",
    );
  });
});

// ---------------------------------------------------------------------------
// Task + API failure → VERIFY + GENERAL fallback
// ---------------------------------------------------------------------------

describe("task + API failure → VERIFY + GENERAL fallback", () => {
  it("appends VERIFY and GENERAL when todo API fails", async () => {
    const client = failingClient();
    const result = await applyNudge(client, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasGeneral(result);
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
      const client = mockClient([
        { content: "Task", status: "in_progress", priority: "high", id: "1" },
      ]);
      const result = await applyNudge(client, tool, "s1", "output");
      assert.equal(result.output, "output");
    });
  }
});

// ---------------------------------------------------------------------------
// Null / undefined output → skip
// ---------------------------------------------------------------------------

describe("null / undefined output is skipped", () => {
  it("skips when output is undefined", async () => {
    const client = mockClient([
      { content: "Task", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result: { output?: string } = { output: undefined };
    await nudgePostTask(
      client,
      { tool: "subagent", sessionID: "s1" },
      result,
      "",
    );
    assert.equal(result.output, undefined);
  });

  it("skips when output is null", async () => {
    const client = mockClient([
      { content: "Task", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result: { output?: string } = { output: null as unknown as string };
    await nudgePostTask(
      client,
      { tool: "subagent", sessionID: "s1" },
      result,
      "",
    );
    assert.equal(result.output, null);
  });

  it("skips when output property is absent", async () => {
    const client = mockClient([
      { content: "Task", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result: { output?: string } = {};
    await nudgePostTask(
      client,
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
    const client1 = mockClient(state1);
    const result1 = await applyNudge(
      client1,
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
    const client2 = mockClient(state2);
    const result2 = await applyNudge(
      client2,
      "subagent",
      sessionID,
      "Second run",
    );
    assertHasVerify(result2);
    assertHasDoneNudge(result2);
  });
});

// ---------------------------------------------------------------------------
// Empty todo list → VERIFY + DONE
// ---------------------------------------------------------------------------

describe("empty todo list → VERIFY + DONE", () => {
  it("appends VERIFY reminder and TODO_RESUME_NUDGE when todo list is empty", async () => {
    const client = mockClient([]);
    const result = await applyNudge(client, "subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasDoneNudge(result);
  });
});

// ---------------------------------------------------------------------------
// Case-insensitive tool name
// ---------------------------------------------------------------------------

describe("case-insensitive tool name matching", () => {
  it('handles "Subagent" (capitalized)', async () => {
    const client = mockClient([
      { content: "Active", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result = await applyNudge(client, "Subagent", "s1", "Done");
    assertHasVerify(result);
    assertHasFinalActive(result);
  });

  it('handles "SUBAGENT" (uppercase)', async () => {
    const client = mockClient([
      { content: "Active", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result = await applyNudge(client, "SUBAGENT", "s1", "Done");
    assertHasVerify(result);
    assertHasFinalActive(result);
  });
});

// ---------------------------------------------------------------------------
// Original output preserved
// ---------------------------------------------------------------------------

describe("original output is preserved", () => {
  it("prepends original output before all nudges", async () => {
    const client = mockClient([
      { content: "Active", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result = await applyNudge(
      client,
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
  it("VERIFY_REMINDER starts with anti-sycophancy framing", () => {
    assert.ok(VERIFY_REMINDER.startsWith("**THE SUBAGENT JUST CLAIMED"));
  });

  it("VERIFY_REMINDER has 3 phases: read code, checks, gate decision", () => {
    assert.ok(
      VERIFY_REMINDER.includes("PHASE 1: READ THE CODE FIRST"),
      "should have Phase 1 — read code before running anything",
    );
    assert.ok(
      VERIFY_REMINDER.includes("PHASE 2: RUN AUTOMATED CHECKS"),
      "should have Phase 2 — lsp_diagnostics and targeted tests",
    );
    assert.ok(
      VERIFY_REMINDER.includes("PHASE 3: GATE DECISION"),
      "should have Phase 3 — gate decision before proceeding",
    );
  });

  it("VERIFY_REMINDER includes cross-check claims instruction", () => {
    assert.ok(
      VERIFY_REMINDER.includes("Cross-check every claim"),
      "should require verifying subagent claims against actual code",
    );
  });

  it("VERIFY_REMINDER includes specific tool instructions (Read, lsp_diagnostics)", () => {
    assert.ok(
      VERIFY_REMINDER.includes("which files changed"),
      "Phase 1 should instruct checking which files changed (without prescribing exact git command)",
    );
    assert.ok(
      VERIFY_REMINDER.includes("`Read` EVERY changed file"),
      "Phase 1 should instruct Read of every changed file",
    );
    assert.ok(
      VERIFY_REMINDER.includes("`lsp_diagnostics` on EACH changed file"),
      "Phase 2 should instruct lsp_diagnostics on each file",
    );
  });

  it('VERIFY_REMINDER enforces "Probably = NO" certainty standard', () => {
    assert.ok(VERIFY_REMINDER.includes("Probably"));
  });

  it("VERIFY_REMINDER opens with anti-sycophancy framing", () => {
    assert.ok(
      VERIFY_REMINDER.includes("PROBABLY LYING"),
      "should question subagent reliability before verification steps",
    );
  });

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
// The plugin entry point passes its captured client and workspace directory
// to nudgePostTask via the tool.execute.after handler. Here the adapter is
// invoked directly with the same arguments the handler would unwrap.
// ---------------------------------------------------------------------------

describe("integration: tool.execute.after → nudgePostTask", () => {
  it("appends VERIFY + GENERAL for task tool", async () => {
    const client = mockClient([
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
    await nudgePostTask(
      client,
      { tool: "subagent", sessionID: "s1", callID: "c1" },
      output,
      "",
    );
    assertHasVerify(output);
    assertHasGeneral(output);
    assert.ok(output.output?.startsWith("Task completed"));
  });

  it("appends VERIFY + TODO_RESUME_NUDGE when todo API returns all completed", async () => {
    const client = mockClient([
      {
        content: "Done",
        status: "completed",
        priority: "high",
        id: "1",
      },
    ]);
    const output: { output?: string } = { output: "Task completed" };
    await nudgePostTask(
      client,
      { tool: "subagent", sessionID: "s1", callID: "c1" },
      output,
      "",
    );
    assertHasVerify(output);
    assertHasDoneNudge(output);
  });

  it("does not modify non-task tool output", async () => {
    const client = mockClient([
      {
        content: "Active",
        status: "in_progress",
        priority: "high",
        id: "1",
      },
    ]);
    const output: { output?: string } = { output: "grep result" };
    await nudgePostTask(
      client,
      { tool: "grep", sessionID: "s1", callID: "c1" },
      output,
      "",
    );
    assert.equal(output.output, "grep result");
  });

  it("does not modify output when output is null", async () => {
    const client = mockClient([
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
    await nudgePostTask(
      client,
      { tool: "subagent", sessionID: "s1", callID: "c1" },
      output,
      "",
    );
    assert.equal(output.output, null);
  });

  it("handles todo API failure gracefully (VERIFY+GENERAL)", async () => {
    const client = failingClient();
    const output: { output?: string } = { output: "Task ran" };
    await nudgePostTask(
      client,
      { tool: "subagent", sessionID: "s1", callID: "c1" },
      output,
      "",
    );
    assertHasVerify(output);
    assertHasGeneral(output);
  });
});

// ---------------------------------------------------------------------------
// Plan nudge scenarios
// ---------------------------------------------------------------------------

let _planNudgeCounter = 0;

function tmpDir(): string {
  const dir = join(
    tmpdir(),
    `zoo-post-nudge-test-${Date.now()}-${_planNudgeCounter++}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a plan file under a baseDir's .zoo/plans/ (flat layout).
 */
function writePlanFile(
  baseDir: string,
  filename: string,
  frontmatter: Record<string, string>,
  body: string,
): void {
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const content = `---\n${fmLines}\n---\n\n${body}`;
  const dir = join(baseDir, ".zoo", "plans");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf-8");
}

/**
 * Remove a baseDir's .zoo/plans/ directory recursively.
 */
function cleanupPlanDir(baseDir: string): void {
  try {
    rmSync(join(baseDir, ".zoo", "plans"), {
      recursive: true,
      force: true,
    });
  } catch {
    // ignore
  }
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
      const client = mockClient([
        {
          content: "Some task",
          status: "completed",
          priority: "high",
          id: "1",
        },
      ]);
      const result = await applyNudge(
        client,
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
      const client = mockClient([
        {
          content: "Some task",
          status: "completed",
          priority: "high",
          id: "1",
        },
      ]);
      const result = await applyNudge(
        client,
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
      const client = mockClient([
        {
          content: "Some task",
          status: "completed",
          priority: "high",
          id: "1",
        },
      ]);
      const result = await applyNudge(
        client,
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
      const client = mockClient([
        {
          content: "Some task",
          status: "completed",
          priority: "high",
          id: "1",
        },
      ]);
      const result = await applyNudge(
        client,
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
