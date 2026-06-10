/**
 * Tests for the post-task-nudge hook.
 *
 * Covers all scenarios: task tool injection with various todo states,
 * non-task tools skipped, null/undefined output skipped, API failure
 * fallback, case-insensitive tool names, and stateless consecutive calls.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zookeeper } from "../../index.js";
import {
  TODO_FINAL_ACTIVE,
  TODO_GENERAL,
  VERIFY_REMINDER,
} from "../shared/todo-nudge.js";
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
): {
  session: {
    todo: (opts: { path: { id: string } }) => Promise<{
      data: Array<{
        content: string;
        status: string;
        priority: string;
        id: string;
      }>;
    }>;
  };
} {
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
function failingClient(): {
  session: {
    todo: (opts: { path: { id: string } }) => Promise<{
      data: Array<{
        content: string;
        status: string;
        priority: string;
        id: string;
      }>;
    }>;
  };
} {
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
  client: {
    session: {
      todo: (opts: { path: { id: string } }) => Promise<{
        data: Array<{
          content: string;
          status: string;
          priority: string;
          id: string;
        }>;
      }>;
    };
  },
  tool: string,
  sessionID: string,
  output?: string,
): Promise<{ output?: string }> {
  const result: { output?: string } = { output };
  await nudgePostTask(client, { tool, sessionID }, result);
  return result;
}

/**
 * Assert that the output contains VERIFY_REMINDER.
 */
function assertHasVerify(obj: { output?: string }, msg?: string): void {
  assert.ok(
    obj.output?.includes("VERIFY NOW"),
    msg ?? "expected output to contain VERIFY reminder",
  );
}

/**
 * Assert that the output contains TODO_GENERAL.
 */
function assertHasGeneral(obj: { output?: string }, msg?: string): void {
  assert.ok(
    obj.output?.includes("TODO UPDATE REQUIRED"),
    msg ?? "expected output to contain TODO_GENERAL",
  );
}

/**
 * Assert that the output contains TODO_FINAL_ACTIVE.
 */
function assertHasFinalActive(obj: { output?: string }, msg?: string): void {
  assert.ok(
    obj.output?.includes("LAST TASK STILL in_progress"),
    msg ?? "expected output to contain TODO_FINAL_ACTIVE",
  );
}

/**
 * Assert that the output does NOT contain any todo nudge text.
 */
function assertNoTodoNudge(obj: { output?: string }, msg?: string): void {
  assert.equal(
    obj.output?.includes("TODO UPDATE REQUIRED"),
    false,
    msg ?? "expected output not to contain any todo nudge",
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
    const result = await applyNudge(client, "task", "s1", "Done");
    assertHasVerify(result);
    assertHasGeneral(result);
    assert.equal(result.output?.startsWith("Done"), true);
  });

  it("appends GENERAL when 0 in_progress, 2 pending", async () => {
    const client = mockClient([
      { content: "Task A", status: "pending", priority: "high", id: "1" },
      { content: "Task B", status: "pending", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(client, "task", "s1", "Done");
    assertHasVerify(result);
    assertHasGeneral(result);
  });

  it("appends GENERAL when 1 in_progress, 1 pending", async () => {
    const client = mockClient([
      { content: "Active", status: "in_progress", priority: "high", id: "1" },
      { content: "Pending", status: "pending", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(client, "task", "s1", "Done");
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
    const result = await applyNudge(client, "task", "s1", "Finished");
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
    const result = await applyNudge(client, "task", "s1", "Done");
    assertHasVerify(result);
    assertHasFinalActive(result);
  });
});

// ---------------------------------------------------------------------------
// Task + all completed → VERIFY only
// ---------------------------------------------------------------------------

describe("task + all completed → VERIFY only", () => {
  it("appends VERIFY only when all items are completed", async () => {
    const client = mockClient([
      { content: "Task 1", status: "completed", priority: "high", id: "1" },
      { content: "Task 2", status: "completed", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(client, "task", "s1", "Done");
    assertHasVerify(result);
    assertNoTodoNudge(result);
  });

  it("appends VERIFY only when all items are cancelled", async () => {
    const client = mockClient([
      { content: "Task 1", status: "cancelled", priority: "high", id: "1" },
      { content: "Task 2", status: "cancelled", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(client, "task", "s1", "Done");
    assertHasVerify(result);
    assertNoTodoNudge(result);
  });

  it("appends VERIFY only when todos are mixed completed/cancelled", async () => {
    const client = mockClient([
      { content: "Task 1", status: "completed", priority: "high", id: "1" },
      { content: "Task 2", status: "cancelled", priority: "medium", id: "2" },
    ]);
    const result = await applyNudge(client, "task", "s1", "Done");
    assertHasVerify(result);
    assertNoTodoNudge(result);
  });
});

// ---------------------------------------------------------------------------
// Task + API failure → VERIFY + GENERAL fallback
// ---------------------------------------------------------------------------

describe("task + API failure → VERIFY + GENERAL fallback", () => {
  it("appends VERIFY and GENERAL when todo API fails", async () => {
    const client = failingClient();
    const result = await applyNudge(client, "task", "s1", "Done");
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
    "explore",
    "general",
    "scout",
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
    await nudgePostTask(client, { tool: "task", sessionID: "s1" }, result);
    assert.equal(result.output, undefined);
  });

  it("skips when output is null", async () => {
    const client = mockClient([
      { content: "Task", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result: { output?: string } = { output: null as unknown as string };
    await nudgePostTask(client, { tool: "task", sessionID: "s1" }, result);
    assert.equal(result.output, null);
  });

  it("skips when output property is absent", async () => {
    const client = mockClient([
      { content: "Task", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result: { output?: string } = {};
    await nudgePostTask(client, { tool: "task", sessionID: "s1" }, result);
    assert.equal(result.output, undefined);
  });
});

// ---------------------------------------------------------------------------
// Stateless consecutive calls
// ---------------------------------------------------------------------------

describe("stateless consecutive calls", () => {
  it("first call with active todos injects VERIFY+GENERAL, second call with completed injects VERIFY only", async () => {
    const sessionID = "s1";

    // First call: active todos
    const state1 = [
      { content: "Task 1", status: "in_progress", priority: "high", id: "1" },
      { content: "Task 2", status: "pending", priority: "medium", id: "2" },
    ];
    const client1 = mockClient(state1);
    const result1 = await applyNudge(client1, "task", sessionID, "First run");
    assertHasVerify(result1);
    assertHasGeneral(result1);

    // Second call: all completed (no shared state)
    const state2 = [
      { content: "Task 1", status: "completed", priority: "high", id: "1" },
      { content: "Task 2", status: "completed", priority: "medium", id: "2" },
    ];
    const client2 = mockClient(state2);
    const result2 = await applyNudge(client2, "task", sessionID, "Second run");
    assertHasVerify(result2);
    assertNoTodoNudge(result2);
  });
});

// ---------------------------------------------------------------------------
// Empty todo list → VERIFY only
// ---------------------------------------------------------------------------

describe("empty todo list → VERIFY only", () => {
  it("appends VERIFY only when todo list is empty", async () => {
    const client = mockClient([]);
    const result = await applyNudge(client, "task", "s1", "Done");
    assertHasVerify(result);
    assertNoTodoNudge(result);
  });
});

// ---------------------------------------------------------------------------
// Case-insensitive tool name
// ---------------------------------------------------------------------------

describe("case-insensitive tool name matching", () => {
  it('handles "Task" (capitalized)', async () => {
    const client = mockClient([
      { content: "Active", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result = await applyNudge(client, "Task", "s1", "Done");
    assertHasVerify(result);
    assertHasFinalActive(result);
  });

  it('handles "TASK" (uppercase)', async () => {
    const client = mockClient([
      { content: "Active", status: "in_progress", priority: "high", id: "1" },
    ]);
    const result = await applyNudge(client, "TASK", "s1", "Done");
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
    const result = await applyNudge(client, "task", "s1", "Original result");
    assert.ok(result.output?.startsWith("Original result"));
    assert.ok(result.output?.includes(VERIFY_REMINDER));
  });
});

// ---------------------------------------------------------------------------
// Constants match expected values
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("VERIFY_REMINDER starts with bold VERIFY NOW", () => {
    assert.ok(VERIFY_REMINDER.startsWith("**VERIFY NOW"));
  });

  it("TODO_GENERAL starts with bold TODO UPDATE REQUIRED", () => {
    assert.ok(TODO_GENERAL.startsWith("**TODO UPDATE REQUIRED"));
  });

  it("TODO_FINAL_ACTIVE includes LAST TASK STILL in_progress", () => {
    assert.ok(TODO_FINAL_ACTIVE.includes("LAST TASK STILL in_progress"));
  });
});

// ---------------------------------------------------------------------------
// Integration via plugin entry point
// ---------------------------------------------------------------------------

describe("integration via plugin (tool.execute.after)", () => {
  it("appends VERIFY + GENERAL via plugin for task tool", async () => {
    const plugin = await zookeeper({
      client: mockClient([
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
      ]),
    });
    const output: { output?: string } = { output: "Task completed" };
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: "s1", callID: "c1" },
      output,
    );
    assertHasVerify(output);
    assertHasGeneral(output);
    assert.ok(output.output?.startsWith("Task completed"));
  });

  it("appends VERIFY only via plugin when todo API returns all completed", async () => {
    const plugin = await zookeeper({
      client: mockClient([
        {
          content: "Done",
          status: "completed",
          priority: "high",
          id: "1",
        },
      ]),
    });
    const output: { output?: string } = { output: "Task completed" };
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: "s1", callID: "c1" },
      output,
    );
    assertHasVerify(output);
    assertNoTodoNudge(output);
  });

  it("does not modify non-task tool output via plugin", async () => {
    const plugin = await zookeeper({
      client: mockClient([
        {
          content: "Active",
          status: "in_progress",
          priority: "high",
          id: "1",
        },
      ]),
    });
    const output: { output?: string } = { output: "grep result" };
    await plugin["tool.execute.after"](
      { tool: "grep", sessionID: "s1", callID: "c1" },
      output,
    );
    assert.equal(output.output, "grep result");
  });

  it("does not modify output when output is null via plugin", async () => {
    const plugin = await zookeeper({
      client: mockClient([
        {
          content: "Active",
          status: "in_progress",
          priority: "high",
          id: "1",
        },
      ]),
    });
    const output: { output?: string } = {
      output: null as unknown as string,
    };
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: "s1", callID: "c1" },
      output,
    );
    assert.equal(output.output, null);
  });

  it("handles todo API failure gracefully via plugin (VERIFY+GENERAL)", async () => {
    const plugin = await zookeeper({
      client: failingClient(),
    });
    const output: { output?: string } = { output: "Task ran" };
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: "s1", callID: "c1" },
      output,
    );
    assertHasVerify(output);
    assertHasGeneral(output);
  });
});
