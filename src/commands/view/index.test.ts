/**
 * Tests for the `/view` command unit (`src/commands/view/index.ts`).
 *
 * Boundary: the command contribution as the host drives it — it needs the
 * pi-only view channel plus the context capabilities, so a composition that
 * cannot bind them contributes no command, and one that can presents the
 * page of the transform's next output for the session's CURRENT
 * conversation.  No round view is published before the call in these
 * cases: the page must be produced from the session projection alone.
 *
 * The isolation case runs the command against a real per-instance runtime
 * (a temporary store with a write counter) and asserts that the preview
 * wrote no state, no store file, no round view, no model limit, no log and
 * no notice, and left the input conversation untouched.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createPiAdapter } from "../../adapters/pi/adapter.js";
import type { PiAgentMessage } from "../../adapters/pi/types.js";
import type { ContextPruningConfig } from "../../core/config-types.js";
import {
  type ContextRuntime,
  createContextRuntime,
  type RuntimeFlaggedState,
} from "../../core/context/runtime.js";
import { computeSpanHash } from "../../core/context/spanhash.js";
import { markKey } from "../../core/context/state.js";
import { createStateStore, type StateStore } from "../../core/context/store.js";
import type { ToolHost } from "../../core/ports/tool-host.js";
import type { ViewHost } from "../../core/ports/view.js";
import { composeForTest, facts } from "../../testkits/compose.js";
import { makeBlock, makeMark } from "../../testkits/context.js";
import { permitFor } from "../../testkits/context-runtime.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { unit } from "./index.js";

/** The profile the unit is selected by. */
const PROFILE = {
  name: "poly",
  agents: [],
  skills: [],
  hooks: [],
  tools: [],
  commands: ["view"],
};

/** A config with no protection map: nothing is released or produced. */
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

/** The page the transcript renders to: one line per unit, tool kept whole. */
const EXPECTED_PAGE = [
  " 4 tokens  user:      │ [m1] 看一下目录",
  '63 tokens  assistant: │ [m2] 我来执行 [tool bash] {"command":"ls"} [result] file1',
];

/** A view host that records every presented page. */
function recordingHost(): { host: ViewHost; pages: string[][] } {
  const pages: string[][] = [];
  const host: ViewHost = {
    present: (_sessionID, lines) => {
      pages.push([...lines]);
    },
  };
  return { host, pages };
}

/** A tool host that records every notice and toast. */
function recordingToolHost(): {
  toolHost: ToolHost;
  notices: string[];
  toasts: string[];
} {
  const notices: string[] = [];
  const toasts: string[] = [];
  return {
    notices,
    toasts,
    toolHost: {
      notify: async (_sessionId, text) => {
        notices.push(text);
      },
      toast: (_sessionId, toast) => {
        toasts.push(toast.text);
      },
    },
  };
}

/** One runtime over its own temporary store (the tests never share state). */
function freshRuntime(): ContextRuntime {
  return createContextRuntime(createStateStore(makeTmpDir("zoo-view-command")));
}

/** One runtime over a temporary store that counts its writes. */
function countingRuntime(): {
  runtime: ContextRuntime;
  saves: string[];
  dir: string;
} {
  const dir = makeTmpDir("zoo-view-command");
  const base = createStateStore(dir);
  const saves: string[] = [];
  const store: StateStore = {
    ...base,
    save: (sessionId, state) => {
      saves.push(sessionId);
      base.save(sessionId, state);
    },
  };
  return { runtime: createContextRuntime(store), saves, dir };
}

/** Run the `/view` command of one composition. */
async function runView(
  caps: Parameters<typeof unit.create>[0],
  sessionID: string,
  messages?: unknown,
): Promise<void> {
  const contribution = unit.create(caps, facts()).commands[0];
  await contribution?.handle(
    {
      command: "view",
      sessionID,
      arguments: "",
      ...(messages === undefined ? {} : { messages }),
    },
    permitFor(sessionID),
  );
}

/** The capabilities the command needs, plus a notice recorder. */
function caps(
  runtime: ContextRuntime,
  viewHost: ViewHost,
  toolHost?: ToolHost,
): Parameters<typeof unit.create>[0] {
  return {
    contextRuntime: runtime,
    contextConfig: CONFIG,
    adapter: createPiAdapter(),
    viewHost,
    ...(toolHost === undefined ? {} : { toolHost }),
  };
}

after(() => {
  _resetForTesting();
});

describe("/view command unit", () => {
  it("is skipped when the host cannot bind the pi-only view capability", () => {
    const composed = composeForTest(PROFILE, [unit], {
      contextRuntime: createContextRuntime(),
      contextConfig: CONFIG,
      adapter: createPiAdapter(),
    });

    assert.deepEqual(composed.commands, {});
    assert.deepEqual(composed.report.skipped, [
      { name: "view", missing: ["viewHost"] },
    ]);
  });

  it("registers /view when the host binds the view capability", () => {
    const composed = composeForTest(PROFILE, [unit], {
      ...caps(freshRuntime(), recordingHost().host),
    });

    assert.deepEqual(Object.keys(composed.commands), ["view"]);
    assert.equal(
      composed.commands.view?.description,
      "显示当轮上下文视图的 mN 行",
    );
  });

  it("presents the transform's current message view without a published round view", async () => {
    const runtime = freshRuntime();
    const { host, pages } = recordingHost();
    assert.equal(runtime.roundView("sess-1"), undefined);

    await runView(caps(runtime, host), "sess-1", transcript());

    assert.deepEqual(pages, [EXPECTED_PAGE]);
  });

  it("presents a hint when the host cannot name the session's messages", async () => {
    const { host, pages } = recordingHost();

    await runView(caps(freshRuntime(), host), "sess-1");

    assert.deepEqual(pages, [["当前会话还没有可显示的消息。"]]);
  });

  it("presents a hint for an empty conversation", async () => {
    const { host, pages } = recordingHost();

    await runView(caps(freshRuntime(), host), "sess-1", []);

    assert.deepEqual(pages, [["当前会话还没有可显示的消息。"]]);
  });

  it("presents a folded block as one summary row under its own mN", async () => {
    const adapter = createPiAdapter();
    const snapshot = adapter.history(transcript());
    const runtime = freshRuntime();
    const permit = permitFor("sess-fold");
    await runtime.commit(permit, (state) => {
      state.blocks.set(1, {
        ...makeBlock(snapshot.messages, 1, 3),
        spanHash: computeSpanHash(snapshot, 1, 3),
      });
    });
    const { host, pages } = recordingHost();

    await runView(caps(runtime, host), "sess-fold", transcript());

    assert.deepEqual(pages, [
      [
        "4 tokens  user:    │ [m1] 看一下目录",
        "9 tokens  summary: │ [m2] [Block b1 · 2 条] summary [1, 3)",
      ],
    ]);
  });

  it("writes nothing and leaves the session untouched", async () => {
    const { runtime, saves } = countingRuntime();
    const permit = permitFor("sess-1");
    await runtime.commit(permit, (state) => {
      state.marks.set(markKey(2), makeMark({ anchorOrdinal: 2 }));
      state.pendingViewChange = true;
    });
    runtime.setModelLimit(permit, 200000, "model-a");
    const committed: RuntimeFlaggedState | undefined = runtime.read(
      permit,
      (state) => state,
    );
    assert.ok(committed !== undefined);
    const marksBefore = [...committed.marks];
    const limit = runtime.modelLimit("sess-1");
    const messages = transcript();
    const before = structuredClone(messages);
    const { host, pages } = recordingHost();
    const { toolHost, notices, toasts } = recordingToolHost();
    _resetForTesting();

    await runView(caps(runtime, host, toolHost), "sess-1", messages);

    assert.deepEqual(pages, [EXPECTED_PAGE]);
    assert.deepEqual(saves, ["sess-1"], "only the setup commit wrote");
    assert.deepEqual([...committed.marks], marksBefore);
    assert.equal(committed.pendingViewChange, true);
    assert.equal(runtime.modelLimit("sess-1"), limit);
    assert.equal(runtime.roundView("sess-1"), undefined);
    assert.deepEqual(messages, before, "the input conversation is untouched");
    assert.deepEqual(notices, [], "no notice was posted");
    assert.deepEqual(toasts, [], "no toast was shown");
    assert.deepEqual(_getBufferForTesting(), [], "no log was written");
  });
});
