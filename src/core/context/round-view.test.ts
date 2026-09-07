/**
 * Tests for the round-view cache (`src/core/context/round-view.ts`).
 *
 * Covers: freezing (region text, message metadata, the invocation table
 * and its reverse index, and summary view items all become copied data,
 * so later host or state mutations never reach a published view),
 * publish / read / clear per session, overwrite semantics, and the
 * `cleanupSession` registration that drops the record with the rest of
 * the session's runtime state.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { HostMessage, Invocation, Projection } from "./lens.js";
import { project, regionKey } from "./lens.js";
import {
  _listRoundViewSessionsForTesting,
  _resetRoundViewsForTesting,
  clearRoundView,
  freezeNumberedView,
  freezeProjection,
  getRoundView,
  publishRoundView,
} from "./round-view.js";
import {
  _resetContextStateManagerForTesting,
  cleanupSession,
} from "./runtime.js";
import type { NumberedItem } from "./view-refs.js";

afterEach(() => {
  _resetRoundViewsForTesting();
  _resetContextStateManagerForTesting();
});

/** A live lens message whose single content region reads a mutable field. */
function liveMsg(
  role: string,
  holder: { text: string },
  hidden = false,
): HostMessage {
  return {
    role,
    hidden,
    regions: [{ kind: "content", get: () => holder.text }],
  };
}

/** Build a snapshot over live holders so mutation can be observed. */
function liveProjection(
  holders: Array<{ text: string }>,
  invocations: Invocation[] = [],
): { snapshot: Projection; holders: Array<{ text: string }> } {
  const messages = holders.map((holder, i) =>
    liveMsg(i === 0 ? "user" : "assistant", holder),
  );
  return { snapshot: project(messages, invocations), holders };
}

describe("freezeProjection", () => {
  it("copies region text so later host writes cannot reach the copy", () => {
    const { snapshot, holders } = liveProjection([
      { text: "第一条" },
      { text: "第二条" },
    ]);
    const frozen = freezeProjection(snapshot);

    assert.equal(frozen.messages[0]?.regions[0]?.get(), "第一条");
    holders[0].text = "被改写了";
    assert.equal(
      frozen.messages[0]?.regions[0]?.get(),
      "第一条",
      "the frozen text is a copy, not a live handle",
    );
    // The source snapshot still reads live — freezing never mutates it.
    assert.equal(snapshot.messages[0]?.regions[0]?.get(), "被改写了");
  });

  it("keeps role, hidden and usage while copying metadata", () => {
    const messages: HostMessage[] = [
      {
        role: "user",
        hidden: true,
        usage: { input: 10, cacheRead: 5, cacheWrite: 1 },
        compaction: true,
        regions: [{ kind: "content", get: () => "t" }],
      },
    ];
    const frozen = freezeProjection(project(messages, []));
    const msg = frozen.messages[0];
    assert.equal(msg?.role, "user");
    assert.equal(msg?.hidden, true);
    assert.equal(msg?.compaction, true);
    assert.deepEqual(msg?.usage, { input: 10, cacheRead: 5, cacheWrite: 1 });
    if (msg?.usage) msg.usage.input = 999;
    assert.equal(messages[0].usage?.input, 10, "usage object is copied");
  });

  it("copies the invocation table and rebuilds a consistent reverse index", () => {
    const invocation: Invocation = {
      name: "bash",
      status: "completed",
      input: { ordinal: 1, regionIndex: 0 },
      output: { ordinal: 1, regionIndex: 1 },
    };
    const messages: HostMessage[] = [
      { role: "user", hidden: false, regions: [] },
      {
        role: "assistant",
        hidden: false,
        regions: [
          { kind: "tool-input", get: () => "{}" },
          { kind: "tool-output", get: () => "out" },
        ],
      },
    ];
    const frozen = freezeProjection(project(messages, [invocation]));

    assert.equal(frozen.invocations.length, 1);
    assert.notEqual(frozen.invocations[0], invocation, "invocation is copied");
    assert.equal(
      frozen.byRegion.get(regionKey({ ordinal: 1, regionIndex: 1 }))?.status,
      "completed",
      "the reverse index survives the freeze",
    );
    invocation.output = { ordinal: 9, regionIndex: 9 };
    assert.deepEqual(
      frozen.invocations[0]?.output,
      { ordinal: 1, regionIndex: 1 },
      "nested address objects are copied",
    );
  });
});

describe("freezeNumberedView", () => {
  it("copies summary spans so later block mutations cannot reshape the view", () => {
    const block = { start: 2, end: 5, title: "主题", summary: "摘要" };
    const numbered: NumberedItem[] = [
      { n: 1, item: { type: "original", ordinal: 0 } },
      { n: 2, item: { type: "summary", block } },
    ];
    const frozen = freezeNumberedView(numbered);

    block.start = 99;
    block.end = 100;
    block.summary = "改了";
    assert.deepEqual(frozen[0]?.item, { type: "original", ordinal: 0 });
    assert.deepEqual(frozen[1]?.item, {
      type: "summary",
      block: { start: 2, end: 5, title: "主题", summary: "摘要" },
    });
  });
});

describe("publishRoundView / getRoundView", () => {
  it("freezes what it stores and reads it back per session", () => {
    const { snapshot, holders } = liveProjection([{ text: "hi" }]);
    const numbered: NumberedItem[] = [
      { n: 1, item: { type: "original", ordinal: 0 } },
    ];
    publishRoundView("s-a", { projection: snapshot, numbered });
    holders[0].text = "changed";
    numbered[0].n = 42;

    const view = getRoundView("s-a");
    assert.ok(view);
    assert.equal(view.projection.messages[0]?.regions[0]?.get(), "hi");
    assert.equal(view.numbered[0]?.n, 1, "numbered items are copied too");
    assert.equal(getRoundView("s-b"), undefined, "views are per session");
    assert.deepEqual(_listRoundViewSessionsForTesting(), ["s-a"]);
  });

  it("overwrites the previous round's view", () => {
    publishRoundView("s", {
      projection: liveProjection([{ text: "第一轮" }]).snapshot,
      numbered: [],
    });
    publishRoundView("s", {
      projection: liveProjection([{ text: "第二轮" }]).snapshot,
      numbered: [],
    });
    const view = getRoundView("s");
    assert.equal(view?.projection.messages[0]?.regions[0]?.get(), "第二轮");
    assert.deepEqual(_listRoundViewSessionsForTesting(), ["s"]);
  });

  it("clearRoundView drops only that session", () => {
    publishRoundView("keep", { projection: project([], []), numbered: [] });
    publishRoundView("drop", { projection: project([], []), numbered: [] });
    clearRoundView("drop");
    assert.equal(getRoundView("drop"), undefined);
    assert.ok(getRoundView("keep"));
  });
});

describe("session cleanup", () => {
  it("cleanupSession drops the cached round view", () => {
    const sessionID = "sess-cleanup-view";
    publishRoundView(sessionID, {
      projection: liveProjection([{ text: "x" }]).snapshot,
      numbered: [],
    });
    assert.ok(getRoundView(sessionID));

    cleanupSession(sessionID);

    assert.equal(getRoundView(sessionID), undefined);
    assert.deepEqual(_listRoundViewSessionsForTesting(), []);
  });
});
