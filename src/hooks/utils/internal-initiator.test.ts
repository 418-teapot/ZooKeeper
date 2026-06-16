/**
 * Tests for the internal-initiator marker utilities.
 *
 * Covers: marker detection, creation with deduplication, stripping, and part
 * classification helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createInternalAgentTextPart,
  hasInternalInitiatorMarker,
  isRealUserTextPart,
  isSyntheticOrInternalOnlyTextParts,
  isSyntheticOrInternalTextPart,
  stripInternalInitiatorMarkers,
  ZOO_INTERNAL_INITIATOR_MARKER,
} from "./internal-initiator.js";

// ---------------------------------------------------------------------------
// createInternalAgentTextPart
// ---------------------------------------------------------------------------

describe("createInternalAgentTextPart", () => {
  it("appends exactly one marker for clean text", () => {
    const text = "Hello world";
    const part = createInternalAgentTextPart(text);

    assert.equal(part.type, "text");
    assert.equal(part.text, `Hello world\n${ZOO_INTERNAL_INITIATOR_MARKER}`);
  });

  it("does not add synthetic flag or metadata", () => {
    const text = "Visible notification";
    const part = createInternalAgentTextPart(text);

    assert.equal("synthetic" in part, false);
    assert.equal("metadata" in part, false);
  });

  it("does not duplicate the marker when text already ends with one", () => {
    const text = `Already marked\n${ZOO_INTERNAL_INITIATOR_MARKER}`;
    const part = createInternalAgentTextPart(text);

    const markerCount =
      part.text.split(ZOO_INTERNAL_INITIATOR_MARKER).length - 1;
    assert.equal(markerCount, 1);
    assert.equal(part.text, `Already marked\n${ZOO_INTERNAL_INITIATOR_MARKER}`);
  });

  it("collapses multiple embedded markers to a single trailing one", () => {
    const text = `First\n${ZOO_INTERNAL_INITIATOR_MARKER}\nSecond\n${ZOO_INTERNAL_INITIATOR_MARKER}\nThird\n${ZOO_INTERNAL_INITIATOR_MARKER}`;
    const part = createInternalAgentTextPart(text);

    const markerCount =
      part.text.split(ZOO_INTERNAL_INITIATOR_MARKER).length - 1;
    assert.equal(markerCount, 1);
    assert.ok(part.text.endsWith(ZOO_INTERNAL_INITIATOR_MARKER));
  });

  it("strips embedded markers but keeps content", () => {
    const text = `Line one\n${ZOO_INTERNAL_INITIATOR_MARKER}\nLine two\n${ZOO_INTERNAL_INITIATOR_MARKER}`;
    const part = createInternalAgentTextPart(text);

    assert.ok(part.text.includes("Line one"));
    assert.ok(part.text.includes("Line two"));
    const markerCount =
      part.text.split(ZOO_INTERNAL_INITIATOR_MARKER).length - 1;
    assert.equal(markerCount, 1);
  });

  it("still appends a single marker for empty text", () => {
    const text = "";
    const part = createInternalAgentTextPart(text);

    assert.equal(part.text, `\n${ZOO_INTERNAL_INITIATOR_MARKER}`);
  });
});

// ---------------------------------------------------------------------------
// stripInternalInitiatorMarkers
// ---------------------------------------------------------------------------

describe("stripInternalInitiatorMarkers", () => {
  it("returns trimmed text when there are no markers", () => {
    const text = "No markers here";
    assert.equal(stripInternalInitiatorMarkers(text), "No markers here");
  });

  it("removes a single trailing marker", () => {
    const text = `Content\n${ZOO_INTERNAL_INITIATOR_MARKER}`;
    assert.equal(stripInternalInitiatorMarkers(text), "Content");
  });

  it("removes multiple stacked markers", () => {
    const text = `Content\n${ZOO_INTERNAL_INITIATOR_MARKER}\n${ZOO_INTERNAL_INITIATOR_MARKER}\n${ZOO_INTERNAL_INITIATOR_MARKER}`;
    assert.equal(stripInternalInitiatorMarkers(text), "Content");
  });

  it("removes markers on consecutive lines without separators", () => {
    const text = `${ZOO_INTERNAL_INITIATOR_MARKER}${ZOO_INTERNAL_INITIATOR_MARKER}${ZOO_INTERNAL_INITIATOR_MARKER}`;
    assert.equal(stripInternalInitiatorMarkers(text), "");
  });
});

// ---------------------------------------------------------------------------
// hasInternalInitiatorMarker
// ---------------------------------------------------------------------------

describe("hasInternalInitiatorMarker", () => {
  it("detects marker in standard form", () => {
    assert.ok(
      hasInternalInitiatorMarker(`notice\n${ZOO_INTERNAL_INITIATOR_MARKER}`),
    );
  });

  it("detects marker with extra whitespace inside comment", () => {
    assert.ok(
      hasInternalInitiatorMarker("notice\n<!--   ZOO_INTERNAL_INITIATOR   -->"),
    );
  });

  it("returns false for plain text", () => {
    assert.equal(hasInternalInitiatorMarker("just user input"), false);
  });

  it("returns false for similar-looking unrelated comment", () => {
    assert.equal(
      hasInternalInitiatorMarker("<!-- SOME_OTHER_COMMENT -->"),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// isSyntheticOrInternalTextPart / isRealUserTextPart
// ---------------------------------------------------------------------------

describe("isSyntheticOrInternalTextPart", () => {
  it("returns true for parts with synthetic flag", () => {
    const part = {
      type: "text",
      text: "internal message",
      synthetic: true,
    };
    assert.ok(isSyntheticOrInternalTextPart(part));
  });

  it("returns true for parts with the marker", () => {
    const part = {
      type: "text",
      text: `reminder\n${ZOO_INTERNAL_INITIATOR_MARKER}`,
    };
    assert.ok(isSyntheticOrInternalTextPart(part));
  });

  it("returns false for plain text parts", () => {
    const part = { type: "text", text: "user typed this" };
    assert.equal(isSyntheticOrInternalTextPart(part), false);
  });

  it("returns false for non-text parts", () => {
    const part = { type: "image", text: "irrelevant" };
    assert.equal(isSyntheticOrInternalTextPart(part as any), false);
  });

  it("returns false for parts without text", () => {
    const part = { type: "text" };
    assert.equal(isSyntheticOrInternalTextPart(part as any), false);
  });
});

describe("isRealUserTextPart", () => {
  it("returns true for plain user text", () => {
    const part = { type: "text", text: "real user input" };
    assert.ok(isRealUserTextPart(part));
  });

  it("returns false for synthetic parts", () => {
    const part = {
      type: "text",
      text: "internal",
      synthetic: true,
    };
    assert.equal(isRealUserTextPart(part), false);
  });

  it("returns false for parts with the marker", () => {
    const part = {
      type: "text",
      text: `reminder\n${ZOO_INTERNAL_INITIATOR_MARKER}`,
    };
    assert.equal(isRealUserTextPart(part), false);
  });
});

// ---------------------------------------------------------------------------
// isSyntheticOrInternalOnlyTextParts
// ---------------------------------------------------------------------------

describe("isSyntheticOrInternalOnlyTextParts", () => {
  it("returns true when all parts are synthetic or internal", () => {
    const parts = [
      { type: "text", text: "hidden", synthetic: true },
      { type: "text", text: `reminder\n${ZOO_INTERNAL_INITIATOR_MARKER}` },
    ];
    assert.ok(isSyntheticOrInternalOnlyTextParts(parts));
  });

  it("returns false when a real user part is mixed in", () => {
    const parts = [
      { type: "text", text: `reminder\n${ZOO_INTERNAL_INITIATOR_MARKER}` },
      { type: "text", text: "actual user request" },
    ];
    assert.equal(isSyntheticOrInternalOnlyTextParts(parts), false);
  });

  it("returns false for empty array", () => {
    assert.equal(isSyntheticOrInternalOnlyTextParts([]), false);
  });

  it("returns false for undefined", () => {
    assert.equal(isSyntheticOrInternalOnlyTextParts(undefined), false);
  });
});
