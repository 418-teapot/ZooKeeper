/**
 * Tests for the core terminal control-sequence stripper
 * (`terminal-sequences.ts`).
 *
 * Locks the faithful pi-tui semantics the ask tool relies on: the
 * no-escape fast path, removal of ESC-initiated CSI / OSC / APC sequences,
 * and preservation of visible text plus bare C0 controls.  The expected
 * values are literals derived from the sequence grammar, independent of the
 * implementation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "./terminal-sequences.js";

describe("stripTerminalSequences", () => {
  it("returns the input unchanged when it has no escape", () => {
    const text = "plain text with \t tab, newline\nand \x07 bell";
    assert.equal(stripTerminalSequences(text), text);
  });

  it("strips CSI colour and erase sequences", () => {
    assert.equal(stripTerminalSequences("\x1b[31mred\x1b[0m"), "red");
    assert.equal(stripTerminalSequences("\x1b[2Jcleared"), "cleared");
    assert.equal(stripTerminalSequences("move\x1b[10;20Hhere"), "movehere");
  });

  it("strips OSC sequences terminated by BEL or ST", () => {
    assert.equal(stripTerminalSequences("\x1b]0;evil\x07title"), "title");
    assert.equal(stripTerminalSequences("\x1b]8;;http://x\x1b\\link"), "link");
  });

  it("strips APC sequences terminated by BEL or ST", () => {
    assert.equal(stripTerminalSequences("\x1b_\x07marker"), "marker");
    assert.equal(stripTerminalSequences("\x1b_abc\x1b\\tail"), "tail");
  });

  it("collapses a control-sequence-only string to empty", () => {
    assert.equal(stripTerminalSequences("\x1b[2J\x1b[0m"), "");
    assert.equal(stripTerminalSequences("\x1b[31m"), "");
    assert.equal(stripTerminalSequences("\x1b_\x07"), "");
  });

  it("keeps cursor-motion CSI finals A/B/C/D untouched", () => {
    assert.equal(stripTerminalSequences("\x1b[A"), "\x1b[A");
    assert.equal(stripTerminalSequences("\x1b[1B"), "\x1b[1B");
  });

  it("keeps an unterminated escape sequence verbatim", () => {
    assert.equal(stripTerminalSequences("\x1b[31"), "\x1b[31");
    assert.equal(stripTerminalSequences("\x1b]0;open"), "\x1b]0;open");
  });
});
