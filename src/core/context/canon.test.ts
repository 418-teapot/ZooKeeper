/**
 * Tests for the mutation-invariant message projection (`canon.ts`).
 *
 * Covers the spec's R6 mitigation: every text mutation the core itself
 * performs (tool-output / tool-input placeholder replacement) must
 * leave `canon` unchanged, while real content changes must always
 * change it.  Also covers concatenation boundary ambiguity and
 * hidden-message behavior.  All fixtures are built through the lens
 * testkit.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canon } from "./canon.js";
import {
  makeAssistantMsg,
  makeMsg,
  makeToolMsg,
  setRegionText,
} from "./lens-testkit.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "./message-parts.js";

// ---------------------------------------------------------------------------
// Mutation invariance — core-side rewrites must not change canon
// ---------------------------------------------------------------------------

describe("mutation invariance", () => {
  it("tool-output placeholder replacement leaves canon unchanged", () => {
    const msg = makeToolMsg("bash", "ls -la", "some long output");
    const before = canon(msg);
    setRegionText(msg, 1, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(canon(msg), before);
  });

  it("tool-input placeholder replacement leaves canon unchanged", () => {
    const msg = makeToolMsg("edit", "large input payload", "ok");
    const before = canon(msg);
    setRegionText(msg, 0, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    assert.equal(canon(msg), before);
  });

  it("all core mutations together leave canon unchanged", () => {
    const msg = makeAssistantMsg({
      text: "let me check",
      thinking: "reasoning trace",
      toolCalls: [{ name: "bash", input: "ls", output: "files" }],
    });
    const before = canon(msg);
    setRegionText(msg, 2, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    setRegionText(msg, 3, PRUNED_TOOL_OUTPUT_REPLACEMENT);
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

  it("a line-start ref marker in content changes canon (hashed verbatim)", () => {
    assert.notEqual(
      canon(makeMsg("user", ["hello"])),
      canon(makeMsg("user", ["[m3] hello"])),
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
