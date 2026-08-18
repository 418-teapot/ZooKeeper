/**
 * Tests for the mutation-invariant message projection (`canon.ts`).
 *
 * Covers the spec's R6 mitigation: every text mutation the core itself
 * performs (line-start ref injection, tool-output / tool-input
 * placeholder replacement) must leave `canon` unchanged, while real
 * content changes must always change it.  Also covers concatenation
 * boundary ambiguity, hidden-message behavior, and the exact strip
 * rules.  All fixtures are built through the lens testkit.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canon, stripTags } from "./canon.js";
import { regionsOfKind } from "./lens.js";
import { makeAssistantMsg, makeMsg, makeToolMsg } from "./lens-testkit.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "./message-parts.js";

// ---------------------------------------------------------------------------
// Mutation invariance — core-side rewrites must not change canon
// ---------------------------------------------------------------------------

describe("mutation invariance", () => {
  it("line-start ref prefix injection into content leaves canon unchanged", () => {
    const msg = makeAssistantMsg({ text: "first line\nsecond line" });
    const before = canon(msg);
    regionsOfKind(msg, "content")[0].set(`[m12] ${msg.regions[0].get()}`);
    assert.equal(canon(msg), before);
  });

  it("tool-output placeholder replacement leaves canon unchanged", () => {
    const msg = makeToolMsg("bash", "ls -la", "some long output");
    const before = canon(msg);
    regionsOfKind(msg, "tool-output")[0].set(PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(canon(msg), before);
  });

  it("tool-input placeholder replacement leaves canon unchanged", () => {
    const msg = makeToolMsg("edit", "large input payload", "ok");
    const before = canon(msg);
    regionsOfKind(msg, "tool-input")[0].set(
      PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
    );
    assert.equal(canon(msg), before);
  });

  it("all core mutations together leave canon unchanged", () => {
    const msg = makeAssistantMsg({
      text: "let me check",
      thinking: "reasoning trace",
      toolCalls: [{ name: "bash", input: "ls", output: "files" }],
    });
    const before = canon(msg);
    regionsOfKind(msg, "content")[0].set("[m3] let me check");
    regionsOfKind(msg, "tool-input")[0].set(
      PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
    );
    regionsOfKind(msg, "tool-output")[0].set(PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(canon(msg), before);
  });
});

// ---------------------------------------------------------------------------
// Real content change must change canon
// ---------------------------------------------------------------------------

describe("content change", () => {
  it("a one-character content change changes canon", () => {
    assert.notEqual(
      canon(makeMsg("user", ["hello world"])),
      canon(makeMsg("user", ["hello worle"])),
    );
  });

  it("a one-character thinking change changes canon", () => {
    assert.notEqual(
      canon(makeAssistantMsg({ thinking: "plan A" })),
      canon(makeAssistantMsg({ thinking: "plan B" })),
    );
  });

  it("a different tool name changes canon", () => {
    assert.notEqual(
      canon(makeToolMsg("bash", "i", "o")),
      canon(makeToolMsg("read", "i", "o")),
    );
  });

  it("a different role changes canon", () => {
    assert.notEqual(
      canon(makeMsg("user", ["hi"])),
      canon(makeMsg("assistant", ["hi"])),
    );
  });

  it("an added content region changes canon", () => {
    assert.notEqual(
      canon(makeMsg("user", ["a"])),
      canon(makeMsg("user", ["a", "b"])),
    );
  });

  it("an added tool call changes canon", () => {
    assert.notEqual(
      canon(makeToolMsg("bash", "i", "o")),
      canon(
        makeAssistantMsg({
          toolCalls: [
            { name: "bash", input: "i", output: "o" },
            { name: "bash", input: "i2", output: "o2" },
          ],
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Structural boundaries — no concatenation ambiguity
// ---------------------------------------------------------------------------

describe("structural boundary", () => {
  it("component concatenation is unambiguous (ab+c vs a+bc)", () => {
    assert.notEqual(
      canon(makeMsg("user", ["ab", "c"])),
      canon(makeMsg("user", ["a", "bc"])),
    );
  });

  it("content region order is significant", () => {
    assert.notEqual(
      canon(makeMsg("user", ["first", "second"])),
      canon(makeMsg("user", ["second", "first"])),
    );
  });

  it("role and content boundaries are unambiguous", () => {
    assert.notEqual(canon(makeMsg("ab", ["c"])), canon(makeMsg("a", ["bc"])));
  });

  it("content and thinking boundaries are unambiguous", () => {
    assert.notEqual(
      canon(makeAssistantMsg({ text: "ab", thinking: "c" })),
      canon(makeAssistantMsg({ text: "a", thinking: "bc" })),
    );
  });
});

// ---------------------------------------------------------------------------
// Hidden messages — canon ignores the flag, the caller decides
// ---------------------------------------------------------------------------

describe("hidden messages", () => {
  it("computes canon normally and ignores the hidden flag", () => {
    const visible = makeMsg("user", ["hello"], { hidden: false });
    const hidden = makeMsg("user", ["hello"], { hidden: true });
    assert.equal(typeof canon(hidden), "string");
    assert.equal(canon(hidden), canon(visible));
  });

  it("hidden tool messages also ignore the flag", () => {
    const visible = makeToolMsg("bash", "i", "o", { hidden: false });
    const hidden = makeToolMsg("bash", "i", "o", { hidden: true });
    assert.equal(canon(hidden), canon(visible));
  });
});

// ---------------------------------------------------------------------------
// stripTags exact rules
// ---------------------------------------------------------------------------

describe("stripTags", () => {
  it("strips a line-start ref prefix including the trailing space", () => {
    assert.equal(stripTags("[m12] hello\nworld"), "hello\nworld");
  });

  it("preserves a bare ref in mid-text", () => {
    assert.equal(stripTags("see [m3] here"), "see [m3] here");
  });

  it("preserves a ref not at the start of a line", () => {
    assert.equal(stripTags("a\nb [m5] c"), "a\nb [m5] c");
  });

  it("preserves a line-start ref without the trailing space", () => {
    assert.equal(stripTags("[m3]here"), "[m3]here");
  });

  it("is idempotent", () => {
    const input = "[m12] line1\nline2";
    assert.equal(stripTags(stripTags(input)), stripTags(input));
  });
});
