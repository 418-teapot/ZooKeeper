/**
 * Unit tests for the pruned-output classification in `capture.ts`.
 *
 * The render layer (`src/adapters/opencode/apply-view.ts` →
 * `injectLinePrefix`) prepends a line-start `[mN] ` ref marker to every
 * visible item's injection region before the snapshot is read back, so
 * a tool-output placeholder reaches the capture with that prefix still
 * attached.  The capture must still recognise the placeholder — its
 * identity is the single source of truth in
 * `src/core/context/message-parts.ts` — by stripping the prefix with
 * the same `LINE_START_REF_PREFIX` rule the render layer strips with.
 *
 * The classification is reached via the public `captureMessage`
 * surface: `captureToolOutput` is a private helper, but its only
 * observable consequence is `ViewToolPartCapture.pruned`, so the
 * behaviour is verifiable end-to-end through `captureMessage`.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { ContextMessageEntry } from "../../../src/adapters/opencode/types.js";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../../src/core/context/message-parts.js";
import { captureMessage } from "./capture.js";

/**
 * Build a minimal assistant entry carrying a single tool part whose
 * output is the given string.  Mirrors the host's tool-part shape
 * (`type: "tool"`, `state.output`) that `captureMessage` reads; cast
 * via the same pattern the adjacent `types.test.ts` uses because the
 * v1 part shape is read through `Record<string, unknown>` in the
 * capture itself.
 */
function toolEntry(output: string, input: unknown = "ls"): ContextMessageEntry {
  const parts = [
    { type: "tool", tool: "bash", state: { input, output } },
  ] as unknown as ContextMessageEntry["parts"];
  return { info: { role: "assistant", id: "m-1" }, parts };
}

describe("captureMessage — pruned tool-output classification", () => {
  test("placeholder prefixed by `[mN] ` is classified as pruned", () => {
    // Snapshot evidence: G-MS-03 round "dcp-sweep-no-arg" — apply-view's
    // injectLinePrefix adds `[m4] ` before the placeholder in the live
    // view; the capture must still flag the output as pruned even
    // though the placeholder is no longer at index 0.  The capture
    // receives the full `state.output` (placeholder + prefix, 82 chars);
    // it preserves the full string in the pruned branch.
    const prefixed = `[m4] ${PRUNED_TOOL_OUTPUT_REPLACEMENT}`;
    const capture = captureMessage(toolEntry(prefixed));
    expect(capture.toolParts.length).toBe(1);
    expect(capture.toolParts[0].pruned).toBe(true);
    expect(capture.toolParts[0].output).toBe(prefixed);
  });

  test("ordinary tool output (with or without `[mN] ` prefix) is not pruned", () => {
    // Plain `ls` output — not a placeholder.  The `[mN] ` prefix
    // carried over from the render layer must not flip the pruned
    // flag.  The preview is the first 80 chars verbatim.
    const plain =
      "[m2] total 12\ndrwxr-xr-x 2 root root 4096 Aug 17 .";
    const capture = captureMessage(toolEntry(plain));
    expect(capture.toolParts.length).toBe(1);
    expect(capture.toolParts[0].pruned).toBe(false);
    expect(capture.toolParts[0].output).toBe(plain.slice(0, 80));
  });

  test("bare placeholder (no `[mN] ` prefix) is classified as pruned", () => {
    // Defensive case: a fixture or older snapshot that reaches the
    // capture without the line-start prefix must still flag pruned —
    // the placeholder contract predates the render-layer prefix.
    const capture = captureMessage(
      toolEntry(PRUNED_TOOL_OUTPUT_REPLACEMENT),
    );
    expect(capture.toolParts.length).toBe(1);
    expect(capture.toolParts[0].pruned).toBe(true);
    expect(capture.toolParts[0].output).toBe(PRUNED_TOOL_OUTPUT_REPLACEMENT);
  });

  test("object input wrapping the error placeholder is classified as inputPruned", () => {
    // `writeInputBack` wraps a non-parsing placeholder written over an
    // object input as `{ pruned: <placeholder> }` so the outbound
    // `tool_use.input` stays schema-valid; the capture must still flag
    // the input as pruned through its all-placeholder-values branch.
    const capture = captureMessage(
      toolEntry("ok", { pruned: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT }),
    );
    expect(capture.toolParts.length).toBe(1);
    expect(capture.toolParts[0].inputPruned).toBe(true);
    expect(capture.toolParts[0].input).toBe(
      JSON.stringify({ pruned: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT }).slice(
        0,
        80,
      ),
    );
  });
});
