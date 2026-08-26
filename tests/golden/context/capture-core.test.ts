/**
 * Unit tests for the host-agnostic prune classification in
 * `capture-core.ts` (`captureToolOutput` / `captureToolInput`).
 *
 * The render layer prepends a line-start `[mN] ` ref marker to every
 * visible item's injection region, and a prune placeholder written as a
 * whole region therefore reaches the capture with that prefix in front
 * of it.  The capture must still recognise the placeholder — its
 * identity is the single source of truth in
 * `src/core/context/message-parts.ts` — by stripping the line-start
 * prefix at capture time as snapshot hygiene.
 *
 * The helpers operate on plain strings / values, so the classification
 * is verified here directly (the v1 message-shape integration is
 * covered by the opencode lane's `capture.test.ts`).
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../../src/core/context/message-parts.js";
import { captureToolInput, captureToolOutput } from "./capture-core.js";

describe("captureToolOutput — pruned tool-output classification", () => {
  test("placeholder prefixed by `[mN] ` is classified as pruned", () => {
    // Snapshot evidence: G-MS-03 round "dcp-sweep-no-arg" — the
    // renderer's injectLinePrefix adds `[m4] ` before the placeholder in
    // the live view; the capture must still flag the output as pruned
    // even though the placeholder is no longer at index 0.  The capture
    // receives the full `state.output` (placeholder + prefix, 82 chars);
    // it preserves the full string in the pruned branch.
    const prefixed = `[m4] ${PRUNED_TOOL_OUTPUT_REPLACEMENT}`;
    const capture = captureToolOutput(prefixed);
    expect(capture.pruned).toBe(true);
    expect(capture.output).toBe(prefixed);
  });

  test("ordinary tool output (with or without `[mN] ` prefix) is not pruned", () => {
    // Plain `ls` output — not a placeholder.  The `[mN] ` prefix
    // carried over from the render layer must not flip the pruned
    // flag.  The preview is the first 80 chars verbatim.
    const plain = "[m2] total 12\ndrwxr-xr-x 2 root root 4096 Aug 17 .";
    const capture = captureToolOutput(plain);
    expect(capture.pruned).toBe(false);
    expect(capture.output).toBe(plain.slice(0, 80));
  });

  test("bare placeholder (no `[mN] ` prefix) is classified as pruned", () => {
    // Defensive case: a fixture or older snapshot that reaches the
    // capture without the line-start prefix must still flag pruned —
    // the placeholder contract predates the render-layer prefix.
    const capture = captureToolOutput(PRUNED_TOOL_OUTPUT_REPLACEMENT);
    expect(capture.pruned).toBe(true);
    expect(capture.output).toBe(PRUNED_TOOL_OUTPUT_REPLACEMENT);
  });

  test("empty / undefined output yields an empty non-pruned capture", () => {
    expect(captureToolOutput(undefined)).toEqual({
      output: "",
      pruned: false,
      input: null,
      inputPruned: false,
    });
    expect(captureToolOutput("")).toEqual({
      output: "",
      pruned: false,
      input: null,
      inputPruned: false,
    });
  });
});

describe("captureToolInput — input prune classification", () => {
  test("object input wrapping the error placeholder is classified as inputPruned", () => {
    // `writeInputBack` wraps a non-parsing placeholder written over an
    // object input as `{ pruned: <placeholder> }` so the outbound
    // `tool_use.input` stays schema-valid; the capture must still flag
    // the input as pruned through its all-placeholder-values branch.
    const capture = captureToolInput({
      pruned: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
    });
    expect(capture.inputPruned).toBe(true);
    expect(capture.input).toBe(
      JSON.stringify({ pruned: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT }).slice(
        0,
        80,
      ),
    );
  });

  test("null / undefined input yields a null preview", () => {
    expect(captureToolInput(null)).toEqual({ input: null, inputPruned: false });
    expect(captureToolInput(undefined)).toEqual({
      input: null,
      inputPruned: false,
    });
  });

  test("plain string input is previewed, not pruned", () => {
    const capture = captureToolInput("ls -la");
    expect(capture.inputPruned).toBe(false);
    expect(capture.input).toBe("ls -la");
  });
});
