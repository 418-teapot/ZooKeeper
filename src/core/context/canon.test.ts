/**
 * Tests for the mutation-invariant message projection (`canon.ts`).
 *
 * Covers the spec's R6 mitigation: every text mutation the core itself
 * performs (tool-output / tool-input placeholder replacement) must
 * leave `canon` unchanged, while real content changes must always
 * change it.  Also covers concatenation boundary ambiguity and
 * hidden-message behavior.  All fixtures are built through the lens
 * testkit; `canon` observes each message through a projection of one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canon } from "./canon.js";
import type { HostMessage } from "./lens.js";
import {
  makeAssistantMsg,
  makeMsg,
  makeToolMsg,
  projectMessages,
  setRegionText,
} from "./lens-testkit.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "./message-parts.js";

/** Canon of a single message via a one-message projection. */
function canon1(msg: HostMessage): string {
  return canon(projectMessages([msg]), 0);
}

// ---------------------------------------------------------------------------
// Mutation invariance — core-side rewrites must not change canon
// ---------------------------------------------------------------------------

describe("mutation invariance", () => {
  it("tool-output placeholder replacement leaves canon unchanged", () => {
    const msg = makeToolMsg("bash", "ls -la", "some long output");
    const before = canon1(msg);
    setRegionText(msg, 1, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(canon1(msg), before);
  });

  it("tool-input placeholder replacement leaves canon unchanged", () => {
    const msg = makeToolMsg("edit", "large input payload", "ok");
    const before = canon1(msg);
    setRegionText(msg, 0, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    assert.equal(canon1(msg), before);
  });

  it("all core mutations together leave canon unchanged", () => {
    const msg = makeAssistantMsg({
      text: "let me check",
      thinking: "reasoning trace",
      toolCalls: [{ name: "bash", input: "ls", output: "files" }],
    });
    const before = canon1(msg);
    setRegionText(msg, 2, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    setRegionText(msg, 3, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    assert.equal(canon1(msg), before);
  });
});

// ---------------------------------------------------------------------------
// Real content change must change canon
// ---------------------------------------------------------------------------

describe("content change", () => {
  it("a one-character content change changes canon", () => {
    assert.notEqual(
      canon1(makeMsg("user", ["hello world"])),
      canon1(makeMsg("user", ["hello worle"])),
    );
  });

  it("a one-character thinking change changes canon", () => {
    assert.notEqual(
      canon1(makeAssistantMsg({ thinking: "plan A" })),
      canon1(makeAssistantMsg({ thinking: "plan B" })),
    );
  });

  it("a different tool name changes canon", () => {
    assert.notEqual(
      canon1(makeToolMsg("bash", "i", "o")),
      canon1(makeToolMsg("read", "i", "o")),
    );
  });

  it("a different role changes canon", () => {
    assert.notEqual(
      canon1(makeMsg("user", ["hi"])),
      canon1(makeMsg("assistant", ["hi"])),
    );
  });

  it("a line-start ref marker in content changes canon (hashed verbatim)", () => {
    assert.notEqual(
      canon1(makeMsg("user", ["hello"])),
      canon1(makeMsg("user", ["[m3] hello"])),
    );
  });

  it("an added content region changes canon", () => {
    assert.notEqual(
      canon1(makeMsg("user", ["a"])),
      canon1(makeMsg("user", ["a", "b"])),
    );
  });

  it("an added tool call changes canon", () => {
    assert.notEqual(
      canon1(makeToolMsg("bash", "i", "o")),
      canon1(
        makeAssistantMsg({
          toolCalls: [
            { name: "bash", input: "i", output: "o" },
            { name: "bash", input: "i2", output: "o2" },
          ],
        }),
      ),
    );
  });

  it("an unpaired tool region contributes the empty name (fail-closed)", () => {
    // A bare tool-output region with no invocation table entry (an
    // orphan result message) hashes with the empty-string name — the
    // pairing information simply is not there.
    const orphan: HostMessage = {
      role: "toolResult",
      hidden: false,
      regions: [{ kind: "tool-output", get: () => "output" }],
    };
    assert.equal(canon1(orphan), JSON.stringify(["toolResult", [], [], [""]]));
  });
});

// ---------------------------------------------------------------------------
// Structural boundaries — no concatenation ambiguity
// ---------------------------------------------------------------------------

describe("structural boundary", () => {
  it("component concatenation is unambiguous (ab+c vs a+bc)", () => {
    assert.notEqual(
      canon1(makeMsg("user", ["ab", "c"])),
      canon1(makeMsg("user", ["a", "bc"])),
    );
  });

  it("content region order is significant", () => {
    assert.notEqual(
      canon1(makeMsg("user", ["first", "second"])),
      canon1(makeMsg("user", ["second", "first"])),
    );
  });

  it("role and content boundaries are unambiguous", () => {
    assert.notEqual(canon1(makeMsg("ab", ["c"])), canon1(makeMsg("a", ["bc"])));
  });

  it("content and thinking boundaries are unambiguous", () => {
    assert.notEqual(
      canon1(makeAssistantMsg({ text: "ab", thinking: "c" })),
      canon1(makeAssistantMsg({ text: "a", thinking: "bc" })),
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
    assert.equal(typeof canon1(hidden), "string");
    assert.equal(canon1(hidden), canon1(visible));
  });

  it("hidden tool messages also ignore the flag", () => {
    const visible = makeToolMsg("bash", "i", "o", { hidden: false });
    const hidden = makeToolMsg("bash", "i", "o", { hidden: true });
    assert.equal(canon1(hidden), canon1(visible));
  });
});
