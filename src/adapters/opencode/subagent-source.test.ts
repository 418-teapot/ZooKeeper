/**
 * Tests for the OpenCode subagent fact source (`subagent-source.ts`).
 *
 * The source is the translator between host facts and the core run
 * registry, so every assertion is made through the registry — the single
 * source of truth — rather than through the translator's interior.
 *
 * Boundary: `createSubagentSource(...)` and the pure extraction helpers it
 * re-exports.  The panel view is not involved: it only re-reads the
 * registry.
 *
 * Live events, the historical reconcile scan, and the token poll are all
 * driven through the injected host slices (a fake client and a fake state)
 * so the tests exercise the same translation paths production uses.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  getRun,
  resetRegistry,
  startRun,
  topLevelRuns,
} from "../../core/subagent/registry.js";
import {
  createSubagentSource,
  extractAgent,
  extractContextTokens,
  extractModel,
  extractTimes,
  extractTitle,
  type SubagentSource,
  type SubagentSourceDeps,
} from "./subagent-source.js";

const PARENT = "ses-parent";

// bun shares one isolate across every test file, so the module-level
// registry (and any poll timer a source left behind) must be reset between
// tests to keep every assertion deterministic.
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  resetRegistry();
});

/** Resolve after `ms` — the poll interval is real time, so tests wait. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The session-messages client slice the source reads tokens through. */
interface FakeClient {
  /** Every `session.messages` call, in order. */
  calls: Array<{ sessionID: string; limit?: number }>;
  /** The v1 client slice the source consumes. */
  session: {
    messages(options: { sessionID: string; limit?: number }): Promise<unknown>;
  };
}

/**
 * Build a fake client whose token reads yield `reads` in order (the last
 * value repeating) — `[]` when no read is configured.
 */
function fakeClient(
  reads: Array<number | undefined> = [],
  options: { fail?: boolean; delayMs?: number } = {},
): FakeClient {
  const pending = [...reads];
  const client: FakeClient = {
    calls: [],
    session: {
      messages: async (call) => {
        client.calls.push(call);
        if (options.delayMs !== undefined) await wait(options.delayMs);
        if (options.fail) throw new Error("client unavailable");
        const tokens = pending.length > 1 ? pending.shift() : pending[0];
        if (tokens === undefined) return [];
        return [
          {
            info: {
              role: "assistant",
              tokens: { input: tokens, cache: { read: 0 } },
            },
          },
        ];
      },
    },
  };
  return client;
}

/**
 * Build a fake state slice whose `session.get` reports the given parent
 * links (an unknown id yields nothing, like an unsynced session).
 */
function fakeState(parentOf: Record<string, string | undefined> = {}): unknown {
  return {
    session: {
      get: (id: string) =>
        id in parentOf ? { id, parentID: parentOf[id] } : undefined,
    },
  };
}

/** Build a source wired to fakes; its dispose runs after each test. */
function makeSource(
  overrides: Partial<SubagentSourceDeps> & {
    history?: unknown[];
    onHistoryRead?: (sessionId: string) => void;
  } = {},
): SubagentSource {
  const history = overrides.history ?? [];
  const source = createSubagentSource({
    client: (overrides.client ?? fakeClient()) as SubagentSourceDeps["client"],
    state: overrides.state ?? fakeState(),
    parentSessionId: overrides.parentSessionId ?? PARENT,
    fetchSessionMessages: async (sessionId) => {
      overrides.onHistoryRead?.(sessionId);
      return history;
    },
  });
  disposers.push(() => source.dispose());
  return source;
}

/** Wrap a task tool part in the host event envelope. */
function partEvent(
  sessionID: string,
  part: Record<string, unknown>,
): { properties?: Record<string, unknown> } {
  return { properties: { sessionID, part } };
}

/** Build a task tool part with the given state. */
function taskPart(
  id: string,
  state: Record<string, unknown>,
): Record<string, unknown> {
  return { type: "tool", tool: "task", id, state };
}

// ---------------------------------------------------------------------------
// Live part events → registry runs
// ---------------------------------------------------------------------------

describe("subagent source — live part translation", () => {
  it("registers a running task part as a running run", () => {
    const source = makeSource();
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", {
          status: "running",
          input: { subagent_type: "lynx" },
          time: { start: 100 },
        }),
      ),
    );

    const runs = topLevelRuns(PARENT);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.id, "part_1");
    assert.equal(runs[0]?.status, "running");
    assert.equal(runs[0]?.agent, "lynx");
    assert.equal(runs[0]?.parentSession, PARENT);
    assert.equal(runs[0]?.startedAt, 100);
    assert.equal(runs[0]?.endedAt, undefined);
  });

  it("falls back to 'task' when the part carries no subagent type", () => {
    const source = makeSource();
    source.onToolPartUpdated(
      partEvent(PARENT, taskPart("part_1", { status: "running" })),
    );
    assert.equal(getRun("part_1")?.agent, "task");
  });

  it("maps a completed part to done with the host's end time", () => {
    const source = makeSource();
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", {
          status: "completed",
          input: { subagent_type: "beaver" },
          time: { start: 100, end: 900 },
        }),
      ),
    );

    const run = getRun("part_1");
    assert.equal(run?.status, "done");
    assert.equal(run?.startedAt, 100);
    assert.equal(run?.endedAt, 900);
    assert.equal(run?.error, undefined);
  });

  it("maps a real error to the error status with its message", () => {
    const source = makeSource();
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", {
          status: "error",
          error: "model overloaded",
          input: { subagent_type: "beaver" },
        }),
      ),
    );

    const run = getRun("part_1");
    assert.equal(run?.status, "error");
    assert.equal(run?.error, "model overloaded");
  });

  it("maps an interrupted error to aborted (cancellation is not a failure)", () => {
    const source = makeSource();
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", {
          status: "error",
          error: "tool killed",
          metadata: { interrupted: true },
        }),
      ),
    );

    const run = getRun("part_1");
    assert.equal(run?.status, "aborted");
    assert.equal(run?.error, undefined, "a cancellation carries no error text");
  });

  it("maps the host's abort message to aborted", () => {
    const source = makeSource();
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", {
          status: "error",
          error: "Tool execution aborted",
        }),
      ),
    );

    assert.equal(getRun("part_1")?.status, "aborted");
    assert.equal(getRun("part_1")?.error, undefined);
  });

  it("ignores part events of another session", () => {
    const source = makeSource();
    source.onToolPartUpdated(
      partEvent("ses-other", taskPart("part_1", { status: "running" })),
    );
    assert.deepEqual(topLevelRuns(PARENT), []);
    assert.equal(getRun("part_1"), undefined);
  });

  it("ignores non-task tools and non-tool parts", () => {
    const source = makeSource();
    source.onToolPartUpdated(
      partEvent(PARENT, { type: "tool", tool: "bash", id: "part_b" }),
    );
    source.onToolPartUpdated(
      partEvent(PARENT, { type: "text", id: "part_t", text: "hi" }),
    );
    assert.deepEqual(topLevelRuns(PARENT), []);
  });

  it("ignores parts without an id or without a state", () => {
    const source = makeSource();
    source.onToolPartUpdated(
      partEvent(PARENT, { type: "tool", tool: "task", state: {} }),
    );
    source.onToolPartUpdated(
      partEvent(PARENT, { type: "tool", tool: "task", id: "part_1" }),
    );
    assert.deepEqual(topLevelRuns(PARENT), []);
  });

  it("does not register a pending part (nothing has started yet)", () => {
    const source = makeSource();
    source.onToolPartUpdated(
      partEvent(PARENT, taskPart("part_1", { status: "pending" })),
    );
    assert.equal(getRun("part_1"), undefined);
  });

  it("keeps one run per part across repeated events", () => {
    const source = makeSource();
    for (const status of ["running", "running", "completed"]) {
      source.onToolPartUpdated(
        partEvent(PARENT, taskPart("part_1", { status })),
      );
    }
    assert.equal(topLevelRuns(PARENT).length, 1);
    assert.equal(getRun("part_1")?.status, "done");
  });
});

// ---------------------------------------------------------------------------
// Label enrichment and terminal absorption
// ---------------------------------------------------------------------------

describe("subagent source — label enrichment", () => {
  /** Send a running part fact for `partId` with the given tool state. */
  function send(
    source: SubagentSource,
    partId: string,
    state: Record<string, unknown>,
  ): void {
    source.onToolPartUpdated(
      partEvent(PARENT, taskPart(partId, { status: "running", ...state })),
    );
  }

  it("upgrades the label as stronger title sources appear", () => {
    const source = makeSource();
    const partId = "abcdef123456";

    send(source, partId, {});
    assert.equal(getRun(partId)?.label, "abcdef12", "part id is the fallback");

    send(source, partId, { input: { prompt: "把 tracker 的职责并入核心" } });
    assert.equal(getRun(partId)?.label, "把 tracker 的职责并入核心");

    send(source, partId, {
      input: {
        description: "单源化子代理状态",
        prompt: "把 tracker 的职责并入核心",
      },
    });
    assert.equal(getRun(partId)?.label, "单源化子代理状态");

    send(source, partId, {
      title: "宿主标题",
      input: { description: "单源化子代理状态" },
    });
    assert.equal(getRun(partId)?.label, "宿主标题");
  });

  it("never downgrades the label to a weaker title source", () => {
    const source = makeSource();
    const partId = "part_1";

    send(source, partId, { title: "宿主标题", input: { prompt: "提示词" } });
    assert.equal(getRun(partId)?.label, "宿主标题");

    // A later part update that carries only the prompt must not regress it.
    send(source, partId, { input: { prompt: "提示词" } });
    assert.equal(getRun(partId)?.label, "宿主标题");
  });

  it("does not replace the label from the same source level", () => {
    const source = makeSource();
    const partId = "part_1";

    send(source, partId, { input: { prompt: "最初的提示词" } });
    send(source, partId, { input: { prompt: "改写后的提示词" } });
    assert.equal(getRun("part_1")?.label, "最初的提示词");
  });

  it("keeps the label frozen once the run finished", () => {
    const source = makeSource();
    const partId = "part_1";
    send(source, partId, { title: "宿主标题" });
    source.onToolPartUpdated(
      partEvent(PARENT, taskPart(partId, { status: "completed" })),
    );
    send(source, partId, { title: "更晚的标题", input: {} });
    assert.equal(getRun(partId)?.label, "宿主标题");
  });
});

describe("subagent source — monotone enrichment", () => {
  it("records the child session, model and end time reported later", async () => {
    const source = makeSource();
    const partId = "part_1";
    source.onToolPartUpdated(
      partEvent(PARENT, taskPart(partId, { status: "running" })),
    );
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart(partId, {
          status: "completed",
          time: { start: 100, end: 700 },
          metadata: { session_id: "ses-child", model: { modelID: "dummy" } },
        }),
      ),
    );

    // The terminal write waits for the final token read, so the run closes a
    // tick after the part event.
    await wait(10);
    const run = getRun(partId);
    assert.equal(run?.status, "done");
    assert.equal(run?.childSession, "ses-child");
    assert.equal(run?.model, "dummy");
    assert.equal(run?.endedAt, 700);
  });

  it("absorbs a late running event after the run finished", () => {
    const source = makeSource();
    const partId = "part_1";
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart(partId, {
          status: "completed",
          time: { start: 100, end: 700 },
          input: { description: "已完成" },
        }),
      ),
    );
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart(partId, { status: "running", input: { description: "迟到" } }),
      ),
    );

    const run = getRun(partId);
    assert.equal(run?.status, "done");
    assert.equal(run?.label, "已完成");
    assert.equal(run?.endedAt, 700);
  });

  it("keeps the first terminal outcome when a second one arrives", () => {
    const source = makeSource();
    const partId = "part_1";
    source.onToolPartUpdated(
      partEvent(PARENT, taskPart(partId, { status: "completed" })),
    );
    source.onToolPartUpdated(
      partEvent(PARENT, taskPart(partId, { status: "error", error: "later" })),
    );

    const run = getRun(partId);
    assert.equal(run?.status, "done");
    assert.equal(run?.error, undefined);
  });
});

// ---------------------------------------------------------------------------
// Token polling and finalization
// ---------------------------------------------------------------------------

describe("subagent source — token poll", () => {
  /** A running part whose child session is `childSession`. */
  function childPart(
    partId: string,
    childSession: string,
    state: Record<string, unknown> = {},
  ): { properties?: Record<string, unknown> } {
    return partEvent(
      PARENT,
      taskPart(partId, {
        status: "running",
        metadata: { session_id: childSession },
        ...state,
      }),
    );
  }

  it("writes the child session's context length while the run runs", async () => {
    const client = fakeClient([1200, 2400]);
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: fakeState({ "ses-child": PARENT }),
    });
    source.onToolPartUpdated(childPart("part_1", "ses-child"));

    await wait(620);
    assert.equal(getRun("part_1")?.tokens, 1200);

    await wait(620);
    assert.equal(getRun("part_1")?.tokens, 2400);
    assert.deepEqual(client.calls[0], { sessionID: "ses-child", limit: 20 });
  });

  it("reads the final context length before the run freezes", async () => {
    const client = fakeClient([500, 999]);
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: fakeState({ "ses-child": PARENT }),
    });
    source.onToolPartUpdated(childPart("part_1", "ses-child"));
    await wait(620);
    assert.equal(getRun("part_1")?.tokens, 500);

    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", {
          status: "completed",
          time: { start: 100, end: 700 },
          metadata: { session_id: "ses-child" },
        }),
      ),
    );
    await wait(20);

    const run = getRun("part_1");
    assert.equal(run?.status, "done");
    assert.equal(run?.endedAt, 700);
    assert.equal(run?.tokens, 999, "the final read is authoritative");
  });

  it("still finishes the run when the final read fails", async () => {
    const client = fakeClient([], { fail: true });
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: fakeState({ "ses-child": PARENT }),
    });
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", {
          status: "completed",
          metadata: { session_id: "ses-child" },
        }),
      ),
    );
    await wait(20);

    const run = getRun("part_1");
    assert.equal(run?.status, "done");
    assert.equal(run?.tokens, undefined);
  });

  it("keeps the run running when the poll's token read fails", async () => {
    const source = makeSource({
      client: fakeClient([], { fail: true }) as SubagentSourceDeps["client"],
      state: fakeState({ "ses-child": PARENT }),
    });
    source.onToolPartUpdated(childPart("part_1", "ses-child"));
    await wait(620);

    assert.equal(getRun("part_1")?.status, "running");
    assert.equal(getRun("part_1")?.tokens, undefined);
  });

  it("stops polling a session that is not a child of the panel session", async () => {
    const client = fakeClient([1200]);
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: fakeState({ "ses-child": "ses-other" }),
    });
    source.onToolPartUpdated(childPart("part_1", "ses-child"));
    await wait(620);

    assert.equal(client.calls.length, 0);
    assert.equal(getRun("part_1")?.status, "running");
  });

  it("skips a round while the child session is unknown to the state slice", async () => {
    const client = fakeClient([1200]);
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: fakeState(),
    });
    source.onToolPartUpdated(childPart("part_1", "ses-child"));
    await wait(620);

    assert.equal(client.calls.length, 0);
  });

  it("skips a round while a token read is still in flight", async () => {
    const client = fakeClient([1200], { delayMs: 700 });
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: fakeState({ "ses-child": PARENT }),
    });
    source.onToolPartUpdated(childPart("part_1", "ses-child"));
    await wait(1000);

    assert.equal(client.calls.length, 1, "the second tick must not stack");
  });

  it("survives a state slice without a session reader", async () => {
    const client = fakeClient([1200]);
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: {},
    });
    source.onToolPartUpdated(childPart("part_1", "ses-child"));
    await wait(620);

    assert.equal(client.calls.length, 0);
  });

  it("survives a state slice whose session reader throws", async () => {
    const client = fakeClient([1200]);
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: {
        session: {
          get: () => {
            throw new Error("state exploded");
          },
        },
      },
    });
    source.onToolPartUpdated(childPart("part_1", "ses-child"));
    await wait(620);

    assert.equal(client.calls.length, 0);
    assert.equal(getRun("part_1")?.status, "running");
  });

  it("stops polling a run that was finished elsewhere", async () => {
    const { finishRun } = await import("../../core/subagent/registry.js");
    const client = fakeClient([1200]);
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: fakeState({ "ses-child": PARENT }),
    });
    source.onToolPartUpdated(childPart("part_1", "ses-child"));
    finishRun("part_1", { status: "aborted" });

    await wait(620);
    assert.equal(client.calls.length, 0, "the run is terminal — stop reading");
  });

  it("stops polling on dispose", async () => {
    const client = fakeClient([1200]);
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: fakeState({ "ses-child": PARENT }),
    });
    source.onToolPartUpdated(childPart("part_1", "ses-child"));
    source.dispose();

    await wait(620);
    assert.equal(client.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Reconcile scan (mount + child-session settlement)
// ---------------------------------------------------------------------------

/** Build a minimal context message entry holding the given parts. */
function msg(parts: Array<Record<string, unknown>>): Record<string, unknown> {
  return { info: { role: "assistant", id: "msg_1" }, parts };
}

describe("subagent source — reconcile", () => {
  it("recovers runs from the session history", async () => {
    const history = [
      msg([
        taskPart("part_done", {
          status: "completed",
          time: { start: 100, end: 900 },
          input: { description: "已完成" },
          metadata: { session_id: "ses-a", model: { modelID: "dummy" } },
        }),
      ]),
      msg([
        taskPart("part_run", {
          status: "running",
          time: { start: 950 },
          input: { prompt: "进行中" },
          metadata: { session_id: "ses-b" },
        }),
      ]),
    ];
    const source = makeSource({ history });
    await source.reconcile();
    await wait(10);

    const done = getRun("part_done");
    assert.equal(done?.status, "done");
    assert.equal(done?.label, "已完成");
    assert.equal(done?.agent, "task");
    assert.equal(done?.childSession, "ses-a");
    assert.equal(done?.model, "dummy");
    assert.equal(done?.startedAt, 100);
    assert.equal(done?.endedAt, 900);

    const running = getRun("part_run");
    assert.equal(running?.status, "running");
    assert.equal(running?.label, "进行中");
    assert.equal(running?.startedAt, 950);
  });

  it("is idempotent across repeated scans", async () => {
    const history = [
      msg([
        taskPart("part_1", {
          status: "completed",
          time: { start: 100, end: 900 },
          input: { description: "已完成" },
        }),
      ]),
    ];
    const source = makeSource({ history });
    await source.reconcile();
    await wait(10);
    const endedAt = getRun("part_1")?.endedAt;
    await source.reconcile();
    await wait(10);

    assert.equal(topLevelRuns(PARENT).length, 1, "no duplicate runs");
    assert.equal(getRun("part_1")?.endedAt, endedAt);
  });

  it("leaves a finished run untouched when the history is older", async () => {
    const source = makeSource({
      history: [
        msg([
          taskPart("part_1", {
            status: "running",
            input: { description: "扫描到的标题" },
          }),
        ]),
      ],
    });
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", {
          status: "completed",
          input: { description: "实时标题" },
        }),
      ),
    );
    await source.reconcile();
    await wait(10);

    const run = getRun("part_1");
    assert.equal(run?.status, "done");
    assert.equal(run?.label, "实时标题");
  });

  it("only fills the fields the live events have not reported", async () => {
    const client = fakeClient([100]);
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: fakeState({ "ses-x": PARENT }),
      history: [
        msg([
          taskPart("part_1", {
            status: "completed",
            metadata: {
              session_id: "ses-x",
              model: { modelID: "scanned-model" },
            },
          }),
        ]),
      ],
    });
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", {
          status: "running",
          metadata: { model: { modelID: "live-model" } },
        }),
      ),
    );
    await source.reconcile();
    await wait(20);

    const run = getRun("part_1");
    assert.equal(run?.status, "done", "the scanned terminal state wins");
    assert.equal(run?.model, "live-model", "live facts are not overwritten");
    assert.equal(run?.childSession, "ses-x", "a missing field is filled");
  });

  it("fills the fields of a run another producer registered", async () => {
    // A run can already exist when the panel mounts (another producer wrote
    // it into the same process-level registry): the scan fills what that run
    // is missing instead of starting a second one.
    startRun({ id: "part_1", agent: "lynx", parentSession: PARENT });
    const source = makeSource({
      history: [
        msg([
          taskPart("part_1", {
            status: "running",
            input: { description: "扫描来的标题" },
            metadata: {
              session_id: "ses-x",
              model: { modelID: "scanned-model" },
            },
          }),
        ]),
      ],
    });
    await source.reconcile();

    const run = getRun("part_1");
    assert.equal(run?.status, "running");
    assert.equal(run?.label, "扫描来的标题");
    assert.equal(run?.model, "scanned-model");
    assert.equal(run?.childSession, "ses-x");
    assert.equal(topLevelRuns(PARENT).length, 1);
  });

  it("skips pending parts and parts without usable data", async () => {
    const source = makeSource({
      history: [
        msg([taskPart("part_pending", { status: "pending" })]),
        msg([{ type: "tool", tool: "task", id: "part_no_state" }]),
        { info: {}, parts: "not-a-list" },
        { info: {}, parts: [{ type: "tool", tool: "bash", id: "part_b" }] },
        null,
      ],
    });
    await source.reconcile();
    await wait(10);

    assert.deepEqual(topLevelRuns(PARENT), []);
  });

  it("survives a history read that is not a list", async () => {
    const source = makeSource({
      history: "broken" as unknown as unknown[],
    });
    await source.reconcile();
    await wait(10);
    assert.deepEqual(topLevelRuns(PARENT), []);
  });

  it("swallows a failing history read", async () => {
    const source = makeSource();
    disposers.push(() => {});
    await assert.doesNotReject(async () => {
      await source.reconcile(Promise.reject(new Error("history unavailable")));
    });
    assert.deepEqual(topLevelRuns(PARENT), []);
  });

  it("scans the panel session's history and reuses a pre-fetched read", async () => {
    const scanned: string[] = [];
    const source = makeSource({
      history: [msg([taskPart("part_1", { status: "running" })])],
      onHistoryRead: (sessionId) => scanned.push(sessionId),
    });
    await source.reconcile();
    assert.deepEqual(scanned, [PARENT]);

    await source.reconcile(
      Promise.resolve([msg([taskPart("part_2", { status: "running" })])]),
    );
    assert.deepEqual(scanned, [PARENT], "the pre-fetched list is reused");
    assert.equal(getRun("part_2")?.status, "running");
  });

  it("starts polling a run recovered from the history", async () => {
    const client = fakeClient([777]);
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: fakeState({ "ses-b": PARENT }),
      history: [
        msg([
          taskPart("part_run", {
            status: "running",
            metadata: { session_id: "ses-b" },
          }),
        ]),
      ],
    });
    await source.reconcile();
    await wait(620);

    assert.equal(getRun("part_run")?.tokens, 777);
  });

  it("reads the final context length of a terminal run from the history", async () => {
    const client = fakeClient([888]);
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      history: [
        msg([
          taskPart("part_done", {
            status: "completed",
            metadata: { session_id: "ses-a" },
          }),
        ]),
      ],
    });
    await source.reconcile();
    await wait(20);

    assert.equal(getRun("part_done")?.status, "done");
    assert.equal(getRun("part_done")?.tokens, 888);
  });

  it("lets a stronger scanned title replace a weaker live label", async () => {
    const source = makeSource();
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", {
          status: "running",
          input: { prompt: "investigate the flaky test suite" },
        }),
      ),
    );
    assert.equal(getRun("part_1")?.label, "investigate the flaky test suite");

    await source.reconcile(
      Promise.resolve([
        msg([
          taskPart("part_1", {
            status: "running",
            title: "修测试",
            input: { prompt: "investigate the flaky test suite" },
          }),
        ]),
      ]),
    );

    assert.equal(getRun("part_1")?.label, "修测试");
  });

  it("keeps a stronger live label when the scan offers a weaker one", async () => {
    const source = makeSource();
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", {
          status: "running",
          title: "修测试",
          input: { prompt: "investigate the flaky test suite" },
        }),
      ),
    );

    await source.reconcile(
      Promise.resolve([
        msg([
          taskPart("part_1", {
            status: "running",
            input: { prompt: "investigate the flaky test suite" },
          }),
        ]),
      ]),
    );

    assert.equal(getRun("part_1")?.label, "修测试");
  });

  it("installs no run or timer when disposed mid-reconcile", async () => {
    let release!: (messages: unknown[]) => void;
    const pendingHistory = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    const client = fakeClient([1200]);
    const source = makeSource({
      client: client as SubagentSourceDeps["client"],
      state: fakeState({ "ses-child": PARENT }),
    });

    const scan = source.reconcile(pendingHistory);
    source.dispose();
    release([
      msg([
        taskPart("part_x", {
          status: "running",
          metadata: { session_id: "ses-child" },
        }),
      ]),
    ]);
    await scan;
    await wait(620);

    assert.equal(getRun("part_x"), undefined);
    assert.equal(client.calls.length, 0, "no poll timer after dispose");
  });
});

describe("subagent source — child session settlement", () => {
  it("does not terminate a run on session.idle alone", async () => {
    const source = makeSource({
      history: [
        msg([
          taskPart("part_1", {
            status: "running",
            metadata: { session_id: "ses-child" },
          }),
        ]),
      ],
      state: fakeState({ "ses-child": PARENT }),
    });
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", {
          status: "running",
          metadata: { session_id: "ses-child" },
        }),
      ),
    );
    source.onSessionIdle({ properties: { sessionID: "ses-child" } });
    await wait(20);

    const run = getRun("part_1");
    assert.equal(run?.status, "running");
    assert.equal(run?.endedAt, undefined);
  });

  it("reconciles the authoritative part state on session.idle", async () => {
    const source = makeSource({
      history: [
        msg([
          taskPart("part_1", {
            status: "completed",
            time: { start: 100, end: 800 },
            input: { description: "已完成" },
          }),
        ]),
      ],
    });
    source.onToolPartUpdated(
      partEvent(
        PARENT,
        taskPart("part_1", { status: "running", time: { start: 100 } }),
      ),
    );
    assert.equal(getRun("part_1")?.status, "running");

    source.onSessionIdle({ properties: { sessionID: "ses-child" } });
    await wait(20);

    const run = getRun("part_1");
    assert.equal(run?.status, "done");
    assert.equal(run?.endedAt, 800);
  });

  it("reconciles the authoritative part state on session.error", async () => {
    const source = makeSource({
      history: [
        msg([
          taskPart("part_1", {
            status: "error",
            error: "provider failed",
            metadata: { session_id: "ses-child" },
          }),
        ]),
      ],
    });
    source.onToolPartUpdated(
      partEvent(PARENT, taskPart("part_1", { status: "running" })),
    );

    source.onSessionError({ properties: { sessionID: "ses-child" } });
    await wait(20);

    const run = getRun("part_1");
    assert.equal(run?.status, "error");
    assert.equal(run?.error, "provider failed");
  });

  it("ignores settlement events of the panel's own session", async () => {
    const scanned: string[] = [];
    const source = makeSource({ onHistoryRead: (id) => scanned.push(id) });
    source.onSessionIdle({ properties: { sessionID: PARENT } });
    source.onSessionError({ properties: { sessionID: PARENT } });
    source.onSessionIdle({ properties: {} });
    await wait(10);

    assert.deepEqual(scanned, []);
  });
});

// ---------------------------------------------------------------------------
// Pure part-fact extractors (migrated from the retired TUI module)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// extractAgent
// ---------------------------------------------------------------------------

describe("extractAgent", () => {
  it("returns subagent_type from input", () => {
    const input = { subagent_type: "beaver" };
    assert.equal(extractAgent(input), "beaver");
  });

  it('returns "task" when no subagent_type', () => {
    assert.equal(extractAgent({}), "task");
  });

  it('returns "task" when input is undefined', () => {
    assert.equal(extractAgent(undefined), "task");
  });

  it("converts subagent_type to string", () => {
    const input = { subagent_type: 42 };
    assert.equal(extractAgent(input as Record<string, unknown>), "42");
  });
});

// ---------------------------------------------------------------------------
// extractModel
// ---------------------------------------------------------------------------

describe("extractModel", () => {
  it("extracts modelID from metadata.model", () => {
    const meta = { model: { modelID: "dummy-small" } };
    assert.equal(extractModel(meta), "dummy-small");
  });

  it("returns undefined when metadata is undefined", () => {
    assert.equal(extractModel(undefined), undefined);
  });

  it("returns undefined when model field is not an object", () => {
    const meta = { model: "dummy-small" };
    assert.equal(extractModel(meta), undefined);
  });

  it("returns undefined when model field is null", () => {
    const meta = { model: null };
    assert.equal(extractModel(meta), undefined);
  });

  it("returns undefined when modelID is missing", () => {
    const meta = { model: { providerID: "anthropic" } };
    assert.equal(extractModel(meta), undefined);
  });

  it("returns undefined when modelID is not a string", () => {
    const meta = { model: { modelID: 42 } };
    assert.equal(extractModel(meta), undefined);
  });
});

// ---------------------------------------------------------------------------
// extractTitle
// ---------------------------------------------------------------------------

describe("extractTitle", () => {
  it("returns state.title if present", () => {
    const state = { title: "My Title", status: "running" };
    assert.equal(extractTitle(state), "My Title");
  });

  it("prefers description from input", () => {
    const state = {
      status: "running",
      input: { description: "desc text", prompt: "full prompt here" },
    };
    assert.equal(extractTitle(state), "desc text");
  });

  it("falls back to truncated prompt (40 chars)", () => {
    const longPrompt = "a".repeat(50);
    const state = {
      status: "running",
      input: { prompt: longPrompt },
    };
    assert.equal(extractTitle(state), "a".repeat(40));
  });

  it('truncates prompt at 40 chars and does not add "…"', () => {
    const prompt = "1234567890".repeat(5);
    const state = {
      status: "running",
      input: { prompt },
    };
    const title = extractTitle(state);
    assert.equal(title.length, 40);
    assert.equal(title, "1234567890".repeat(4));
  });

  it("returns part id slice as last fallback", () => {
    const state = { status: "running", input: {} };
    const partId = "part_abc123_def456";
    assert.equal(extractTitle(state, partId), "part_abc");
  });

  it("falls back to empty string when no inputs at all", () => {
    const state = { status: "running" };
    assert.equal(extractTitle(state), "");
  });
});
// ---------------------------------------------------------------------------

describe("extractTimes", () => {
  it("extracts startedAt and endedAt from state.time", () => {
    const state = {
      status: "completed",
      time: { start: 1000, end: 5000 },
    };
    const result = extractTimes(state);
    assert.equal(result.startedAt, 1000);
    assert.equal(result.endedAt, 5000);
  });

  it("returns only startedAt when state has no end", () => {
    const state = {
      status: "running",
      time: { start: 1000 },
    };
    const result = extractTimes(state);
    assert.equal(result.startedAt, 1000);
    assert.equal(result.endedAt, undefined);
  });

  it("returns undefined fields when state.time is absent", () => {
    const state = { status: "running" };
    const result = extractTimes(state);
    assert.equal(result.startedAt, undefined);
    assert.equal(result.endedAt, undefined);
  });

  it("returns undefined fields when state.time is not an object", () => {
    const state = { status: "completed", time: "invalid" };
    const result = extractTimes(state);
    assert.equal(result.startedAt, undefined);
    assert.equal(result.endedAt, undefined);
  });

  it("rejects non-number start value", () => {
    const state = {
      status: "completed",
      time: { start: "string", end: 5000 },
    };
    const result = extractTimes(state);
    assert.equal(result.startedAt, undefined);
    assert.equal(result.endedAt, 5000);
  });

  it("rejects non-finite start value (Infinity)", () => {
    const state = {
      status: "running",
      time: { start: Infinity },
    };
    const result = extractTimes(state);
    assert.equal(result.startedAt, undefined);
  });

  it("rejects non-finite end value (NaN)", () => {
    const state = {
      status: "completed",
      time: { start: 1000, end: NaN },
    };
    const result = extractTimes(state);
    assert.equal(result.startedAt, 1000);
    assert.equal(result.endedAt, undefined);
  });
});
// ---------------------------------------------------------------------------
// extractContextTokens
// ---------------------------------------------------------------------------

describe("extractContextTokens", () => {
  it("treats non-numeric token fields as 0 (no string concatenation)", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 100, cache: { read: 50 } },
        },
      },
      {
        info: {
          role: "assistant",
          tokens: { input: "743", cache: { read: 8064 } },
        },
      },
    ];
    // The newest assistant (last in array) has string input — coerced
    // to 0, so its sum is 8064 (cache.read only), and it must win
    // over the older one.
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      8064,
    );
  });

  it("returns undefined when tokens are entirely non-numeric", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: "100", cache: { read: "50" } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      undefined,
    );
  });

  it("returns sum of input + cache.read for last assistant message", () => {
    const messages = [
      { info: { role: "user" } },
      {
        info: {
          role: "assistant",
          tokens: { input: 100, cache: { read: 50 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      150,
    );
  });

  it("skips zero-sum placeholder, returns previous assistant tokens", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 200, cache: { read: 30 } },
        },
      },
      {
        info: {
          role: "assistant",
          tokens: { input: 0, cache: { read: 0 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      230,
    );
  });

  it("skips multiple zero-sum placeholders", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 50, cache: { read: 10 } },
        },
      },
      {
        info: {
          role: "assistant",
          tokens: { input: 0, cache: { read: 0 } },
        },
      },
      {
        info: {
          role: "assistant",
          tokens: { input: 0, cache: { read: 0 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      60,
    );
  });

  it("returns undefined when all assistant messages are zero-sum", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 0, cache: { read: 0 } },
        },
      },
      {
        info: {
          role: "assistant",
          tokens: { input: 0, cache: { read: 0 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      undefined,
    );
  });

  it("returns undefined when no assistant messages exist", () => {
    const messages = [
      { info: { role: "user", tokens: { input: 100 } } },
      { info: { role: "tool", tokens: { input: 50 } } },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      undefined,
    );
  });

  it("skips assistant messages with missing tokens field", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 100, cache: { read: 20 } },
        },
      },
      { info: { role: "assistant", custom: "no tokens field" } },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      120,
    );
  });

  it("skips assistant with partial tokens missing both input and cache", () => {
    // tokens field exists but both input and cache are absent → sum 0 → skip
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 300, cache: { read: 100 } },
        },
      },
      { info: { role: "assistant", tokens: {} } },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      400,
    );
  });

  it("returns undefined for empty array", () => {
    assert.equal(extractContextTokens([]), undefined);
  });

  it("handles messages with missing info field", () => {
    const messages = [
      { parts: [] },
      {
        info: {
          role: "assistant",
          tokens: { input: 75, cache: { read: 25 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      100,
    );
  });

  it("handles cache.read as undefined (defaults to 0)", () => {
    const messages = [{ info: { role: "assistant", tokens: { input: 100 } } }];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      100,
    );
  });

  it("handles input as undefined (defaults to 0)", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { cache: { read: 200 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      200,
    );
  });

  it("returns sum when input is 0 but cache.read is positive", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 0, cache: { read: 300 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      300,
    );
  });

  it("navigates tool/tool-call messages interleaved with assistant", () => {
    const messages = [
      { info: { role: "user" } },
      {
        info: {
          role: "assistant",
          tokens: { input: 500, cache: { read: 50 } },
        },
      },
      { info: { role: "tool" } },
      { info: { role: "tool" } },
      { info: { role: "assistant", tokens: { input: 0, cache: { read: 0 } } } },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      550,
    );
  });
});
