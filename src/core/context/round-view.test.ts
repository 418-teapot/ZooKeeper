/**
 * Tests for the round-view cache (`src/core/context/round-view.ts`).
 *
 * Covers: freezing (region text, message metadata, the invocation table
 * and its reverse index, and summary view items all become copied data,
 * so later host or state mutations never reach a published view),
 * publish / read / clear per session, overwrite semantics, and the
 * isolation of two registry instances.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostMessage, Invocation, Projection } from "./lens.js";
import { project, regionKey } from "./lens.js";
import {
  createRoundViewRegistry,
  freezeNumberedView,
  freezeProjection,
} from "./round-view.js";
import type { NumberedItem } from "./view-refs.js";

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
      { n: 1, item: { type: "original", start: 0, end: 1 } },
      { n: 2, item: { type: "summary", block } },
    ];
    const frozen = freezeNumberedView(numbered);

    block.start = 99;
    block.end = 100;
    block.summary = "改了";
    assert.deepEqual(frozen[0]?.item, { type: "original", start: 0, end: 1 });
    assert.deepEqual(frozen[1]?.item, {
      type: "summary",
      block: { start: 2, end: 5, title: "主题", summary: "摘要" },
    });
  });
});

describe("round-view registry", () => {
  it("freezes what it stores and reads it back per session", () => {
    const registry = createRoundViewRegistry();
    const { snapshot, holders } = liveProjection([{ text: "hi" }]);
    const numbered: NumberedItem[] = [
      { n: 1, item: { type: "original", start: 0, end: 1 } },
    ];
    registry.publish("s-a", { projection: snapshot, numbered });
    holders[0].text = "changed";
    numbered[0].n = 42;

    const view = registry.get("s-a");
    assert.ok(view);
    assert.equal(view.projection.messages[0]?.regions[0]?.get(), "hi");
    assert.equal(view.numbered[0]?.n, 1, "numbered items are copied too");
    assert.equal(registry.get("s-b"), undefined, "views are per session");
  });

  it("freezes the published protection map", () => {
    const registry = createRoundViewRegistry();
    const protection = {
      activeStart: 2,
      messageCount: 3,
      instructions: [0, 1],
    };
    registry.publish("s", {
      projection: liveProjection([{ text: "x" }]).snapshot,
      numbered: [],
      protection,
    });
    protection.instructions[1] = 9;
    protection.activeStart = 9;
    protection.messageCount = 9;

    const view = registry.get("s");
    assert.deepEqual(view?.protection, {
      activeStart: 2,
      messageCount: 3,
      instructions: [0, 1],
    });
    assert.ok(Object.isFrozen(view?.protection), "map is frozen");
    assert.ok(
      Object.isFrozen(view?.protection?.instructions),
      "list is frozen",
    );
  });

  it("overwrites the previous round's view", () => {
    const registry = createRoundViewRegistry();
    registry.publish("s", {
      projection: liveProjection([{ text: "第一轮" }]).snapshot,
      numbered: [],
    });
    registry.publish("s", {
      projection: liveProjection([{ text: "第二轮" }]).snapshot,
      numbered: [],
    });
    assert.equal(
      registry.get("s")?.projection.messages[0]?.regions[0]?.get(),
      "第二轮",
    );
  });

  it("clear drops only that session", () => {
    const registry = createRoundViewRegistry();
    registry.publish("keep", { projection: project([], []), numbered: [] });
    registry.publish("drop", { projection: project([], []), numbered: [] });
    registry.clear("drop");
    assert.equal(registry.get("drop"), undefined);
    assert.ok(registry.get("keep"));
  });

  it("keeps two registries independent", () => {
    const first = createRoundViewRegistry();
    const second = createRoundViewRegistry();
    first.publish("s", {
      projection: liveProjection([{ text: "x" }]).snapshot,
      numbered: [],
    });
    assert.equal(second.get("s"), undefined);
    assert.ok(first.get("s"));
  });
});
