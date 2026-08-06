/**
 * Tests for the message-ref assign / inject / strip module.
 *
 * Covers: sequential determinism, restart consistency, stripping
 * (assistant only, user preserved), injection placement (last text
 * part, tool-only skip, ignored skip), capacity exhaustion,
 * compaction reset, and non-destructiveness.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import type { ContextMessageEntry } from "../metrics.js";
import {
  _clearAllSessionsForTesting,
  deleteSessionState,
  getOrCreateSessionState,
  readPersistedRefs,
  removeSession,
  saveSessionState,
} from "./marks.js";
import {
  _clearAllRefsForTesting,
  _setNextRefForTesting,
  assignMessageRefs,
  getLastCompactionBoundaryId,
  getMessageIdByRef,
  getMessageRefById,
  injectMessageRefs,
  resetMessageRefs,
  setLastCompactionBoundaryId,
  snapshotRefs,
  stripHallucinatedRefs,
  stripRefsFromString,
} from "./message-refs.js";
import {
  MAX_INDEX,
  ZOO_MSG_ID_CANONICAL_END_REGEX,
  ZOO_MSG_ID_TAG,
} from "./types.js";

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
  _clearAllRefsForTesting();
  for (const sid of PERSISTED_SESSION_IDS) {
    deleteSessionState(sid);
    removeSession(sid);
  }
  _clearAllSessionsForTesting();
});

/**
 * Session IDs used by the persistence tests — their state files must be
 * cleaned up in teardown so a stale snapshot never leaks into another
 * test's registry hydration.
 */
const PERSISTED_SESSION_IDS = [
  "sess-persist-hydrate",
  "sess-persist-restart",
  "sess-persist-fresh",
  "sess-persist-reset",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textPart(
  text: string,
  ignored = false,
): { type: string; text: string; ignored?: boolean } {
  return { type: "text", text, ...(ignored ? { ignored: true } : {}) };
}

function msg(
  role: string,
  id: string,
  parts: Array<{ type: string; text?: string; ignored?: boolean }>,
  sessionID?: string,
  extra?: { ignored?: boolean },
): ContextMessageEntry {
  const info: Record<string, unknown> = { role, id };
  if (sessionID) info.sessionID = sessionID;
  if (extra?.ignored) info.ignored = true;
  return {
    info: info as unknown as ContextMessageEntry["info"],
    parts: parts as ContextMessageEntry["parts"],
  };
}

/**
 * Build the expected tag string for a given ref.
 */
function tag(ref: string): string {
  return `<${ZOO_MSG_ID_TAG}>${ref}</${ZOO_MSG_ID_TAG}>`;
}

/**
 * Run the full strip→assign→inject pipeline.
 */
function runPipeline(
  sessionId: string,
  messages: ContextMessageEntry[],
): number {
  stripHallucinatedRefs(messages);
  const assigned = assignMessageRefs(sessionId, messages);
  injectMessageRefs(sessionId, messages);
  return assigned;
}

// ---------------------------------------------------------------------------
// Sequential determinism
// ---------------------------------------------------------------------------

describe("sequential determinism", () => {
  it("same stored input produces byte-identical output each round", () => {
    const sessionId = "sess-det";
    const baseInput: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("Hello")]),
      msg("assistant", "a1", [textPart("Hi there")]),
      msg("user", "u2", [textPart("List files")]),
      msg("assistant", "a2", [
        textPart("Here are the files:"),
        textPart("file1.txt\nfile2.txt"),
      ]),
    ];

    // Round 1: fresh copy of baseInput (simulates reading from storage).
    const input1 = JSON.parse(JSON.stringify(baseInput));
    runPipeline(sessionId, input1);
    const snapshot1 = JSON.parse(JSON.stringify(input1));

    // Round 2: fresh copy of the SAME baseInput.
    const input2 = JSON.parse(JSON.stringify(baseInput));
    runPipeline(sessionId, input2);
    const snapshot2 = JSON.parse(JSON.stringify(input2));

    assert.deepEqual(snapshot1, snapshot2);
  });

  it("pipeline produces same output for deep-copied identical input", () => {
    // Verify that running the pipeline on an independently constructed
    // copy of the same messages yields identical output.
    const sessionId = "sess-det-copy";
    const baseInput: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("Hello")]),
      msg("assistant", "a1", [textPart("World")]),
    ];

    const input1 = JSON.parse(JSON.stringify(baseInput));
    runPipeline(sessionId, input1);

    const sessionId2 = "sess-det-copy-2";
    const input2 = JSON.parse(JSON.stringify(baseInput));
    runPipeline(sessionId2, input2);

    assert.deepEqual(
      JSON.parse(JSON.stringify(input1)),
      JSON.parse(JSON.stringify(input2)),
    );
  });
});

// ---------------------------------------------------------------------------
// Restart consistency
// ---------------------------------------------------------------------------

describe("restart consistency", () => {
  it("fresh registry re-walking same array produces identical ref mapping", () => {
    const sessionId = "sess-restart";
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [textPart("first")]),
      msg("assistant", "a2", [textPart("second")]),
      msg("assistant", "a3", [textPart("third")]),
    ];

    // First "session": assign + inject refs.
    const count1 = assignMessageRefs(sessionId, messages);
    assert.equal(count1, 3);
    injectMessageRefs(sessionId, messages);

    // Verify injected tags.
    assert.ok(
      (messages[0].parts?.[0] as { text?: string }).text?.includes(
        tag("m0001"),
      ),
    );
    assert.ok(
      (messages[1].parts?.[0] as { text?: string }).text?.includes(
        tag("m0002"),
      ),
    );
    assert.ok(
      (messages[2].parts?.[0] as { text?: string }).text?.includes(
        tag("m0003"),
      ),
    );

    // Simulate restart: clear registries.
    _clearAllRefsForTesting();

    // Strip existing tags, then re-assign + inject on same array.
    stripHallucinatedRefs(messages);
    const count2 = assignMessageRefs(sessionId, messages);
    injectMessageRefs(sessionId, messages);

    // Same refs assigned (same ordering) — same ref mapping.
    assert.equal(count2, 3); // Fresh registry — all newly assigned.
    assert.ok(
      (messages[0].parts?.[0] as { text?: string }).text?.includes(
        tag("m0001"),
      ),
    );
    assert.ok(
      (messages[1].parts?.[0] as { text?: string }).text?.includes(
        tag("m0002"),
      ),
    );
    assert.ok(
      (messages[2].parts?.[0] as { text?: string }).text?.includes(
        tag("m0003"),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Persisted ref registry (snapshot + restore across simulated restart)
// ---------------------------------------------------------------------------

describe("persisted ref registry", () => {
  it("hydrates from persisted refs when the runtime registry is absent", () => {
    const sessionId = "sess-persist-hydrate";
    const round1: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("q1")]),
      msg("assistant", "a1", [textPart("r1")]),
      msg("user", "u2", [textPart("q2")]),
    ];

    // Round 1: assign refs, then snapshot into state.refs and persist
    // (mirrors the compress-save path).
    const count1 = assignMessageRefs(sessionId, round1);
    assert.equal(count1, 3);
    const state = getOrCreateSessionState(sessionId);
    const refsSnapshot = snapshotRefs(sessionId);
    if (refsSnapshot) state.refs = refsSnapshot;
    saveSessionState(sessionId, state);

    // Simulated restart: wipe the runtime registry (and session state).
    _clearAllRefsForTesting();
    removeSession(sessionId);
    _clearAllSessionsForTesting();

    // Same messages re-assigned — refs must come from the snapshot,
    // so the same message keeps the same ref as before.
    const count2 = assignMessageRefs(sessionId, round1);
    assert.equal(count2, 0, "snapshot refs must not be re-assigned");
    assert.equal(getMessageIdByRef(sessionId, "m0001"), "u1");
    assert.equal(getMessageIdByRef(sessionId, "m0002"), "a1");
    assert.equal(getMessageIdByRef(sessionId, "m0003"), "u2");

    // A NEW message continues from the restored nextRef (m0004).
    const more: ContextMessageEntry[] = [
      msg("assistant", "a2", [textPart("r2")]),
    ];
    const count3 = assignMessageRefs(sessionId, more);
    assert.equal(count3, 1);
    assert.equal(getMessageIdByRef(sessionId, "m0004"), "a2");
  });

  it("keeps refs identical across a fold + restart (cache-stability invariant)", () => {
    const sessionId = "sess-persist-restart";
    const full: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("q1")]),
      msg("assistant", "a1", [textPart("r1")]),
      msg("user", "u2", [textPart("q2")]),
      msg("assistant", "a2", [textPart("r2")]),
      msg("user", "u3", [textPart("q3")]),
      msg("assistant", "a3", [textPart("r3")]),
      msg("user", "u4", [textPart("q4")]),
    ];

    // Round 1: assign over the full (unfolded) list → m0001..m0007.
    assert.equal(assignMessageRefs(sessionId, full), 7);
    assert.equal(getMessageIdByRef(sessionId, "m0001"), "u1");
    assert.equal(getMessageIdByRef(sessionId, "m0007"), "u4");

    // Snapshot at the last save (pre-fold — mirrors the compress save).
    const state = getOrCreateSessionState(sessionId);
    const refsSnapshot = snapshotRefs(sessionId);
    if (refsSnapshot) state.refs = refsSnapshot;
    saveSessionState(sessionId, state);

    // Runtime continuation over a FOLDED-style list: u2/a2/u3 removed,
    // one synthetic `zoo-fold-b1` inserted at the anchor position, plus
    // one brand-new message (u5).
    const folded: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("q1")]),
      msg("assistant", "a1", [textPart("r1")]),
      msg("user", "zoo-fold-b1", [textPart("[Compression Block b1] summary")]),
      msg("assistant", "a3", [textPart("r3")]),
      msg("user", "u4", [textPart("q4")]),
      msg("user", "u5", [textPart("q5")]),
    ];
    const count2 = assignMessageRefs(sessionId, folded);
    assert.equal(count2, 2, "zoo-fold-b1 and u5 are the only new messages");
    assert.equal(getMessageIdByRef(sessionId, "m0008"), "zoo-fold-b1");
    assert.equal(getMessageIdByRef(sessionId, "m0009"), "u5");

    // Simulated restart: only the disk snapshot survives.
    _clearAllRefsForTesting();
    removeSession(sessionId);
    _clearAllSessionsForTesting();

    // Post-restart: hydrate from the snapshot, then assign over the same
    // folded view.  Every message present in both rounds must keep its
    // exact pre-restart ref; synthetic/new messages re-derive the same
    // numbers from the restored nextRef.
    const count3 = assignMessageRefs(sessionId, folded);
    assert.equal(count3, 2, "hydrated refs are not re-assigned");
    assert.equal(getMessageIdByRef(sessionId, "m0001"), "u1");
    assert.equal(getMessageIdByRef(sessionId, "m0002"), "a1");
    assert.equal(getMessageIdByRef(sessionId, "m0006"), "a3");
    assert.equal(getMessageIdByRef(sessionId, "m0007"), "u4");
    assert.equal(getMessageIdByRef(sessionId, "m0008"), "zoo-fold-b1");
    assert.equal(getMessageIdByRef(sessionId, "m0009"), "u5");
  });

  it("no persisted refs → fresh numbering from m0001 (unchanged behavior)", () => {
    const sessionId = "sess-persist-fresh";
    deleteSessionState(sessionId); // ensure no stale file on disk
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("q1")]),
      msg("assistant", "a1", [textPart("r1")]),
    ];

    const count = assignMessageRefs(sessionId, messages);
    assert.equal(count, 2);
    assert.equal(getMessageIdByRef(sessionId, "m0001"), "u1");
    assert.equal(getMessageIdByRef(sessionId, "m0002"), "a1");
  });
});

// ---------------------------------------------------------------------------
// Stripping
// ---------------------------------------------------------------------------

describe("stripHallucinatedRefs", () => {
  // --- End-position tags ARE stripped ---

  it("strips end-position well-formed tag from assistant text", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        textPart("Some text\n<zoo-msg-id>m0001</zoo-msg-id>"),
      ]),
    ];

    stripHallucinatedRefs(messages);

    assert.equal(
      (messages[0].parts?.[0] as { text?: string }).text,
      "Some text",
    );
  });

  it("strips end-position tag from user message text (universal strip)", () => {
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [
        textPart("Some text\n<zoo-msg-id>m0001</zoo-msg-id>"),
      ]),
    ];

    stripHallucinatedRefs(messages);

    assert.equal(
      (messages[0].parts?.[0] as { text?: string }).text,
      "Some text",
    );
  });

  it("strips end-position fuzzy tag (misspelled tag name)", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [textPart("text\n<zoo-msg-id>m0001</zoomsgid>")]),
    ];

    stripHallucinatedRefs(messages);

    assert.equal((messages[0].parts?.[0] as { text?: string }).text, "text");
  });

  it("strips end-position stacked trailing fragments (loop)", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        textPart(
          "text\n<zoo-msg-id>m0001</zoo-msg-id>\n<zoo-msg-id>m0002</zoomsgid>",
        ),
      ]),
    ];

    stripHallucinatedRefs(messages);

    assert.equal((messages[0].parts?.[0] as { text?: string }).text, "text");
  });

  it("strips end-position orphan close tag from tool output", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        {
          type: "tool",
          state: {
            input: "",
            output: "data</zoo-msg-id>",
          },
        } as unknown as {
          type: string;
          text?: string;
        },
      ]),
    ];

    stripHallucinatedRefs(messages);

    const part = messages[0].parts?.[0] as unknown as Record<string, unknown>;
    const state = part.state as Record<string, unknown>;
    assert.equal(state.output, "data");
  });

  it("strips end-position orphan open tag from text", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [textPart("text\n<zoo-msg-id>")]),
    ];

    stripHallucinatedRefs(messages);

    assert.equal((messages[0].parts?.[0] as { text?: string }).text, "text");
  });

  // --- Mid-text tags are PRESERVED (new semantics) ---

  it("preserves mid-text forged tag in assistant text", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        textPart("Result is\n<zoo-msg-id>m9999</zoo-msg-id> done"),
      ]),
    ];

    stripHallucinatedRefs(messages);

    // Tag NOT at end --- must be preserved.
    assert.equal(
      (messages[0].parts?.[0] as { text?: string }).text,
      "Result is\n<zoo-msg-id>m9999</zoo-msg-id> done",
    );
  });

  it("preserves mid-text forged tag in user text", () => {
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [
        textPart("See <zoo-msg-id>m9999</zoo-msg-id> for reference"),
      ]),
    ];

    stripHallucinatedRefs(messages);

    assert.equal(
      (messages[0].parts?.[0] as { text?: string }).text,
      "See <zoo-msg-id>m9999</zoo-msg-id> for reference",
    );
  });

  it("preserves multiple mid-text tag occurrences in the same part", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        textPart(
          "<zoo-msg-id>m9999</zoo-msg-id> and <zoo-msg-id>m9998</zoo-msg-id> trailing",
        ),
      ]),
    ];

    stripHallucinatedRefs(messages);

    assert.equal(
      (messages[0].parts?.[0] as { text?: string }).text,
      "<zoo-msg-id>m9999</zoo-msg-id> and <zoo-msg-id>m9998</zoo-msg-id> trailing",
    );
  });

  it("preserves mid-text tags in tool output", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        {
          type: "tool",
          state: {
            input: "",
            output:
              "some result\n<zoo-msg-id>m9999</zoo-msg-id>\n<zoo-msg-id>m9998</zoo-msg-id>more result",
          },
        } as unknown as {
          type: string;
          text?: string;
        },
      ]),
    ];

    stripHallucinatedRefs(messages);

    const part = messages[0].parts?.[0] as unknown as Record<string, unknown>;
    const state = part.state as Record<string, unknown>;
    assert.equal(
      state.output,
      "some result\n<zoo-msg-id>m9999</zoo-msg-id>\n<zoo-msg-id>m9998</zoo-msg-id>more result",
    );
  });

  it("preserves mid-text orphan tags in text parts", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [textPart("orphan open <zoo-msg-id> here")]),
      msg("user", "u1", [textPart("orphan close </zoo-msg-id> here")]),
    ];

    stripHallucinatedRefs(messages);

    assert.equal(
      (messages[0].parts?.[0] as { text?: string }).text,
      "orphan open <zoo-msg-id> here",
    );
    assert.equal(
      (messages[1].parts?.[0] as { text?: string }).text,
      "orphan close </zoo-msg-id> here",
    );
  });

  // --- Bare / standalone refs not stripped ---

  it("preserves bare standalone ref not preceded by tag name", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [textPart("some text m0001")]),
    ];

    stripHallucinatedRefs(messages);

    assert.equal(
      (messages[0].parts?.[0] as { text?: string }).text,
      "some text m0001",
    );
  });

  it("preserves ref separated from tag fragment by space (no angle brackets)", () => {
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [textPart("some text m0001 zoo-msg-id")]),
    ];

    stripHallucinatedRefs(messages);

    assert.equal(
      (messages[0].parts?.[0] as { text?: string }).text,
      "some text m0001 zoo-msg-id",
    );
  });
});
// ---------------------------------------------------------------------------
// Injection placement
// ---------------------------------------------------------------------------

describe("injectMessageRefs placement", () => {
  it("appends tag to the end of the LAST text part", () => {
    const sessionId = "sess-inject-last";
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [textPart("first part"), textPart("second part")]),
    ];

    assignMessageRefs(sessionId, messages);
    injectMessageRefs(sessionId, messages);

    const parts = messages[0].parts ?? [];
    // First text part unchanged
    assert.equal((parts[0] as { text?: string }).text, "first part");
    // Last text part gets the tag appended
    assert.equal(
      (parts[1] as { text?: string }).text,
      `second part\n${tag("m0001")}`,
    );
  });

  it("injects tag into user message with text part", () => {
    const sessionId = "sess-inject-user";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")]),
    ];

    assignMessageRefs(sessionId, messages);
    injectMessageRefs(sessionId, messages);

    // User message should receive a tag at the end of the last text part.
    assert.equal(
      (messages[0].parts?.[0] as { text?: string }).text,
      `hello\n${tag("m0001")}`,
    );
  });

  it("injects tags into both user and assistant messages", () => {
    const sessionId = "sess-inject-mixed";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("user query")]),
      msg("assistant", "a1", [textPart("assistant reply")]),
    ];

    assignMessageRefs(sessionId, messages);
    const count = injectMessageRefs(sessionId, messages);
    assert.equal(count, 2); // Both user and assistant injected.

    assert.ok(
      (messages[0].parts?.[0] as { text?: string }).text?.endsWith(
        `\n${tag("m0001")}`,
      ),
    );
    assert.ok(
      (messages[1].parts?.[0] as { text?: string }).text?.endsWith(
        `\n${tag("m0002")}`,
      ),
    );
  });

  it("injects synthetic tag into tool-only assistant with no usable tool output", () => {
    const sessionId = "sess-inject-tool-synth";
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        { type: "tool", text: undefined } as unknown as {
          type: string;
          text?: string;
        },
      ]),
    ];

    const assigned = assignMessageRefs(sessionId, messages);
    assert.equal(assigned, 1);

    const injected = injectMessageRefs(sessionId, messages);
    assert.equal(injected, 1); // Synthetic part created

    // Synthetic text part inserted BEFORE the first (only) tool part.
    const parts = messages[0].parts ?? [];
    assert.equal(parts.length, 2);
    assert.equal((parts[0] as { type: string }).type, "text");
    assert.equal((parts[0] as { text?: string }).text, tag("m0001"));
    assert.equal((parts[1] as { type: string }).type, "tool");
  });

  it("skips ignored messages", () => {
    const sessionId = "sess-inject-ignored";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")], undefined, { ignored: true }),
    ];

    const assigned = assignMessageRefs(sessionId, messages);
    assert.equal(assigned, 0); // Ignored — not assigned

    const injected = injectMessageRefs(sessionId, messages);
    assert.equal(injected, 0); // Ignored — not injected
  });

  it("skips messages without an assigned ref", () => {
    const sessionId = "sess-inject-noref";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")]),
    ];

    // Do NOT call assign — no refs exist
    const injected = injectMessageRefs(sessionId, messages);
    assert.equal(injected, 0);
  });

  it("assistant: tool-output priority — tag in outputs, not text", () => {
    const sessionId = "sess-inject-tool-pri";
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        {
          type: "text",
          text: "some text",
        },
        {
          type: "tool",
          state: { input: "", output: "tool result" },
        } as unknown as {
          type: string;
          text?: string;
        },
      ]),
    ];

    assignMessageRefs(sessionId, messages);
    injectMessageRefs(sessionId, messages);

    // Tag must be in the tool output, not the text part.
    const parts = messages[0].parts ?? [];
    assert.equal(
      (parts[0] as { text?: string }).text,
      "some text",
      "text part unchanged",
    );
    const toolPart = parts[1] as unknown as Record<string, unknown>;
    const state = toolPart.state as Record<string, unknown>;
    assert.equal(
      state.output,
      `tool result\n${tag("m0001")}`,
      "tool output carries the tag",
    );
  });

  it("assistant: tool part with non-completed status falls back to text part", () => {
    const sessionId = "sess-inject-status-skip";
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        {
          type: "tool",
          state: {
            input: "",
            output: "running output",
            status: "running",
          },
        } as unknown as {
          type: string;
          text?: string;
        },
        textPart("fallback text"),
      ]),
    ];

    assignMessageRefs(sessionId, messages);
    injectMessageRefs(sessionId, messages);

    // Tool output must NOT get the tag (status !== "completed").
    const toolPart = messages[0].parts?.[0] as unknown as Record<
      string,
      unknown
    >;
    const toolState = toolPart.state as Record<string, unknown>;
    assert.equal(
      toolState.output,
      "running output",
      "tool output must not carry the tag",
    );

    // Tag must be in the last text part (fallback placement).
    const lastTextPart = messages[0].parts?.[1] as { text?: string };
    assert.equal(
      lastTextPart.text,
      `fallback text\n${tag("m0001")}`,
      "tag falls back to last text part",
    );
  });

  it("assistant: tag goes to last text part when no tool parts", () => {
    const sessionId = "sess-inject-no-tool";
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [textPart("only text")]),
    ];

    assignMessageRefs(sessionId, messages);
    injectMessageRefs(sessionId, messages);

    assert.equal(
      (messages[0].parts?.[0] as { text?: string }).text,
      `only text\n${tag("m0001")}`,
    );
  });

  it("assistant: synthetic part inserted before first tool when no text part and tool has no usable output", () => {
    const sessionId = "sess-inject-synth-before-tool";
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        {
          type: "tool",
          state: { input: "" }, // no output field
        } as unknown as {
          type: string;
          text?: string;
        },
        {
          type: "tool",
          state: { input: "", output: 42 }, // output is not a string
        } as unknown as {
          type: string;
          text?: string;
        },
      ]),
    ];

    assignMessageRefs(sessionId, messages);
    injectMessageRefs(sessionId, messages);

    // Synthetic part inserted before the first tool part.
    const parts = messages[0].parts ?? [];
    assert.equal(parts.length, 3);
    assert.equal((parts[0] as { type: string }).type, "text");
    assert.equal((parts[0] as { text?: string }).text, tag("m0001"));
  });

  it("user: tag appended to every text part", () => {
    const sessionId = "sess-inject-user-multi";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("first part"), textPart("second part")]),
    ];

    assignMessageRefs(sessionId, messages);
    injectMessageRefs(sessionId, messages);

    const parts = messages[0].parts ?? [];
    assert.equal(
      (parts[0] as { text?: string }).text,
      `first part\n${tag("m0001")}`,
    );
    assert.equal(
      (parts[1] as { text?: string }).text,
      `second part\n${tag("m0001")}`,
    );
  });

  it("user: synthetic part pushed when no text parts exist", () => {
    const sessionId = "sess-inject-user-synth";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [
        {
          type: "tool",
          state: { input: "", output: "data" },
        } as unknown as {
          type: string;
          text?: string;
        },
      ]),
    ];

    assignMessageRefs(sessionId, messages);
    injectMessageRefs(sessionId, messages);

    // Synthetic text part pushed to end.
    const parts = messages[0].parts ?? [];
    assert.equal(parts.length, 2);
    assert.equal((parts[1] as { type: string }).type, "text");
    assert.equal((parts[1] as { text?: string }).text, tag("m0001"));
  });

  it("dedup guard prevents double-tag when inject runs twice", () => {
    const sessionId = "sess-inject-dedup";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")]),
      msg("assistant", "a1", [
        {
          type: "tool",
          tool: "bash",
          callID: "c1",
          state: { input: "", output: "result" },
        } as unknown as {
          type: string;
          text?: string;
        },
      ]),
    ];

    assignMessageRefs(sessionId, messages);

    // First inject.
    const count1 = injectMessageRefs(sessionId, messages);
    assert.equal(count1, 2); // Both injected.

    // Second inject — dedup guard should prevent double-tag.
    const count2 = injectMessageRefs(sessionId, messages);
    assert.equal(count2, 2); // Both still "injected" (dedup = true).

    // User text: tag appears exactly once.
    const userText = (messages[0].parts?.[0] as { text?: string }).text ?? "";
    const userMatches = userText.match(/<zoo-msg-id>m\d{4}<\/zoo-msg-id>/g);
    assert.equal(userMatches?.length ?? 0, 1);

    // Assistant tool output: tag appears exactly once.
    const toolPart = messages[1].parts?.[0] as unknown as Record<
      string,
      unknown
    >;
    const toolOutput = (toolPart.state as Record<string, unknown>)
      .output as string;
    const toolMatches = toolOutput.match(/<zoo-msg-id>m\d{4}<\/zoo-msg-id>/g);
    assert.equal(toolMatches?.length ?? 0, 1);
  });

  it("skips messages with unknown role (neither user nor assistant)", () => {
    const sessionId = "sess-inject-system";
    const messages: ContextMessageEntry[] = [
      msg("system", "s1", [textPart("system message")]),
    ];

    assignMessageRefs(sessionId, messages);
    const injected = injectMessageRefs(sessionId, messages);
    assert.equal(injected, 0); // system role skipped
  });
});

// ---------------------------------------------------------------------------
// Capacity exhaustion
// ---------------------------------------------------------------------------

describe("capacity exhaustion", () => {
  it("stops assigning at MAX_INDEX and does not throw", () => {
    const sessionId = "sess-cap";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("first")]),
    ];

    // Assign one ref to initialize the registry.
    assignMessageRefs(sessionId, messages);

    // Bump nextRef beyond MAX_INDEX to simulate exhaustion.
    _setNextRefForTesting(sessionId, MAX_INDEX + 1);

    // Try to assign another message — should not throw.
    const messages2: ContextMessageEntry[] = [
      msg("user", "u2", [textPart("second")]),
    ];

    const count = assignMessageRefs(sessionId, messages2);
    assert.equal(count, 0); // No new assignments — capacity exhausted.

    // Inject should skip u2 since it has no ref.
    const injected = injectMessageRefs(sessionId, messages2);
    assert.equal(injected, 0);

    // u2 text should NOT contain a tag.
    assert.equal((messages2[0].parts?.[0] as { text?: string }).text, "second");
  });

  it("warns once per session on capacity exhaustion", () => {
    const sessionId = "sess-cap-warn";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("first")]),
    ];

    // Initialize registry.
    assignMessageRefs(sessionId, messages);
    _setNextRefForTesting(sessionId, MAX_INDEX + 1);

    // First exhaustion — should log a warning.
    const messages2: ContextMessageEntry[] = [
      msg("user", "u2", [textPart("second")]),
    ];
    assignMessageRefs(sessionId, messages2);

    const entries = _getBufferForTesting();
    const warnEntries = entries.filter(
      (e) =>
        e.hook === "message-refs" &&
        e.event === "refs_capacity_exhausted" &&
        e.level === "warn",
    );
    assert.equal(warnEntries.length, 1);

    // Second call — should NOT log another warning.
    const messages3: ContextMessageEntry[] = [
      msg("user", "u3", [textPart("third")]),
    ];
    assignMessageRefs(sessionId, messages3);

    const entriesAfter = _getBufferForTesting();
    const warnEntriesAfter = entriesAfter.filter(
      (e) =>
        e.hook === "message-refs" &&
        e.event === "refs_capacity_exhausted" &&
        e.level === "warn",
    );
    assert.equal(warnEntriesAfter.length, 1); // Still 1 — not incremented.
  });

  it("assigns ref m9999 before stopping at the boundary", () => {
    const sessionId = "sess-cap-boundary";
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [textPart("boundary test")]),
    ];

    // Set nextRef to MAX_INDEX so the next assignment uses m9999.
    _setNextRefForTesting(sessionId, MAX_INDEX);
    const count = assignMessageRefs(sessionId, messages);
    assert.equal(count, 1); // m9999 assigned.

    injectMessageRefs(sessionId, messages);
    assert.ok(
      (messages[0].parts?.[0] as { text?: string }).text?.includes(
        tag("m9999"),
      ),
    );

    // Now nextRef is MAX_INDEX + 1 = 10000, which exceeds MAX_INDEX.
    const messages2: ContextMessageEntry[] = [
      msg("assistant", "a2", [textPart("beyond")]),
    ];
    const count2 = assignMessageRefs(sessionId, messages2);
    assert.equal(count2, 0); // Stopped.
  });
});

// ---------------------------------------------------------------------------
// Compaction reset
// ---------------------------------------------------------------------------

describe("compaction reset", () => {
  it("resetMessageRefs clears registry so refs are renumbered from m0001", () => {
    const sessionId = "sess-compact";
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [textPart("pre-compact")]),
      msg("assistant", "a2", [textPart("pre-compact asst")]),
    ];

    // Assign refs.
    assignMessageRefs(sessionId, messages);

    // Simulate compaction: reset.
    resetMessageRefs(sessionId);

    // Re-assign — should start from m0001.
    const messages2: ContextMessageEntry[] = [
      msg("assistant", "a1", [textPart("post-compact")]),
      msg("assistant", "a2", [textPart("post-compact asst")]),
    ];

    const assigned = assignMessageRefs(sessionId, messages2);
    assert.equal(assigned, 2);

    injectMessageRefs(sessionId, messages2);
    assert.ok(
      (messages2[0].parts?.[0] as { text?: string }).text?.includes(
        tag("m0001"),
      ),
    );
    assert.ok(
      (messages2[1].parts?.[0] as { text?: string }).text?.includes(
        tag("m0002"),
      ),
    );
  });

  it("resetMessageRefs does not throw for non-existent session", () => {
    resetMessageRefs("sess-nonexistent");
    assert.ok(true);
  });

  it("reset after a persisted snapshot renumbers fresh messages from m0001", () => {
    const sessionId = "sess-persist-reset";
    const round1: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("q1")]),
      msg("assistant", "a1", [textPart("r1")]),
      msg("user", "u2", [textPart("q2")]),
    ];

    // Round 1: assign refs, then persist a snapshot (mirrors the
    // compress-save path — snapshotRefs → state.refs → saveSessionState).
    assert.equal(assignMessageRefs(sessionId, round1), 3);
    const state = getOrCreateSessionState(sessionId);
    const refsSnapshot = snapshotRefs(sessionId);
    if (refsSnapshot) state.refs = refsSnapshot;
    saveSessionState(sessionId, state);

    // Sanity: the stale snapshot really is on disk.
    assert.ok(readPersistedRefs(sessionId) !== null);

    // Compaction reset must invalidate BOTH the runtime registry and the
    // persisted snapshot — otherwise the next ensureRegistry would
    // re-hydrate the stale counter and refs would NOT renumber.
    resetMessageRefs(sessionId);
    assert.equal(
      readPersistedRefs(sessionId),
      null,
      "stale persisted snapshot must be cleared",
    );

    // Fresh (post-compaction) messages re-assigned — must start from
    // m0001, NOT continue from the stale nextRef (which was 4).
    const fresh: ContextMessageEntry[] = [
      msg("assistant", "n1", [textPart("post-compact")]),
      msg("user", "n2", [textPart("post-compact q")]),
    ];
    const assigned = assignMessageRefs(sessionId, fresh);
    assert.equal(assigned, 2);
    assert.equal(getMessageIdByRef(sessionId, "m0001"), "n1");
    assert.equal(getMessageIdByRef(sessionId, "m0002"), "n2");
    // The stale counter must not leak through — a continuation would
    // have assigned n1 → m0004.
    assert.equal(getMessageIdByRef(sessionId, "m0004"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Compaction boundary ID
// ---------------------------------------------------------------------------

describe("compaction boundary ID", () => {
  it("get returns null for non-existent session", () => {
    assert.equal(getLastCompactionBoundaryId("sess-no-boundary"), null);
  });

  it("set then get round-trips a boundary ID", () => {
    const sessionId = "sess-boundary-rw";
    setLastCompactionBoundaryId(sessionId, "msg_boundary_123");
    assert.equal(getLastCompactionBoundaryId(sessionId), "msg_boundary_123");
  });

  it("set creates registry when absent", () => {
    const sessionId = "sess-boundary-create";
    setLastCompactionBoundaryId(sessionId, "msg_boundary_456");
    // Reading back should work even though no assign was ever called.
    assert.equal(getLastCompactionBoundaryId(sessionId), "msg_boundary_456");
    // Registry is now usable for normal ref operations.
    const messages = [msg("user", "u1", [textPart("after boundary set")])];
    assert.equal(assignMessageRefs(sessionId, messages), 1);
  });

  it("accepts null to clear the boundary", () => {
    const sessionId = "sess-boundary-clear";
    setLastCompactionBoundaryId(sessionId, "msg_boundary_789");
    assert.equal(getLastCompactionBoundaryId(sessionId), "msg_boundary_789");

    setLastCompactionBoundaryId(sessionId, null);
    assert.equal(getLastCompactionBoundaryId(sessionId), null);
  });

  it("resetMessageRefs also clears the stored boundary ID", () => {
    const sessionId = "sess-boundary-reset";
    setLastCompactionBoundaryId(sessionId, "msg_boundary_999");
    resetMessageRefs(sessionId);
    assert.equal(getLastCompactionBoundaryId(sessionId), null);
  });
});

// ---------------------------------------------------------------------------
// Reverse ref lookup (getMessageIdByRef)
// ---------------------------------------------------------------------------

describe("getMessageIdByRef", () => {
  it("returns the message ID for a ref assigned by assignMessageRefs", () => {
    const sessionId = "sess-ref-lookup-hit";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")]),
      msg("assistant", "a1", [textPart("reply")]),
      msg("user", "u2", [textPart("follow-up")]),
    ];

    assignMessageRefs(sessionId, messages);

    assert.equal(getMessageIdByRef(sessionId, "m0001"), "u1");
    assert.equal(getMessageIdByRef(sessionId, "m0002"), "a1");
    assert.equal(getMessageIdByRef(sessionId, "m0003"), "u2");
  });

  it("returns undefined for an unknown ref on a known session", () => {
    const sessionId = "sess-ref-lookup-miss";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")]),
    ];

    assignMessageRefs(sessionId, messages);

    // "m0002" was never assigned; "m9999" is far outside the range.
    assert.equal(getMessageIdByRef(sessionId, "m0002"), undefined);
    assert.equal(getMessageIdByRef(sessionId, "m9999"), undefined);
  });

  it("returns undefined for a session with no registry", () => {
    // No assign / set was ever called for this session.
    assert.equal(
      getMessageIdByRef("sess-ref-lookup-empty", "m0001"),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Forward ref lookup (getMessageRefById)
// ---------------------------------------------------------------------------

describe("getMessageRefById", () => {
  it("returns the ref for a message ID assigned by assignMessageRefs", () => {
    const sessionId = "sess-ref-fwd-hit";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")]),
      msg("assistant", "a1", [textPart("reply")]),
      msg("user", "u2", [textPart("follow-up")]),
    ];

    assignMessageRefs(sessionId, messages);

    assert.equal(getMessageRefById(sessionId, "u1"), "m0001");
    assert.equal(getMessageRefById(sessionId, "a1"), "m0002");
    assert.equal(getMessageRefById(sessionId, "u2"), "m0003");
  });

  it("returns undefined for an unknown message ID on a known session", () => {
    const sessionId = "sess-ref-fwd-miss";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")]),
    ];

    assignMessageRefs(sessionId, messages);

    // "u2" was never assigned a ref.
    assert.equal(getMessageRefById(sessionId, "u2"), undefined);
  });

  it("returns undefined for a session with no registry", () => {
    // No assign / set was ever called for this session.
    assert.equal(getMessageRefById("sess-ref-fwd-empty", "u1"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Non-destructiveness
// ---------------------------------------------------------------------------

describe("non-destructiveness", () => {
  it("strip+inject only mutates intended fields", () => {
    const sessionId = "sess-nd";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")]),
      msg("assistant", "a1", [{ type: "text", text: "response" }], "sess-nd"),
    ];

    // Deep copy to snapshot.
    const snapshot = JSON.parse(JSON.stringify(messages));

    // Apply assign + inject (no strip — no tags to remove).
    assignMessageRefs(sessionId, messages);
    injectMessageRefs(sessionId, messages);

    // Both user and assistant messages get tags.
    // u1 → m0001, a1 → m0002.

    // ── User message: info & parts length unchanged; text mutated.
    assert.deepEqual(messages[0].info, snapshot[0].info);
    assert.equal(messages[0].parts?.length, snapshot[0].parts?.length);
    const userSnapshotText = (snapshot[0].parts?.[0] as { text?: string }).text;
    const userMutatedText = (messages[0].parts?.[0] as { text?: string }).text;
    assert.notEqual(userSnapshotText, userMutatedText);
    assert.ok(userMutatedText?.endsWith(`\n${tag("m0001")}`));

    // ── Assistant message: info & parts length unchanged; text mutated.
    assert.deepEqual(messages[1].info, snapshot[1].info);
    assert.equal(messages[1].parts?.length, snapshot[1].parts?.length);
    const asstSnapshotText = (snapshot[1].parts?.[0] as { text?: string }).text;
    const asstMutatedText = (messages[1].parts?.[0] as { text?: string }).text;
    assert.notEqual(asstSnapshotText, asstMutatedText);
    assert.ok(asstMutatedText?.endsWith(`\n${tag("m0002")}`));
  });
});

// ---------------------------------------------------------------------------
// stripRefsFromString
// ---------------------------------------------------------------------------
describe("stripRefsFromString", () => {
  // --- End-position tags ARE stripped ---

  it("strips end-position well-formed tag", () => {
    const result = stripRefsFromString(
      "some text\n<zoo-msg-id>m0001</zoo-msg-id>",
    );
    assert.equal(result, "some text");
  });

  it("strips end-position misspelled tag name", () => {
    const result = stripRefsFromString("text\n<zoo-msg-id>m0001</zoomsgid>");
    assert.equal(result, "text");
  });

  it("strips end-position missing closing angle bracket", () => {
    const result = stripRefsFromString("text\n<zoo-msg-id>m0001</zoo-msg-id");
    assert.equal(result, "text");
  });

  it("strips end-position missing closing slash", () => {
    const result = stripRefsFromString("text\n<zoo-msg-id>m0001<zoo-msg-id>");
    assert.equal(result, "text");
  });

  it("strips end-position mixed case variant", () => {
    const result = stripRefsFromString("text\n<ZOO-MSG-ID>M0001</ZOO-MSG-ID>");
    assert.equal(result, "text");
  });

  it("strips end-position orphan close tag", () => {
    const result = stripRefsFromString("text\n</zoo-msg-id>");
    assert.equal(result, "text");
  });

  it("strips end-position orphan open tag", () => {
    const result = stripRefsFromString("text\n<zoo-msg-id>");
    assert.equal(result, "text");
  });

  it("strips end-position stacked trailing fragments (loop)", () => {
    const result = stripRefsFromString(
      "text\n<zoo-msg-id>m0001</zoo-msg-id>\n<zoo-msg-id>m0002</zoomsgid>",
    );
    assert.equal(result, "text");
  });

  it("strips multiple stacked occurrences via loop", () => {
    const result = stripRefsFromString(
      "text\n<zoo-msg-id>m0001</zoo-msg-id>\n<zoo-msg-id>m0002</zoo-msg-id>",
    );
    assert.equal(result, "text");
  });

  it("handles empty string", () => {
    assert.equal(stripRefsFromString(""), "");
  });

  // --- Rule 1 (?:<\/?\s*)? optional closing-fragment branch — missing `<` ---

  it("strips end-position closing fragment missing opening angle bracket (slash prefix)", () => {
    const result = stripRefsFromString("text\nm0001/zoo-msg-id>");
    assert.equal(result, "text");
  });

  it("strips end-position closing fragment missing opening angle bracket (no slash prefix)", () => {
    const result = stripRefsFromString("text\nm0001zoo-msg-id>");
    assert.equal(result, "text");
  });

  // --- Rule 1 (?:<)? pre-ref branch — stray `<` before ref ---

  it("strips end-position stray angle bracket before ref with closing residue", () => {
    const result = stripRefsFromString("text\n<m0001</zoo-msg-id>");
    assert.equal(result, "text");
  });

  // --- Rule 2 (?:\s*m\d{4})? trailing-ref branch — open tag glued to ref ---

  it("strips end-position orphan open tag glued to ref (misspelled tag name)", () => {
    const result = stripRefsFromString("text\n<zoo-msgid>m0001");
    assert.equal(result, "text");
  });

  it("strips end-position orphan open tag glued to ref (well-formed tag name)", () => {
    const result = stripRefsFromString("text\n<zoo-msg-id>m0001");
    assert.equal(result, "text");
  });

  // --- Mid-text tags are PRESERVED (new semantics) ---

  it("preserves mid-text well-formed tag", () => {
    const result = stripRefsFromString(
      "some text\n<zoo-msg-id>m9999</zoo-msg-id> more",
    );
    assert.equal(result, "some text\n<zoo-msg-id>m9999</zoo-msg-id> more");
  });

  it("preserves mid-text orphan open tag", () => {
    const result = stripRefsFromString("text <zoo-msg-id> here");
    assert.equal(result, "text <zoo-msg-id> here");
  });

  it("preserves mid-text orphan close tag", () => {
    const result = stripRefsFromString("text </zoo-msg-id> here");
    assert.equal(result, "text </zoo-msg-id> here");
  });

  it("preserves mid-text orphan tag with attributes", () => {
    const result = stripRefsFromString('text <zoo-msg-id attr="v"> here');
    assert.equal(result, 'text <zoo-msg-id attr="v"> here');
  });

  it("preserves mid-text mixed paired and orphan tags", () => {
    const result = stripRefsFromString(
      "<zoo-msg-id>m9999</zoo-msg-id> and </zoo-msg-id> trailing",
    );
    assert.equal(
      result,
      "<zoo-msg-id>m9999</zoo-msg-id> and </zoo-msg-id> trailing",
    );
  });

  it("preserves mid-text multiple paired occurrences", () => {
    const result = stripRefsFromString(
      "<zoo-msg-id>m9999</zoo-msg-id><zoo-msg-id>m9998</zoo-msg-id>abc",
    );
    assert.equal(
      result,
      "<zoo-msg-id>m9999</zoo-msg-id><zoo-msg-id>m9998</zoo-msg-id>abc",
    );
  });

  it("leaves clean text untouched", () => {
    const input = "plain text without any tags";
    assert.equal(stripRefsFromString(input), input);
  });

  it("preserves bare standalone ref (not preceded by tag fragment)", () => {
    const input = "some text m0001";
    assert.equal(stripRefsFromString(input), input);
  });

  it("preserves ref separated from tag name by space (no angle brackets)", () => {
    const input = "m0001 zoo-msg-id";
    assert.equal(stripRefsFromString(input), input);
  });
});

// ---------------------------------------------------------------------------
// ZOO_MSG_ID_CANONICAL_END_REGEX (fuzzy-variant detection guard)
// ---------------------------------------------------------------------------
describe("ZOO_MSG_ID_CANONICAL_END_REGEX", () => {
  it("matches canonical lowercase trailing tag", () => {
    assert.ok(ZOO_MSG_ID_CANONICAL_END_REGEX.test("\nm0001</zoo-msg-id>"));
  });

  it("matches UPPERCASE canonical trailing tag (i-flag regression guard)", () => {
    assert.ok(ZOO_MSG_ID_CANONICAL_END_REGEX.test("\nM0001</ZOO-MSG-ID>"));
  });

  it("does NOT match misspelled tag name (non-canonical)", () => {
    assert.equal(
      ZOO_MSG_ID_CANONICAL_END_REGEX.test("\nm0001</zoomsgid>"),
      false,
    );
  });

  it("does NOT match bare trailing ref (no tag fragment)", () => {
    assert.equal(ZOO_MSG_ID_CANONICAL_END_REGEX.test(" m0001"), false);
  });
});

describe("assignMessageRefs with isSubAgent", () => {
  it("skips first user message in sub-agent session", () => {
    const sessionId = "sess-subagent-skip";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("first question")]),
      msg("assistant", "a1", [textPart("reply")]),
    ];

    const assigned = assignMessageRefs(sessionId, messages, true);
    // Only assistant gets a ref; first user skipped.
    assert.equal(assigned, 1);
  });

  it("subsequent messages number from m0001", () => {
    const sessionId = "sess-subagent-numbering";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("first")]),
      msg("assistant", "a1", [textPart("reply")]),
      msg("user", "u2", [textPart("second")]),
      msg("assistant", "a2", [textPart("reply2")]),
    ];

    const assigned = assignMessageRefs(sessionId, messages, true);
    // Three refs: a1=m0001, u2=m0002, a2=m0003
    assert.equal(assigned, 3);

    injectMessageRefs(sessionId, messages);

    // First user has NO tag
    assert.ok(
      !(messages[0].parts?.[0] as { text?: string }).text?.includes(
        tag("m0001"),
      ),
    );

    // a1 has m0001
    assert.ok(
      (messages[1].parts?.[0] as { text?: string }).text?.includes(
        tag("m0001"),
      ),
    );

    // u2 has m0002
    assert.ok(
      (messages[2].parts?.[0] as { text?: string }).text?.includes(
        tag("m0002"),
      ),
    );

    // a2 has m0003
    assert.ok(
      (messages[3].parts?.[0] as { text?: string }).text?.includes(
        tag("m0003"),
      ),
    );
  });

  it("two rounds stay consistent (resume semantics)", () => {
    const sessionId = "sess-subagent-resume";

    // Round 1: first user + assistant
    const msgs1: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("q1")]),
      msg("assistant", "a1", [textPart("r1")]),
    ];
    const assigned1 = assignMessageRefs(sessionId, msgs1, true);
    assert.equal(assigned1, 1); // a1=m0001, u1 skipped

    // Round 2: full history + new messages.
    // The registry persists across calls (simulates real runtime).
    const msgs2: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("q1")]),
      msg("assistant", "a1", [textPart("r1")]),
      msg("user", "u2", [textPart("q2")]),
      msg("assistant", "a2", [textPart("r2")]),
    ];
    const assigned2 = assignMessageRefs(sessionId, msgs2, true);
    // u2 and a2 are new — 2 more refs.
    assert.equal(assigned2, 2);

    injectMessageRefs(sessionId, msgs2);

    // u1 has NO tag (skipped)
    assert.ok(
      !(msgs2[0].parts?.[0] as { text?: string }).text?.includes(
        "<zoo-msg-id>",
      ),
    );

    // a1 has m0001
    assert.ok(
      (msgs2[1].parts?.[0] as { text?: string }).text?.includes(tag("m0001")),
    );

    // u2 has m0002
    assert.ok(
      (msgs2[2].parts?.[0] as { text?: string }).text?.includes(tag("m0002")),
    );

    // a2 has m0003
    assert.ok(
      (msgs2[3].parts?.[0] as { text?: string }).text?.includes(tag("m0003")),
    );
  });

  it("ignored messages before first user do not disrupt skip", () => {
    const sessionId = "sess-subagent-ignored";
    const messages: ContextMessageEntry[] = [
      msg("system", "s1", [textPart("system msg")], undefined, {
        ignored: true,
      }),
      msg("user", "u1", [textPart("real question")]),
      msg("assistant", "a1", [textPart("response")]),
    ];

    const assigned = assignMessageRefs(sessionId, messages, true);
    // system ignored, u1 skipped, a1=m0001
    assert.equal(assigned, 1);

    injectMessageRefs(sessionId, messages);

    // u1 has no tag
    assert.ok(
      !(messages[1].parts?.[0] as { text?: string }).text?.includes(
        "<zoo-msg-id>",
      ),
    );
    // a1 has m0001
    assert.ok(
      (messages[2].parts?.[0] as { text?: string }).text?.includes(
        tag("m0001"),
      ),
    );
  });

  it("main session (isSubAgent=false) assigns all user messages refs", () => {
    const sessionId = "sess-subagent-main";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("first")]),
      msg("assistant", "a1", [textPart("reply")]),
      msg("user", "u2", [textPart("second")]),
    ];

    const assigned = assignMessageRefs(sessionId, messages, false);
    // All 3 get refs.
    assert.equal(assigned, 3);

    injectMessageRefs(sessionId, messages);

    assert.ok(
      (messages[0].parts?.[0] as { text?: string }).text?.includes(
        tag("m0001"),
      ),
    );
    assert.ok(
      (messages[1].parts?.[0] as { text?: string }).text?.includes(
        tag("m0002"),
      ),
    );
    assert.ok(
      (messages[2].parts?.[0] as { text?: string }).text?.includes(
        tag("m0003"),
      ),
    );
  });

  it("isSubAgent undefined behaves same as false (no skip)", () => {
    const sessionId = "sess-subagent-undefined";
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("first")]),
      msg("assistant", "a1", [textPart("reply")]),
    ];

    const assigned = assignMessageRefs(sessionId, messages); // undefined
    assert.equal(assigned, 2); // Both assigned.
  });
});
