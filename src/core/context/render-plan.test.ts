/**
 * Tests for the core render plan (`render-plan.ts`).
 *
 * Boundary: `planViewRender` + `applyLineInjections` — the
 * host-agnostic algorithm that turns an already-numbered folded view
 * into an ordered list of materialization entries and writes the
 * round's line refs back through the lens.  Host message construction
 * and delivery stay with the adapters and are not exercised here.
 *
 * Fixtures are local writable regions registered through
 * `recordRegionProvenance`, so the tests exercise the same side table
 * the adapters populate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostMessage, RegionKind, TextRegion, ViewItem } from "./lens.js";
import {
  applyLineInjections,
  planViewRender,
  type RenderEntry,
} from "./render-plan.js";
import type { SessionState } from "./state.js";
import { numberView } from "./view-refs.js";
import {
  type RegionProvenance,
  recordRegionProvenance,
  type WritableRegion,
} from "./writable-regions.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a writable region whose text lives in a local cell.
 *
 * @param kind - The region kind.
 * @param text - The initial text.
 * @param provenance - Derivation source; omitted means unregistered.
 * @returns The region, readable and writable in place.
 */
function region(
  kind: RegionKind,
  text: string,
  provenance?: RegionProvenance,
): WritableRegion {
  let value = text;
  const built: WritableRegion = {
    kind,
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
  if (provenance !== undefined) recordRegionProvenance(built, provenance);
  return built;
}

/**
 * Wrap regions into a host message.
 *
 * @param regions - The message's regions, in order.
 * @param hidden - Whether the message is hidden.
 * @returns The host message fixture.
 */
function message(regions: TextRegion[], hidden = false): HostMessage {
  return { role: "user", hidden, regions };
}

/** An empty session state. */
function emptyState(): SessionState {
  return { blocks: new Map(), marks: new Map() };
}

/**
 * Plan a render the way the pipeline does: number the view over the
 * lens' hidden predicate, then plan.
 *
 * @param lens - The lens transcript.
 * @param items - The folded view items.
 * @param state - The session state.
 * @returns The render plan.
 */
function plan(
  lens: HostMessage[],
  items: ViewItem[],
  state: SessionState,
): RenderEntry[] {
  const numbered = numberView(
    items,
    (ordinal) => lens[ordinal]?.hidden ?? true,
  );
  return planViewRender(lens, items, numbered, state);
}

/** Original items covering every ordinal one-by-one. */
function unitItems(count: number): ViewItem[] {
  return Array.from({ length: count }, (_, ordinal) => ({
    type: "original",
    start: ordinal,
    end: ordinal + 1,
  }));
}

// ---------------------------------------------------------------------------
// Line placement
// ---------------------------------------------------------------------------

describe("planViewRender line placement", () => {
  it("takes line numbers from the published view and skips hidden units", () => {
    const lens = [
      message([region("content", "q", "text")]),
      message([
        region("thinking", "trace", "thinking"),
        region("content", "a", "text"),
      ]),
      message([region("content", "hidden", "text")], true),
      message([region("content", "b", "text")]),
    ];

    assert.deepEqual(plan(lens, unitItems(4), emptyState()), [
      { kind: "source", ordinal: 0, line: 1 },
      { kind: "source", ordinal: 1, line: 2 },
      { kind: "source", ordinal: 2 },
      { kind: "source", ordinal: 3, line: 3 },
    ] as RenderEntry[]);
  });

  it("places a unit's line on its first member that carries an injectable region", () => {
    // A fold unit spans two messages: the assistant's thinking trace and
    // a tool result.  Only the tool result is injectable, so the unit's
    // single line lands there while both members stay in the plan.
    const lens = [
      message([region("thinking", "trace", "thinking")]),
      message([region("tool-output", "out", "tool")]),
    ];
    const items: ViewItem[] = [
      { type: "original", start: 0, end: 2 },
      { type: "original", start: 2, end: 3 },
    ];
    lens.push(message([region("content", "next", "text")]));

    assert.deepEqual(plan(lens, items, emptyState()), [
      { kind: "source", ordinal: 0 },
      { kind: "source", ordinal: 1, line: 1 },
      { kind: "source", ordinal: 2, line: 2 },
    ] as RenderEntry[]);
  });

  it("leaves a visible unit without a line when no member is injectable", () => {
    const lens = [
      message([region("thinking", "trace", "thinking")]),
      message([region("content", "q", "text")]),
    ];

    assert.deepEqual(plan(lens, unitItems(2), emptyState()), [
      { kind: "source", ordinal: 0 },
      { kind: "source", ordinal: 1, line: 2 },
    ] as RenderEntry[]);
  });

  it("treats a transcript hole inside a unit as hidden", () => {
    // Ordinal 0 addresses no lens message (a hole): the unit stays
    // visible through its second member and the line moves there.
    const lens = [
      undefined,
      message([region("content", "a", "text")]),
    ] as unknown as HostMessage[];

    assert.deepEqual(
      plan(lens, [{ type: "original", start: 0, end: 2 }], emptyState()),
      [
        { kind: "source", ordinal: 0 },
        { kind: "source", ordinal: 1, line: 1 },
      ] as RenderEntry[],
    );
  });
});

// ---------------------------------------------------------------------------
// Summary text
// ---------------------------------------------------------------------------

describe("planViewRender summary text", () => {
  it("renders the folded block through the shared summary format", () => {
    const lens = [
      message([region("content", "q", "text")]),
      message([region("content", "a1", "text")]),
      message([region("content", "a2", "text")]),
      message([region("content", "b", "text")]),
    ];
    const state = emptyState();
    state.blocks.set(1, {
      start: 1,
      end: 3,
      title: "第一段",
      summary: "摘要正文",
      spanHash: "hash",
      status: "active",
      compressedTokens: 100,
      summaryTokens: 10,
      createdAt: 1000,
    });
    const items: ViewItem[] = [
      { type: "original", start: 0, end: 1 },
      { type: "summary", block: state.blocks.get(1) as never },
      { type: "original", start: 3, end: 4 },
    ];

    assert.deepEqual(plan(lens, items, state), [
      { kind: "source", ordinal: 0, line: 1 },
      {
        kind: "summary",
        text: "[m2] [Block b1 · 2 条] 第一段\n摘要正文",
        id: 1,
      },
      { kind: "source", ordinal: 3, line: 3 },
    ] as RenderEntry[]);
  });

  it("renders a block whose id is not in the map without the bN segment", () => {
    const lens = [message([region("content", "a1", "text")])];
    const items: ViewItem[] = [
      {
        type: "summary",
        block: { start: 0, end: 1, title: "标题", summary: "正文" },
      },
    ];

    // No block id in the map: the plan carries the label without the
    // `bN` segment and no id for host-owned sentinels to reuse.
    assert.deepEqual(plan(lens, items, emptyState()), [
      { kind: "summary", text: "[m1] [Block 1 条] 标题\n正文" },
    ] as RenderEntry[]);
  });
});

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

describe("applyLineInjections", () => {
  it("writes each planned line as a prefix on the addressed message only", () => {
    const first = region("content", "q", "text");
    const second = region("tool-output", "out", "tool");
    const third = region("content", "hidden", "text");
    const lens = [message([first]), message([second]), message([third], true)];
    const renderPlan: RenderEntry[] = [
      { kind: "source", ordinal: 0, line: 1 },
      { kind: "source", ordinal: 1, line: 2 },
      { kind: "source", ordinal: 2 },
      { kind: "summary", text: "[m3] [Block b1 · 1 条]\n正文" },
    ];

    applyLineInjections(lens, renderPlan);

    assert.equal(first.get(), "[m1] q");
    assert.equal(second.get(), "[m2] out");
    assert.equal(third.get(), "hidden");
  });

  it("skips entries whose ordinal addresses no message", () => {
    const content = region("content", "q", "text");
    const lens = [message([content])];

    applyLineInjections(lens, [{ kind: "source", ordinal: 4, line: 9 }]);

    assert.equal(content.get(), "q");
  });

  it("prepends without stripping an existing line-start marker", () => {
    const content = region("content", "[m3] marked text", "text");
    const lens = [message([content])];

    applyLineInjections(lens, [{ kind: "source", ordinal: 0, line: 1 }]);

    assert.equal(content.get(), "[m1] [m3] marked text");
  });
});
