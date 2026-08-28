/**
 * Tests for the structured progress accumulator
 * (`src/core/subagent/accumulate.ts`).
 *
 * The accumulator is host-agnostic: the pi driver feeds it the raw fields
 * extracted from sub-session events (tool start/end, output lines, turns)
 * and it maintains the bounded structured view (recent tool calls, recent
 * output lines, turn/tool-call counters, start time) that the transcript
 * view model renders.  This suite locks the accumulation rules: bounded
 * recency caps, counter increments, and the snapshot projection.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createStructuredProgress,
  RECENT_OUTPUT_CAP,
  RECENT_TOOL_CAP,
  recordOutput,
  recordTokens,
  recordToolCall,
  recordToolStart,
  recordTurn,
  summarizeToolCall,
  summarizeValue,
  toSnapshot,
} from "./accumulate.js";

describe("accumulate — createStructuredProgress", () => {
  it("seeds empty state with the injected start time", () => {
    const state = createStructuredProgress(1234);
    assert.equal(state.startedAt, 1234);
    assert.deepEqual(state.toolCalls, []);
    assert.deepEqual(state.outputLines, []);
    assert.equal(state.turnCount, 0);
    assert.equal(state.toolCallCount, 0);
  });

  it("defaults the start time to the current clock", () => {
    const before = Date.now();
    const state = createStructuredProgress();
    assert.ok(state.startedAt >= before && state.startedAt <= Date.now());
  });
});

describe("accumulate — bounded recency", () => {
  it("caps the recent tool-call list to RECENT_TOOL_CAP, keeping the newest", () => {
    const state = createStructuredProgress(0);
    for (let i = 0; i < RECENT_TOOL_CAP + 5; i++) {
      recordToolCall(state, `tool${i}`, `summary ${i}`);
    }
    assert.equal(state.toolCalls.length, RECENT_TOOL_CAP);
    assert.equal(state.toolCalls[0].name, "tool5");
    assert.equal(
      state.toolCalls[RECENT_TOOL_CAP - 1].name,
      `tool${RECENT_TOOL_CAP + 4}`,
    );
  });

  it("caps the recent output-line list to RECENT_OUTPUT_CAP, keeping the newest", () => {
    const state = createStructuredProgress(0);
    for (let i = 0; i < RECENT_OUTPUT_CAP + 5; i++) {
      recordOutput(state, `line ${i}`);
    }
    assert.equal(state.outputLines.length, RECENT_OUTPUT_CAP);
    assert.equal(state.outputLines[0], "line 5");
    assert.equal(
      state.outputLines[RECENT_OUTPUT_CAP - 1],
      `line ${RECENT_OUTPUT_CAP + 4}`,
    );
  });
});

describe("accumulate — counters", () => {
  it("increments the tool-call counter on tool start, not on end", () => {
    const state = createStructuredProgress(0);
    recordToolStart(state);
    recordToolStart(state);
    assert.equal(state.toolCallCount, 2);
    assert.equal(state.turnCount, 0);
  });

  it("increments the turn counter per assistant turn", () => {
    const state = createStructuredProgress(0);
    recordTurn(state);
    recordTurn(state);
    recordTurn(state);
    assert.equal(state.turnCount, 3);
  });

  it("records a tool call with name and summary", () => {
    const state = createStructuredProgress(0);
    recordToolCall(state, "bash", "npm run build");
    assert.deepEqual(state.toolCalls, [
      { name: "bash", summary: "npm run build" },
    ]);
  });

  it("accumulates token usage from consecutive reports", () => {
    const state = createStructuredProgress(0);
    recordTokens(state, 1500);
    recordTokens(state, 500);
    assert.equal(state.tokens, 2000);
  });

  it("ignores absent, zero, negative, and NaN token reports", () => {
    const state = createStructuredProgress(0);
    recordTokens(state, Number.NaN);
    recordTokens(state, 0);
    recordTokens(state, -5);
    assert.equal(state.tokens, undefined);
  });

  it("flips the token field from undefined on the first valid report", () => {
    const state = createStructuredProgress(0);
    recordTokens(state, 0);
    assert.equal(state.tokens, undefined);
    recordTokens(state, 100);
    assert.equal(state.tokens, 100);
  });
});

describe("accumulate — summarizeValue", () => {
  it("renders a short string verbatim", () => {
    assert.equal(summarizeValue("hello world"), "hello world");
  });

  it("renders a JSON preview for objects, capped with an ellipsis", () => {
    const summary = summarizeValue({ command: "x".repeat(200) });
    assert.ok(summary.length <= 81, `summary too long: ${summary.length}`);
    assert.ok(summary.endsWith("…"), `missing ellipsis: ${summary}`);
    assert.ok(
      summary.startsWith('{"command":"'),
      `unexpected shape: ${summary}`,
    );
  });

  it("returns an empty string for nullish input", () => {
    assert.equal(summarizeValue(undefined), "");
    assert.equal(summarizeValue(null), "");
  });

  it("strips ANSI escapes and collapses whitespace before truncating", () => {
    const summary = summarizeValue(
      "\u001b[1mhello\u001b[0m   \u001b[31mworld\u001b[0m",
    );
    assert.equal(summary, "hello world");
  });
});

describe("accumulate — summarizeToolCall", () => {
  it("renders a bash call as `$ <command>`, capped at 60", () => {
    const summary = summarizeToolCall("bash", {
      command: "npm run build",
    });
    assert.equal(summary, "$ npm run build");
  });

  it("caps a long bash command at 60 with an ellipsis", () => {
    const summary = summarizeToolCall("bash", {
      command: `echo ${"x".repeat(100)}`,
    });
    // `$ ` prefix plus the 60-column command preview.
    assert.equal(summary.length, 62, `summary too long: ${summary.length}`);
    assert.ok(summary.startsWith("$ echo "));
    assert.ok(summary.endsWith("…"));
  });

  it("renders a read call as `read <path>` with $HOME collapsed to ~", () => {
    const summary = summarizeToolCall("read", {
      file_path: `${process.env.HOME}/src/a.ts`,
    });
    assert.equal(summary, `read ~/src/a.ts`);
  });

  it("renders a write call as `write <path>`", () => {
    const summary = summarizeToolCall("write", {
      file_path: "/tmp/out.txt",
      content: "line1\nline2\nline3",
    });
    assert.equal(summary, "write /tmp/out.txt");
  });

  it("renders an edit call as `edit <path>` with $HOME collapsed to ~", () => {
    const summary = summarizeToolCall("edit", {
      path: `${process.env.HOME}/src/b.ts`,
    });
    assert.equal(summary, "edit ~/src/b.ts");
  });

  it("falls back to `<name> <JSON args>` (capped at 40) for other tools", () => {
    const summary = summarizeToolCall("webfetch", {
      url: "https://example.com",
      method: "GET",
    });
    assert.ok(summary.startsWith("webfetch "), `unexpected: ${summary}`);
    assert.ok(summary.includes('"url"'), `missing url: ${summary}`);
  });

  it("collapses ANSI escapes inside tool-call args", () => {
    const summary = summarizeToolCall("bash", {
      command: "\u001b[1mecho hi\u001b[0m",
    });
    assert.equal(summary, "$ echo hi");
  });
});

describe("accumulate — toSnapshot", () => {
  it("projects only the structured fields onto a snapshot", () => {
    const state = createStructuredProgress(99);
    recordToolCall(state, "bash", "build");
    recordOutput(state, "ok");
    recordTurn(state);
    recordToolStart(state);
    assert.deepEqual(toSnapshot(state), {
      toolCalls: [{ name: "bash", summary: "build" }],
      outputLines: ["ok"],
      turnCount: 1,
      toolCallCount: 1,
      startedAt: 99,
    });
  });

  it("includes the token total once tokens were accumulated", () => {
    const state = createStructuredProgress(99);
    recordTokens(state, 1234);
    assert.equal(toSnapshot(state).tokens, 1234);
  });
});
