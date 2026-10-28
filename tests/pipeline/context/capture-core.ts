/**
 * Snapshot capture helpers — host-agnostic projections of message text and
 * prune-placeholder strings.
 *
 * Three noise classes are excluded here (they never reach the JSON):
 * host message ids (only the sentinel zoo-* ids survive, enforced by the
 * host lane's message projection), refs (they stay raw in text and are
 * normalised at compare time), and compaction boundary / anchor
 * internals.  Session state is not captured at all — it is internal
 * implementation detail, and its behaviour is asserted through external
 * observables instead (see `semantic-contracts.ts`).
 *
 * Everything here operates on plain strings and values — no host message
 * shape and no core state is read.  The host-specific message projection
 * lives in each lane's `capture.ts`, which composes these helpers.
 *
 * @module
 */

import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../../src/core/context/message-parts.js";
import { LINE_START_REF_PREFIX } from "../../../src/core/context/view-refs.js";
import type { ViewToolPartCapture } from "./types.js";

/** Preview length for non-pruned tool outputs. */
const TOOL_OUTPUT_PREVIEW = 80;

/** All prune placeholder strings (output + error-input variant). */
const PRUNE_PLACEHOLDERS = [
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
];

/**
 * Capture the prune observables of a single tool output.
 *
 * The render layer (`injectLinePrefix` in the opencode / pi renderers)
 * prepends a line-start `[mN] ` ref marker to every visible item's
 * injection region, so a placeholder written as a whole region may
 * arrive with that prefix in front of it.  Strip one line-start prefix
 * with `LINE_START_REF_PREFIX` as snapshot hygiene — the marker is
 * per-round and transient — so the placeholder contract stays the
 * single source of truth.
 *
 * @param output - The tool output string.
 * @returns The preview capture.
 */
export function captureToolOutput(
  output: string | undefined,
): ViewToolPartCapture {
  if (typeof output !== "string" || output.length === 0) {
    return { output: "", pruned: false, input: null, inputPruned: false };
  }
  const stripped = output.replace(LINE_START_REF_PREFIX, "");
  if (stripped.startsWith(PRUNED_TOOL_OUTPUT_REPLACEMENT)) {
    return { output, pruned: true, input: null, inputPruned: false };
  }
  return {
    output: output.slice(0, TOOL_OUTPUT_PREVIEW),
    pruned: false,
    input: null,
    inputPruned: false,
  };
}

/**
 * Capture the input observables of a tool part (error-input pruning
 * replaces input fields, not outputs).
 *
 * @param input - The tool part input value.
 * @returns The input preview + pruned flag.
 */
export function captureToolInput(input: unknown): {
  input: string | null;
  inputPruned: boolean;
} {
  if (input == null) return { input: null, inputPruned: false };
  if (
    typeof input === "string" &&
    input === PRUNED_TOOL_ERROR_INPUT_REPLACEMENT
  ) {
    return { input, inputPruned: true };
  }
  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    const values = Object.values(record);
    if (
      values.length > 0 &&
      values.every((v) => PRUNE_PLACEHOLDERS.includes(v as string))
    ) {
      return {
        input: JSON.stringify(record).slice(0, TOOL_OUTPUT_PREVIEW),
        inputPruned: true,
      };
    }
  }
  const preview =
    typeof input === "string"
      ? input.slice(0, TOOL_OUTPUT_PREVIEW)
      : JSON.stringify(input).slice(0, TOOL_OUTPUT_PREVIEW);
  return { input: preview, inputPruned: false };
}
