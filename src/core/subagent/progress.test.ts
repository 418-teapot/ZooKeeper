/**
 * Tests for the compact snapshot text formatting (`src/core/subagent/progress.ts`).
 *
 * Covers the pure formatting side of the compact-progress contract: the
 * last-line extraction, the size cap with its ellipsis marker, the tool-name
 * prefix, and the hard guarantee that a multi-KB input never yields an
 * over-cap snapshot line.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatProgressLine,
  formatSnapshotOutput,
  SNAPSHOT_ELLIPSIS,
  SNAPSHOT_OUTPUT_CAP,
} from "./progress.js";

describe("progress — module constants", () => {
  it("hardcodes the output cap to 200 characters", () => {
    assert.equal(SNAPSHOT_OUTPUT_CAP, 200);
  });

  it("hardcodes the ellipsis marker to a single ellipsis character", () => {
    assert.equal(SNAPSHOT_ELLIPSIS, "…");
  });
});

describe("formatSnapshotOutput", () => {
  it("returns the text verbatim when it is a single short line", () => {
    assert.equal(
      formatSnapshotOutput("finished the task"),
      "finished the task",
    );
  });

  it("returns the last non-empty line of a multi-line text", () => {
    const text = "line one\nline two\nline three";
    assert.equal(formatSnapshotOutput(text), "line three");
  });

  it("skips trailing empty lines and returns the last non-empty one", () => {
    const text = "first\nsecond\n\n\n";
    assert.equal(formatSnapshotOutput(text), "second");
  });

  it("returns an empty string for empty or whitespace-only text", () => {
    assert.equal(formatSnapshotOutput(""), "");
    assert.equal(formatSnapshotOutput("\n\n"), "");
  });

  it("truncates a long last line to the cap with the ellipsis marker", () => {
    const long = "x".repeat(500);
    const compact = formatSnapshotOutput(long);
    assert.equal(compact.length, SNAPSHOT_OUTPUT_CAP);
    assert.ok(compact.endsWith(SNAPSHOT_ELLIPSIS));
    assert.ok(compact.startsWith("x".repeat(SNAPSHOT_OUTPUT_CAP - 1)));
  });

  it("never exceeds the cap for a multi-KB input", () => {
    // The size-cap assertion required by the compact-progress contract:
    // a multi-KB assistant text must never leak into a snapshot.
    const huge = Array.from(
      { length: 2000 },
      (_, i) => `line ${i} of text`,
    ).join("\n");
    const compact = formatSnapshotOutput(huge);
    assert.ok(
      compact.length <= SNAPSHOT_OUTPUT_CAP,
      `snapshot exceeded cap: ${compact.length}`,
    );
  });
});

describe("formatProgressLine", () => {
  it("prefixes the compact output with the running tool in brackets", () => {
    const line = formatProgressLine({
      currentTool: "bash",
      output: "compiling",
      done: false,
    });
    assert.equal(line, "[bash] compiling");
  });

  it("renders a tool-less snapshot as the compact output alone", () => {
    const line = formatProgressLine({ output: "done", done: true });
    assert.equal(line, "done");
  });

  it("caps the tool-prefixed line's output to the cap", () => {
    const long = "y".repeat(400);
    const line = formatProgressLine({
      currentTool: "edit",
      output: long,
      done: false,
    });
    const prefix = "[edit] ";
    assert.ok(
      line.length <= prefix.length + SNAPSHOT_OUTPUT_CAP,
      `line exceeded cap: ${line.length}`,
    );
    assert.ok(line.startsWith(prefix));
    assert.ok(line.endsWith(SNAPSHOT_ELLIPSIS));
  });

  it("prefixes the line with an optional label outside the output cap", () => {
    const line = formatProgressLine(
      { currentTool: "bash", output: "compiling", done: false },
      SNAPSHOT_OUTPUT_CAP,
      "实现功能",
    );
    assert.equal(line, "[实现功能] [bash] compiling");
  });

  it("renders a label-prefixed tool-less snapshot as label + output", () => {
    const line = formatProgressLine(
      { output: "done", done: true },
      SNAPSHOT_OUTPUT_CAP,
      "实现功能",
    );
    assert.equal(line, "[实现功能] done");
  });

  it("keeps the label outside the capped output length", () => {
    const long = "y".repeat(400);
    const line = formatProgressLine(
      { currentTool: "edit", output: long, done: false },
      SNAPSHOT_OUTPUT_CAP,
      "实现功能",
    );
    const prefix = "[实现功能] [edit] ";
    assert.ok(
      line.length <= prefix.length + SNAPSHOT_OUTPUT_CAP,
      `label-prefixed line exceeded cap: ${line.length}`,
    );
    assert.ok(line.startsWith(prefix));
    assert.ok(line.endsWith(SNAPSHOT_ELLIPSIS));
  });
});
