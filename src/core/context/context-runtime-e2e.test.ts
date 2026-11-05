/**
 * End-to-end tests for two plugin instances sharing one process.
 *
 * Boundary: the public entries a host drives — the context-pruning
 * transform, the compress tool, and the session record catalog — over
 * explicit `ContextRuntime` instances and `WorkPermit`s.  The
 * expectations are the observable records (state, files, runtime-only
 * maps) after overlapping or cancelled work, never the runtime's internal
 * sequencing.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { createV1Adapter } from "../../adapters/opencode/adapter.js";
import { callFor, permitFor } from "../../testkits/context-runtime.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import { createCompressTool } from "../../tools/compress.js";
import type { ContextPruningConfig } from "../config-types.js";
import { sessionAgentResource } from "../session/agent.js";
import {
  contextSessionResources,
  createSessionResourceCatalog,
} from "../session/resources.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "./message-parts.js";
import { contextPruningTransformHandler } from "./pipeline.js";
import { buildProtectionMap } from "./protection-map.js";
import { type ContextRuntime, createContextRuntime } from "./runtime.js";
import { markKey } from "./state.js";
import { createStateStore, type StateStore } from "./store.js";

/** Scratch store directories the current test created. */
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A v1-shaped message entry the opencode adapter projects. */
interface FixtureMessage {
  info: {
    role: string;
    id: string;
    sessionID: string;
    tokens?: { input?: number; output?: number };
  };
  parts: unknown[];
}

/** A short transcript whose assistant carries a text part. */
function transcript(sessionID: string): FixtureMessage[] {
  const text = "y".repeat(2000);
  return [
    {
      info: { role: "user", id: "u1", sessionID },
      parts: [{ type: "text", text: "start" }],
    },
    {
      info: {
        role: "assistant",
        id: "a1",
        sessionID,
        tokens: { input: 1000, output: 100 },
      },
      parts: [{ type: "text", text }],
    },
    {
      info: { role: "user", id: "u2", sessionID },
      parts: [{ type: "text", text: "continue" }],
    },
  ];
}

/** The transform config of these tests: release everything pending. */
const CONFIG: ContextPruningConfig = {
  activeMessages: 1,
  activeTokens: 0,
  releasedPercent: 0,
  dedup: {},
  purgeErrors: {},
  compress: { thresholdTokens: 0, maxRanges: 8 },
};

/** The adapter the transform and the tool share. */
const adapter = createV1Adapter();

/** Create a runtime over a fresh scratch store. */
function sandboxRuntime(): { runtime: ContextRuntime; store: StateStore } {
  const dir = makeTmpDir("zoo-context-e2e");
  tmpDirs.push(dir);
  const store = createStateStore(dir);
  return { runtime: createContextRuntime(store), store };
}

/** Seed a pending mark on the transcript's text region. */
function seedPendingMark(
  runtime: ContextRuntime,
  sessionID: string,
  ordinal: number,
): void {
  runtime.read(permitFor(sessionID), (state) => {
    state.marks.set(markKey(ordinal, 0), {
      anchorOrdinal: ordinal,
      regionIndex: 0,
      content: "x",
      contentTokens: 100,
      effective: false,
      markedAt: 1000,
    });
  });
}

/** The committed state of a session. */
function stateOf(runtime: ContextRuntime, sessionID: string) {
  const state = runtime.read(permitFor(sessionID), (draft) => draft);
  if (state === undefined) throw new Error(`no committed state: ${sessionID}`);
  return state;
}

describe("one process, two plugin instances", () => {
  it("keeps their releases and deletions apart", async () => {
    const first = sandboxRuntime();
    const second = sandboxRuntime();
    const sessionID = "shared";
    for (const { runtime } of [first, second]) {
      await runtime.commit(permitFor(sessionID), (state) => {
        state.blocks.set(1, {
          start: 0,
          end: 1,
          summary: "kept",
          spanHash: "ffff0000",
          status: "active",
          compressedTokens: 10,
          summaryTokens: 2,
          createdAt: 1000,
        });
      });
      runtime.setModelLimit(permitFor(sessionID), 1000, "model");
    }

    const firstCatalog = createSessionResourceCatalog(
      contextSessionResources(first.runtime),
    );
    await firstCatalog.release(sessionID);

    assert.equal(stateOf(first.runtime, sessionID).blocks.size, 1);
    assert.equal(first.runtime.modelLimit(sessionID), undefined);
    assert.equal(
      stateOf(second.runtime, sessionID).blocks.get(1)?.summary,
      "kept",
      "the sibling instance keeps its state",
    );
    assert.ok(second.runtime.modelLimit(sessionID));

    const secondCatalog = createSessionResourceCatalog([
      ...contextSessionResources(second.runtime),
      sessionAgentResource,
    ]);
    await secondCatalog.delete(sessionID);
    assert.equal(second.store.load(sessionID).blocks.size, 0);
  });
});

describe("one session, overlapping entries", () => {
  it("runs a transform and a compress call without losing either update", async () => {
    const { runtime } = sandboxRuntime();
    const sessionID = "overlap";
    const messages = transcript(sessionID);
    seedPendingMark(runtime, sessionID, 1);
    // The published view is the address space the tool resolves its refs
    // in; publish the same transcript both entries operate on.
    const published = adapter.history(messages);
    runtime.publishRoundView(sessionID, {
      projection: published,
      numbered: [
        { n: 1, item: { type: "original", start: 0, end: 1 } },
        { n: 2, item: { type: "original", start: 1, end: 2 } },
        { n: 3, item: { type: "original", start: 2, end: 3 } },
      ],
      protection: buildProtectionMap(published.messages, 1, 0),
    });
    const tool = createCompressTool(
      {
        async notify() {},
      },
      CONFIG,
      runtime,
    );

    const [, toolResult] = await Promise.all([
      contextPruningTransformHandler(
        runtime,
        permitFor(sessionID),
        adapter,
        messages,
        CONFIG,
      ),
      tool.execute(
        {
          ranges: [
            { fromRef: "m2", toRef: "m2", title: "段", summary: "摘要" },
          ],
        },
        callFor(sessionID, { permit: permitFor(sessionID) }),
      ),
    ]);

    const state = stateOf(runtime, sessionID);
    assert.equal(state.blocks.size, 1, "the compress block survives");
    assert.equal(
      state.marks.get(markKey(1, 0))?.effective,
      true,
      "the transform's release survives",
    );
    assert.ok(toolResult.text.includes("已压缩"));
  });
});

describe("cancellation mid-round", () => {
  it("writes no file and leaves the release save untouched", async () => {
    const { runtime, store } = sandboxRuntime();
    const sessionID = "cancelled";
    const messages = transcript(sessionID);

    // Round 1: a healthy transform commits an effective release.
    seedPendingMark(runtime, sessionID, 1);
    await contextPruningTransformHandler(
      runtime,
      permitFor(sessionID),
      adapter,
      transcript(sessionID),
      CONFIG,
    );
    assert.equal(store.load(sessionID).marks.size, 1);
    assert.equal(
      store.load(sessionID).marks.get(markKey(1, 0))?.effective,
      true,
    );

    // Round 2: the host cancels the call while the adapter applies the
    // release edits — the commitment point of the whole round.
    seedPendingMark(runtime, sessionID, 2);
    const controller = new AbortController();
    const cancelling = {
      ...adapter,
      applyEdits(
        conversation: unknown,
        edits: Parameters<typeof adapter.applyEdits>[1],
      ): unknown {
        controller.abort();
        return adapter.applyEdits(conversation, edits);
      },
    };
    const result = await contextPruningTransformHandler(
      runtime,
      permitFor(sessionID, controller.signal),
      cancelling,
      messages,
      CONFIG,
    );

    assert.equal(result, messages, "the cancelled round returns the input");
    assert.equal(
      store.load(sessionID).marks.size,
      1,
      "the cancelled round writes nothing",
    );

    // The release path saves what was committed, never the cancelled
    // round's draft: the second mark stays pending.
    runtime.release(sessionID);
    const reloaded = store.load(sessionID);
    assert.equal(reloaded.marks.get(markKey(1, 0))?.effective, true);
    assert.equal(reloaded.marks.get(markKey(2, 0))?.effective, false);
  });
});

describe("cancellation after the commit", () => {
  it("publishes and returns the committed round", async () => {
    const { runtime, store } = sandboxRuntime();
    const sessionID = "committed-then-cancelled";
    const messages = transcript(sessionID);
    seedPendingMark(runtime, sessionID, 1);

    // The session stops right after the commit succeeded.
    const controller = new AbortController();
    const stopping: ContextRuntime = {
      ...runtime,
      commit: async (permit, change) => {
        const value = await runtime.commit(permit, change);
        controller.abort();
        return value;
      },
    };
    const notices: string[] = [];
    const toasts: unknown[] = [];

    const result = await contextPruningTransformHandler(
      stopping,
      permitFor(sessionID, controller.signal),
      adapter,
      messages,
      CONFIG,
      (text) => notices.push(text),
      false,
      (payload) => toasts.push(payload),
    );

    // The round committed, so the commit's results belong to it: the tools
    // receive its address space, the caller its rendered conversation, and
    // the user the queued notice.
    assert.equal(
      store.load(sessionID).marks.get(markKey(1, 0))?.effective,
      true,
    );
    assert.ok(runtime.roundView(sessionID), "the committed view is published");
    assert.equal(notices.length, 1, "the committed release is announced");
    assert.deepEqual(toasts, [], "no nudge ran in this round");
    const rendered = result as Array<{ parts: Array<{ text?: string }> }>;
    assert.equal(
      rendered.length,
      3,
      "the committed view is handed back to the caller",
    );
    assert.ok(
      String(rendered[1].parts[0]?.text).includes(
        PRUNED_TOOL_OUTPUT_REPLACEMENT,
      ),
      "the returned conversation carries the committed release",
    );
  });
});
