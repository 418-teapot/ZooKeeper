/**
 * Tests for the pi host's loop settle wiring.
 *
 * Covers the `buildPiHandlers` settle/stop-cause/budget wiring at pi's
 * pre-settle boundary: `agent_end` only records the finished run, then
 * the `agent_before_settle` judge returns a `zoo-loop-wake`
 * custom-message entry with `continue: true` (pi commits it and runs the
 * continuation before `prompt()` returns).  The todo list is the sole
 * wake authority — a completed run with unfinished active work wakes
 * whatever the run did: read-only calls, a subagent delegation, even no
 * tool call at all; prose never suppresses a wake because a genuine wait
 * on the user is declared through the `blocked` status (a fully blocked
 * list silences, and a mixed list renders the waiting-on reason).
 * Structural exemptions stay silent: a non-`completed` outcome — an
 * aborted or errored run (pi reports the outcome itself, so a user Esc
 * recorded as `stopReason: "error"` no longer wakes) — an open blocking
 * UI prompt, a headless unanswered ask, an unidentifiable session.  A
 * delivered wake locks the session: a text-only reply to a wake stays
 * silent without spending budget, any tool activity releases the lock,
 * and a real user turn clears both the lock and the budget.  A stale
 * extension context is swallowed, and a profile without settle
 * contributions or without a valid `[zoo.continuation].max_wakes` leaves
 * the handler a no-op.
 *
 * A second suite drives the auto-debug strategy end to end against a
 * real `zdebug` release binary and an on-disk Case: verify exit 0
 * converges silently, exit 1 wakes with the re-run verdict, a
 * broken criterion (exit > 1) silences as `verify-error`, a spent wake
 * budget stops further wakes, and an aborted run is interdicted before
 * the strategy is consulted.
 *
 * Also covers the budget-map lifecycle: a `session_start` drops a
 * (re)starting session's stale entry, the size cap evicts the
 * oldest-inserted sessions, and a profile without the feature performs no
 * bookkeeping writes at all.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { PiBoundaryResult } from "../../adapters/pi/types.js";
import { buildPiHandlers } from "../../adapters/pi/wire.js";
import { sessionAgentRegistry } from "../../core/session-agent.js";
import { _resetForTesting as resetIdentityForTesting } from "../../core/subagent/identity.js";
import { resetRegistry } from "../../core/subagent/registry.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { CONTINUATION_PROMPT } from "../todo-continuation/decide.js";
import {
  type CaseFixture,
  createCaseFixture,
  requireZdebugBinary,
  zdebugExec,
} from "./e2e-fixture.js";

afterEach(() => {
  _resetForTesting();
  resetIdentityForTesting();
  resetRegistry();
  sessionAgentRegistry.clear();
});

// ---------------------------------------------------------------------------
// Test doubles and helpers
// ---------------------------------------------------------------------------

/** A minimal pi ExtensionAPI double (the settle wiring needs no methods). */
function mockApi(): {
  on(event: string, handler: (...args: any[]) => unknown): void;
  registerTool(tool: unknown): void;
  registerCommand(name: string, options: unknown): void;
  appendEntry(customType: string, data?: unknown): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  registerEntryRenderer(customType: string, renderer: unknown): void;
} {
  return {
    on(_event, _handler) {},
    registerTool(_tool) {},
    registerCommand(_name, _options) {},
    appendEntry(_customType, _data) {},
    getActiveTools() {
      return [];
    },
    setActiveTools(_names) {},
    registerEntryRenderer(_customType, _renderer) {},
  };
}

/** A pi event context whose session resolves to `sessionID`. */
function settleCtx(sessionID: string, branch: unknown[] = []) {
  return {
    sessionManager: {
      getSessionId: () => sessionID,
      getBranch: () => branch,
    },
  };
}

/**
 * Drive the loop wiring the way pi does: `agent_end` records the run,
 * then the pre-settle boundary hands the judge the outcome pi derived
 * from the run's terminal stop reason.
 *
 * @param handlers - The built pi handlers.
 * @param evt - The `agent_end` event carrying the run's messages.
 * @param ctx - The extension context.
 * @param outcome - The outcome pi reports at the boundary.
 * @returns The boundary result the judge returned.
 */
async function settle(
  handlers: ReturnType<typeof buildPiHandlers>,
  evt: unknown,
  ctx: unknown,
  outcome: "completed" | "aborted" | "error" = "completed",
): Promise<PiBoundaryResult> {
  await handlers.agentEnd(evt, ctx);
  return handlers.beforeSettle({ type: "agent_before_settle", outcome }, ctx);
}

/** A wake entry as the loop host writes it: a plain-text custom message. */
interface WakeEntry {
  type: "custom_message";
  customType: string;
  display: boolean;
  content: string;
}

/** The wake entries a boundary result carries (empty means silence). */
function wakes(result: PiBoundaryResult): WakeEntry[] {
  return (result.entries ?? []) as unknown as WakeEntry[];
}

/** The `cause` recorded by the host for the last settle. */
function settleReceivedCause(): unknown {
  const received = _getBufferForTesting().filter(
    (entry) => entry.event === "settle_received",
  );
  return received.at(-1)?.cause;
}

/** The silence reason recorded by the runner for the last settle. */
function settleSilenceReason(): unknown {
  const silent = _getBufferForTesting().filter(
    (entry) => entry.event === "settle_silent",
  );
  return silent.at(-1)?.reason;
}

/** The engine interlock reason recorded for the last settle. */
function interlockReason(): unknown {
  const interlocked = _getBufferForTesting().filter(
    (entry) => entry.event === "settle_interlock",
  );
  return interlocked.at(-1)?.reason;
}

/** An assistant message carrying the given content parts. */
function assistant(parts: unknown[], stopReason = "stop") {
  return { role: "assistant", stopReason, content: parts };
}

/** A text content part. */
function textPart(text: string): unknown {
  return { type: "text", text };
}

/** A tool-call content part. */
function toolCallPart(
  name: string,
  args: Record<string, unknown> = {},
): unknown {
  return { type: "toolCall", id: `call-${name}`, name, arguments: args };
}

/** A `toolResult` message for the ask tool carrying structured details. */
function askResultMessage(questions: unknown[]): unknown {
  return { role: "toolResult", toolName: "ask", details: { questions } };
}

/** A real user prompt acting as a turn boundary. */
function userMessage(content: string): unknown {
  return { role: "user", content };
}

/** An `agent_end` event carrying a settled run's messages. */
function runEnded(messages: unknown[]) {
  return { type: "agent_end", messages };
}

/** A normal (settled, non-aborted) finished run that made tool activity. */
const RUN_ENDED = runEnded([assistant([toolCallPart("bash")])]);

/**
 * A settled run whose final turn answers a wake in prose only: the turn
 * after its last user boundary carries no tool call.
 */
function textOnlyRun(): unknown {
  return runEnded([
    userMessage("continue"),
    assistant([textPart("Everything is already done.")]),
  ]);
}

/** A session transcript branch carrying one active todo snapshot. */
const ACTIVE_BRANCH = [
  {
    message: {
      role: "toolResult",
      toolName: "todo",
      details: {
        op: "init",
        phases: [
          {
            name: "Implement",
            tasks: [{ content: "Wire source", status: "in_progress" }],
          },
        ],
      },
    },
  },
];

/** A branch whose only remaining task is blocked on the user. */
const BLOCKED_BRANCH = [
  {
    message: {
      role: "toolResult",
      toolName: "todo",
      details: {
        op: "init",
        phases: [
          {
            name: "Ship",
            tasks: [
              { content: "Wire source", status: "completed" },
              {
                content: "Await sign-off",
                status: "blocked",
                blocker: "user sign-off",
              },
            ],
          },
        ],
      },
    },
  },
];

/** A branch mixing one active and one blocked task with a blocker. */
const MIXED_BRANCH = [
  {
    message: {
      role: "toolResult",
      toolName: "todo",
      details: {
        op: "init",
        phases: [
          {
            name: "Ship",
            tasks: [
              { content: "Wire source", status: "pending" },
              {
                content: "Await sign-off",
                status: "blocked",
                blocker: "user approval",
              },
            ],
          },
        ],
      },
    },
  },
];

/** A profile enabling only the todo-continuation hook. */
const ZOO = {
  mode: {
    poly: {
      agents: [],
      skills: [],
      hooks: ["todo-continuation"],
      tools: [],
      commands: [],
    },
  },
  continuation: { max_wakes: 3 },
};

/** The same profile with a one-reminder budget. */
const ZOO_LIMIT_1 = { ...ZOO, continuation: { max_wakes: 1 } };

/** The same profile with a two-reminder budget. */
const ZOO_LIMIT_2 = { ...ZOO, continuation: { max_wakes: 2 } };

/** The same profile without any `[zoo.continuation]` section. */
const ZOO_NO_CONTINUATION = { mode: { poly: { ...ZOO.mode.poly } } };

/** A profile with no settle-contributing hooks. */
const ZOO_NO_SETTLE = {
  mode: {
    poly: {
      agents: [],
      skills: [],
      hooks: [],
      tools: [],
      commands: [],
    },
  },
};

// ---------------------------------------------------------------------------
// buildPiHandlers — settle wiring
// ---------------------------------------------------------------------------

describe("buildPiHandlers — loop settle", () => {
  it("returns the wake as a boundary entry with continue so pi runs it", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    assert.equal(handlers.hasSettledHandlers, true);

    // The wake must be committed at pi's pre-settle boundary: pi runs the
    // continuation before `prompt()` returns, so a single-shot host keeps
    // the session alive to act on it.
    const result = await settle(
      handlers,
      RUN_ENDED,
      settleCtx("sess-1", ACTIVE_BRANCH),
    );

    assert.equal(result.continue, true);
    const entries = wakes(result);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.type, "custom_message");
    assert.equal(entry.customType, "zoo-loop-wake");
    assert.equal(entry.display, true);
    assert.ok(entry.content.startsWith(CONTINUATION_PROMPT));
    assert.ok(entry.content.includes("Wire source"));
  });

  it("preserves boundary entries earlier handlers contributed", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const ctx = settleCtx("sess-prior", ACTIVE_BRANCH);
    handlers.agentEnd(RUN_ENDED, ctx);

    // pi adopts a handler's returned `entries` as the new accumulated
    // list without merging, so the wake must re-emit the drafts the
    // boundary event already carries.
    const prior = { type: "custom", customType: "other-ext", data: 1 };
    const result = await handlers.beforeSettle(
      { type: "agent_before_settle", outcome: "completed", entries: [prior] },
      ctx,
    );

    assert.equal(result.continue, true);
    assert.deepEqual(result.entries?.[0], prior);
    assert.equal(wakes(result).length, 2);
  });

  it("stays silent when the run ended awaiting user input", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const c = settleCtx("sess-await", ACTIVE_BRANCH);

    handlers.uiPromptStart({ type: "ui_prompt_start" }, c);
    const result = await settle(handlers, RUN_ENDED, c);

    assert.equal(wakes(result).length, 0);
  });

  it("stays silent when the run was aborted", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const c = settleCtx("sess-aborted", ACTIVE_BRANCH);

    const result = await settle(
      handlers,
      {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "aborted" }],
      },
      c,
      "aborted",
    );

    assert.equal(wakes(result).length, 0);
  });

  it("stays silent when pi reports the run as an error", async () => {
    // The regression: pi records a user-aborted run's terminal message as
    // `stopReason: "error"`, and the outcome it reports at the boundary is
    // the authority — re-deriving the outcome from the transcript used to
    // misclassify the abort as settled and wake into a dead run.
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const c = settleCtx("sess-error", ACTIVE_BRANCH);

    const result = await settle(handlers, RUN_ENDED, c, "error");

    assert.equal(wakes(result).length, 0);
  });

  it("stays silent when the session cannot be identified", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const c = {
      sessionManager: {
        getSessionId: () => "",
        getBranch: () => ACTIVE_BRANCH,
      },
    };

    const result = await settle(handlers, RUN_ENDED, c);

    assert.equal(wakes(result).length, 0);
  });

  it("stays silent when the reminder budget is exhausted", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO_LIMIT_1, api as any);
    const c = settleCtx("sess-budget", ACTIVE_BRANCH);

    const first = await settle(handlers, RUN_ENDED, c);
    const second = await settle(handlers, RUN_ENDED, c);

    assert.equal(wakes(first).length, 1);
    assert.equal(wakes(second).length, 0);
  });

  it("resets the budget on a real user turn, allowing another wake", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO_LIMIT_1, api as any);
    const c = settleCtx("sess-reset", ACTIVE_BRANCH);

    await settle(handlers, RUN_ENDED, c);
    const spent = await settle(handlers, RUN_ENDED, c);
    assert.equal(wakes(spent).length, 0, "second run is budget-exhausted");

    // A real user prompt starts a fresh budget.
    await handlers.beforeAgentStart({ systemPrompt: "base" }, c);
    const fresh = await settle(handlers, RUN_ENDED, c);
    assert.equal(wakes(fresh).length, 1, "a user turn grants a fresh reminder");
  });

  it("never propagates a stale-context error out of the judge", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    // pi invalidates a captured ctx on session replacement / reload; reading
    // `sessionManager` then throws.  The judge must swallow it and log.
    const stale = {
      get sessionManager(): never {
        throw new Error("stale ctx");
      },
    };

    const result = await settle(handlers, RUN_ENDED, stale);

    assert.equal(wakes(result).length, 0);
    const failed = _getBufferForTesting().filter(
      (entry) => entry.event === "settle_failed",
    );
    assert.equal(failed.length, 1);
  });

  it("is a no-op when the profile contributes no settle handler", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO_NO_SETTLE, api as any);
    assert.equal(handlers.hasSettledHandlers, false);

    const result = await settle(
      handlers,
      RUN_ENDED,
      settleCtx("sess-none", ACTIVE_BRANCH),
    );

    assert.equal(wakes(result).length, 0);
  });

  it("is a no-op when no valid continuation config is present", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO_NO_CONTINUATION, api as any);
    assert.equal(handlers.hasSettledHandlers, false);

    const result = await settle(
      handlers,
      RUN_ENDED,
      settleCtx("sess-noconf", ACTIVE_BRANCH),
    );

    assert.equal(wakes(result).length, 0);
  });

  it("drops a session's budget on session_start so it restarts fresh", async () => {
    const api = mockApi();
    const reminders = new Map<string, Map<string, number>>();
    const handlers = buildPiHandlers(ZOO_LIMIT_1, api as any, undefined, {
      remindersUsed: reminders,
    });
    const c = settleCtx("sess-del", ACTIVE_BRANCH);

    await settle(handlers, RUN_ENDED, c);
    assert.equal(reminders.get("sess-del")?.get("todoContinuation"), 1);

    // The same session starting again begins with a fresh budget.
    await handlers.sessionStart({ type: "session_start" }, c);
    assert.equal(reminders.has("sess-del"), false);

    await settle(handlers, RUN_ENDED, c);
    assert.equal(reminders.get("sess-del")?.get("todoContinuation"), 1);
  });

  it("caps the budget store, evicting the oldest-inserted sessions", async () => {
    const api = mockApi();
    const reminders = new Map<string, Map<string, number>>();
    for (let i = 0; i < 100; i += 1) {
      reminders.set(`s${i}`, new Map([["todoContinuation", 1]]));
    }
    const handlers = buildPiHandlers(ZOO, api as any, undefined, {
      remindersUsed: reminders,
    });

    await settle(handlers, RUN_ENDED, settleCtx("s100", ACTIVE_BRANCH));

    assert.equal(reminders.size, 100);
    assert.equal(reminders.has("s0"), false, "oldest entry evicted");
    assert.equal(
      reminders.get("s100")?.get("todoContinuation"),
      1,
      "new entry retained",
    );
  });

  it("performs no continuation bookkeeping when the feature is disabled", async () => {
    const api = mockApi();
    const reminders = new Map<string, Map<string, number>>([
      ["sess-keep", new Map([["todoContinuation", 1]])],
    ]);
    const handlers = buildPiHandlers(ZOO_NO_SETTLE, api as any, undefined, {
      remindersUsed: reminders,
    });
    assert.equal(handlers.hasSettledHandlers, false);

    // Neither lifecycle hook touches the map: no reset, no eviction, no
    // insertion.
    await handlers.beforeAgentStart(
      { systemPrompt: "base" },
      settleCtx("sess-keep", ACTIVE_BRANCH),
    );
    await handlers.sessionStart(
      { type: "session_start" },
      settleCtx("sess-keep", ACTIVE_BRANCH),
    );

    assert.equal(reminders.get("sess-keep")?.get("todoContinuation"), 1);
    assert.equal(reminders.size, 1);
  });

  it("performs no bookkeeping when max_wakes is absent", async () => {
    const api = mockApi();
    const reminders = new Map<string, Map<string, number>>([
      ["sess-keep", new Map([["todoContinuation", 1]])],
    ]);
    const handlers = buildPiHandlers(
      ZOO_NO_CONTINUATION,
      api as any,
      undefined,
      {
        remindersUsed: reminders,
      },
    );
    assert.equal(handlers.hasSettledHandlers, false);

    await handlers.beforeAgentStart(
      { systemPrompt: "base" },
      settleCtx("sess-keep", ACTIVE_BRANCH),
    );
    await handlers.sessionStart(
      { type: "session_start" },
      settleCtx("sess-keep", ACTIVE_BRANCH),
    );

    assert.equal(reminders.get("sess-keep")?.get("todoContinuation"), 1);
    assert.equal(reminders.size, 1);
  });
});

// ---------------------------------------------------------------------------
// buildPiHandlers — auto-debug end to end (real zdebug binary + Case)
// ---------------------------------------------------------------------------

/** A profile enabling only the auto-debug settle strategy. */
const AUTODEBUG_ZOO_PROFILE = {
  agents: [],
  skills: [],
  hooks: ["auto-debug"],
  tools: [],
  commands: [],
};

/**
 * Build a `[zoo]` config enabling the auto-debug strategy.
 *
 * @param maxWakes - The `[zoo.autodebug].max_wakes` allowance.
 * @returns The zoo config.
 */
function autoDebugZoo(maxWakes = 3) {
  return {
    mode: { poly: { ...AUTODEBUG_ZOO_PROFILE } },
    autodebug: {
      max_wakes: maxWakes,
    },
  };
}

describe("buildPiHandlers — auto-debug end to end", () => {
  let origDebug: string | undefined;

  // The strategy's silence reason is only observable at debug level.
  beforeEach(() => {
    origDebug = process.env.ZOO_DEBUG;
    process.env.ZOO_DEBUG = "1";
    // Fail loudly, never skip, when the release binary is missing.
    requireZdebugBinary();
  });
  afterEach(() => {
    if (origDebug === undefined) delete process.env.ZOO_DEBUG;
    else process.env.ZOO_DEBUG = origDebug;
  });

  /** The auto-debug strategy's silence reason for the last settle. */
  function silenceReason(): unknown {
    const silent = _getBufferForTesting().filter(
      (entry) =>
        entry.event === "settle_silent" && entry.handler === "autoDebug",
    );
    return silent.at(-1)?.reason;
  }

  /**
   * Build pi handlers over a fixture workspace, wiring the real binary.
   *
   * @param fixture - The workspace/Case fixture.
   * @param maxWakes - The auto-debug wake allowance.
   * @returns The recorded pi API and the built handlers.
   */
  function handlersFor(fixture: CaseFixture, maxWakes = 3) {
    const api = mockApi();
    const handlers = buildPiHandlers(
      autoDebugZoo(maxWakes),
      api as any,
      undefined,
      { directory: fixture.workspace, zdebugExec },
    );
    return { api, handlers };
  }

  it("converges silently when the verification experiment passes", async () => {
    const fixture = await createCaseFixture({ verifyCommand: "exit 0" });
    try {
      const { handlers } = handlersFor(fixture);

      const result = await settle(
        handlers,
        RUN_ENDED,
        settleCtx("ad-converged"),
      );

      assert.equal(wakes(result).length, 0);
      assert.equal(silenceReason(), "converged");
    } finally {
      fixture.dispose();
    }
  });

  it("wakes with the re-run verdict while verify still fails", async () => {
    const fixture = await createCaseFixture({ verifyCommand: "exit 1" });
    try {
      const { handlers } = handlersFor(fixture);

      const result = await settle(handlers, RUN_ENDED, settleCtx("ad-wake"));

      const entries = wakes(result);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].customType, "zoo-loop-wake");
      assert.ok(
        entries[0].content.includes("判据重跑结果"),
        "wake carries the re-run verdict",
      );
      assert.ok(
        entries[0].content.includes(".zoo/debug/CASE-1/summary.md"),
        "wake points at the Case summary",
      );
      assert.equal(result.continue, true);
    } finally {
      fixture.dispose();
    }
  });

  it("silences verify-error when the criterion itself is broken", async () => {
    const fixture = await createCaseFixture({ verifyCommand: "exit 3" });
    try {
      const { handlers } = handlersFor(fixture);

      const result = await settle(
        handlers,
        RUN_ENDED,
        settleCtx("ad-verify-error"),
      );

      assert.equal(wakes(result).length, 0);
      assert.equal(silenceReason(), "verify-error");
    } finally {
      fixture.dispose();
    }
  });

  it("stops waking once the auto-debug budget is spent", async () => {
    const fixture = await createCaseFixture({ verifyCommand: "exit 1" });
    try {
      const { handlers } = handlersFor(fixture, 1);
      const c = settleCtx("ad-budget");

      const first = await settle(handlers, RUN_ENDED, c);
      assert.equal(wakes(first).length, 1, "the first settle wakes");

      const second = await settle(handlers, RUN_ENDED, c);
      assert.equal(
        wakes(second).length,
        0,
        "a spent budget silences the second",
      );
    } finally {
      fixture.dispose();
    }
  });

  it("honors the abort interlock before consulting the strategy", async () => {
    const fixture = await createCaseFixture({ verifyCommand: "exit 1" });
    try {
      const { handlers } = handlersFor(fixture);

      const result = await settle(
        handlers,
        {
          type: "agent_end",
          messages: [{ role: "assistant", stopReason: "aborted" }],
        },
        settleCtx("ad-aborted"),
        "aborted",
      );

      assert.equal(wakes(result).length, 0);
      assert.equal(silenceReason(), undefined, "strategy never consulted");
    } finally {
      fixture.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// buildPiHandlers — settled-turn progress and handback facts
// ---------------------------------------------------------------------------

describe("buildPiHandlers — settled-turn facts", () => {
  let origDebug: string | undefined;

  // The silence reason is only observable at debug level; enable it for
  // these assertions and restore the process env afterwards.
  beforeEach(() => {
    origDebug = process.env.ZOO_DEBUG;
    process.env.ZOO_DEBUG = "1";
  });
  afterEach(() => {
    if (origDebug === undefined) delete process.env.ZOO_DEBUG;
    else process.env.ZOO_DEBUG = origDebug;
  });

  it("wakes a turn that issued an edit call", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const evt = runEnded([
      userMessage("do work"),
      assistant([toolCallPart("edit", { filePath: "a.ts" })]),
    ]);

    const result = await settle(
      handlers,
      evt,
      settleCtx("sess-edit", ACTIVE_BRANCH),
    );

    assert.equal(wakes(result).length, 1);
  });

  it("wakes a turn whose only tool call is the todo tool", async () => {
    // The old no-progress false-negative hole: a planning turn is still
    // activity, and wakefulness is the list's call, not the turn's.
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const evt = runEnded([
      userMessage("plan work"),
      assistant([toolCallPart("todo", { op: "init" })]),
    ]);

    const result = await settle(
      handlers,
      evt,
      settleCtx("sess-todo", ACTIVE_BRANCH),
    );

    assert.equal(wakes(result).length, 1);
    assert.equal(settleReceivedCause(), "settled");
  });

  it("wakes a turn that delegated to a subagent, whatever the agent", async () => {
    // The executor/read-only distinction is gone: any tool call counts
    // as activity and the list decides wakefulness.
    for (const agent of ["beaver", "lynx"]) {
      const api = mockApi();
      const handlers = buildPiHandlers(ZOO, api as any);
      const evt = runEnded([
        userMessage("delegate"),
        assistant([toolCallPart("subagent", { agent })]),
      ]);

      const result = await settle(
        handlers,
        evt,
        settleCtx(`sess-${agent}`, ACTIVE_BRANCH),
      );

      assert.equal(wakes(result).length, 1, `delegation to ${agent} must wake`);
    }
  });

  it("wakes a turn whose final text solicits the user's approval", async () => {
    // Prose never classifies a wait: a genuine stop on the user is
    // declared through a blocked task, so an approval solicitation in
    // otherwise-active turns is just a settled turn.
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const evt = runEnded([
      userMessage("implement"),
      assistant([
        toolCallPart("bash"),
        textPart("方案已拟定，确认后我就开始实施。"),
      ]),
    ]);

    const result = await settle(
      handlers,
      evt,
      settleCtx("sess-await-text", ACTIVE_BRANCH),
    );

    assert.equal(wakes(result).length, 1);
    assert.equal(settleReceivedCause(), "settled");
  });

  it("leaves an ordinary final text turn unaffected", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const evt = runEnded([
      userMessage("implement"),
      assistant([toolCallPart("bash"), textPart("All changes applied.")]),
    ]);

    const result = await settle(
      handlers,
      evt,
      settleCtx("sess-plain", ACTIVE_BRANCH),
    );

    assert.equal(wakes(result).length, 1);
    assert.equal(settleReceivedCause(), "settled");
  });

  it("wakes when the event carries no transcript messages", async () => {
    // No tool activity does not imply silence: without a prior wake
    // there is no lock, and the list alone decides.
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);

    const result = await settle(
      handlers,
      { type: "agent_end" },
      settleCtx("sess-empty", ACTIVE_BRANCH),
    );

    assert.equal(wakes(result).length, 1);
    assert.equal(settleReceivedCause(), "settled");
  });

  it("wakes when the turn has no assistant message", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const evt = runEnded([userMessage("only a prompt")]);

    const result = await settle(
      handlers,
      evt,
      settleCtx("sess-noassistant", ACTIVE_BRANCH),
    );

    assert.equal(wakes(result).length, 1);
  });

  it("scopes activity to the turn after the last user message", async () => {
    // After a wake locks the session, only the settled turn counts as
    // activity: the earlier turn's edit must not release the lock.
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO_LIMIT_2, api as any);
    const c = settleCtx("sess-scope", ACTIVE_BRANCH);

    const first = await settle(handlers, RUN_ENDED, c);
    assert.equal(wakes(first).length, 1, "the working run wakes");

    const second = await settle(
      handlers,
      runEnded([
        userMessage("do work"),
        assistant([toolCallPart("edit", { filePath: "a.ts" })]),
        userMessage("anything left?"),
        assistant([textPart("The work is complete.")]),
      ]),
      c,
    );

    assert.equal(wakes(second).length, 0, "the text-only tail keeps the lock");
    assert.equal(interlockReason(), "awaiting-activity");
  });

  it("stays silent on a text-only reply to a wake without spending budget", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO_LIMIT_2, api as any);
    const c = settleCtx("sess-lock", ACTIVE_BRANCH);

    const first = await settle(handlers, RUN_ENDED, c);
    assert.equal(wakes(first).length, 1, "the working run wakes and locks");

    const second = await settle(handlers, textOnlyRun(), c);
    assert.equal(wakes(second).length, 0, "the prose-only answer stays silent");
    assert.equal(interlockReason(), "awaiting-activity");

    // A later active run still wakes: the silenced reply left the
    // second allowance untouched.
    const third = await settle(handlers, RUN_ENDED, c);
    assert.equal(wakes(third).length, 1, "the text-only reply spent no budget");
  });

  it("releases the lock when the reply makes a read-only tool call", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const c = settleCtx("sess-unlock", ACTIVE_BRANCH);

    const first = await settle(handlers, RUN_ENDED, c);
    assert.equal(wakes(first).length, 1, "the working run wakes and locks");

    const second = await settle(
      handlers,
      runEnded([
        userMessage("continue"),
        assistant([toolCallPart("read", { filePath: "a.ts" })]),
      ]),
      c,
    );

    assert.equal(
      wakes(second).length,
      1,
      "read-only activity releases the lock",
    );
    assert.ok(
      wakes(second)[0].content.startsWith(CONTINUATION_PROMPT),
      "the re-evaluated wake carries the reminder again",
    );
  });

  it("a real user turn clears the lock along with the budget", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO_LIMIT_1, api as any);
    const c = settleCtx("sess-lock-reset", ACTIVE_BRANCH);

    const first = await settle(handlers, RUN_ENDED, c);
    assert.equal(wakes(first).length, 1, "the working run wakes and locks");

    const second = await settle(handlers, textOnlyRun(), c);
    assert.equal(wakes(second).length, 0, "the text-only reply stays silent");

    // A real user prompt resets the budget AND clears the lock, so even
    // a text-only settle under the fresh budget wakes again.
    await handlers.beforeAgentStart({ systemPrompt: "base" }, c);
    const third = await settle(handlers, textOnlyRun(), c);

    assert.equal(wakes(third).length, 1, "the user turn cleared the lock too");
  });

  it("stays silent when every remaining task is blocked", async () => {
    // A blocked task is the agent's own declaration that it waits on
    // the user — the list silences the loop, no prose needed.
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);

    const result = await settle(
      handlers,
      RUN_ENDED,
      settleCtx("sess-blocked", BLOCKED_BRANCH),
    );

    assert.equal(wakes(result).length, 0);
    assert.equal(settleSilenceReason(), "no-active");
  });

  it("renders the waiting-on reason when a mixed list wakes", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);

    const result = await settle(
      handlers,
      RUN_ENDED,
      settleCtx("sess-mixed", MIXED_BRANCH),
    );

    const entries = wakes(result);
    assert.equal(entries.length, 1);
    assert.ok(
      entries[0].content.includes(
        "- [blocked] Await sign-off (waiting on: user approval)",
      ),
      "the store carries the blocker into the reminder",
    );
    assert.ok(
      entries[0].content.includes("Wire source"),
      "the active task stays in the reminder",
    );
  });

  it("classifies a headless ask (no-ui) as awaiting-input", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    // In a non-TUI host the ask tool cannot draw a dialog, so every
    // question comes back `unavailable`/`no-ui`: the agent asked the user
    // something and no human could answer.  The wake must be suppressed.
    const evt = runEnded([
      userMessage("ask me"),
      assistant([toolCallPart("bash"), toolCallPart("ask")]),
      askResultMessage([
        {
          question: "Which one?",
          result: { status: "unavailable", reason: "no-ui" },
        },
      ]),
    ]);

    const result = await settle(
      handlers,
      evt,
      settleCtx("sess-ask-noui", ACTIVE_BRANCH),
    );

    assert.equal(wakes(result).length, 0);
    assert.equal(settleReceivedCause(), "awaiting-input");
  });

  it("leaves a turn whose ask was answered unaffected", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const evt = runEnded([
      userMessage("ask me"),
      assistant([toolCallPart("bash"), toolCallPart("ask")]),
      askResultMessage([
        {
          question: "Which one?",
          result: { status: "answered", answer: ["A"], wasCustom: false },
        },
      ]),
    ]);

    const result = await settle(
      handlers,
      evt,
      settleCtx("sess-ask-answered", ACTIVE_BRANCH),
    );

    assert.equal(wakes(result).length, 1);
    assert.equal(settleReceivedCause(), "settled");
  });

  it("does not treat an ask timeout or abort as awaiting-input", async () => {
    for (const reason of ["timeout", "aborted"] as const) {
      const api = mockApi();
      const handlers = buildPiHandlers(ZOO, api as any);
      const evt = runEnded([
        userMessage("ask me"),
        assistant([toolCallPart("bash"), toolCallPart("ask")]),
        askResultMessage([
          { question: "Which one?", result: { status: "unavailable", reason } },
        ]),
      ]);

      const result = await settle(
        handlers,
        evt,
        settleCtx(`sess-ask-${reason}`, ACTIVE_BRANCH),
      );

      assert.equal(wakes(result).length, 1, `${reason} should still wake`);
      assert.equal(settleReceivedCause(), "settled");
    }
  });

  it("ignores malformed ask details without crashing", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(ZOO, api as any);
    const evt = runEnded([
      userMessage("ask me"),
      assistant([toolCallPart("bash"), toolCallPart("ask")]),
      { role: "toolResult", toolName: "ask" },
      { role: "toolResult", toolName: "ask", details: null },
      { role: "toolResult", toolName: "ask", details: { questions: "nope" } },
      askResultMessage([null, 42, { result: "x" }]),
    ]);

    const result = await settle(
      handlers,
      evt,
      settleCtx("sess-ask-malformed", ACTIVE_BRANCH),
    );

    assert.equal(wakes(result).length, 1);
    assert.equal(settleReceivedCause(), "settled");
  });
});
