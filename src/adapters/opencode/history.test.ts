/**
 * Tests for the v1 message → lens mapping adapter (`history.ts`).
 *
 * Three layers:
 *
 * 1. Mapping table — every v1 part type maps to the expected region
 *    kind, message-level fields (`role`, `tokens`, `ignored`) map to the
 *    lens message fields, and edge shapes (empty parts, null parts,
 *    step-start, parallel tools, non-string text) are covered.
 * 2. Parity — real v1 entries are mapped through `history()` and fed to
 *    the new estimators; the results must equal the legacy estimators
 *    applied to the same entries, per message and per transcript.
 * 3. Write-back — the adapter's `WritableRegion` regions mutate the
 *    v1 object in place: `part.text`, `state.output`, and
 *    `state.input` (JSON.parse round-trip for object inputs;
 *    non-parsing placeholder text is wrapped into an object so the
 *    outbound tool input stays schema-valid), matching the prune
 *    semantics.
 * 4. Null hardening — null/undefined v1 entries map to hidden empty
 *    messages that are safe through the whole core chain (canon, span
 *    hashing, fold, first-user search) and are skipped by estimation.
 *    Line-number injection is exercised on null-derived hidden messages
 *    in `apply-view.test.ts`.
 * 5. Injection provenance — `isInjectableRegion` marks exactly the
 *    text-derived content and tool-output regions, never the
 *    estimation-only content derived from step-start/snapshot/file
 *    parts.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { canon } from "../../core/context/canon.js";
import type { TextRegion } from "../../core/context/lens.js";
import { makeMsg } from "../../core/context/lens-testkit.js";
import {
  estimateMessageHeuristic,
  measureMessages,
} from "../../core/context/measure.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../core/context/message-parts.js";
import { computeSpanHash } from "../../core/context/spanhash.js";
import { _resetForTesting } from "../../utils/logger.js";
import { history, isInjectableRegion, type WritableRegion } from "./history.js";
import {
  type ContextMessageEntry,
  type ContextTokenInfo,
  computeContextReport as legacyComputeContextReport,
  estimateMessageHeuristic as legacyEstimateMessageHeuristic,
  measureContext as legacyMeasureContext,
} from "./types.js";

// ---------------------------------------------------------------------------
// Logger cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// v1 fixture helpers (real v1-shaped objects, not lens test doubles)
// ---------------------------------------------------------------------------

/**
 * Tool-part shape as it appears in real v1 messages.
 */
interface ToolPartShape {
  type: string;
  text?: string;
  tool?: string;
  state?: {
    input?: unknown;
    output?: unknown;
    status?: string;
  };
}

/**
 * Build a text part.
 */
function textPart(text: string, ignored?: boolean): Record<string, unknown> {
  return { type: "text", text, ...(ignored ? { ignored: true } : {}) };
}

/**
 * Build a reasoning part.
 */
function reasoningPart(text: string): Record<string, unknown> {
  return { type: "reasoning", text };
}

/**
 * Build a tool part with optional status and call identifier.
 */
function toolPart(
  tool: string,
  input: unknown,
  output: unknown,
  status?: string,
  callID?: string,
): Record<string, unknown> {
  return {
    type: "tool",
    tool,
    ...(callID ? { callID } : {}),
    state: {
      input,
      output,
      ...(status ? { status } : {}),
    },
  };
}

/**
 * Build a v1 message entry.
 */
function entry(
  role: string,
  parts?: unknown[],
  tokens?: ContextTokenInfo,
  ignored?: boolean,
): ContextMessageEntry {
  return {
    info: {
      role,
      id: "m1",
      ...(tokens ? { tokens } : {}),
      ...(ignored !== undefined ? { ignored } : {}),
    } as unknown as ContextMessageEntry["info"],
    parts: (parts ?? []) as unknown as ContextMessageEntry["parts"],
  };
}

/**
 * Regions of the single mapped message for a v1 entry.
 */
function regionsOf(entryToMap: ContextMessageEntry): TextRegion[] {
  return history([entryToMap])[0].regions;
}

// ---------------------------------------------------------------------------
// Mapping table
// ---------------------------------------------------------------------------

describe("v1 part → region mapping", () => {
  it("text part maps to a content region with its text", () => {
    const [region] = regionsOf(entry("user", [textPart("Hello World")]));
    assert.equal(region.kind, "content");
    assert.equal(region.get(), "Hello World");
  });

  it("multiple text parts map to multiple content regions, order preserved", () => {
    const regions = regionsOf(
      entry("user", [textPart("first"), textPart("second"), textPart("third")]),
    );
    assert.deepEqual(
      regions.map((r) => r.kind),
      ["content", "content", "content"],
    );
    assert.deepEqual(
      regions.map((r) => r.get()),
      ["first", "second", "third"],
    );
  });

  it("reasoning part maps to a thinking region", () => {
    const [region] = regionsOf(
      entry("assistant", [reasoningPart("reasoning trace")]),
    );
    assert.equal(region.kind, "thinking");
    assert.equal(region.get(), "reasoning trace");
  });

  it("tool part maps to tool-input + tool-output regions with metadata", () => {
    const [inputRegion, outputRegion] = regionsOf(
      entry("assistant", [
        toolPart("bash", "ls", "file1", "running", "call-1"),
      ]),
    );
    assert.equal(inputRegion.kind, "tool-input");
    assert.equal(outputRegion.kind, "tool-output");
    assert.equal(inputRegion.get(), "ls");
    assert.equal(outputRegion.get(), "file1");
    assert.equal(inputRegion.tool?.name, "bash");
    assert.equal(inputRegion.tool?.status, "running");
    assert.equal(outputRegion.tool?.name, "bash");
    assert.equal(outputRegion.tool?.status, "running");
  });

  it("status stays undefined when the tool part carries none", () => {
    const [inputRegion] = regionsOf(
      entry("assistant", [toolPart("bash", "ls", "out")]),
    );
    assert.equal(inputRegion.tool?.status, undefined);
  });

  it("object tool input is JSON-serialized on get (legacy counting parity)", () => {
    const input = { cmd: "ls" };
    const output = { stdout: "file1\n" };
    const [inputRegion, outputRegion] = regionsOf(
      entry("assistant", [toolPart("bash", input, output)]),
    );
    assert.equal(inputRegion.get(), JSON.stringify(input));
    assert.equal(outputRegion.get(), JSON.stringify(output));
  });

  it("tool part without state but with text maps to content (legacy text counting)", () => {
    const [region] = regionsOf(
      entry("assistant", [{ type: "tool", text: "orphan text" }]),
    );
    assert.equal(region.kind, "content");
    assert.equal(region.get(), "orphan text");
  });

  it("parallel tool calls keep per-call region pairs in order", () => {
    const regions = regionsOf(
      entry("assistant", [
        toolPart("bash", "a", "A"),
        textPart("interleaved"),
        toolPart("read", "b.ts", "B"),
      ]),
    );
    assert.deepEqual(
      regions.map((r) => r.kind),
      ["tool-input", "tool-output", "content", "tool-input", "tool-output"],
    );
    assert.deepEqual(
      regions.map((r) => r.tool?.name),
      ["bash", "bash", undefined, "read", "read"],
    );
  });

  it("step-start part without text contributes no region", () => {
    const regions = regionsOf(entry("assistant", [{ type: "step-start" }]));
    assert.deepEqual(regions, []);
  });

  it("non-tool parts with text map to content (step-finish/snapshot/file)", () => {
    const regions = regionsOf(
      entry("assistant", [
        { type: "step-finish", text: "step done" },
        { type: "snapshot", text: "snapshot body" },
        { type: "file", path: "a.txt", text: "file content" },
      ]),
    );
    assert.deepEqual(
      regions.map((r) => r.kind),
      ["content", "content", "content"],
    );
    assert.deepEqual(
      regions.map((r) => r.get()),
      ["step done", "snapshot body", "file content"],
    );
  });

  it("non-string text field is skipped defensively (no crash)", () => {
    const regions = regionsOf(
      entry("user", [
        { type: "text", text: 42 } as unknown as Record<string, unknown>,
      ]),
    );
    assert.deepEqual(regions, []);
  });

  it("null part entries are skipped", () => {
    const regions = regionsOf(
      entry("user", [null, textPart("hi")] as unknown[]),
    );
    assert.equal(regions.length, 1);
    assert.equal(regions[0].get(), "hi");
  });

  it("empty parts map to an empty region list", () => {
    assert.deepEqual(regionsOf(entry("user", [])), []);
    assert.deepEqual(regionsOf(entry("user")), []);
  });

  it("role passes through info.role (including system)", () => {
    assert.equal(history([entry("user", [textPart("hi")])])[0].role, "user");
    assert.equal(
      history([entry("assistant", [textPart("hi")])])[0].role,
      "assistant",
    );
    assert.equal(
      history([entry("system", [textPart("sys")])])[0].role,
      "system",
    );
  });

  it("usage flattens the nested cache report into five components", () => {
    const [msg] = history([
      entry("assistant", [textPart("hi")], {
        input: 10,
        output: 20,
        reasoning: 5,
        cache: { read: 30, write: 40 },
      }),
    ]);
    assert.deepEqual(msg.usage, {
      input: 10,
      output: 20,
      reasoning: 5,
      cacheRead: 30,
      cacheWrite: 40,
    });
  });

  it("usage stays undefined when tokens are absent", () => {
    assert.equal(
      history([entry("user", [textPart("hi")])])[0].usage,
      undefined,
    );
  });

  it("info.ignored maps to hidden", () => {
    const [msg] = history([entry("user", [textPart("hi")], undefined, true)]);
    assert.equal(msg.hidden, true);
  });

  it("all-parts-ignored maps to hidden (isMessageIgnored semantics)", () => {
    const [msg] = history([
      entry("user", [textPart("a", true), textPart("b", true)]),
    ]);
    assert.equal(msg.hidden, true);
  });

  it("empty parts are NOT hidden even with no ignored flags", () => {
    assert.equal(history([entry("user", [])])[0].hidden, false);
  });

  it("info.summary === true maps to compaction (host-native boundary)", () => {
    const [msg] = history([
      {
        info: { role: "assistant", id: "summary", summary: true },
        parts: [textPart("Previous conversation condensed")],
      } as unknown as ContextMessageEntry,
    ]);
    assert.equal(msg.compaction, true);
  });

  it("info.synthetic is NOT mapped to compaction (distinct concept)", () => {
    const [msg] = history([
      {
        info: { role: "user", id: "synthetic", synthetic: true },
        parts: [textPart("[Block b1 · 2 条] title\nbody")],
      } as unknown as ContextMessageEntry,
    ]);
    assert.equal(msg.compaction, undefined);
  });

  it("compaction stays undefined when summary is absent", () => {
    const [msg] = history([entry("assistant", [textPart("hi")])]);
    assert.equal(msg.compaction, undefined);
  });
});

// ---------------------------------------------------------------------------
// Parity: per-message heuristic (legacy estimateMessageHeuristic)
// ---------------------------------------------------------------------------

describe("parity: per-message heuristic vs legacy", () => {
  const cases: Array<[string, ContextMessageEntry]> = [
    ["pure text", entry("user", [textPart("Hello World")])],
    [
      "CJK mixed text",
      entry("user", [textPart("你好 world"), textPart("，。ＡＢ")]),
    ],
    ["reasoning part", entry("assistant", [reasoningPart("reasoning trace")])],
    [
      "tool with string input/output",
      entry("assistant", [toolPart("bash", "ls", "file1")]),
    ],
    [
      "tool with object input/output",
      entry("assistant", [
        toolPart("bash", { cmd: "ls" }, { stdout: "file1\n" }),
      ]),
    ],
    [
      "tool with error status",
      entry("assistant", [toolPart("read", "a.ts", "content", "error")]),
    ],
    [
      "tool without state but with text",
      entry("assistant", [{ type: "tool", text: "orphan text" }]),
    ],
    ["step-start without text", entry("assistant", [{ type: "step-start" }])],
    [
      "step-finish with text",
      entry("assistant", [{ type: "step-finish", text: "step done" }]),
    ],
    ["snapshot with text", entry("user", [{ type: "snapshot", text: "body" }])],
    [
      "file part with text",
      entry("user", [{ type: "file", path: "a.txt", text: "file content" }]),
    ],
    ["empty parts", entry("user", [])],
    [
      "mixed parts",
      entry("assistant", [
        { type: "step-start" },
        reasoningPart("think"),
        textPart("answer"),
        toolPart("bash", "ls", "out"),
      ]),
    ],
    [
      "parallel tool calls",
      entry("assistant", [
        toolPart("bash", "a", "A"),
        toolPart("read", "b.ts", "B"),
      ]),
    ],
  ];

  for (const [name, entryToMap] of cases) {
    it(name, () => {
      const [lens] = history([entryToMap]);
      assert.equal(
        estimateMessageHeuristic(lens),
        legacyEstimateMessageHeuristic(entryToMap),
      );
    });
  }

  it("ignored message maps to hidden and estimates 0", () => {
    // The legacy per-message estimator does NOT skip ignored parts, so the
    // direct per-message comparison cannot hold for ignored messages; the
    // hidden-skip semantic is pinned whole-session via computeContextReport
    // below and per-message here as the new-core 0 estimate.
    const entryToMap = entry(
      "user",
      [textPart("ignored text")],
      undefined,
      true,
    );
    const [lens] = history([entryToMap]);
    assert.equal(lens.hidden, true);
    assert.equal(estimateMessageHeuristic(lens), 0);
    assert.ok(legacyEstimateMessageHeuristic(entryToMap) > 0);
  });
});

// ---------------------------------------------------------------------------
// Parity: whole-session measurement
// ---------------------------------------------------------------------------

describe("parity: whole-session vs legacy", () => {
  it("usage-exact precedence matches legacy measureContext", () => {
    const v1 = [
      entry("user", [textPart("Hello")]),
      entry("assistant", [textPart("Response")], {
        input: 500,
        output: 100,
        reasoning: 50,
        cache: { read: 200, write: 50 },
      }),
      entry("user", [textPart("Follow-up text here")]),
    ];
    const measured = measureMessages(history(v1));
    const legacy = legacyMeasureContext({ messages: v1 });
    assert.equal(measured.exact, legacy.exact_tokens); // 500+100+50+200+50 = 900
    assert.equal(measured.heuristic, legacy.estimated_new_tokens); // ceil(19/4) = 5
    assert.equal(measured.total, legacy.estimated_tokens); // 905
    assert.equal(measured.messageCount, legacy.message_count); // 3
  });

  it("ignored messages are hidden and skipped like legacy computeContextReport", () => {
    // Legacy measureContext counts ignored tail text and includes ignored
    // messages in message_count; computeContextReport is the counterpart
    // that skips them, so it is the comparison target for the hidden
    // dimension (same convention as measure.test.ts).
    const v1 = [
      entry("user", [textPart("Hello")]),
      entry("assistant", [textPart("Response")], { input: 500, output: 100 }),
      entry("user", [textPart("Ignored /dcp context report")], undefined, true),
      entry("user", [textPart("Normal follow-up")]),
    ];
    const measured = measureMessages(history(v1));
    const legacy = legacyComputeContextReport(v1);
    assert.equal(measured.exact, legacy.exact); // 600
    assert.equal(measured.heuristic, legacy.heuristic); // ceil(16/4) = 4
    assert.equal(measured.total, legacy.total); // 604
    assert.equal(measured.messageCount, legacy.messageCount); // 3
  });

  it("empty transcript matches legacy measureContext zeros", () => {
    const measured = measureMessages(history([]));
    const legacy = legacyMeasureContext({ messages: [] });
    assert.equal(measured.exact, legacy.exact_tokens);
    assert.equal(measured.heuristic, legacy.estimated_new_tokens);
    assert.equal(measured.total, legacy.estimated_tokens);
    assert.equal(measured.messageCount, legacy.message_count);
  });

  it("nullish transcript input yields zeros", () => {
    assert.deepEqual(measureMessages(history(undefined)), {
      exact: 0,
      heuristic: 0,
      total: 0,
      messageCount: 0,
    });
    assert.deepEqual(measureMessages(history(null)), {
      exact: 0,
      heuristic: 0,
      total: 0,
      messageCount: 0,
    });
  });

  it("dirty transcript maps null entries to hidden empty messages and matches legacy on exact/heuristic/total", () => {
    const v1 = [
      null as unknown as ContextMessageEntry,
      entry("user", [textPart("Hi")]),
      undefined as unknown as ContextMessageEntry,
      entry("assistant", [textPart("OK")], { input: 100, output: 50 }),
      null as unknown as ContextMessageEntry,
    ];
    const mapped = history(v1);
    // Ordinals line up with the v1 array; null entries become hidden
    // empty messages (never null — the core chain assumes non-null).
    assert.equal(mapped.length, 5);
    assert.ok(mapped[0].hidden);
    assert.ok(mapped[2].hidden);
    assert.ok(mapped[4].hidden);
    assert.deepEqual(mapped[0].regions, []);
    const measured = measureMessages(mapped);
    const legacy = legacyMeasureContext({ messages: v1 });
    assert.equal(measured.exact, legacy.exact_tokens); // 150
    assert.equal(measured.heuristic, legacy.estimated_new_tokens); // 0
    assert.equal(measured.total, legacy.estimated_tokens); // 150
    // Divergence: legacy counts null entries in message_count; the
    // hidden empty messages are excluded from the new count.
    assert.equal(measured.messageCount, 2);
    assert.notEqual(measured.messageCount, legacy.message_count); // 5
  });
});

// ---------------------------------------------------------------------------
// region set() write-back
// ---------------------------------------------------------------------------

describe("region set() write-back", () => {
  it("content region set rewrites part.text", () => {
    const entryToMap = entry("user", [textPart("before")]);
    const region = history([entryToMap])[0].regions[0] as WritableRegion;
    region.set("after");
    const part = entryToMap.parts?.[0] as { text?: string };
    assert.equal(part.text, "after");
    assert.equal(region.get(), "after");
  });

  it("thinking region set rewrites part.text", () => {
    const entryToMap = entry("assistant", [reasoningPart("thought")]);
    const region = history([entryToMap])[0].regions[0] as WritableRegion;
    assert.equal(region.kind, "thinking");
    region.set("new thought");
    const part = entryToMap.parts?.[0] as { text?: string };
    assert.equal(part.text, "new thought");
    assert.equal(region.get(), "new thought");
  });

  it("tool-output region set writes state.output as a string", () => {
    const entryToMap = entry("assistant", [toolPart("bash", "ls", "out")]);
    const region = history([entryToMap])[0].regions[1] as WritableRegion;
    region.set(PRUNED_TOOL_OUTPUT_REPLACEMENT);
    const part = entryToMap.parts?.[0] as ToolPartShape;
    assert.equal(part.state?.output, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(region.get(), PRUNED_TOOL_OUTPUT_REPLACEMENT);
  });

  it("tool-input region set rewrites a string input verbatim", () => {
    // Placeholder parity with the legacy prune string-input path.
    const entryToMap = entry("assistant", [
      toolPart("bash", "a command", "out"),
    ]);
    const region = history([entryToMap])[0].regions[0] as WritableRegion;
    region.set(PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    const part = entryToMap.parts?.[0] as ToolPartShape;
    assert.equal(part.state?.input, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    assert.equal(region.get(), PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
  });

  it("tool-input region set JSON-parses object input back when the text parses", () => {
    const entryToMap = entry("assistant", [
      toolPart("bash", { cmd: "ls" }, "out"),
    ]);
    const region = history([entryToMap])[0].regions[0] as WritableRegion;
    assert.equal(region.get(), '{"cmd":"ls"}');
    region.set('{"cmd":"pwd"}');
    const part = entryToMap.parts?.[0] as ToolPartShape;
    assert.deepEqual(part.state?.input, { cmd: "pwd" });
    assert.equal(region.get(), '{"cmd":"pwd"}');
  });

  it("tool-input region set keeps object input an object for non-parsing text", () => {
    // Placeholder text never parses as JSON; storing it as a bare string
    // would make the outbound tool_use.input a string and break the
    // Anthropic schema (input must be an object).  The placeholder is
    // wrapped into a `{ pruned }` envelope instead.  Marks are re-applied
    // every turn, so the write must be idempotent.
    const entryToMap = entry("assistant", [
      toolPart("bash", { cmd: "ls" }, "out"),
    ]);
    const region = history([entryToMap])[0].regions[0] as WritableRegion;
    region.set(PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    const part = entryToMap.parts?.[0] as ToolPartShape;
    assert.equal(typeof part.state?.input, "object");
    assert.deepEqual(part.state?.input, {
      pruned: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
    });
    assert.equal(
      region.get(),
      JSON.stringify({ pruned: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT }),
    );

    // Re-applying the same placeholder (release re-writes effective marks
    // every turn) leaves the wrapped object unchanged.
    region.set(PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    assert.equal(typeof part.state?.input, "object");
    assert.deepEqual(part.state?.input, {
      pruned: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
    });
  });
});

// ---------------------------------------------------------------------------
// Null hardening: null entries → hidden empty messages, chain-safe
// ---------------------------------------------------------------------------

describe("null entry hardening", () => {
  it("null/undefined entries map to hidden empty messages with ordinals preserved", () => {
    const mapped = history([
      null as unknown as ContextMessageEntry,
      entry("user", [textPart("Hello")]),
      undefined as unknown as ContextMessageEntry,
    ]);
    assert.equal(mapped.length, 3);
    // Never null — the core chain assumes non-null messages.
    for (const msg of mapped) assert.ok(msg !== null);
    assert.ok(mapped[0].hidden);
    assert.ok(mapped[2].hidden);
    assert.deepEqual(mapped[0].regions, []);
    assert.equal(mapped[1].hidden, false);
    assert.equal(mapped[1].regions[0].get(), "Hello");
  });

  it("estimation skips the hidden empty messages", () => {
    const mapped = history([
      null as unknown as ContextMessageEntry,
      entry("user", [textPart("Hello")]),
      undefined as unknown as ContextMessageEntry,
    ]);
    assert.equal(estimateMessageHeuristic(mapped[0]), 0);
    assert.equal(estimateMessageHeuristic(mapped[2]), 0);
    // measureMessages does not throw and counts only non-hidden messages.
    assert.doesNotThrow(() => measureMessages(mapped));
    assert.equal(measureMessages(mapped).messageCount, 1);
  });

  it("canon and span hashing project the hidden empty messages normally", () => {
    const mapped = history([
      null as unknown as ContextMessageEntry,
      entry("user", [textPart("Hello")]),
      undefined as unknown as ContextMessageEntry,
    ]);
    // canon on a hidden empty message is deterministic and safe.
    assert.equal(canon(mapped[0]), JSON.stringify(["user", [], [], []]));
    // computeSpanHash over a transcript containing null-derived entries
    // does not throw and yields a fixed-length hex hash.
    const hash = computeSpanHash(mapped, 0, mapped.length);
    assert.match(hash, /^[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// isInjectableRegion — injection provenance
// ---------------------------------------------------------------------------

describe("isInjectableRegion", () => {
  it("text-derived content regions are injectable", () => {
    const region = regionsOf(entry("user", [textPart("hi")]))[0];
    assert.equal(region.kind, "content");
    assert.equal(isInjectableRegion(region), true);
  });

  it("multiple text parts keep every content region injectable", () => {
    const regions = regionsOf(entry("user", [textPart("a"), textPart("b")]));
    for (const region of regions) {
      assert.equal(isInjectableRegion(region), true);
    }
  });

  it("tool-output regions are injectable, tool-input regions are not", () => {
    const [inputRegion, outputRegion] = regionsOf(
      entry("assistant", [toolPart("bash", "ls", "out")]),
    );
    assert.equal(isInjectableRegion(outputRegion), true);
    assert.equal(isInjectableRegion(inputRegion), false);
  });

  it("reasoning-derived thinking regions are not injectable", () => {
    const region = regionsOf(entry("assistant", [reasoningPart("think")]))[0];
    assert.equal(region.kind, "thinking");
    assert.equal(isInjectableRegion(region), false);
  });

  it("other-derived content regions (step-start/snapshot/file) are not injectable", () => {
    const regions = regionsOf(
      entry("assistant", [
        { type: "step-start", text: "start" },
        { type: "snapshot", text: "body" },
        { type: "file", path: "a.txt", text: "content" },
      ]),
    );
    assert.equal(regions.length, 3);
    for (const region of regions) {
      assert.equal(region.kind, "content");
      assert.equal(isInjectableRegion(region), false);
    }
  });

  it("stateless tool part with text (other provenance) is not injectable", () => {
    const region = regionsOf(
      entry("assistant", [{ type: "tool", text: "orphan" }]),
    )[0];
    assert.equal(region.kind, "content");
    assert.equal(isInjectableRegion(region), false);
  });

  it("regions this adapter did not create are not injectable", () => {
    const foreign = makeMsg("user", ["hi"]).regions[0];
    assert.equal(isInjectableRegion(foreign), false);
  });

  it("mixed message marks exactly text content and tool-output", () => {
    const regions = regionsOf(
      entry("assistant", [
        { type: "step-start", text: "start" },
        textPart("hello"),
        reasoningPart("think"),
        toolPart("bash", "ls", "out"),
      ]),
    );
    assert.deepEqual(
      regions.map((r) => isInjectableRegion(r)),
      [false, true, false, false, true],
    );
  });

  it("nullish input is not injectable", () => {
    assert.equal(isInjectableRegion(null as unknown as TextRegion), false);
    assert.equal(isInjectableRegion(undefined as unknown as TextRegion), false);
  });
});
