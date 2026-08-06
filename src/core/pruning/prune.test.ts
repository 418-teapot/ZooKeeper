/**
 * Tests for the context-pruning prune module (`src/core/pruning/prune.ts`)
 * — `pruneToolOutputs` / `pruneToolErrors`.
 *
 * Covers: empty state → noop, pre-populated effective marks → output
 * replaced, non-effective (pending) marks NOT replaced, placeholder
 * verbatim match, accumulation (no clear).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _resetForTesting } from "../../utils/logger.js";
import type { ContextMessageEntry } from "../metrics.js";
import { estimateTokenCount } from "../metrics.js";
import {
  addMark,
  getOrCreateSessionState,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
  pruneToolErrors,
  pruneToolOutputs,
} from "./index.js";
import { _clearAllSessionsForTesting } from "./marks.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_INPUT_REPLACEMENT,
  type SweepToolPart,
} from "./types.js";

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  _resetForTesting();
  _clearAllSessionsForTesting();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textPart(
  text: string,
  ignored = false,
): { type: string; text: string; ignored?: boolean } {
  return { type: "text", text, ...(ignored ? { ignored: true } : {}) };
}

function toolPart(
  callID: string,
  output: string,
  input?: unknown,
  tool?: string,
): SweepToolPart {
  return {
    type: "tool",
    callID,
    state: { input: input ?? "", output },
    tool: tool ?? "bash",
  };
}

function msg(
  role: string,
  id: string,
  parts: Array<
    SweepToolPart | { type: string; text: string; ignored?: boolean }
  >,
  sessionID?: string,
): ContextMessageEntry {
  return {
    info: { role, id, ...(sessionID ? { sessionID } : {}) },
    parts: parts as unknown as ContextMessageEntry["parts"],
  };
}

// ---------------------------------------------------------------------------
// PRUNED_TOOL_OUTPUT_REPLACEMENT constant
// ---------------------------------------------------------------------------

describe("PRUNED_TOOL_OUTPUT_REPLACEMENT", () => {
  it("matches the verbatim constant exactly", () => {
    assert.equal(
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
      "[Output removed to save context - information superseded or no longer needed]",
    );
  });
});

// ---------------------------------------------------------------------------
// estimateTokenCount (replaces estimateToolOutputTokens)
// ---------------------------------------------------------------------------

describe("estimateTokenCount", () => {
  it("returns 0 for null / undefined", () => {
    assert.equal(estimateTokenCount(null), 0);
    assert.equal(estimateTokenCount(undefined), 0);
  });

  it("returns 0 for empty string", () => {
    assert.equal(estimateTokenCount(""), 0);
  });

  it("estimates ASCII text at length / 4, ceil'd", () => {
    // "Hello World" = 11 chars → 11/4 = 2.75 → ceil = 3
    assert.equal(estimateTokenCount("Hello World"), 3);
  });

  it("handles JSON output by stringifying", () => {
    const val = { foo: "bar" };
    // JSON.stringify → '{"foo":"bar"}' = 13 chars → 13/4 = 3.25 → ceil = 4
    assert.equal(estimateTokenCount(val), 4);
  });
});

// ---------------------------------------------------------------------------
// pruneToolOutputs — empty state
// ---------------------------------------------------------------------------

describe("pruneToolOutputs with empty state", () => {
  it("is a no-op when marks is empty", () => {
    const state = getOrCreateSessionState("sess-empty");
    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("hello")]),
      msg("assistant", "a1", [toolPart("call-1", "some output")]),
    ];

    const originalOutput = (messages[1].parts?.[0] as SweepToolPart).state
      ?.output;

    pruneToolOutputs(state, messages);

    // Output should be unchanged.
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      originalOutput,
    );
  });

  it("is a no-op when no effective marks match", () => {
    const state = getOrCreateSessionState("sess-nomatch");
    // Add a mark for a callID not in messages.
    addMark(state, "call-other", 50, true, "tool-output");

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "data")]),
    ];

    pruneToolOutputs(state, messages);

    // Output unchanged.
    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      "data",
    );
    // Map is NOT cleared.
    assert.equal(state.marks.size, 1);
  });

  it("does NOT replace non-effective (pending) marks", () => {
    const state = getOrCreateSessionState("sess-pending-only");
    addMark(state, "call-1", 100, false, "tool-output"); // Effective = false.

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "data")]),
    ];

    pruneToolOutputs(state, messages);

    // Output unchanged — pending marks not applied.
    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      "data",
    );
  });
});

// ---------------------------------------------------------------------------
// pruneToolOutputs — pre-populated state
// ---------------------------------------------------------------------------

describe("pruneToolOutputs with pre-populated state", () => {
  it("replaces effective-marked tool outputs with placeholder", () => {
    const state = getOrCreateSessionState("sess-marked");
    addMark(state, "call-1", 100, true, "tool-output");
    addMark(state, "call-2", 200, true, "tool-output");

    const messages: ContextMessageEntry[] = [
      msg("user", "u1", [textPart("do something")]),
      msg("assistant", "a1", [
        toolPart("call-1", "ls output\nfile1\nfile2"),
        textPart("here are the files"),
        toolPart("call-2", "grep result\nmatch"),
      ]),
    ];

    pruneToolOutputs(state, messages);

    const parts = messages[1].parts ?? [];
    // call-1 output replaced.
    assert.equal(
      (parts[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    // call-2 output replaced.
    assert.equal(
      (parts[2] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    // Text part unchanged.
    assert.equal((parts[1] as { text?: string }).text, "here are the files");
  });

  it("handles tool parts without pre-existing state object", () => {
    const state = getOrCreateSessionState("sess-nostate");
    addMark(state, "call-1", 50, true, "tool-output");

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-1",
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    pruneToolOutputs(state, messages);

    const part = messages[0].parts?.[0] as SweepToolPart;
    assert.ok(part.state);
    assert.equal(part.state?.output, PRUNED_TOOL_OUTPUT_REPLACEMENT);
  });

  it("only replaces tools with matching callID, skips others", () => {
    const state = getOrCreateSessionState("sess-skip");
    addMark(state, "call-1", 100, true, "tool-output");

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        toolPart("call-1", "output A"),
        toolPart("call-2", "output B"),
        toolPart("call-3", "output C"),
      ]),
    ];

    pruneToolOutputs(state, messages);

    const parts = messages[0].parts ?? [];
    assert.equal(
      (parts[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    assert.equal((parts[1] as SweepToolPart).state?.output, "output B");
    assert.equal((parts[2] as SweepToolPart).state?.output, "output C");
  });

  it("does NOT clear marks after processing (accumulate)", () => {
    const state = getOrCreateSessionState("sess-accumulate");
    addMark(state, "call-1", 100, true, "tool-output");
    addMark(state, "call-2", 200, true, "tool-output");

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        toolPart("call-1", "data A"),
        toolPart("call-2", "data B"),
      ]),
    ];

    pruneToolOutputs(state, messages);
    assert.equal(state.marks.size, 2);

    // Second call — already placeholders.
    pruneToolOutputs(state, messages);
    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
  });
});

// ---------------------------------------------------------------------------
// Duplicate mark
// ---------------------------------------------------------------------------

describe("duplicate mark prevention", () => {
  it("pruneToolOutputs replaces both occurrences of same callID", () => {
    const state = getOrCreateSessionState("sess-dup-callid");
    addMark(state, "call-1", 100, true, "tool-output");

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "output A")]),
      msg("assistant", "a2", [toolPart("call-1", "output B")]),
    ];

    pruneToolOutputs(state, messages);

    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    assert.equal(
      (messages[1].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
  });
});

// ---------------------------------------------------------------------------
// Accumulation (no clear)
// ---------------------------------------------------------------------------

describe("pruneToolOutputs accumulation (no clear)", () => {
  it("marks.size stays unchanged after prune", () => {
    const state = getOrCreateSessionState("sess-no-clear");
    addMark(state, "call-1", 100, true, "tool-output");
    addMark(state, "call-2", 200, true, "tool-output");

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        toolPart("call-1", "data A"),
        toolPart("call-2", "data B"),
      ]),
    ];

    assert.equal(state.marks.size, 2);
    pruneToolOutputs(state, messages);
    assert.equal(state.marks.size, 2);
  });

  it("accumulates marks across multiple sweep+prune turns", () => {
    const state = getOrCreateSessionState("sess-multi-turn");

    // Turn 1.
    addMark(state, "call-1", 100, true, "tool-output");
    pruneToolOutputs(state, [
      msg("assistant", "a1", [toolPart("call-1", "out1")]),
    ]);
    assert.equal(state.marks.size, 1);

    // Turn 2.
    addMark(state, "call-2", 200, true, "tool-output");
    assert.equal(state.marks.size, 2);
    pruneToolOutputs(state, [
      msg("assistant", "a2", [toolPart("call-2", "out2")]),
    ]);
    assert.equal(state.marks.size, 2);
  });
});

// ---------------------------------------------------------------------------
// Re-prune already-placeholder output
// ---------------------------------------------------------------------------

describe("re-prune already-placeholder output", () => {
  it("is stable (no double-count issues)", () => {
    const state = getOrCreateSessionState("sess-reprune");
    addMark(state, "call-1", 100, true, "tool-output");

    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [toolPart("call-1", "real output")]),
    ];

    pruneToolOutputs(state, messages);
    pruneToolOutputs(state, messages);

    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
  });
});

// ---------------------------------------------------------------------------
// Non-string output at runtime
// ---------------------------------------------------------------------------

describe("pruneToolOutputs — non-string output at runtime", () => {
  it("uses JSON.stringify length for non-string tool output", () => {
    const state = getOrCreateSessionState("sess-nonstr");
    addMark(state, "call-1", 100, true, "tool-output");

    const nonStringOutput = [1, 2, 3];
    const messages: ContextMessageEntry[] = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-1",
          state: {
            output: nonStringOutput as unknown as string,
            input: "",
          },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    const result = pruneToolOutputs(state, messages);

    assert.equal(result.length, 1);
    // JSON.stringify([1,2,3]) = "[1,2,3]" = 8 chars
    assert.equal(
      result[0].beforeLen,
      JSON.stringify(nonStringOutput).length,
      "beforeLen must use JSON.stringify length for non-string runtime output",
    );
    // Output replaced with placeholder.
    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
  });
});

// ===========================================================================
// pruneToolErrors — error input placeholder replacement
// ===========================================================================

describe("pruneToolErrors", () => {
  const PLACEHOLDER = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT;

  it("replaces string-value fields in input object, keeps non-string fields", () => {
    const state = getOrCreateSessionState("sess-err-str");
    addMark(state, "call-err", 50, true, "tool-error-input");

    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-err",
          state: {
            input: { cmd: "ls", path: "/tmp", timeout: 30, verbose: true },
            output: "some error output",
          },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    pruneToolErrors(state, messages);

    const input = (messages[0].parts?.[0] as SweepToolPart).state
      ?.input as Record<string, unknown>;
    // String fields replaced.
    assert.equal(input.cmd, PLACEHOLDER);
    assert.equal(input.path, PLACEHOLDER);
    // Non-string fields untouched.
    assert.equal(input.timeout, 30);
    assert.equal(input.verbose, true);
    // output untouched.
    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      "some error output",
    );
  });

  it("replaces a string-typed input entirely", () => {
    const state = getOrCreateSessionState("sess-err-str-input");
    addMark(state, "call-err", 50, true, "tool-error-input");

    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-err",
          state: {
            input: "plain string input",
            output: "error output",
          },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    pruneToolErrors(state, messages);

    const part = messages[0].parts?.[0] as SweepToolPart;
    assert.equal(part.state?.input, PLACEHOLDER);
    assert.equal(part.state?.output, "error output");
  });

  it("does NOT replace when input is null/undefined", () => {
    const state = getOrCreateSessionState("sess-err-null");
    addMark(state, "call-err", 50, true, "tool-error-input");

    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-err",
          state: {
            input: null,
            output: "err",
          },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    const result = pruneToolErrors(state, messages);
    assert.equal(result.length, 0);
  });

  it("leaves state.error untouched", () => {
    const state = getOrCreateSessionState("sess-err-error-field");
    addMark(state, "call-err", 50, true, "tool-error-input");

    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-err",
          state: {
            input: { cmd: "ls" },
            output: "out",
            error: { message: "permission denied" },
          },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    pruneToolErrors(state, messages);
    const st = messages[0].parts?.[0] as SweepToolPart;
    assert.equal(
      (st.state as { error?: { message: string } } | undefined)?.error
        ?.message as string | undefined,
      "permission denied",
    );
    assert.equal(
      (st.state?.input as Record<string, unknown> | undefined)?.cmd as
        | string
        | undefined,
      PLACEHOLDER,
    );
  });

  it("skips pending (non-effective) marks", () => {
    const state = getOrCreateSessionState("sess-err-pending");
    addMark(state, "call-err", 50, false, "tool-error-input"); // Not effective.

    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-err",
          state: {
            input: { cmd: "ls" },
            output: "err output",
          },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    pruneToolErrors(state, messages);
    const input = (messages[0].parts?.[0] as SweepToolPart).state
      ?.input as Record<string, unknown>;
    assert.equal(input.cmd, "ls");
  });

  it("skips marks with action='tool-output'", () => {
    const state = getOrCreateSessionState("sess-err-skip-output");
    addMark(state, "call-out", 100, true, "tool-output");

    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-out",
          state: {
            input: { cmd: "ls" },
            output: "output data",
          },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    pruneToolErrors(state, messages);
    const input = (messages[0].parts?.[0] as SweepToolPart).state
      ?.input as Record<string, unknown>;
    // tool-output mark should NOT trigger input replacement.
    assert.equal(input.cmd, "ls");
  });

  it("silently skips callIDs with no matching part in messages", () => {
    const state = getOrCreateSessionState("sess-err-no-part");
    addMark(state, "call-ghost", 50, true, "tool-error-input");

    const messages = [
      msg("assistant", "a1", [
        {
          type: "text",
          text: "hello",
        },
      ]),
    ];

    // Should not throw.
    const result = pruneToolErrors(state, messages);
    assert.equal(result.length, 0);
  });

  it("returns beforeLen and afterLen for each replacement", () => {
    const state = getOrCreateSessionState("sess-err-len");
    addMark(state, "call-err", 50, true, "tool-error-input");

    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-err",
          state: {
            input: { cmd: "ls", path: "/tmp/very/long/path" },
            output: "some error",
          },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    const result = pruneToolErrors(state, messages);
    assert.equal(result.length, 1);
    assert.equal(result[0].callID, "call-err");
    // beforeLen = "ls".length + "/tmp/very/long/path".length = 2 + 19 = 21
    assert.equal(result[0].beforeLen, 21);
    // afterLen = placeholder.length * 2 (two string fields replaced)
    assert.equal(result[0].afterLen, PLACEHOLDER.length * 2);
  });

  it("returns empty array when no matching error-input marks exist", () => {
    const state = getOrCreateSessionState("sess-err-empty");
    // No marks at all.
    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-1",
          state: { input: { cmd: "ls" }, output: "ok" },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    const result = pruneToolErrors(state, messages);
    assert.equal(result.length, 0);
  });

  it("replaces top-level string fields but keeps nested objects/arrays unchanged", () => {
    const state = getOrCreateSessionState("sess-err-nested");
    addMark(state, "call-err", 50, true, "tool-error-input");

    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-err",
          state: {
            input: {
              cmd: "ls",
              opts: { recursive: true, path: "/secret" },
              items: ["deep string", "another"],
            },
            output: "error output",
          },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    pruneToolErrors(state, messages);

    const input = (messages[0].parts?.[0] as SweepToolPart).state
      ?.input as Record<string, unknown>;
    // Top-level string replaced.
    assert.equal(input.cmd, PRUNED_TOOL_ERROR_INPUT_REPLACEMENT);
    // Nested object/array strings left untouched.
    assert.deepEqual(input.opts, { recursive: true, path: "/secret" });
    assert.deepEqual(input.items, ["deep string", "another"]);
    // Output untouched.
    assert.equal(
      (messages[0].parts?.[0] as SweepToolPart).state?.output,
      "error output",
    );
  });
});

// ===========================================================================
// Input-heavy tool pruning (question/edit/write)
// ===========================================================================

describe("pruneToolOutputs with input-heavy tools", () => {
  const INPUT_PLACEHOLDER = PRUNED_TOOL_INPUT_REPLACEMENT;

  it("question tool: replaces input.questions array, leaves output intact", () => {
    const state = getOrCreateSessionState("sess-c2-question");
    addMark(state, "call-q", 100, true, "tool-output");

    const messages = [
      msg("assistant", "a1", [
        toolPart(
          "call-q",
          "user answered: yes",
          {
            questions: [
              { text: "Should I use feature X?", options: ["yes", "no"] },
            ],
          },
          "question",
        ),
      ]),
    ];

    pruneToolOutputs(state, messages);

    const part = messages[0].parts?.[0] as SweepToolPart;
    const input = part.state?.input as Record<string, unknown>;

    // Input fields replaced with placeholder.
    assert.equal(input.questions, INPUT_PLACEHOLDER);
    // Output untouched.
    assert.equal(part.state?.output, "user answered: yes");
  });

  it("write tool: replaces input.content, keeps input.filePath, output intact", () => {
    const state = getOrCreateSessionState("sess-c2-write");
    addMark(state, "call-w", 100, true, "tool-output");

    const messages = [
      msg("assistant", "a1", [
        toolPart(
          "call-w",
          "wrote 42 lines",
          {
            filePath: "/home/user/file.ts",
            content: "console.log('hello world');\n".repeat(200),
          },
          "write",
        ),
      ]),
    ];

    pruneToolOutputs(state, messages);

    const part = messages[0].parts?.[0] as SweepToolPart;
    const input = part.state?.input as Record<string, unknown>;

    // Content replaced, filePath kept.
    assert.equal(input.filePath, "/home/user/file.ts");
    assert.equal(input.content, INPUT_PLACEHOLDER);
    // Output untouched.
    assert.equal(part.state?.output, "wrote 42 lines");
  });

  it("edit tool: replaces input.oldString/newString, keeps input.filePath, output intact", () => {
    const state = getOrCreateSessionState("sess-c2-edit");
    addMark(state, "call-e", 100, true, "tool-output");

    const messages = [
      msg("assistant", "a1", [
        toolPart(
          "call-e",
          "applied edit",
          {
            filePath: "/home/user/file.ts",
            oldString: "console.log('old');",
            newString: "console.log('new');",
          },
          "edit",
        ),
      ]),
    ];

    pruneToolOutputs(state, messages);

    const part = messages[0].parts?.[0] as SweepToolPart;
    const input = part.state?.input as Record<string, unknown>;

    // oldString and newString replaced, filePath kept.
    assert.equal(input.filePath, "/home/user/file.ts");
    assert.equal(input.oldString, INPUT_PLACEHOLDER);
    assert.equal(input.newString, INPUT_PLACEHOLDER);
    // Output untouched.
    assert.equal(part.state?.output, "applied edit");
  });

  it("bash tool (non-trio): output replaced as before (unchanged behavior)", () => {
    const state = getOrCreateSessionState("sess-c2-bash-unchanged");
    addMark(state, "call-b", 100, true, "tool-output");

    const messages = [
      msg("assistant", "a1", [
        toolPart("call-b", "ls output\nfile1\nfile2", {
          cmd: "ls",
          path: "/tmp",
        }),
      ]),
    ];

    pruneToolOutputs(state, messages);

    const part = messages[0].parts?.[0] as SweepToolPart;

    // Output replaced with standard placeholder.
    assert.equal(part.state?.output, PRUNED_TOOL_OUTPUT_REPLACEMENT);
    // Input untouched.
    const input = part.state?.input as Record<string, unknown>;
    assert.equal(input.cmd, "ls");
    assert.equal(input.path, "/tmp");
  });

  it("edit tool without filePath: all fields replaced", () => {
    const state = getOrCreateSessionState("sess-c2-edit-nopath");
    addMark(state, "call-e", 100, true, "tool-output");

    const messages = [
      msg("assistant", "a1", [
        toolPart(
          "call-e",
          "applied edit",
          {
            oldString: "old code",
            newString: "new code",
          },
          "edit",
        ),
      ]),
    ];

    pruneToolOutputs(state, messages);

    const part = messages[0].parts?.[0] as SweepToolPart;
    const input = part.state?.input as Record<string, unknown>;

    // All fields replaced (no filePath to preserve).
    assert.equal(input.oldString, INPUT_PLACEHOLDER);
    assert.equal(input.newString, INPUT_PLACEHOLDER);
  });

  it("question tool: string input replaced entirely, output intact", () => {
    const state = getOrCreateSessionState("sess-c2-string-input");
    addMark(state, "call-s", 100, true, "tool-output");

    const messages = [
      msg("assistant", "a1", [
        toolPart("call-s", "asked question", "should I use X?", "question"),
      ]),
    ];

    pruneToolOutputs(state, messages);

    const part = messages[0].parts?.[0] as SweepToolPart;
    // Input replaced entirely.
    assert.equal(
      part.state?.input,
      PRUNED_TOOL_INPUT_REPLACEMENT,
      "string input replaced with placeholder",
    );
    // Output untouched.
    assert.equal(part.state?.output, "asked question");
  });

  it("question tool: top-level array input skipped, output intact", () => {
    const state = getOrCreateSessionState("sess-c2-array-input");
    addMark(state, "call-a", 100, true, "tool-output");

    const messages = [
      msg("assistant", "a1", [
        toolPart("call-a", "asked question", ["opt1", "opt2"], "question"),
      ]),
    ];

    const result = pruneToolOutputs(state, messages);

    // Top-level array inputs are skipped — the trim branch only handles
    // plain objects (unified with pruneToolErrors).
    assert.equal(result.length, 0, "top-level array input is skipped");

    const part = messages[0].parts?.[0] as SweepToolPart;
    // Input untouched (array skipped, not replaced).
    assert.deepEqual(part.state?.input, ["opt1", "opt2"]);
    // Output untouched.
    assert.equal(part.state?.output, "asked question");
  });

  it("question tool: null input silently skipped, output intact", () => {
    const state = getOrCreateSessionState("sess-c2-null-input");
    addMark(state, "call-n", 100, true, "tool-output");

    // Must craft inline — toolPart helper defaults null to "".
    const messages: ContextMessageEntry[] = [
      msg(
        "assistant",
        "a1",
        [
          {
            type: "tool",
            callID: "call-n",
            state: { input: null, output: "question without input" },
            tool: "question",
          } as unknown as { type: string; text?: string },
        ],
        "sess-c2-null-input",
      ),
    ];

    const result = pruneToolOutputs(state, messages);
    assert.equal(result.length, 0, "null input skips replacement");

    const part = messages[0].parts?.[0] as SweepToolPart;
    // Output untouched (null input → nothing to trim, skip).
    assert.equal(
      part.state?.output,
      "question without input",
      "output intact for null input",
    );
  });
});

describe("pruneToolErrors with input-heavy tools", () => {
  const ERR_PLACEHOLDER = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT;

  it("failed edit tool: keeps filePath, replaces oldString/newString with error placeholder", () => {
    const state = getOrCreateSessionState("sess-c2-err-edit");
    addMark(state, "call-err-e", 50, true, "tool-error-input");

    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-err-e",
          state: {
            input: {
              filePath: "/home/user/file.ts",
              oldString: "some old content that is long enough",
              newString: "some new content that is even longer to save tokens",
            },
            output: "edit failed: permission denied",
            status: "error",
          },
          tool: "edit",
        } as SweepToolPart,
      ]),
    ];

    pruneToolErrors(state, messages);

    const part = messages[0].parts?.[0] as SweepToolPart;
    const input = part.state?.input as Record<string, unknown>;

    // filePath kept, other fields replaced.
    assert.equal(input.filePath, "/home/user/file.ts");
    assert.equal(input.oldString, ERR_PLACEHOLDER);
    assert.equal(input.newString, ERR_PLACEHOLDER);
    // Output untouched.
    assert.equal(part.state?.output, "edit failed: permission denied");
  });

  it("failed question tool: all input fields (except filePath) replaced with error placeholder", () => {
    const state = getOrCreateSessionState("sess-c2-err-question");
    addMark(state, "call-err-q", 50, true, "tool-error-input");

    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-err-q",
          state: {
            input: {
              questions: [{ text: "Proceed?", options: ["yes", "no"] }],
            },
            output: "question failed",
            status: "error",
          },
          tool: "question",
        } as SweepToolPart,
      ]),
    ];

    pruneToolErrors(state, messages);

    const part = messages[0].parts?.[0] as SweepToolPart;
    const input = part.state?.input as Record<string, unknown>;

    // Array field replaced with placeholder string (non-string fields also get replaced).
    assert.equal(input.questions, ERR_PLACEHOLDER);
    // Output untouched.
    assert.equal(part.state?.output, "question failed");
  });

  it("failed bash tool (non-trio): string fields replaced as before (unchanged behavior)", () => {
    const state = getOrCreateSessionState("sess-c2-err-bash-unchanged");
    addMark(state, "call-err-b", 50, true, "tool-error-input");

    const messages = [
      msg("assistant", "a1", [
        {
          type: "tool",
          callID: "call-err-b",
          state: {
            input: {
              cmd: "long command ".repeat(30),
              path: "/tmp/long/path",
              timeout: 30,
              verbose: true,
            },
            output: "bash: command not found",
            status: "error",
          },
          tool: "bash",
        } as SweepToolPart,
      ]),
    ];

    pruneToolErrors(state, messages);

    const part = messages[0].parts?.[0] as SweepToolPart;
    const input = part.state?.input as Record<string, unknown>;

    // String fields replaced (unchanged), non-string fields untouched.
    assert.equal(input.cmd, ERR_PLACEHOLDER);
    assert.equal(input.path, ERR_PLACEHOLDER);
    assert.equal(input.timeout, 30);
    assert.equal(input.verbose, true);
  });
});
