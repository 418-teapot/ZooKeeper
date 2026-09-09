/**
 * Tests for the todo tool adapter.
 *
 * Covers: the nine-operation routing through one scripted session sequence
 * (each step asserting the echoed summary and the resulting store state), the
 * loud Chinese argument-validation errors (unknown op, missing/empty batch,
 * batch handed to the read-only `view`, malformed entry fields, empty
 * contents, unknown fields, per-op missing payload, and per-op inapplicable
 * fields — the stray payload that the state machine would otherwise ignore
 * into a destructive "every task" default), batch atomic rollback
 * (one bad entry leaves the stored state untouched and reports the errors),
 * the transcript-truthfulness rule (every successful mutating call writes a
 * fresh `{ op, phases }` snapshot into `hostCtx.details`, a refused call and a
 * `view` write nothing), the restore loop through an injected store, the
 * missing-session-ID error, the renderer attachment seam, and the fail-closed
 * registration gate (no `todoStore` / no `toolHost` → zero tools).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ToolHost } from "../core/client/tool-host.js";
import type { ActiveSet, Deps, ToolContribution } from "../core/slots.js";
import type { TodoSnapshot } from "../core/todo/serialize.js";
import { createTodoStore } from "../core/todo/store.js";
import type { TodoPhase } from "../core/todo/types.js";
import { _resetForTesting } from "../utils/logger.js";
import { unit as todoUnit, validateTodoArgs } from "./todo.js";

// ---------------------------------------------------------------------------
// Fixtures & teardown
// ---------------------------------------------------------------------------

const TEST_SESSION_ID = "sess-todo-tool";

/** No tool context needed — the fake host resolves a fixed session id. */
const TOOL_CTX = {};

/** The transcript, simulated as a newest-first list of written details. */
let transcript: unknown[] = [];

/** The store instance the last `makeTool()` wired, for state assertions. */
let activeStore: ReturnType<typeof createTodoStore> | undefined;

/** Reset the logger, the fake transcript, and the injected store handle. */
afterEach(() => {
  _resetForTesting();
  transcript = [];
  activeStore = undefined;
});

/** The host's tool services: a fixed session id and a no-op notify. */
function fakeHost(sessionID: string | null = TEST_SESSION_ID): ToolHost {
  return {
    resolveSessionId: () => sessionID ?? undefined,
    async notify(): Promise<void> {},
  };
}

/**
 * Instantiate the tool through the unit descriptor over a FRESH store built
 * on the fake transcript — mirroring the real host, where each extension
 * instance owns its store.
 *
 * @param opts - Host overrides (a session id of `undefined` exercises the
 *   missing-session error) and an optional renderer port.
 * @returns The single contributed tool.
 */
function makeTool(opts: { host?: ToolHost } = {}): ToolContribution {
  const store = createTodoStore(async () => transcript);
  activeStore = store;
  const deps = {
    limits: {},
    contextConfig: {},
    client: {},
    directory: "",
    resolveAgent: () => undefined,
    toolHost: opts.host ?? fakeHost(),
    todoStore: store,
  } as unknown as Deps;
  const tools = todoUnit.create(deps, {} as ActiveSet).tools;
  assert.equal(tools.length, 1, "the wired unit contributes exactly one tool");
  return tools[0];
}

/**
 * Run one call, capture any written snapshot onto the fake transcript, and
 * return the echoed summary text.
 *
 * A written detail is `unshift`ed so the transcript stays newest-first,
 * exactly as the host's scan of tool-result details would.
 */
async function run(
  tool: ToolContribution,
  args: Record<string, unknown>,
): Promise<string> {
  const hostCtx: { details?: unknown } = {};
  const text = await tool.execute(args, TOOL_CTX, hostCtx);
  if (hostCtx.details !== undefined) transcript.unshift(hostCtx.details);
  return text;
}

/** Read the live state from the store the last `makeTool()` injected. */
async function state(): Promise<TodoPhase[]> {
  assert.ok(activeStore, "makeTool() must run before reading state");
  return activeStore.get(TEST_SESSION_ID);
}

/** All task contents currently held, in list order. */
function contents(phases: TodoPhase[]): string[] {
  return phases.flatMap((phase) => phase.tasks.map((task) => task.content));
}

/** The status of one task by exact content, or `undefined` when absent. */
function statusOf(phases: TodoPhase[], content: string): string | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((candidate) => candidate.content === content);
    if (task) return task.status;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Nine-operation routing (one scripted sequence)
// ---------------------------------------------------------------------------

describe("todo tool operations", () => {
  it("routes all nine ops through a scripted sequence", async () => {
    const tool = makeTool();

    // 1. init — canonical phased list; the earliest task is auto-promoted.
    const initText = await run(tool, {
      op: "init",
      entries: [
        {
          list: [
            {
              phase: "Setup",
              items: ["Install dependencies", "Configure environment"],
            },
            { phase: "Ship", items: ["Write release notes"] },
          ],
        },
      ],
    });
    assert.match(initText, /Install dependencies \[in_progress] \(Setup\)/);
    assert.match(initText, /Write release notes \[pending] \(Ship\)/);
    assert.deepEqual(contents(await state()), [
      "Install dependencies",
      "Configure environment",
      "Write release notes",
    ]);

    // 2. start — the pointer moves; the earlier in-progress task falls back.
    const startText = await run(tool, {
      op: "start",
      entries: [{ task: "Write release notes" }],
    });
    assert.match(startText, /Write release notes \[in_progress] \(Ship\)/);
    assert.match(startText, /Install dependencies \[pending] \(Setup\)/);

    // 3. done — completed work is counted, never echoed as remaining.
    const doneText = await run(tool, {
      op: "done",
      entries: [{ task: "Write release notes" }],
    });
    assert.match(doneText, /Overall: 1\/3 done/);
    assert.equal(statusOf(await state(), "Write release notes"), "completed");

    // 4. append — a new task lands in the named phase as pending.
    const appendText = await run(tool, {
      op: "append",
      entries: [{ phase: "Ship", items: ["Tag release"] }],
    });
    assert.match(appendText, /Tag release \[pending] \(Ship\)/);

    // 5. block — blocked work is counted separately and carries its reason.
    const blockText = await run(tool, {
      op: "block",
      entries: [{ task: "Tag release", reason: "waiting on user sign-off" }],
    });
    assert.match(blockText, /1 blocked/);
    assert.equal(statusOf(await state(), "Tag release"), "blocked");

    // 6. unblock — back to pending, blocker cleared.
    const unblockText = await run(tool, {
      op: "unblock",
      entries: [{ task: "Tag release" }],
    });
    assert.doesNotMatch(unblockText, /blocked/);
    assert.equal(statusOf(await state(), "Tag release"), "pending");

    // 7. drop — abandoned work counts as closed.
    const dropText = await run(tool, {
      op: "drop",
      entries: [{ tasks: ["Configure environment"] }],
    });
    assert.match(dropText, /Overall: 2\/4 done/);
    assert.equal(statusOf(await state(), "Configure environment"), "abandoned");

    // 8. rm — the task disappears from the list entirely.
    const rmText = await run(tool, {
      op: "rm",
      entries: [{ tasks: ["Configure environment"] }],
    });
    assert.doesNotMatch(rmText, /Configure environment/);
    assert.deepEqual(contents(await state()), [
      "Install dependencies",
      "Write release notes",
      "Tag release",
    ]);

    // 9. view — read-only echo of the same state.
    const viewText = await run(tool, { op: "view" });
    assert.match(viewText, /Overall: 1\/3 done/);
    assert.match(viewText, /Install dependencies \[in_progress]/);
  });

  it("treats a target-less done/drop/rm batch as 'every task'", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", entries: [{ items: ["One", "Two"] }] });
    const text = await run(tool, { op: "done", entries: [{}] });
    assert.match(text, /Remaining items: none\./);
    assert.match(text, /Overall: 2\/2 done/);

    const cleared = await run(tool, { op: "rm", entries: [{}] });
    assert.equal(cleared, "Todo list cleared.");
    assert.deepEqual(
      contents(await state()),
      [],
      "a target-less rm removes every task",
    );
  });

  it("echoes the empty-list variant for a read-only view", async () => {
    const tool = makeTool();
    assert.equal(await run(tool, { op: "view" }), "Todo list is empty.");
  });

  it("replaces the whole list on a repeated init", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", entries: [{ items: ["Old task"] }] });
    const text = await run(tool, {
      op: "init",
      entries: [{ items: ["Fresh plan"], phase: "Redo" }],
    });
    assert.doesNotMatch(text, /Old task/);
    assert.match(text, /Fresh plan \[in_progress] \(Redo\)/);
  });
});

// ---------------------------------------------------------------------------
// Loud Chinese argument validation
// ---------------------------------------------------------------------------

describe("todo tool argument validation", () => {
  /** Assert a call throws with the Chinese guidance prefix. */
  async function expectChinese(
    args: unknown,
    fragment: string,
    message: string,
  ): Promise<void> {
    const tool = makeTool();
    await assert.rejects(
      () => tool.execute(args, TOOL_CTX, {}),
      (err: unknown) => {
        const text = String(err);
        assert.ok(
          text.includes("todo 工具参数格式错误"),
          `${message}: expected the Chinese guidance prefix, got ${text}`,
        );
        assert.ok(
          text.includes(fragment),
          `${message}: expected "${fragment}" in ${text}`,
        );
        return true;
      },
    );
  }

  it("rejects an unknown op", async () => {
    await expectChinese(
      { op: "frobnicate", entries: [{}] },
      "init/start/done/drop/rm/block/unblock/append/view",
      "unknown op lists the vocabulary",
    );
  });

  it("rejects a missing op", async () => {
    await expectChinese({ entries: [{}] }, "op 必须是", "missing op is loud");
  });

  it("rejects non-object arguments", async () => {
    await expectChinese(
      "init",
      "请提供 { op, entries }",
      "scalar args rejected",
    );
  });

  it("rejects a missing entries batch", async () => {
    await expectChinese(
      { op: "init" },
      "entries 必须是数组",
      "init needs entries",
    );
  });

  it("rejects an empty entries batch", async () => {
    await expectChinese(
      { op: "append", entries: [] },
      "entries 不能为空",
      "empty batch rejected",
    );
  });

  it("rejects entries handed to the read-only view op", async () => {
    await expectChinese(
      { op: "view", entries: [{ task: "x" }] },
      "view 是只读操作",
      "view takes no payload",
    );
  });

  it("accepts view with an empty or absent batch", () => {
    assert.deepEqual(validateTodoArgs({ op: "view" }), {
      op: "view",
      entries: [{ op: "view" }],
    });
    assert.deepEqual(validateTodoArgs({ op: "view", entries: [] }), {
      op: "view",
      entries: [{ op: "view" }],
    });
  });

  it("rejects a non-object entry", async () => {
    await expectChinese(
      { op: "start", entries: ["Install dependencies"] },
      "entries[1] 必须是",
      "entry must be an object",
    );
  });

  it("rejects unknown entry fields", async () => {
    await expectChinese(
      { op: "start", entries: [{ task: "a", id: 3 }] },
      '未知字段 "id"',
      "unknown field named",
    );
  });

  it("rejects an empty content string", async () => {
    await expectChinese(
      { op: "start", entries: [{ task: "   " }] },
      "task 不能是空字符串",
      "blank content rejected",
    );
  });

  it("rejects a non-string item inside a list", async () => {
    await expectChinese(
      { op: "init", entries: [{ items: ["ok", 7] }] },
      "items[2] 必须是非空字符串",
      "item index named",
    );
  });

  it("rejects a malformed init list entry", async () => {
    await expectChinese(
      { op: "init", entries: [{ list: [{ phase: "P" }] }] },
      "items 必须是字符串数组",
      "list entry shape enforced",
    );
  });

  it("rejects an init entry with neither list nor items", async () => {
    await expectChinese(
      { op: "init", entries: [{ phase: "P" }] },
      "init 需要提供 list 或 items",
      "init payload enforced",
    );
  });

  it("rejects a start entry with no task", async () => {
    await expectChinese(
      { op: "start", entries: [{}] },
      "start 需要提供 task",
      "start target enforced",
    );
  });

  it("rejects a block with no reason", async () => {
    await expectChinese(
      { op: "block", entries: [{ task: "a" }] },
      "block 需要提供 reason",
      "block reason enforced",
    );
  });

  it("rejects an unblock with no target", async () => {
    await expectChinese(
      { op: "unblock", entries: [{}] },
      "unblock 需要提供 task 或 tasks 或 phase",
      "unblock target enforced",
    );
  });

  it("rejects an append with no phase", async () => {
    await expectChinese(
      { op: "append", entries: [{ items: ["a"] }] },
      "append 需要提供 phase",
      "append phase enforced",
    );
  });

  it("names the offending entry by 1-based position", async () => {
    const tool = makeTool();
    await assert.rejects(
      () =>
        tool.execute(
          { op: "start", entries: [{ task: "fine" }, { task: 5 }] },
          TOOL_CTX,
          {},
        ),
      (err: unknown) => {
        assert.ok(
          String(err).includes("entries[2]"),
          `expected the 1-based index, got ${String(err)}`,
        );
        return true;
      },
    );
  });

  it("errors without a session id in the tool context", async () => {
    const tool = makeTool({ host: fakeHost(null) });
    await assert.rejects(
      () =>
        tool.execute({ op: "init", entries: [{ items: ["a"] }] }, TOOL_CTX, {}),
      /无法确定会话 ID：工具上下文缺少 sessionID。/,
    );
  });
});

// ---------------------------------------------------------------------------
// Per-op entry field restrictions
// ---------------------------------------------------------------------------

describe("todo tool per-op entry fields", () => {
  /** A field value of the right shape for whichever field is being probed. */
  const VALUE: Record<string, unknown> = {
    list: [{ phase: "P", items: ["a"] }],
    items: ["a", "b"],
    phase: "P",
    task: "a",
    tasks: ["a", "b"],
    reason: "waiting on user",
  };

  /**
   * Assert an op rejects an inapplicable field with a Chinese error naming
   * both the op and the offending field.
   */
  function expectFieldRejected(
    op: string,
    field: string,
    extra: Record<string, unknown> = {},
  ): void {
    assert.throws(
      () =>
        validateTodoArgs({
          op,
          entries: [{ [field]: VALUE[field], ...extra }],
        }),
      (err: unknown) => {
        const text = String(err);
        assert.ok(
          text.includes("todo 工具参数格式错误"),
          `${op}+${field}: expected the Chinese prefix, got ${text}`,
        );
        assert.ok(
          text.includes(`${op} 不接受的字段 "${field}"`),
          `${op}+${field}: expected the op and field to be named, got ${text}`,
        );
        return true;
      },
    );
  }

  it("rejects list/items/reason on done, drop and rm entries", () => {
    for (const op of ["done", "drop", "rm"]) {
      for (const field of ["list", "items", "reason"]) {
        expectFieldRejected(op, field);
      }
    }
  });

  it("rejects list and items on block and unblock entries", () => {
    for (const op of ["block", "unblock"]) {
      for (const field of ["list", "items"]) {
        expectFieldRejected(op, field, { reason: "waiting on user" });
      }
    }
  });

  it("rejects reason on unblock (block is the only reason consumer)", () => {
    expectFieldRejected("unblock", "reason", { task: "a" });
  });

  it("rejects everything but task on a start entry", () => {
    for (const field of ["list", "items", "phase", "tasks", "reason"]) {
      expectFieldRejected("start", field, { task: "a" });
    }
  });

  it("rejects task, tasks and reason on an append entry", () => {
    for (const field of ["task", "tasks", "reason"]) {
      expectFieldRejected("append", field, { phase: "P", items: ["a"] });
    }
  });

  it("rejects task, tasks and reason on an init entry", () => {
    for (const field of ["task", "tasks", "reason"]) {
      expectFieldRejected("init", field, { items: ["a"] });
    }
  });

  it("rejects an init entry carrying both list and items", () => {
    assert.throws(
      () =>
        validateTodoArgs({
          op: "init",
          entries: [{ list: [{ phase: "P", items: ["a"] }], items: ["b"] }],
        }),
      (err: unknown) => {
        const text = String(err);
        assert.ok(
          text.includes("todo 工具参数格式错误"),
          `expected the Chinese prefix, got ${text}`,
        );
        assert.ok(
          text.includes("不能同时带 list 和 items"),
          `expected the ambiguity to be named, got ${text}`,
        );
        return true;
      },
    );
  });

  it("points the items-on-a-target-op mistake at tasks and warns of the default", () => {
    assert.throws(
      () => validateTodoArgs({ op: "rm", entries: [{ items: ["a", "b"] }] }),
      /若目标是清单里的这些任务，请改用 tasks[\s\S]*不带目标的 rm 会作用于全部任务——即清空整个清单/,
    );
  });

  it("keeps every op's own payload combination accepted", () => {
    const accepted: Array<Record<string, unknown>> = [
      { op: "init", entries: [{ list: [{ phase: "P", items: ["a"] }] }] },
      { op: "init", entries: [{ items: ["a"] }] },
      { op: "init", entries: [{ items: ["a"], phase: "P" }] },
      { op: "start", entries: [{ task: "a" }] },
      { op: "done", entries: [{ task: "a" }] },
      { op: "done", entries: [{ tasks: ["a"] }] },
      { op: "done", entries: [{ phase: "P" }] },
      { op: "done", entries: [{}] },
      { op: "drop", entries: [{ tasks: ["a"] }] },
      { op: "drop", entries: [{}] },
      { op: "rm", entries: [{ phase: "P" }] },
      { op: "rm", entries: [{}] },
      {
        op: "block",
        entries: [{ task: "a", reason: "waiting on user" }],
      },
      { op: "block", entries: [{ tasks: ["a"], reason: "waiting" }] },
      { op: "block", entries: [{ phase: "P", reason: "waiting" }] },
      { op: "unblock", entries: [{ task: "a" }] },
      { op: "unblock", entries: [{ tasks: ["a"] }] },
      { op: "unblock", entries: [{ phase: "P" }] },
      { op: "append", entries: [{ phase: "P", items: ["a"] }] },
    ];
    for (const args of accepted) {
      assert.doesNotThrow(() => validateTodoArgs(args));
    }
  });

  it("blocks the destructive no-target rm behind a stray items field", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", entries: [{ items: ["Alpha", "Beta"] }] });
    const before = await state();

    const hostCtx: { details?: unknown } = {};
    await assert.rejects(
      () =>
        tool.execute(
          { op: "rm", entries: [{ items: ["Alpha", "Beta"] }] },
          TOOL_CTX,
          hostCtx,
        ),
      /rm 不接受的字段 "items"/,
    );
    assert.deepEqual(
      await state(),
      before,
      "a stray items field must never reach the 'every task' default",
    );
    assert.equal(
      hostCtx.details,
      undefined,
      "a rejected call records no snapshot",
    );
    // And the list is still fully intact for a correctly targeted rm later.
    const text = await run(tool, {
      op: "rm",
      entries: [{ tasks: ["Alpha", "Beta"] }],
    });
    assert.equal(text, "Todo list cleared.");
  });

  it("blocks a stray items field on done and drop the same way", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", entries: [{ items: ["Alpha", "Beta"] }] });
    for (const op of ["done", "drop"]) {
      await assert.rejects(
        () =>
          tool.execute(
            { op, entries: [{ items: ["Alpha", "Beta"] }] },
            TOOL_CTX,
            {},
          ),
        /不接受的字段 "items"/,
      );
      assert.match(
        await run(tool, { op: "view" }),
        /Alpha \[in_progress\]/,
        `${op}+items left the list untouched and un-statused`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Batch atomicity
// ---------------------------------------------------------------------------

describe("todo tool batch atomicity", () => {
  it("rolls the whole batch back when one entry is invalid", async () => {
    const tool = makeTool();
    await run(tool, {
      op: "init",
      entries: [{ items: ["Install dependencies", "Configure environment"] }],
    });
    const before = await state();

    const hostCtx: { details?: unknown } = {};
    const text = await tool.execute(
      {
        op: "done",
        entries: [{ task: "Install dependencies" }, { task: "Never existed" }],
      },
      TOOL_CTX,
      hostCtx,
    );

    assert.match(text, /^Errors: /);
    assert.match(text, /Never existed/);
    assert.deepEqual(
      await state(),
      before,
      "a refused batch must leave the stored state untouched",
    );
    assert.equal(
      hostCtx.details,
      undefined,
      "a refused batch must not write a snapshot",
    );
  });

  it("rolls back a state-changing entry that shares a batch with an error", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", entries: [{ items: ["Alpha", "Beta"] }] });
    const before = await state();

    const hostCtx: { details?: unknown } = {};
    const text = await tool.execute(
      { op: "done", entries: [{ task: "Alpha" }, { task: "Gamma" }] },
      TOOL_CTX,
      hostCtx,
    );
    assert.match(text, /^Errors: /);
    assert.equal(statusOf(await state(), "Alpha"), "in_progress");
    assert.deepEqual(await state(), before);
    assert.equal(hostCtx.details, undefined);
  });

  it("reports the errors while echoing the untouched remaining items", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", entries: [{ items: ["Alpha", "Beta"] }] });
    const text = await run(tool, {
      op: "done",
      entries: [{ task: "task-1" }],
    });
    assert.match(text, /Errors: .*task-1/);
    assert.match(text, /Alpha/);
    assert.match(text, /Beta/);
  });
});

// ---------------------------------------------------------------------------
// Snapshot details (transcript as the single source of truth)
// ---------------------------------------------------------------------------

describe("todo tool snapshot details", () => {
  it("writes a fresh { op, phases } snapshot after every successful mutating call", async () => {
    const tool = makeTool();
    const calls: Array<Record<string, unknown>> = [
      {
        op: "init",
        entries: [{ items: ["Install dependencies", "Run tests"] }],
      },
      { op: "start", entries: [{ task: "Run tests" }] },
      { op: "done", entries: [{ task: "Run tests" }] },
      {
        op: "block",
        entries: [{ task: "Install dependencies", reason: "registry offline" }],
      },
    ];

    for (const call of calls) {
      const hostCtx: { details?: unknown } = {};
      await tool.execute(call, TOOL_CTX, hostCtx);
      const details = hostCtx.details as TodoSnapshot;
      assert.equal(
        details.op,
        call.op,
        `snapshot op matches the call (${String(call.op)})`,
      );
      assert.ok(
        Array.isArray(details.phases),
        "snapshot carries a phases array",
      );
      assert.deepEqual(
        details.phases,
        await state(),
        "the snapshot equals the live state it was written from",
      );
    }
  });

  it("writes nothing for a read-only view", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", entries: [{ items: ["Only task"] }] });
    const hostCtx: { details?: unknown } = {};
    await tool.execute({ op: "view" }, TOOL_CTX, hostCtx);
    assert.equal(hostCtx.details, undefined, "view records no state change");
  });

  it("restores the live state from the newest transcript snapshot", async () => {
    const first = makeTool();
    await run(first, { op: "init", entries: [{ items: ["A", "B"] }] });
    await run(first, { op: "done", entries: [{ task: "A" }] });
    await run(first, {
      op: "append",
      entries: [{ phase: "Todos", items: ["C"] }],
    });

    // A fresh store instance has an empty cache, so its first read restores
    // from the newest-first candidates the host's scan supplies.
    const second = makeTool();
    const text = await run(second, { op: "view" });
    assert.match(text, /Overall: 1\/3 done/);
    assert.match(text, /B/);
    assert.match(text, /C/);
    const phases = await state();
    assert.equal(statusOf(phases, "A"), "completed");
    assert.equal(statusOf(phases, "B"), "in_progress");
    assert.equal(
      transcript.length,
      3,
      "only mutating calls produced snapshots",
    );
  });

  it("drops snapshots written by a host that builds no details slot", async () => {
    const tool = makeTool();
    const text = await tool.execute(
      { op: "init", entries: [{ items: ["No details host"] }] },
      TOOL_CTX,
    );
    assert.match(text, /No details host/);
    assert.equal(statusOf(await state(), "No details host"), "in_progress");
  });
});

// ---------------------------------------------------------------------------
// Registration gate
// ---------------------------------------------------------------------------

describe("todo tool unit descriptor", () => {
  it("has the tool kind and the todo name", () => {
    assert.equal(todoUnit.name, "todo");
    assert.equal(todoUnit.kind, "tool");
  });

  it("contributes zero tools when deps carry no todoStore", () => {
    const deps = {
      limits: {},
      contextConfig: {},
      client: {},
      directory: "",
      resolveAgent: () => undefined,
      toolHost: fakeHost(),
    } as unknown as Deps;
    assert.deepEqual(todoUnit.create(deps, {} as ActiveSet).tools, []);
  });

  it("contributes zero tools when deps carry no tool host", () => {
    const deps = {
      limits: {},
      contextConfig: {},
      client: {},
      directory: "",
      resolveAgent: () => undefined,
      todoStore: createTodoStore(async () => []),
    } as unknown as Deps;
    assert.deepEqual(todoUnit.create(deps, {} as ActiveSet).tools, []);
  });

  it("reads and writes through the injected store, never a fresh one", async () => {
    const store = createTodoStore(async () => []);
    const deps = {
      limits: {},
      contextConfig: {},
      client: {},
      directory: "",
      resolveAgent: () => undefined,
      toolHost: fakeHost(),
      todoStore: store,
    } as unknown as Deps;
    const tool = todoUnit.create(deps, {} as ActiveSet).tools[0];
    await tool.execute(
      { op: "init", entries: [{ items: ["Injected"] }] },
      TOOL_CTX,
      {},
    );
    assert.equal(
      statusOf(await store.get(TEST_SESSION_ID), "Injected"),
      "in_progress",
    );
  });

  it("runs one call at a time so concurrent calls cannot lose updates", () => {
    assert.equal(makeTool().executionMode, "sequential");
  });

  it("attaches host renderers only when the renderer port is supplied", () => {
    const renderCall = () => "card";
    const renderResult = () => "result";
    const deps = {
      limits: {},
      contextConfig: {},
      client: {},
      directory: "",
      resolveAgent: () => undefined,
      toolHost: fakeHost(),
      todoStore: createTodoStore(async () => []),
      todoRenderer: { renderCall, renderResult },
    } as unknown as Deps;
    const tool = todoUnit.create(deps, {} as ActiveSet).tools[0];
    assert.equal(tool.renderCall, renderCall);
    assert.equal(tool.renderResult, renderResult);

    const plain = makeTool();
    assert.equal(plain.renderCall, undefined);
    assert.equal(plain.renderResult, undefined);
  });

  it("carries the operation manual in its description", () => {
    const tool = makeTool();
    for (const op of [
      "init",
      "start",
      "done",
      "drop",
      "rm",
      "block",
      "unblock",
      "append",
      "view",
    ]) {
      assert.ok(
        tool.description.includes(op),
        `description documents the ${op} operation`,
      );
    }
    assert.match(tool.description, /<critical>/);
  });
});
