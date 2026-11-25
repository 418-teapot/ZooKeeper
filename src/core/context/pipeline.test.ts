/**
 * Tests for the pipeline's side-effect-free preview (`pipeline.ts`).
 *
 * Boundary: `previewRound` — it runs the transform's phases over a
 * supplied session state and returns the round's view, its numbering and
 * the projection of the messages the transform would send.  The real
 * transform (state commit, notices, logs, published view) is exercised
 * elsewhere; here every assertion checks that the preview produced the
 * same rendering while writing nothing.
 *
 * Fixtures use the pi adapter, because the pi transcript splits one tool
 * call across an assistant `toolCall` block and a separate `toolResult`
 * message — the shape the page must keep together.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createPiAdapter } from "../../adapters/pi/adapter.js";
import type { PiAgentMessage } from "../../adapters/pi/types.js";
import { makeBlock, makeMark, makeState } from "../../testkits/context.js";
import { permitFor } from "../../testkits/context-runtime.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import type { ContextPruningConfig } from "../config-types.js";
import { previewRound } from "./pipeline.js";
import type { RuntimeFlaggedState } from "./runtime.js";
import { createContextRuntime } from "./runtime.js";
import { computeSpanHash } from "./spanhash.js";
import { markKey } from "./state.js";
import { createStateStore, type StateStore } from "./store.js";
import { formatViewPage } from "./view-page.js";

afterEach(() => {
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A config with no protection map: no mark is released or produced. */
const CONFIG: ContextPruningConfig = {};

/** One user turn, one assistant turn with thinking + a tool call, its result. */
function transcript(): PiAgentMessage[] {
  return [
    { role: "user", content: "看一下目录" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考".repeat(40) },
        { type: "text", text: "我来执行" },
        {
          type: "toolCall",
          id: "c1",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "file1" }],
      isError: false,
    },
  ];
}

/** Preview one transcript against the given state. */
function preview(
  messages: PiAgentMessage[],
  state = makeState(),
  config: ContextPruningConfig = CONFIG,
) {
  return previewRound({
    runtime: createContextRuntime(),
    sessionId: "sess-view",
    state,
    adapter: createPiAdapter(),
    messages,
    config,
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("previewRound rendering", () => {
  it("returns the round's numbering, view items and rendered projection", () => {
    const round = preview(transcript());

    assert.ok(round !== undefined);
    assert.deepEqual(
      round.numbered.map((entry) => entry.n),
      [1, 2],
    );
    assert.equal(round.rendered.messages.length, 3);
    assert.equal(round.plan.length, 3, "one plan entry per rendered message");
  });

  it("keeps the tool call and its result inside one numbered unit", () => {
    const round = preview(transcript());

    assert.ok(round !== undefined);
    // The assistant message carries m2's line ref; the result message is
    // part of the same fold unit and stays unnumbered.
    assert.deepEqual(
      round.rendered.messages[1]?.regions.map((region) => region.get()),
      ["思考".repeat(40), "[m2] 我来执行", '{"command":"ls"}'],
    );
    assert.deepEqual(
      round.rendered.messages[2]?.regions.map((region) => region.get()),
      ["file1"],
    );
  });

  it("names the tool call in the rendered invocation table", () => {
    const round = preview(transcript());

    assert.ok(round !== undefined);
    assert.deepEqual(
      round.rendered.invocations.map((invocation) => [
        invocation.name,
        invocation.status,
      ]),
      [["bash", "completed"]],
    );
  });

  it("returns undefined for a transcript without messages", () => {
    assert.equal(preview([]), undefined);
  });

  it("keeps a tool result's own line ref that the transform never injected", () => {
    const messages = transcript();
    messages[2] = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "[m7] original output" }],
      isError: false,
    };

    assert.deepEqual(formatViewPage(preview(messages)), [
      " 4 tokens  user:      │ [m1] 看一下目录",
      '66 tokens  assistant: │ [m2] 我来执行 [tool bash] {"command":"ls"} [result] [m7] original output',
    ]);
  });

  it("folds an active block into the summary text the transform sends", () => {
    const adapter = createPiAdapter();
    const snapshot = adapter.history(transcript());
    const state = makeState();
    state.blocks.set(1, {
      ...makeBlock(snapshot.messages, 1, 3),
      spanHash: computeSpanHash(snapshot, 1, 3),
    });

    const round = preview(transcript(), state);

    assert.ok(round !== undefined);
    assert.deepEqual(
      round.items.map((item) => item.type),
      ["original", "summary"],
    );
    assert.deepEqual(
      round.numbered.map((entry) => entry.n),
      [1, 2],
    );
    // The page reads this: the ref the transform injected, the block label
    // and the summary text the model receives.
    assert.deepEqual(
      round.rendered.messages.map((message) =>
        message.regions.map((region) => region.get()),
      ),
      [["[m1] 看一下目录"], ["[m2] [Block b1 · 2 条]\nsummary [1, 3)"]],
    );
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe("previewRound isolation", () => {
  it("leaves the supplied state untouched", () => {
    const pending = makeMark({ anchorOrdinal: 2 });
    const state: RuntimeFlaggedState = makeState(500);
    state.marks.set(markKey(2), pending);
    state.pendingViewChange = true;

    preview(transcript(), state);

    assert.equal(state.marks.get(markKey(2)), pending);
    assert.equal(pending.effective, false);
    assert.equal(state.pendingViewChange, true);
    assert.equal(state.nudges?.lastNudgeTokens, 500);
  });

  it("leaves the supplied conversation untouched", () => {
    const messages = transcript();
    const before = structuredClone(messages);

    preview(messages);

    assert.deepEqual(messages, before);
  });

  it("logs nothing, even when an active block stops folding", () => {
    const state = makeState();
    state.blocks.set(1, {
      start: 0,
      end: 2,
      summary: "摘要",
      spanHash: "not-the-current-hash",
      status: "active",
      compressedTokens: 10,
      summaryTokens: 2,
      createdAt: 1,
    });

    const round = preview(transcript(), state);

    assert.ok(round !== undefined);
    assert.deepEqual(_getBufferForTesting(), []);
    // The stale transition happened on the copy only.
    assert.equal(state.blocks.get(1)?.status, "active");
  });

  it("does not write the store or publish a round view", async () => {
    const saved: string[] = [];
    const base = createStateStore(makeTmpDir("zoo-preview"));
    const store: StateStore = {
      ...base,
      save: (sessionId, state) => {
        saved.push(sessionId);
        base.save(sessionId, state);
      },
    };
    const runtime = createContextRuntime(store);
    const permit = permitFor("sess-view");
    await runtime.commit(permit, (state) => {
      state.marks.set(markKey(2), makeMark({ anchorOrdinal: 2 }));
    });
    assert.deepEqual(saved, ["sess-view"], "the setup commit is written");

    const round = previewRound({
      runtime,
      sessionId: "sess-view",
      state: makeState(),
      adapter: createPiAdapter(),
      messages: transcript(),
      config: CONFIG,
    });

    assert.ok(round !== undefined);
    assert.deepEqual(saved, ["sess-view"], "the preview writes nothing");
    assert.equal(runtime.roundView("sess-view"), undefined);
    assert.equal(runtime.modelLimit("sess-view"), undefined);
    assert.equal(
      runtime.read(permit, (state) => state.marks.size),
      1,
      "the committed state keeps its mark pending",
    );
  });
});
