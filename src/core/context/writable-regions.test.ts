/**
 * Tests for the writable-region protocol (`writable-regions.ts`).
 *
 * Boundary: the host-agnostic protocol both adapters build on —
 * provenance registration, the injectability predicate, the
 * tool-output-before-content placement rule, and the pure-prepend
 * prefix write.  The host write-back closures passed into a region are
 * the adapters' concern and stay covered by their own renderer tests.
 *
 * Fixtures are local writable regions registered through
 * `recordRegionProvenance`, so the tests exercise the same side table
 * the adapters populate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  HostMessage,
  RegionEdit,
  RegionKind,
  TextRegion,
} from "./lens.js";
import {
  applyRegionEdits,
  createWritableRegion,
  injectLinePrefix,
  isInjectableRegion,
  pickInjectableRegion,
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
 * Wrap regions into a host message (only the fields the protocol reads).
 *
 * @param regions - The message's regions, in order.
 * @returns The host message fixture.
 */
function message(regions: TextRegion[]): HostMessage {
  return { role: "user", hidden: false, regions };
}

// ---------------------------------------------------------------------------
// 1. Injection predicate
// ---------------------------------------------------------------------------

describe("isInjectableRegion", () => {
  it("marks text-derived content and tool-output regions", () => {
    assert.equal(isInjectableRegion(region("content", "t", "text")), true);
    assert.equal(isInjectableRegion(region("tool-output", "o", "tool")), true);
  });

  it("marks every other derivation as read-only", () => {
    assert.equal(isInjectableRegion(region("content", "i", "image")), false);
    assert.equal(isInjectableRegion(region("content", "s", "summary")), false);
    assert.equal(isInjectableRegion(region("content", "o", "other")), false);
    assert.equal(
      isInjectableRegion(region("thinking", "t", "thinking")),
      false,
    );
    assert.equal(isInjectableRegion(region("tool-input", "i", "tool")), false);
  });

  it("marks unregistered and absent regions as read-only", () => {
    assert.equal(isInjectableRegion(region("content", "t")), false);
    assert.equal(isInjectableRegion(null as unknown as TextRegion), false);
    assert.equal(isInjectableRegion(undefined as unknown as TextRegion), false);
  });
});

// ---------------------------------------------------------------------------
// 2. Placement rule
// ---------------------------------------------------------------------------

describe("pickInjectableRegion", () => {
  it("prefers an injectable tool-output region over any content region", () => {
    const output = region("tool-output", "o", "tool");
    const picked = pickInjectableRegion(
      message([region("content", "t", "text"), output]),
    );
    assert.equal(picked, output);
  });

  it("falls back to the first injectable content region", () => {
    const content = region("content", "t", "text");
    const picked = pickInjectableRegion(
      message([
        region("content", "s", "summary"),
        region("tool-output", "o", "other"),
        content,
      ]),
    );
    assert.equal(picked, content);
  });

  it("returns undefined when no region is injectable", () => {
    const msg = message([
      region("thinking", "t", "thinking"),
      region("tool-input", "i", "tool"),
    ]);
    assert.equal(pickInjectableRegion(msg), undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. Prefix write
// ---------------------------------------------------------------------------

describe("injectLinePrefix", () => {
  it("prepends the ref prefix and reports the write", () => {
    const content = region("content", "hello", "text");
    assert.equal(injectLinePrefix(message([content]), 7), true);
    assert.equal(content.get(), "[m7] hello");
  });

  it("writes into the tool-output region when one is injectable", () => {
    const output = region("tool-output", "out", "tool");
    const content = region("content", "text", "text");
    assert.equal(injectLinePrefix(message([content, output]), 2), true);
    assert.equal(output.get(), "[m2] out");
    assert.equal(content.get(), "text");
  });

  it("reports no write and keeps the text when nothing is injectable", () => {
    const thinking = region("thinking", "trace", "thinking");
    assert.equal(injectLinePrefix(message([thinking]), 3), false);
    assert.equal(thinking.get(), "trace");
  });

  it("never strips an existing marker (pure prepend)", () => {
    const content = region("content", "[m1] old", "text");
    assert.equal(injectLinePrefix(message([content]), 4), true);
    assert.equal(content.get(), "[m4] [m1] old");
  });
});

// ---------------------------------------------------------------------------
// 4. Region factory
// ---------------------------------------------------------------------------

describe("createWritableRegion", () => {
  it("reads and writes through the supplied closures", () => {
    let value = "before";
    const built = createWritableRegion(
      "content",
      () => value,
      (text) => {
        value = text;
      },
      "text",
    );
    assert.equal(built.kind, "content");
    assert.equal(built.get(), "before");
    built.set("after");
    assert.equal(value, "after");
    assert.equal(built.get(), "after");
  });

  it("records provenance so the region is injectable", () => {
    const built = createWritableRegion(
      "content",
      () => "t",
      () => {},
      "text",
    );
    assert.equal(isInjectableRegion(built), true);
  });

  it("keeps a non-injective derivation read-only", () => {
    const built = createWritableRegion(
      "content",
      () => "t",
      () => {},
      "summary",
    );
    assert.equal(isInjectableRegion(built), false);
  });
});

// ---------------------------------------------------------------------------
// 5. Region-edit application
// ---------------------------------------------------------------------------

describe("applyRegionEdits", () => {
  it("writes each edit into the addressed region", () => {
    const other = region("content", "keep", "text");
    const target = region("content", "old", "text");
    const edits: RegionEdit[] = [
      { messageOrdinal: 0, regionIndex: 1, text: "new" },
    ];
    applyRegionEdits([message([other, target])], edits);
    assert.equal(target.get(), "new");
    assert.equal(other.get(), "keep");
  });

  it("skips edits without a region index or an unresolved anchor", () => {
    const content = region("content", "old", "text");
    const edits: RegionEdit[] = [
      { messageOrdinal: 0, text: "no-index" },
      { messageOrdinal: 5, regionIndex: 0, text: "out-of-range" },
      { messageOrdinal: 0, regionIndex: 3, text: "no-region" },
    ];
    applyRegionEdits([message([content])], edits);
    assert.equal(content.get(), "old");
  });
});
