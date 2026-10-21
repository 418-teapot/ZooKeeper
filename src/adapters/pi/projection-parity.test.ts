/**
 * Equivalence test: one activity, two observation paths, one fact log.
 *
 * The run log is fed by two projections of the same subagent run — live
 * session events (`src/adapters/pi/subagent.ts`) and the persisted messages a
 * restart replays (`src/adapters/pi/hydrate.ts`).  This test defines one
 * activity once and derives BOTH inputs from it, then asserts the two fact
 * logs are item-wise identical (`at` normalized, since the live side stamps
 * the observation time and the replay side the message's own timestamp).
 *
 * Boundary: the two public entry points, driven end to end — the driver over
 * a scripted session event stream, and `factsFromContextMessages` over the
 * matching persisted messages.  Anything the two paths disagree about shows
 * up as a fact-level difference, which is exactly what must not happen.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunFact } from "../../core/subagent/run-log.js";
import { createRunLog } from "../../core/subagent/run-log.js";
import { factsFromContextMessages } from "./hydrate.js";
import {
  createPiSubagentDriver,
  type PiAgentSession,
  type PiSessionEvent,
} from "./subagent.js";

/** One text block of a pi message. */
function text(value: string): { type: "text"; text: string } {
  return { type: "text", text: value };
}

/** One thinking block of a pi message. */
function thinking(value: string): { type: "thinking"; thinking: string } {
  return { type: "thinking", thinking: value };
}

/**
 * One synthetic subagent run.
 *
 * The activity is the single source both input streams are derived from: the
 * live events of a session executing it, and the messages pi persists for it.
 * Tool calls are scripted one per assistant turn, so the observed order of
 * their facts is the same on both sides (a host may interleave parallel calls
 * differently; this test pins the sequential case the subagent runs).
 */
const ACTIVITY = {
  prompt: "SUMMARY: fix the flaky test\n\nCONTEXT: it fails intermittently",
  first: {
    content: [thinking("let me look at the test"), text("reading it")],
    usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 5 },
    timestamp: 1_700_000_000_000,
  },
  call: {
    id: "tc-1",
    name: "bash",
    args: { command: "bun test", timeout: 60 },
    text: "running the suite",
    usage: { input: 40, output: 8, totalTokens: 48 },
    timestamp: 1_700_000_001_000,
    result: "1 failing",
    isError: false,
  },
  steer: {
    text: "and now add a regression test",
    timestamp: 1_700_000_002_000,
  },
  last: {
    content: [text("added the test")],
    usage: { input: 12, output: 3 },
    timestamp: 1_700_000_003_000,
  },
} as const;

/** The assistant content block of the scripted tool call. */
function callBlocks(): unknown[] {
  return [
    text(ACTIVITY.call.text),
    {
      type: "toolCall",
      id: ACTIVITY.call.id,
      name: ACTIVITY.call.name,
      arguments: ACTIVITY.call.args,
    },
  ];
}

/**
 * The session events of the activity, as pi emits them.
 *
 * The prompt echo is NOT scripted here: the driver's session (see `driveLive`)
 * emits it for the prompt it is handed, exactly as pi's agent loop does.
 */
function liveEvents(): PiSessionEvent[] {
  return [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: ACTIVITY.first.content,
        usage: ACTIVITY.first.usage,
        stopReason: "toolUse",
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: callBlocks(),
        usage: ACTIVITY.call.usage,
        stopReason: "toolUse",
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: ACTIVITY.call.id,
      toolName: ACTIVITY.call.name,
      args: ACTIVITY.call.args,
    },
    {
      type: "tool_execution_end",
      toolCallId: ACTIVITY.call.id,
      toolName: ACTIVITY.call.name,
      result: { content: [text(ACTIVITY.call.result)] },
      isError: ACTIVITY.call.isError,
    },
    {
      type: "message_end",
      message: { role: "user", content: [text(ACTIVITY.steer.text)] },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: ACTIVITY.last.content,
        usage: ACTIVITY.last.usage,
        stopReason: "stop",
      },
    },
    { type: "agent_end" },
  ];
}

/** The messages pi persists for the activity, as a restart replays them. */
function persistedMessages(): unknown[] {
  return [
    { role: "user", content: [text(ACTIVITY.prompt)], timestamp: 0 },
    {
      role: "assistant",
      content: ACTIVITY.first.content,
      usage: ACTIVITY.first.usage,
      timestamp: ACTIVITY.first.timestamp,
    },
    {
      role: "assistant",
      content: callBlocks(),
      usage: ACTIVITY.call.usage,
      timestamp: ACTIVITY.call.timestamp,
    },
    {
      role: "toolResult",
      toolCallId: ACTIVITY.call.id,
      toolName: ACTIVITY.call.name,
      content: [text(ACTIVITY.call.result)],
      isError: ACTIVITY.call.isError,
      timestamp: ACTIVITY.call.timestamp,
    },
    {
      role: "user",
      content: [text(ACTIVITY.steer.text)],
      timestamp: ACTIVITY.steer.timestamp,
    },
    {
      role: "assistant",
      content: ACTIVITY.last.content,
      usage: ACTIVITY.last.usage,
      timestamp: ACTIVITY.last.timestamp,
    },
  ];
}

/**
 * Run the driver over the activity's session events, returning its fact log.
 *
 * The scripted session echoes the prompt back as a user `message_end` before
 * delivering the scripted events — pi's agent loop emits the message it was
 * handed before streaming — so the live path observes the prompt the way a
 * real session reports it.
 */
async function driveLive(): Promise<readonly RunFact[]> {
  let listener: ((event: PiSessionEvent) => void) | undefined;
  const session: PiAgentSession = {
    subscribe(l) {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    async prompt(prompt) {
      listener?.({
        type: "message_end",
        message: { role: "user", content: [text(prompt)] },
      });
      for (const event of liveEvents()) listener?.(event);
    },
    abort() {},
    dispose() {},
  };
  const driver = createPiSubagentDriver({
    createSession: async () => ({ session }),
    createSessionManager: async () => ({ getSessionId: () => "child" }),
    resolveModel: async (model) => ({
      model,
      modelRuntime: { getModel: () => undefined },
    }),
  });
  const log = createRunLog();
  await driver.run(
    { agent: "beaver", prompt: ACTIVITY.prompt, tools: ["bash"], model: "p/m" },
    { signal: new AbortController().signal, log },
  );
  return log.facts();
}

/** The same log with the observation timestamps normalized away. */
function normalized(facts: readonly RunFact[]): Array<Record<string, unknown>> {
  return facts.map((fact) => ({ ...fact, at: 0 }));
}

describe("run fact projection — live and replayed observation agree", () => {
  it("derives the same fact sequence from events and from persisted messages", async () => {
    const live = normalized(await driveLive());
    const replayed = normalized(factsFromContextMessages(persistedMessages()));
    assert.deepEqual(
      live.map((fact) => fact.type),
      [
        // The instruction the session was handed, once.
        "user_message",
        "message_end",
        "message_end",
        "tool_start",
        "tool_end",
        // The steered input arrives as its own user message.
        "user_message",
        "message_end",
      ],
      "the live path records the scripted activity in order",
    );
    assert.deepEqual(replayed, live);
  });

  it("records the same untruncated content and usage on both paths", async () => {
    const live = await driveLive();
    const replayed = factsFromContextMessages(persistedMessages());
    const usageOf = (facts: readonly RunFact[]) =>
      facts.flatMap((fact) =>
        fact.type === "message_end" && fact.usage !== undefined
          ? [fact.usage]
          : [],
      );
    const argsOf = (facts: readonly RunFact[]) =>
      facts.flatMap((fact) => (fact.type === "tool_start" ? [fact.args] : []));
    const resultOf = (facts: readonly RunFact[]) =>
      facts.flatMap((fact) => (fact.type === "tool_end" ? [fact.content] : []));
    // The provider's cache-write figure is not part of the run-log usage
    // shape, so both paths drop it identically.
    assert.deepEqual(usageOf(live), [
      { input: 100, output: 20, cacheRead: 900 },
      { input: 40, output: 8, totalTokens: 48 },
      { input: 12, output: 3 },
    ]);
    assert.deepEqual(usageOf(replayed), usageOf(live));
    assert.deepEqual(argsOf(live), [ACTIVITY.call.args]);
    assert.deepEqual(argsOf(replayed), argsOf(live));
    assert.deepEqual(resultOf(live), [[text(ACTIVITY.call.result)]]);
    assert.deepEqual(resultOf(replayed), resultOf(live));
  });
});
