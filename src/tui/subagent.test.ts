/**
 * Tests for sub-agent tracking logic in `src/tui/subagent.ts`.
 *
 * Covers the pure helper functions exported from the module:
 * subStatusFromState, extractTitle, extractAgent, collectSubEntries,
 * mergeScannedEntries.
 *
 * Rendering and event-wiring tests are omitted because the TUI
 * component requires a full @opentui/solid + plugin runtime.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ContextMessageEntry } from "../core/context/metrics.js";
import type { SubEntry } from "./subagent.js";
import {
  collectSubEntries,
  extractAgent,
  extractContextTokens,
  extractModel,
  extractTimes,
  extractTitle,
  formatDuration,
  mergeScannedEntries,
  subStatusFromState,
} from "./subagent.js";

// ---------------------------------------------------------------------------
// subStatusFromState
// ---------------------------------------------------------------------------

describe("subStatusFromState", () => {
  it('returns "done" for "completed"', () => {
    assert.equal(subStatusFromState("completed"), "done");
  });

  it('returns "error" for "error"', () => {
    assert.equal(subStatusFromState("error"), "error");
  });

  it('returns "running" for "running"', () => {
    assert.equal(subStatusFromState("running"), "running");
  });

  it('returns "running" for "pending"', () => {
    assert.equal(subStatusFromState("pending"), "running");
  });

  it('returns "running" for unknown states', () => {
    assert.equal(subStatusFromState("cancelled"), "running");
  });
});

// ---------------------------------------------------------------------------
// extractAgent
// ---------------------------------------------------------------------------

describe("extractAgent", () => {
  it("returns subagent_type from input", () => {
    const input = { subagent_type: "beaver" };
    assert.equal(extractAgent(input), "beaver");
  });

  it('returns "task" when no subagent_type', () => {
    assert.equal(extractAgent({}), "task");
  });

  it('returns "task" when input is undefined', () => {
    assert.equal(extractAgent(undefined), "task");
  });

  it("converts subagent_type to string", () => {
    const input = { subagent_type: 42 };
    assert.equal(extractAgent(input as Record<string, unknown>), "42");
  });
});

// ---------------------------------------------------------------------------
// extractModel
// ---------------------------------------------------------------------------

describe("extractModel", () => {
  it("extracts modelID from metadata.model", () => {
    const meta = { model: { modelID: "deepseek-v4-flash" } };
    assert.equal(extractModel(meta), "deepseek-v4-flash");
  });

  it("returns undefined when metadata is undefined", () => {
    assert.equal(extractModel(undefined), undefined);
  });

  it("returns undefined when model field is not an object", () => {
    const meta = { model: "deepseek-v4-flash" };
    assert.equal(extractModel(meta), undefined);
  });

  it("returns undefined when model field is null", () => {
    const meta = { model: null };
    assert.equal(extractModel(meta), undefined);
  });

  it("returns undefined when modelID is missing", () => {
    const meta = { model: { providerID: "anthropic" } };
    assert.equal(extractModel(meta), undefined);
  });

  it("returns undefined when modelID is not a string", () => {
    const meta = { model: { modelID: 42 } };
    assert.equal(extractModel(meta), undefined);
  });
});

// ---------------------------------------------------------------------------
// extractTitle
// ---------------------------------------------------------------------------

describe("extractTitle", () => {
  it("returns state.title if present", () => {
    const state = { title: "My Title", status: "running" };
    assert.equal(extractTitle(state), "My Title");
  });

  it("prefers description from input", () => {
    const state = {
      status: "running",
      input: { description: "desc text", prompt: "full prompt here" },
    };
    assert.equal(extractTitle(state), "desc text");
  });

  it("falls back to truncated prompt (40 chars)", () => {
    const longPrompt = "a".repeat(50);
    const state = {
      status: "running",
      input: { prompt: longPrompt },
    };
    assert.equal(extractTitle(state), "a".repeat(40));
  });

  it('truncates prompt at 40 chars and does not add "…"', () => {
    const prompt = "1234567890".repeat(5);
    const state = {
      status: "running",
      input: { prompt },
    };
    const title = extractTitle(state);
    assert.equal(title.length, 40);
    assert.equal(title, "1234567890".repeat(4));
  });

  it("returns part id slice as last fallback", () => {
    const state = { status: "running", input: {} };
    const partId = "part_abc123_def456";
    assert.equal(extractTitle(state, partId), "part_abc");
  });

  it("falls back to empty string when no inputs at all", () => {
    const state = { status: "running" };
    assert.equal(extractTitle(state), "");
  });
});

// ---------------------------------------------------------------------------
// extractTimes
// ---------------------------------------------------------------------------

describe("extractTimes", () => {
  it("extracts startedAt and endedAt from state.time", () => {
    const state = {
      status: "completed",
      time: { start: 1000, end: 5000 },
    };
    const result = extractTimes(state);
    assert.equal(result.startedAt, 1000);
    assert.equal(result.endedAt, 5000);
  });

  it("returns only startedAt when state has no end", () => {
    const state = {
      status: "running",
      time: { start: 1000 },
    };
    const result = extractTimes(state);
    assert.equal(result.startedAt, 1000);
    assert.equal(result.endedAt, undefined);
  });

  it("returns undefined fields when state.time is absent", () => {
    const state = { status: "running" };
    const result = extractTimes(state);
    assert.equal(result.startedAt, undefined);
    assert.equal(result.endedAt, undefined);
  });

  it("returns undefined fields when state.time is not an object", () => {
    const state = { status: "completed", time: "invalid" };
    const result = extractTimes(state);
    assert.equal(result.startedAt, undefined);
    assert.equal(result.endedAt, undefined);
  });

  it("rejects non-number start value", () => {
    const state = {
      status: "completed",
      time: { start: "string", end: 5000 },
    };
    const result = extractTimes(state);
    assert.equal(result.startedAt, undefined);
    assert.equal(result.endedAt, 5000);
  });

  it("rejects non-finite start value (Infinity)", () => {
    const state = {
      status: "running",
      time: { start: Infinity },
    };
    const result = extractTimes(state);
    assert.equal(result.startedAt, undefined);
  });

  it("rejects non-finite end value (NaN)", () => {
    const state = {
      status: "completed",
      time: { start: 1000, end: NaN },
    };
    const result = extractTimes(state);
    assert.equal(result.startedAt, 1000);
    assert.equal(result.endedAt, undefined);
  });
});

// ---------------------------------------------------------------------------
// extractContextTokens
// ---------------------------------------------------------------------------

describe("extractContextTokens", () => {
  it("treats non-numeric token fields as 0 (no string concatenation)", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 100, cache: { read: 50 } },
        },
      },
      {
        info: {
          role: "assistant",
          tokens: { input: "743", cache: { read: 8064 } },
        },
      },
    ];
    // The newest assistant (last in array) has string input — coerced
    // to 0, so its sum is 8064 (cache.read only), and it must win
    // over the older one.
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      8064,
    );
  });

  it("returns undefined when tokens are entirely non-numeric", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: "100", cache: { read: "50" } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      undefined,
    );
  });

  it("returns sum of input + cache.read for last assistant message", () => {
    const messages = [
      { info: { role: "user" } },
      {
        info: {
          role: "assistant",
          tokens: { input: 100, cache: { read: 50 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      150,
    );
  });

  it("skips zero-sum placeholder, returns previous assistant tokens", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 200, cache: { read: 30 } },
        },
      },
      {
        info: {
          role: "assistant",
          tokens: { input: 0, cache: { read: 0 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      230,
    );
  });

  it("skips multiple zero-sum placeholders", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 50, cache: { read: 10 } },
        },
      },
      {
        info: {
          role: "assistant",
          tokens: { input: 0, cache: { read: 0 } },
        },
      },
      {
        info: {
          role: "assistant",
          tokens: { input: 0, cache: { read: 0 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      60,
    );
  });

  it("returns undefined when all assistant messages are zero-sum", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 0, cache: { read: 0 } },
        },
      },
      {
        info: {
          role: "assistant",
          tokens: { input: 0, cache: { read: 0 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      undefined,
    );
  });

  it("returns undefined when no assistant messages exist", () => {
    const messages = [
      { info: { role: "user", tokens: { input: 100 } } },
      { info: { role: "tool", tokens: { input: 50 } } },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      undefined,
    );
  });

  it("skips assistant messages with missing tokens field", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 100, cache: { read: 20 } },
        },
      },
      { info: { role: "assistant", custom: "no tokens field" } },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      120,
    );
  });

  it("skips assistant with partial tokens missing both input and cache", () => {
    // tokens field exists but both input and cache are absent → sum 0 → skip
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 300, cache: { read: 100 } },
        },
      },
      { info: { role: "assistant", tokens: {} } },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      400,
    );
  });

  it("returns undefined for empty array", () => {
    assert.equal(extractContextTokens([]), undefined);
  });

  it("handles messages with missing info field", () => {
    const messages = [
      { parts: [] },
      {
        info: {
          role: "assistant",
          tokens: { input: 75, cache: { read: 25 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      100,
    );
  });

  it("handles cache.read as undefined (defaults to 0)", () => {
    const messages = [{ info: { role: "assistant", tokens: { input: 100 } } }];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      100,
    );
  });

  it("handles input as undefined (defaults to 0)", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { cache: { read: 200 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      200,
    );
  });

  it("returns sum when input is 0 but cache.read is positive", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          tokens: { input: 0, cache: { read: 300 } },
        },
      },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      300,
    );
  });

  it("navigates tool/tool-call messages interleaved with assistant", () => {
    const messages = [
      { info: { role: "user" } },
      {
        info: {
          role: "assistant",
          tokens: { input: 500, cache: { read: 50 } },
        },
      },
      { info: { role: "tool" } },
      { info: { role: "tool" } },
      { info: { role: "assistant", tokens: { input: 0, cache: { read: 0 } } } },
    ];
    assert.equal(
      extractContextTokens(messages as Record<string, unknown>[]),
      550,
    );
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("formats seconds (< 60)", () => {
    assert.equal(formatDuration(12_000), "12s");
  });

  it("formats 0 seconds", () => {
    assert.equal(formatDuration(0), "0s");
  });

  it("formats minutes and seconds (≥ 60)", () => {
    assert.equal(formatDuration(125_000), "2m05s");
  });

  it("zero-pads seconds in minute format", () => {
    assert.equal(formatDuration(60_000), "1m00s");
  });

  it("formats exact minute boundary", () => {
    assert.equal(formatDuration(60_000), "1m00s");
  });

  it("formats multiple minutes with seconds", () => {
    assert.equal(formatDuration(5 * 60_000 + 7_000), "5m07s");
  });

  it('returns "—" for negative values', () => {
    assert.equal(formatDuration(-1), "—");
  });

  it('returns "—" for NaN', () => {
    assert.equal(formatDuration(NaN), "—");
  });

  it('returns "—" for Infinity', () => {
    assert.equal(formatDuration(Infinity), "—");
  });
});

// ---------------------------------------------------------------------------
// collectSubEntries
// ---------------------------------------------------------------------------

/**
 * Build a minimal ContextMessageEntry containing the given parts.
 * For type compatibility we cast through `unknown` since the live
 * SDK returns richer part shapes than `ContextTextPart`.
 */
function msg(parts: Array<Record<string, unknown>>): ContextMessageEntry {
  return {
    info: { role: "assistant", id: "msg_1" },
    parts: parts as unknown as ContextMessageEntry["parts"],
  };
}

/** A minimal task tool part with the given overrides. */
function taskPart(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "tool",
    tool: "task",
    id: "part_default",
    state: { status: "completed", input: { subagent_type: "beaver" } },
    ...overrides,
  };
}

describe("collectSubEntries", () => {
  it("extracts a completed task part as done entry", () => {
    const result = collectSubEntries([msg([taskPart({ id: "part_1" })])]);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "part_1");
    assert.equal(result[0].status, "done");
    assert.equal(result[0].agent, "beaver");
  });

  it("maps completed status to done", () => {
    const result = collectSubEntries([
      msg([taskPart({ id: "p1", state: { status: "completed" } })]),
    ]);
    assert.equal(result[0].status, "done");
  });

  it("maps error status to error", () => {
    const result = collectSubEntries([
      msg([taskPart({ id: "p1", state: { status: "error", error: "fail" } })]),
    ]);
    assert.equal(result[0].status, "error");
  });

  it("maps running status to running", () => {
    const result = collectSubEntries([
      msg([taskPart({ id: "p1", state: { status: "running" } })]),
    ]);
    assert.equal(result[0].status, "running");
  });

  it("includes error field when status is error", () => {
    const result = collectSubEntries([
      msg([
        taskPart({
          id: "p1",
          state: { status: "error", error: "something went wrong" },
        }),
      ]),
    ]);
    assert.equal(result[0].error, "something went wrong");
  });

  it("omits error field when status is not error", () => {
    const result = collectSubEntries([
      msg([taskPart({ id: "p1", state: { status: "completed" } })]),
    ]);
    assert.equal(result[0].error, undefined);
  });

  it("reads sessionId from metadata.session_id", () => {
    const result = collectSubEntries([
      msg([
        taskPart({
          id: "p1",
          state: {
            status: "completed",
            metadata: { session_id: "child_sid" },
          },
        }),
      ]),
    ]);
    assert.equal(result[0].sessionId, "child_sid");
  });

  it("reads sessionId from metadata.sessionId as fallback", () => {
    const result = collectSubEntries([
      msg([
        taskPart({
          id: "p1",
          state: {
            status: "completed",
            metadata: { sessionId: "child_sid_2" },
          },
        }),
      ]),
    ]);
    assert.equal(result[0].sessionId, "child_sid_2");
  });

  it("skips pending parts", () => {
    const result = collectSubEntries([
      msg([taskPart({ id: "p1", state: { status: "pending" } })]),
    ]);
    assert.equal(result.length, 0);
  });

  it("ignores non-task tool parts", () => {
    const result = collectSubEntries([
      msg([
        {
          type: "tool",
          tool: "webfetch",
          id: "p_web",
          state: { status: "completed" },
        },
      ]),
    ]);
    assert.equal(result.length, 0);
  });

  it("skips part without id", () => {
    const result = collectSubEntries([msg([taskPart({ id: undefined })])]);
    assert.equal(result.length, 0);
  });

  it("skips part without state", () => {
    const result = collectSubEntries([
      msg([{ type: "tool", tool: "task", id: "p_no_state" }]),
    ]);
    assert.equal(result.length, 0);
  });

  it("returns empty array when messages have no parts", () => {
    const result = collectSubEntries([{ info: { role: "user", id: "m1" } }]);
    assert.equal(result.length, 0);
  });

  it("returns empty array for empty messages list", () => {
    const result = collectSubEntries([]);
    assert.equal(result.length, 0);
  });

  it("extracts entries across multiple messages", () => {
    const result = collectSubEntries([
      msg([taskPart({ id: "p_a", state: { status: "completed" } })]),
      msg([taskPart({ id: "p_b", state: { status: "running" } })]),
    ]);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "p_a");
    assert.equal(result[1].id, "p_b");
  });

  it("uses title from state.title", () => {
    const result = collectSubEntries([
      msg([
        taskPart({
          id: "p1",
          state: { title: "My Title", status: "completed" },
        }),
      ]),
    ]);
    assert.equal(result[0].title, "My Title");
  });

  it("extracts model from metadata.model.modelID", () => {
    const result = collectSubEntries([
      msg([
        taskPart({
          id: "p1",
          state: {
            status: "completed",
            metadata: { model: { modelID: "deepseek-v4-flash" } },
          },
        }),
      ]),
    ]);
    assert.equal(result[0].model, "deepseek-v4-flash");
  });

  it("sets model to undefined when metadata lacks model field", () => {
    const result = collectSubEntries([
      msg([
        taskPart({
          id: "p1",
          state: {
            status: "completed",
            metadata: { sessionId: "sid" },
          },
        }),
      ]),
    ]);
    assert.equal(result[0].model, undefined);
  });

  it("extracts startedAt and endedAt from state.time", () => {
    const result = collectSubEntries([
      msg([
        taskPart({
          id: "p1",
          state: {
            status: "completed",
            input: { subagent_type: "beaver" },
            time: { start: 1000, end: 5000 },
          },
        }),
      ]),
    ]);
    assert.equal(result[0].startedAt, 1000);
    assert.equal(result[0].endedAt, 5000);
  });

  it("extracts only startedAt for running entries (no end)", () => {
    const result = collectSubEntries([
      msg([
        taskPart({
          id: "p1",
          state: {
            status: "running",
            input: { subagent_type: "beaver" },
            time: { start: 2000 },
          },
        }),
      ]),
    ]);
    assert.equal(result[0].startedAt, 2000);
    assert.equal(result[0].endedAt, undefined);
  });

  it("does not set startedAt when state.time is absent", () => {
    const result = collectSubEntries([
      msg([
        taskPart({
          id: "p1",
          state: {
            status: "completed",
            input: { subagent_type: "beaver" },
          },
        }),
      ]),
    ]);
    assert.equal(result[0].startedAt, undefined);
    assert.equal(result[0].endedAt, undefined);
  });
});

// ---------------------------------------------------------------------------
// mergeScannedEntries
// ---------------------------------------------------------------------------

/**
 * Build a minimal SubEntry for testing mergeScannedEntries.
 * Defaults to a running entry with id "p1".
 */
function entry(overrides: Partial<SubEntry> & { id: string }): SubEntry {
  return {
    title: "test",
    agent: "beaver",
    status: "running",
    sessionId: "child_sid",
    tokens: undefined,
    error: undefined,
    ...overrides,
  };
}

describe("mergeScannedEntries", () => {
  it("inserts a new entry from scanned", () => {
    const prev = new Map<string, SubEntry>();
    const scanned = [entry({ id: "p1", status: "done" })];
    const result = mergeScannedEntries(prev, scanned);

    assert.equal(result.size, 1);
    assert.equal(result.get("p1")?.id, "p1");
    assert.equal(result.get("p1")?.status, "done");
  });

  it("only patches missing sessionId on existing entry", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "existing",
      agent: "lynx",
      status: "running",
      tokens: 500,
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    const scanned = [
      entry({
        id: "p1",
        status: "running",
        sessionId: "child_1",
        tokens: 999, // should be ignored
      }),
    ];
    const result = mergeScannedEntries(prev, scanned);

    assert.equal(result.size, 1);
    assert.equal(result.get("p1")?.status, "running");
    assert.equal(result.get("p1")?.sessionId, "child_1");
    // Tokens from scanned are never applied.
    assert.equal(result.get("p1")?.tokens, 500);
    assert.equal(result.get("p1")?.title, "existing");
    assert.equal(result.get("p1")?.agent, "lynx");
  });

  it("does not overwrite existing running with scanned running (tokens preserved)", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "keep-title",
      agent: "beaver",
      status: "running",
      tokens: 123,
      sessionId: "child_x",
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    // Scanned running entry — same status, no tokens.
    const scanned = [entry({ id: "p1", status: "running", tokens: undefined })];
    const result = mergeScannedEntries(prev, scanned);

    assert.equal(result.get("p1")?.status, "running");
    assert.equal(result.get("p1")?.tokens, 123);
    assert.equal(result.get("p1")?.title, "keep-title");
  });

  it("overwrites running status with scanned done (terminal state)", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "resolve",
      agent: "beaver",
      status: "running",
      tokens: 789,
      sessionId: "child_y",
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    const scanned = [entry({ id: "p1", status: "done", tokens: undefined })];
    const result = mergeScannedEntries(prev, scanned);

    // Status must transition to done.
    assert.equal(result.get("p1")?.status, "done");
    // Tokens from existing entry are preserved.
    assert.equal(result.get("p1")?.tokens, 789);
    // Error should not be set (scanned is done, not error).
    assert.equal(result.get("p1")?.error, undefined);
  });

  it("overwrites running status+error with scanned error (terminal state)", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "fail-task",
      agent: "kiwi",
      status: "running",
      tokens: 200,
      sessionId: "child_z",
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    const scanned = [
      entry({
        id: "p1",
        status: "error",
        error: "something went wrong",
        tokens: undefined,
      }),
    ];
    const result = mergeScannedEntries(prev, scanned);

    // Status must transition to error.
    assert.equal(result.get("p1")?.status, "error");
    // Error message from scanned must be applied.
    assert.equal(result.get("p1")?.error, "something went wrong");
    // Tokens from existing entry are preserved.
    assert.equal(result.get("p1")?.tokens, 200);
  });

  it("does not overwrite existing done entry even if scanned says running", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "done-task",
      agent: "beaver",
      status: "done",
      tokens: 100,
      sessionId: "child_w",
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    // Scanned says running — but existing is terminal (done).
    const scanned = [entry({ id: "p1", status: "running", tokens: undefined })];
    const result = mergeScannedEntries(prev, scanned);

    // Status must remain done (terminal is irreversible).
    assert.equal(result.get("p1")?.status, "done");
    assert.equal(result.get("p1")?.tokens, 100);
  });

  it("does not overwrite existing error entry even if scanned says done", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "err-task",
      agent: "beaver",
      status: "error",
      error: "original error",
      tokens: 50,
      sessionId: "child_v",
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    // Scanned says done — but existing is terminal (error).
    const scanned = [entry({ id: "p1", status: "done", tokens: undefined })];
    const result = mergeScannedEntries(prev, scanned);

    // Status must remain error (terminal is irreversible).
    assert.equal(result.get("p1")?.status, "error");
    assert.equal(result.get("p1")?.error, "original error");
    assert.equal(result.get("p1")?.tokens, 50);
  });

  it("preserves multiple entries with independent merge decisions", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "keep",
      agent: "beaver",
      status: "done",
      tokens: 100,
      sessionId: "child_a",
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    const scanned = [
      entry({ id: "p1", status: "running" }), // should NOT overwrite done
      entry({ id: "p2", status: "done", agent: "lynx", title: "new-scan" }), // new
    ];
    const result = mergeScannedEntries(prev, scanned);

    assert.equal(result.size, 2);
    // p1 stays done (terminal)
    assert.equal(result.get("p1")?.status, "done");
    assert.equal(result.get("p1")?.tokens, 100);
    // p2 is new
    assert.equal(result.get("p2")?.status, "done");
    assert.equal(result.get("p2")?.agent, "lynx");
  });

  it("patches missing model on existing terminal entry (rule 2)", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "done-task",
      agent: "beaver",
      status: "done",
      sessionId: "child_sid",
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    const scanned = [
      entry({
        id: "p1",
        status: "done",
        model: "claude-3-opus",
        sessionId: "child_sid",
      }),
    ];
    const result = mergeScannedEntries(prev, scanned);

    assert.equal(result.get("p1")?.status, "done");
    assert.equal(result.get("p1")?.model, "claude-3-opus");
  });

  it("patches missing model on existing running entry (rule 4)", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "running-task",
      agent: "beaver",
      status: "running",
      tokens: 300,
      sessionId: "child_sid",
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    const scanned = [
      entry({
        id: "p1",
        status: "running",
        model: "deepseek-v4-flash",
        sessionId: "child_sid",
      }),
    ];
    const result = mergeScannedEntries(prev, scanned);

    assert.equal(result.get("p1")?.status, "running");
    assert.equal(result.get("p1")?.tokens, 300); // existing tokens preserved
    assert.equal(result.get("p1")?.model, "deepseek-v4-flash");
  });

  it("does not overwrite existing model on running entry (rule 4 priority)", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "existing-model",
      agent: "beaver",
      status: "running",
      model: "claude-sonnet",
      sessionId: "child_sid",
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    const scanned = [
      entry({
        id: "p1",
        status: "running",
        model: "deepseek-v4-flash",
        sessionId: "child_sid",
      }),
    ];
    const result = mergeScannedEntries(prev, scanned);

    // Existing model should be preserved (live event is fresher).
    assert.equal(result.get("p1")?.model, "claude-sonnet");
  });

  // ── startedAt / endedAt ───────────────────────────────────────

  it("inserts new entry with startedAt and endedAt from scanned", () => {
    const prev = new Map<string, SubEntry>();
    const scanned = [
      entry({
        id: "p1",
        status: "done",
        startedAt: 1000,
        endedAt: 5000,
      }),
    ];
    const result = mergeScannedEntries(prev, scanned);

    assert.equal(result.get("p1")?.startedAt, 1000);
    assert.equal(result.get("p1")?.endedAt, 5000);
  });

  it("preserves existing startedAt on terminal entry (rule 2)", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "done-task",
      agent: "beaver",
      status: "done",
      startedAt: 1000,
      endedAt: 5000,
      sessionId: "child_sid",
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    const scanned = [
      entry({
        id: "p1",
        status: "done",
        startedAt: 2000,
        endedAt: 8000,
      }),
    ];
    const result = mergeScannedEntries(prev, scanned);

    // Terminal entry should preserve all its time fields.
    assert.equal(result.get("p1")?.startedAt, 1000);
    assert.equal(result.get("p1")?.endedAt, 5000);
  });

  it("does not overwrite existing endedAt on terminal entry even if scanned lacks it", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "done-task",
      agent: "beaver",
      status: "done",
      startedAt: 1000,
      endedAt: 5000,
      sessionId: "child_sid",
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    // Scanned has startedAt but no endedAt.
    const scanned = [
      entry({
        id: "p1",
        status: "done",
        startedAt: 2000,
      }),
    ];
    const result = mergeScannedEntries(prev, scanned);

    assert.equal(result.get("p1")?.startedAt, 1000);
    assert.equal(result.get("p1")?.endedAt, 5000);
  });

  it("overwrites running startedAt with scanned startedAt on rule 3 overwrite", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "resolve",
      agent: "beaver",
      status: "running",
      tokens: 789,
      sessionId: "child_y",
      startedAt: 100,
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    const scanned = [
      entry({
        id: "p1",
        status: "done",
        startedAt: 1000,
        endedAt: 5000,
      }),
    ];
    const result = mergeScannedEntries(prev, scanned);

    // Rule 3 overwrite replaces the entry with scanned's fields.
    assert.equal(result.get("p1")?.status, "done");
    // startedAt should come from scanned on overwrite.
    assert.equal(result.get("p1")?.startedAt, 1000);
    assert.equal(result.get("p1")?.endedAt, 5000);
  });

  it("patches missing startedAt on existing running entry from scanned (rule 4)", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "running-task",
      agent: "beaver",
      status: "running",
      tokens: 300,
      sessionId: "child_sid",
      // No startedAt — live event didn't have it yet.
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    const scanned = [
      entry({
        id: "p1",
        status: "running",
        startedAt: 1000,
        sessionId: "child_sid",
      }),
    ];
    const result = mergeScannedEntries(prev, scanned);

    assert.equal(result.get("p1")?.startedAt, 1000);
    // Existing fields preserved.
    assert.equal(result.get("p1")?.tokens, 300);
    assert.equal(result.get("p1")?.status, "running");
  });

  it("does not overwrite existing startedAt on running entry (rule 4)", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "running-task",
      agent: "beaver",
      status: "running",
      tokens: 300,
      sessionId: "child_sid",
      startedAt: 500,
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    const scanned = [
      entry({
        id: "p1",
        status: "running",
        startedAt: 1000,
        sessionId: "child_sid",
      }),
    ];
    const result = mergeScannedEntries(prev, scanned);

    // Existing startedAt should be preserved (live event is fresher).
    assert.equal(result.get("p1")?.startedAt, 500);
    assert.equal(result.get("p1")?.tokens, 300);
  });

  it("patches missing endedAt on rule 3 overwrite from scanned", () => {
    const existing: SubEntry = {
      id: "p1",
      title: "resolve",
      agent: "beaver",
      status: "running",
      sessionId: "child_y",
      startedAt: 100,
    };
    const prev = new Map<string, SubEntry>([["p1", existing]]);
    const scanned = [
      entry({
        id: "p1",
        status: "done",
        startedAt: 100,
        endedAt: 8000,
      }),
    ];
    const result = mergeScannedEntries(prev, scanned);

    assert.equal(result.get("p1")?.status, "done");
    assert.equal(result.get("p1")?.endedAt, 8000);
  });
});
