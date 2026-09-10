/**
 * Tests for the todo tool adapter.
 *
 * Covers: the nine-operation routing through one scripted session sequence
 * (each step asserting the echoed summary and the resulting store state), the
 * flat argument parsing (per-op field whitelist, missing/malformed payload,
 * empty contents, unknown fields), the
 * op-inference fallback for a missing `op`, the rule that every rejection
 * ends with a copy-ready example call, batch atomicity (a refused call leaves
 * the stored state untouched and writes no snapshot), the
 * transcript-truthfulness rule (every successful mutating call writes a fresh
 * `{ op, phases }` snapshot into `hostCtx.details`, a refused call and a
 * `view` write nothing), the restore loop through an injected store, the
 * missing-session-ID error, the renderer attachment seam, the fail-closed
 * registration gate (no `todoStore` / no `toolHost` → zero tools), and the
 * store gate that keeps concurrently dispatched calls from losing updates.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ToolHost } from "../core/client/tool-host.js";
import type { ActiveSet, Deps, ToolContribution } from "../core/slots.js";
import type { TodoSnapshot } from "../core/todo/serialize.js";
import { createTodoStore } from "../core/todo/store.js";
import type { TodoPhase } from "../core/todo/types.js";
import { _resetForTesting } from "../utils/logger.js";
import { parseTodoArgs, unit as todoUnit } from "./todo.js";

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

/** Run the parser, requiring a copy-ready example in every rejection. */
function expectRejection(args: unknown, fragment: string, label: string): void {
  assert.throws(
    () => parseTodoArgs(args),
    (err: unknown) => {
      const text = String(err);
      assert.ok(
        text.includes("todo 工具参数格式错误"),
        `${label}: expected the Chinese guidance prefix, got ${text}`,
      );
      assert.ok(
        text.includes(fragment),
        `${label}: expected "${fragment}" in ${text}`,
      );
      assert.ok(
        text.includes("正确示例："),
        `${label}: every rejection must end with an example, got ${text}`,
      );
      assert.match(
        text,
        /正确示例：\{.*"op"/,
        `${label}: the example must be a whole call, got ${text}`,
      );
      return true;
    },
  );
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
      list: [
        {
          phase: "Setup",
          items: ["Install dependencies", "Configure environment"],
        },
        { phase: "Ship", items: ["Write release notes"] },
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
      task: "Write release notes",
    });
    assert.match(startText, /Write release notes \[in_progress] \(Ship\)/);
    assert.match(startText, /Install dependencies \[pending] \(Setup\)/);

    // 3. done — completed work is counted, never echoed as remaining; the
    // next pending task is auto-promoted by normalization.
    const doneText = await run(tool, {
      op: "done",
      task: "Write release notes",
    });
    assert.match(doneText, /Overall: 1\/3 done/);
    assert.equal(statusOf(await state(), "Write release notes"), "completed");

    // 4. append — a new task lands in the named phase as pending.
    const appendText = await run(tool, {
      op: "append",
      phase: "Ship",
      items: ["Tag release"],
    });
    assert.match(appendText, /Tag release \[pending] \(Ship\)/);

    // 5. block — blocked work is counted separately and carries its reason.
    const blockText = await run(tool, {
      op: "block",
      task: "Tag release",
      reason: "waiting on user sign-off",
    });
    assert.match(blockText, /1 blocked/);
    assert.equal(statusOf(await state(), "Tag release"), "blocked");

    // 6. unblock — back to pending, blocker cleared.
    const unblockText = await run(tool, { op: "unblock", task: "Tag release" });
    assert.doesNotMatch(unblockText, /blocked/);
    assert.equal(statusOf(await state(), "Tag release"), "pending");

    // 7. drop — abandoned work counts as closed.
    const dropText = await run(tool, {
      op: "drop",
      task: "Configure environment",
    });
    assert.match(dropText, /Overall: 2\/4 done/);
    assert.equal(statusOf(await state(), "Configure environment"), "abandoned");

    // 8. rm — the task disappears from the list entirely.
    const rmText = await run(tool, { op: "rm", task: "Configure environment" });
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

  it("refuses a target-less done/drop/rm instead of hitting every task", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", items: ["One", "Two"] });
    for (const op of ["done", "drop", "rm"]) {
      await assert.rejects(
        () => tool.execute({ op }, TOOL_CTX, {}),
        op === "drop" ? /drop 缺少目标/ : /task 必须是字符串/,
      );
      assert.match(
        await run(tool, { op: "view" }),
        /One \[in_progress]/,
        `${op} without a task must leave the list intact`,
      );
    }
    // Clearing the list still works — one explicit rm per task.
    await run(tool, { op: "rm", task: "One" });
    await run(tool, { op: "rm", task: "Two" });
    assert.equal(await run(tool, { op: "view" }), "Todo list is empty.");
  });

  it("drops a whole phase and auto-promotes outside it", async () => {
    const tool = makeTool();
    await run(tool, {
      op: "init",
      list: [
        { phase: "P1", items: ["a", "b"] },
        { phase: "P2", items: ["c"] },
      ],
    });
    // init promotes the earliest pending: "a" is in_progress inside P1.
    const text = await run(tool, { op: "drop", phase: "P1" });
    const after = await state();
    assert.equal(statusOf(after, "a"), "abandoned");
    assert.equal(statusOf(after, "b"), "abandoned");
    // Every task of the dropped phase is abandoned, so the promotion can
    // only land on the next pending outside it.
    assert.equal(statusOf(after, "c"), "in_progress");
    assert.match(text, /Overall: 2\/3 done, 1 open/);
  });

  it("echoes the empty-list variant for a read-only view", async () => {
    const tool = makeTool();
    assert.equal(await run(tool, { op: "view" }), "Todo list is empty.");
  });

  it("replaces the whole list on a repeated init", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", items: ["Old task"] });
    const text = await run(tool, {
      op: "init",
      items: ["Fresh plan"],
      phase: "Redo",
    });
    assert.doesNotMatch(text, /Old task/);
    assert.match(text, /Fresh plan \[in_progress] \(Redo\)/);
  });
});

// ---------------------------------------------------------------------------
// Loud Chinese argument validation (every rejection carries an example)
// ---------------------------------------------------------------------------

describe("todo tool argument validation", () => {
  it("rejects an unknown op, naming the vocabulary", () => {
    expectRejection(
      { op: "frobnicate", task: "a" },
      "op 必须是 init/start/done/drop/rm/block/unblock/append/view 之一",
      "unknown op",
    );
  });

  it("rejects non-object arguments", () => {
    expectRejection("init", "参数必须是扁平对象", "scalar args");
    expectRejection(null, "参数必须是扁平对象", "null args");
  });

  it("rejects a done whose task is missing, empty, or not a string", () => {
    expectRejection({ op: "done" }, "task 必须是字符串", "missing task");
    expectRejection(
      { op: "done", task: "   " },
      "不能是空字符串",
      "blank task",
    );
    expectRejection(
      { op: "done", task: 5 },
      "task 必须是字符串",
      "number task",
    );
  });

  it("rejects an init with neither list nor items", () => {
    expectRejection(
      { op: "init", phase: "P" },
      "init 缺少清单：需要 list",
      "init payload",
    );
  });

  it("rejects an init carrying both payloads", () => {
    expectRejection(
      { op: "init", list: [{ phase: "P", items: ["a"] }], items: ["b"] },
      "不能同时带 list 和 items",
      "init ambiguity",
    );
  });

  it("rejects an empty init list and a malformed list entry", () => {
    expectRejection(
      { op: "init", list: [] },
      "list 不能是空数组",
      "empty list",
    );
    expectRejection(
      { op: "init", list: [{ phase: "P" }] },
      "items 必须是字符串数组",
      "list entry shape",
    );
    expectRejection(
      { op: "init", list: ["P"] },
      "list[1] 必须是",
      "list entry must be an object",
    );
  });

  it("names the offending item index inside a string array", () => {
    expectRejection(
      { op: "init", items: ["ok", 7] },
      "items[2] 必须是非空字符串",
      "item index",
    );
    expectRejection(
      { op: "append", phase: "P", items: [] },
      "items 不能是空数组",
      "empty items",
    );
  });

  it("rejects an unknown top-level field", () => {
    expectRejection(
      { op: "start", task: "a", id: 3 },
      '未知字段 "id"',
      "unknown field",
    );
  });

  it("rejects a legacy entries field as an unknown field", () => {
    expectRejection(
      { op: "done", entries: [{ task: "a" }] },
      '含未知字段 "entries"：done 只接受 task',
      "legacy envelope",
    );
  });

  it("rejects a legacy tasks field as an unknown field", () => {
    for (const op of ["done", "drop", "rm"]) {
      expectRejection(
        { op, tasks: ["a", "b"] },
        `含未知字段 "tasks"：${op} 只接受 task`,
        `${op} legacy tasks field`,
      );
    }
  });

  it("rejects an init whose phased list also carries a top-level phase", () => {
    expectRejection(
      { op: "init", list: [{ phase: "P", items: ["a"] }], phase: "Q" },
      "init 带 list 时不能带 phase",
      "init list + phase",
    );
    // The same refusal applies to the inferred (op-less) shape.
    expectRejection(
      { list: [{ phase: "P", items: ["a"] }], phase: "Q" },
      "init 带 list 时不能带 phase",
      "inferred init list + phase",
    );
  });

  it("rejects a block with no reason and one with no target", () => {
    expectRejection(
      { op: "block", task: "a" },
      "reason 必须是字符串",
      "block reason",
    );
    expectRejection(
      { op: "block", reason: "waiting" },
      "block 缺少目标",
      "block target",
    );
    expectRejection(
      { op: "block", task: "a", phase: "P", reason: "waiting" },
      "不能同时给 task 和 phase",
      "block ambiguity",
    );
  });

  it("rejects an unblock with no target", () => {
    expectRejection({ op: "unblock" }, "unblock 缺少目标", "unblock target");
  });

  it("rejects a drop with no target or with both task and phase", () => {
    expectRejection({ op: "drop" }, "drop 缺少目标", "drop target");
    expectRejection(
      { op: "drop", task: "a", phase: "P" },
      "drop 的目标不能同时给 task 和 phase",
      "drop ambiguity",
    );
  });

  it("rejects an append with no phase and one with no items", () => {
    expectRejection(
      { op: "append", items: ["a"] },
      "phase 必须是字符串",
      "append phase",
    );
    expectRejection(
      { op: "append", phase: "P" },
      "items 必须是字符串",
      "append items",
    );
  });

  it("rejects any payload on the read-only view op", () => {
    expectRejection(
      { op: "view", task: "a" },
      'view 不接受的字段 "task"',
      "view payload",
    );
    expectRejection(
      { op: "view", items: ["a"] },
      "view 是只读操作，不带任何字段",
      "view items",
    );
    // The bare call is the only legal one.
    assert.deepEqual(parseTodoArgs({ op: "view" }), [{ op: "view" }]);
  });

  it("errors without a session id in the tool context", async () => {
    const tool = makeTool({ host: fakeHost(null) });
    await assert.rejects(
      () => tool.execute({ op: "init", items: ["a"] }, TOOL_CTX, {}),
      /无法确定会话 ID：工具上下文缺少 sessionID。/,
    );
  });
});

// ---------------------------------------------------------------------------
// Op inference for a missing op
// ---------------------------------------------------------------------------

describe("todo tool op inference", () => {
  it("infers init from a list", () => {
    assert.deepEqual(
      parseTodoArgs({
        list: [{ phase: "P", items: ["a"] }],
      }),
      [{ op: "init", list: [{ phase: "P", items: ["a"] }] }],
    );
  });

  it("infers init from bare items and append from items + phase", () => {
    assert.deepEqual(parseTodoArgs({ items: ["a", "b"] }), [
      { op: "init", items: ["a", "b"] },
    ]);
    assert.deepEqual(parseTodoArgs({ items: ["a"], phase: "P" }), [
      { op: "append", phase: "P", items: ["a"] },
    ]);
  });

  it("refuses to guess when the shape is ambiguous", () => {
    expectRejection({ task: "a" }, "缺少 op", "task alone");
    expectRejection({ phase: "P" }, "缺少 op", "phase alone");
    expectRejection({}, "缺少 op", "empty args");
    expectRejection({ reason: "waiting" }, "缺少 op", "reason alone");
  });

  it("never overrides an explicit op", () => {
    // items + phase would infer append, but an explicit init wins.
    assert.deepEqual(parseTodoArgs({ op: "init", items: ["a"], phase: "P" }), [
      { op: "init", items: ["a"], phase: "P" },
    ]);
    // An explicit append keeps its meaning even where init would also fit.
    assert.deepEqual(
      parseTodoArgs({ op: "append", phase: "P", items: ["a"] }),
      [{ op: "append", phase: "P", items: ["a"] }],
    );
  });
});

// ---------------------------------------------------------------------------
// Per-op field whitelist
// ---------------------------------------------------------------------------

describe("todo tool per-op fields", () => {
  /**
   * Assert an op rejects an inapplicable field, naming op + field + example.
   */
  function expectFieldRejected(
    op: string,
    field: string,
    extra: Record<string, unknown> = {},
  ): void {
    expectRejection(
      { op, [field]: sampleValue(field), ...extra },
      `${op} 不接受的字段 "${field}"`,
      `${op}+${field}`,
    );
  }

  /** A field value of the right shape for whichever field is being probed. */
  function sampleValue(field: string): unknown {
    switch (field) {
      case "list":
        return [{ phase: "P", items: ["a"] }];
      case "items":
        return ["a", "b"];
      case "phase":
        return "P";
      case "task":
        return "a";
      case "reason":
        return "waiting on user";
      default:
        return "x";
    }
  }

  it("rejects list/items/reason/phase on done and rm, list/items/reason on drop", () => {
    for (const op of ["done", "rm"]) {
      for (const field of ["list", "items", "reason", "phase"]) {
        expectFieldRejected(op, field, { task: "a" });
      }
    }
    for (const field of ["list", "items", "reason"]) {
      expectFieldRejected("drop", field, { task: "a" });
    }
  });

  it("rejects list/items/reason on start", () => {
    for (const field of ["list", "items", "reason"]) {
      expectFieldRejected("start", field, { task: "a" });
    }
  });

  it("rejects list/items on block and unblock, reason on unblock", () => {
    expectFieldRejected("block", "items", { task: "a", reason: "waiting" });
    expectFieldRejected("block", "list", { task: "a", reason: "waiting" });
    expectFieldRejected("unblock", "items", { task: "a" });
    expectFieldRejected("unblock", "list", { task: "a" });
    expectFieldRejected("unblock", "reason", { task: "a" });
  });

  it("rejects task/reason on append and init, reason/list-or-items as needed", () => {
    for (const field of ["task", "reason"]) {
      expectFieldRejected("append", field, { phase: "P", items: ["a"] });
      expectFieldRejected("init", field, { items: ["a"] });
    }
    expectFieldRejected("init", "reason", {
      list: [{ phase: "P", items: ["a"] }],
    });
  });

  it("keeps every op's own accepted combination", () => {
    const accepted: unknown[] = [
      { op: "init", list: [{ phase: "P", items: ["a"] }] },
      { op: "init", items: ["a"] },
      { op: "init", items: ["a"], phase: "P" },
      { op: "start", task: "a" },
      { op: "done", task: "a" },
      { op: "drop", task: "a" },
      { op: "drop", phase: "P" },
      { op: "rm", task: "a" },
      { op: "block", task: "a", reason: "waiting" },
      { op: "block", phase: "P", reason: "waiting" },
      { op: "unblock", task: "a" },
      { op: "unblock", phase: "P" },
      { op: "append", phase: "P", items: ["a"] },
      { op: "view" },
    ];
    for (const args of accepted) {
      assert.doesNotThrow(() => parseTodoArgs(args), JSON.stringify(args));
    }
  });

  it("parses into a single-entry batch stamped with the op", () => {
    const entries = parseTodoArgs({ op: "done", task: "a" });
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { op: "done", task: "a" });
    assert.deepEqual(parseTodoArgs({ op: "view" }), [{ op: "view" }]);
  });

  it("blocks the destructive no-target rm behind a stray items field", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", items: ["Alpha", "Beta"] });
    const before = await state();

    const hostCtx: { details?: unknown } = {};
    await assert.rejects(
      () =>
        tool.execute({ op: "rm", items: ["Alpha", "Beta"] }, TOOL_CTX, hostCtx),
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
    await run(tool, { op: "rm", task: "Alpha" });
    const text = await run(tool, { op: "rm", task: "Beta" });
    assert.equal(text, "Todo list cleared.");
  });
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

describe("todo tool atomicity", () => {
  it("leaves the stored state untouched when the core rejects the call", async () => {
    const tool = makeTool();
    await run(tool, {
      op: "init",
      items: ["Install dependencies", "Configure environment"],
    });
    const before = await state();

    const hostCtx: { details?: unknown } = {};
    const text = await tool.execute(
      { op: "done", task: "Never existed" },
      TOOL_CTX,
      hostCtx,
    );

    assert.match(text, /^Errors: /);
    assert.match(text, /Never existed/);
    assert.deepEqual(
      await state(),
      before,
      "a refused call must leave the stored state untouched",
    );
    assert.equal(
      hostCtx.details,
      undefined,
      "a refused call must not write a snapshot",
    );
  });

  it("keeps a later duplicate-content append from half-applying", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", items: ["Alpha", "Beta"] });
    const before = await state();

    // An append of an existing content is reported, not applied.
    const text = await run(tool, {
      op: "append",
      phase: "P",
      items: ["Alpha"],
    });
    assert.match(text, /^Errors: /);
    assert.match(text, /already exists/);
    assert.deepEqual(await state(), before);
  });

  it("reports the errors while echoing the untouched remaining items", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", items: ["Alpha", "Beta"] });
    const text = await run(tool, { op: "done", task: "task-1" });
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
      { op: "init", items: ["Install dependencies", "Run tests"] },
      { op: "start", task: "Run tests" },
      { op: "done", task: "Run tests" },
      { op: "block", task: "Install dependencies", reason: "registry offline" },
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
    await run(tool, { op: "init", items: ["Only task"] });
    const hostCtx: { details?: unknown } = {};
    await tool.execute({ op: "view" }, TOOL_CTX, hostCtx);
    assert.equal(hostCtx.details, undefined, "view records no state change");
  });

  it("restores the live state from the newest transcript snapshot", async () => {
    const first = makeTool();
    await run(first, { op: "init", items: ["A", "B"] });
    await run(first, { op: "done", task: "A" });
    await run(first, { op: "append", phase: "Todos", items: ["C"] });

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
      { op: "init", items: ["No details host"] },
      TOOL_CTX,
    );
    assert.match(text, /No details host/);
    assert.equal(statusOf(await state(), "No details host"), "in_progress");
  });
});

// ---------------------------------------------------------------------------
// Registration gate
// ---------------------------------------------------------------------------

describe("todo tool concurrency", () => {
  /** Read a task status out of a snapshot written by a mutating call. */
  function snapshotStatus(
    details: unknown,
    content: string,
  ): string | undefined {
    return statusOf((details as TodoSnapshot).phases, content);
  }

  it("loses no update when two mutations are dispatched together", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", items: ["Alpha", "Beta"] });

    const ctxAlpha: { details?: unknown } = {};
    const ctxBeta: { details?: unknown } = {};
    const [textAlpha, textBeta] = await Promise.all([
      tool.execute({ op: "done", task: "Alpha" }, TOOL_CTX, ctxAlpha),
      tool.execute({ op: "done", task: "Beta" }, TOOL_CTX, ctxBeta),
    ]);
    // No lost update, and a total order: the call submitted first saw the
    // base state (one of two done), the second read the first one's write.
    assert.match(textAlpha, /Overall: 1\/2 done/);
    assert.match(textBeta, /Overall: 2\/2 done/);
    const final = await state();
    assert.equal(statusOf(final, "Alpha"), "completed");
    assert.equal(statusOf(final, "Beta"), "completed");

    // And the two snapshots are explainable as a total order: exactly one
    // of them still saw the base state, the other read the first call's
    // write. Two snapshots off the same base would mean an unlocked
    // read-modify-write.
    const both = (details: unknown) =>
      snapshotStatus(details, "Alpha") === "completed" &&
      snapshotStatus(details, "Beta") === "completed";
    assert.notEqual(
      both(ctxAlpha.details),
      both(ctxBeta.details),
      "the second call must observe the first call's write",
    );
  });

  it("applies every one of many concurrent mutating calls", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", items: ["T1", "T2", "T3", "T4"] });

    const calls = [
      { op: "done", task: "T1" },
      { op: "drop", task: "T2" },
      { op: "append", items: ["T5"], phase: "Todos" },
      { op: "rm", task: "T3" },
      { op: "block", task: "T4", reason: "waiting on the registry" },
    ];
    const texts = await Promise.all(
      calls.map((call) => tool.execute(call, TOOL_CTX, {})),
    );

    const final = await state();
    const contents = final.flatMap((phase) =>
      phase.tasks.map((task) => task.content),
    );
    assert.equal(texts.length, calls.length, "every call produced a summary");
    assert.ok(contents.includes("T5"), "the appended task survived");
    assert.ok(!contents.includes("T3"), "the removed task stayed gone");
    assert.equal(statusOf(final, "T1"), "completed", "the completion survived");
    assert.equal(
      statusOf(final, "T2"),
      "abandoned",
      "the abandonment survived",
    );
    assert.equal(statusOf(final, "T4"), "blocked", "the block survived");
  });

  it("still reports a failed call to its own caller only", async () => {
    const tool = makeTool();
    await run(tool, { op: "init", items: ["Alpha"] });

    const outcomes = await Promise.allSettled([
      tool.execute({ op: "done", task: "Ghost" }, TOOL_CTX, {}),
      tool.execute({ op: "done", task: "Alpha" }, TOOL_CTX, {}),
    ]);

    // A refused operation is a summary with errors, not a rejection; the
    // point is that the following call still ran and still took effect.
    assert.equal(outcomes[0].status, "fulfilled");
    assert.equal(outcomes[1].status, "fulfilled");
    assert.match(
      (outcomes[0] as PromiseFulfilledResult<string>).value,
      /Ghost|错误|不存在/,
    );
    assert.equal(statusOf(await state(), "Alpha"), "completed");
  });

  it("never queues behind another session's store", async () => {
    // Two tools over two stores are independent gates: the sequencer is
    // per store, matching the state it protects.
    const first = createTodoStore(async () => []);
    const second = createTodoStore(async () => []);
    const depsFor = (store: ReturnType<typeof createTodoStore>) =>
      ({
        limits: {},
        contextConfig: {},
        client: {},
        directory: "",
        resolveAgent: () => undefined,
        toolHost: fakeHost(),
        todoStore: store,
      }) as unknown as Deps;
    const toolA = todoUnit.create(depsFor(first), {} as ActiveSet).tools[0];
    const toolB = todoUnit.create(depsFor(second), {} as ActiveSet).tools[0];

    await Promise.all([
      toolA.execute({ op: "init", items: ["A only"] }, TOOL_CTX, {}),
      toolB.execute({ op: "init", items: ["B only"] }, TOOL_CTX, {}),
    ]);

    assert.deepEqual(
      (await first.get(TEST_SESSION_ID)).flatMap((p) =>
        p.tasks.map((t) => t.content),
      ),
      ["A only"],
    );
    assert.deepEqual(
      (await second.get(TEST_SESSION_ID)).flatMap((p) =>
        p.tasks.map((t) => t.content),
      ),
      ["B only"],
    );
  });
});

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
    await tool.execute({ op: "init", items: ["Injected"] }, TOOL_CTX, {});
    assert.equal(
      statusOf(await store.get(TEST_SESSION_ID), "Injected"),
      "in_progress",
    );
  });

  it("exposes a flat argument schema with every field optional", () => {
    const tool = makeTool();
    // All fields optional at schema level: the runtime parser owns the
    // per-op requirements so its shape inference and example-carrying
    // errors stay reachable.
    assert.deepEqual(tool.required, []);
    assert.deepEqual(Object.keys(tool.args ?? {}).sort(), [
      "items",
      "list",
      "op",
      "phase",
      "reason",
      "task",
    ]);
    assert.equal(tool.args?.entries, undefined);
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

  it("carries the operation manual and one example per op in its description", () => {
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
      assert.ok(
        tool.description.includes(`"op":"${op}"`),
        `description shows a copy-ready ${op} call`,
      );
    }
    assert.doesNotMatch(tool.description, /entries/);
  });
});
