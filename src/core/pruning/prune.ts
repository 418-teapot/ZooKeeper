/**
 * Pruning logic — the sweep phase of mark-sweep context pruning.
 *
 * Provides `pruneToolOutputs` which replaces effective-marked tool
 * outputs with a placeholder string.  The mark phase is handled by
 * producers (sweep.ts, dedup.ts) which write to `state.marks`.
 *
 * @module
 */

import type { ContextMessageEntry } from "../metrics.js";
import type { SessionState, SweepToolPart } from "./types.js";
import {
  getCallId,
  INPUT_HEAVY_TOOLS,
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result item from `pruneToolOutputs` describing a single replaced output.
 */
export interface PruneReplacement {
  /** Tool call identifier. */
  callID: string;
  /** Length of the original output (string len or JSON-stringified len). */
  beforeLen: number;
  /** Length of the placeholder replacement. */
  afterLen: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Length accounting for a single trimmed input-heavy tool input.
 */
interface TrimResult {
  /** Length of the original input (string len or sum of field lengths). */
  beforeLen: number;
  /** Length of the replacement placeholder(s). */
  afterLen: number;
}

/**
 * Compute trim accounting for a string-typed input-heavy tool input.
 *
 * The caller replaces the entire input with the placeholder.  Returns
 * null when the input is not a string.
 *
 * @param input - The tool input.
 * @param placeholder - Replacement constant for this prune path.
 * @returns Length accounting, or null when the input is not a string.
 */
function trimStringInput(
  input: unknown,
  placeholder: string,
): TrimResult | null {
  if (typeof input !== "string") return null;
  return { beforeLen: input.length, afterLen: placeholder.length };
}

/**
 * Trim a plain-object input-heavy tool input IN-PLACE: keep `filePath`,
 * replace every other top-level field with the placeholder.
 *
 * Top-level arrays and non-object inputs are skipped (return null) — this
 * branch is meant for plain records; array-valued FIELDS inside the record
 * are replaced like any other field.
 *
 * @param input - The tool input (mutated in place when trimmed).
 * @param placeholder - Replacement constant for this prune path.
 * @returns Length accounting, or null when the input is not a non-empty
 *   plain object.
 */
function trimInputHeavyObject(
  input: unknown,
  placeholder: string,
): TrimResult | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;
  const originalKeys = Object.keys(record);
  if (originalKeys.length === 0) return null;

  // Compute beforeLen: sum of all field lengths (stringified for
  // non-string values).
  let beforeLen = 0;
  for (const key of originalKeys) {
    const val = record[key];
    beforeLen +=
      typeof val === "string" ? val.length : JSON.stringify(val).length;
  }

  // Keep filePath, replace every other top-level field.  Non-string
  // fields (e.g. questions array) also get replaced with the placeholder.
  const hasFilePath = "filePath" in record;
  for (const key of originalKeys) {
    if (key !== "filePath") {
      record[key] = placeholder;
    }
  }

  const replacedCount = hasFilePath
    ? originalKeys.length - 1
    : originalKeys.length;
  return { beforeLen, afterLen: placeholder.length * replacedCount };
}

// ---------------------------------------------------------------------------
// Prune (sweep phase)
// ---------------------------------------------------------------------------

/**
 * Prune tool outputs that have been effective-marked in the session state.
 *
 * Walks each message's parts array.  For every tool part whose
 * `callID` has an effective mark in `state.marks`, its `state.output`
 * is replaced IN-PLACE with `PRUNED_TOOL_OUTPUT_REPLACEMENT`.
 *
 * Non-effective (pending) marks are NOT applied — they await batch
 * release via `releaseBatch`.
 *
 * Token accounting is NOT performed here — it happens at mark-time
 * (producers) when estimated token counts are first recorded.  This
 * avoids double-counting across transform turns since the transform
 * reloads messages fresh from DB each turn but marks accumulate.
 *
 * This function mutates `messages` in place and reads `state.marks`.
 * It does NOT mutate state or stats.
 *
 * @param state - The session state (must have `marks` map).
 * @param messages - Array of session message entries (mutated in place).
 * @returns Array of `PruneReplacement` objects describing each replaced
 *   output (empty array when no effective marks exist or no matches found).
 */
export function pruneToolOutputs(
  state: SessionState,
  messages: ContextMessageEntry[],
): PruneReplacement[] {
  if (state.marks.size === 0) return [];

  const replacedOutputs: PruneReplacement[] = [];

  // Replace ALL matching effective outputs in place.
  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const toolPart = part as SweepToolPart;
      if (toolPart.type !== "tool") continue;
      const callID = getCallId(toolPart);
      if (!callID) continue;

      const mark = state.marks.get(callID);
      if (!mark?.effective) continue;
      // Only apply marks with the output action — error-input marks
      // are handled by pruneToolErrors.
      if (mark.action !== "tool-output") continue;

      const toolName = toolPart.tool ?? "";

      if (INPUT_HEAVY_TOOLS.has(toolName)) {
        // Input-heavy tool — trim input instead of replacing output.
        // Output is NEVER touched — it is small and precious.
        const input = toolPart.state?.input;

        // Null / undefined: nothing to trim. Silently skip (output
        // must never be touched for trio tools).
        if (input == null) continue;

        // String input: replace entire input (mirrors pruneToolErrors).
        const stringTrim = trimStringInput(
          input,
          PRUNED_TOOL_INPUT_REPLACEMENT,
        );
        if (stringTrim) {
          if (toolPart.state) {
            toolPart.state.input = PRUNED_TOOL_INPUT_REPLACEMENT;
          }
          replacedOutputs.push({ callID, ...stringTrim });
          continue;
        }

        // Plain object input: preserve filePath, replace other fields.
        // Top-level arrays and non-object inputs are skipped by the
        // shared helper (consistent with pruneToolErrors).
        const objectTrim = trimInputHeavyObject(
          input,
          PRUNED_TOOL_INPUT_REPLACEMENT,
        );
        if (objectTrim) {
          replacedOutputs.push({ callID, ...objectTrim });
        }

        // Non-object, non-string, non-null (e.g. number, boolean):
        // nothing to trim. Silently skip.
      } else {
        // Non-input-heavy tool: replace output with placeholder (original
        // behavior).
        const originalOutput = toolPart.state?.output;

        // Runtime safety: TS types say string but JS host data may not
        // always conform. JSON.stringify fallback handles the non-string
        // case gracefully without crashing or reporting beforeLen as 0.
        const out = originalOutput as unknown;
        const beforeLen =
          typeof out === "string"
            ? out.length
            : out != null
              ? JSON.stringify(out).length
              : 0;
        const afterLen = PRUNED_TOOL_OUTPUT_REPLACEMENT.length;
        replacedOutputs.push({ callID, beforeLen, afterLen });

        if (toolPart.state) {
          toolPart.state.output = PRUNED_TOOL_OUTPUT_REPLACEMENT;
        } else {
          (toolPart as unknown as Record<string, unknown>).state = {
            output: PRUNED_TOOL_OUTPUT_REPLACEMENT,
          };
        }
      }
    }
  }

  // NOTE: marks is NOT cleared — it accumulates per DCP semantics.
  // The map persists for TUI visibility and is only reset via
  // deleteSessionState (session.deleted) or compaction.

  return replacedOutputs;
}

// ---------------------------------------------------------------------------
// Prune error inputs (sweep phase)
// ---------------------------------------------------------------------------

/**
 * Prune inputs of failed tool calls that have been effective-marked with
 * action `"tool-error-input"`.
 *
 * Walks each message's parts array.  For every tool part whose `callID`
 * has an effective mark with action `"tool-error-input"`, its input
 * string-value fields are replaced IN-PLACE with
 * `PRUNED_TOOL_ERROR_INPUT_REPLACEMENT`.
 *
 * Non-string fields (numbers, booleans, arrays, nested objects) within
 * the input object are left untouched.  If the input is a plain string,
 * it is replaced entirely.  Null / undefined inputs are left unchanged.
 *
 * Non-effective (pending) marks and marks with other actions (e.g.
 * `"tool-output"`) are NOT applied.
 *
 * This function mutates `messages` in place and reads `state.marks`.
 * It does NOT mutate state or stats.
 *
 * @param state - The session state (must have `marks` map).
 * @param messages - Array of session message entries (mutated in place).
 * @returns Array of `PruneReplacement` objects describing each replaced
 *   input (empty array when no effective error-input marks exist or
 *   no matches found).
 */
export function pruneToolErrors(
  state: SessionState,
  messages: ContextMessageEntry[],
): PruneReplacement[] {
  if (state.marks.size === 0) return [];

  const replacedInputs: PruneReplacement[] = [];

  for (const msg of messages) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      const toolPart = part as SweepToolPart;
      if (toolPart.type !== "tool") continue;
      const callID = getCallId(toolPart);
      if (!callID) continue;

      const mark = state.marks.get(callID);
      if (!mark?.effective) continue;

      // Only apply marks with the error-input action.
      if (mark.action !== "tool-error-input") continue;

      const input = toolPart.state?.input;

      // Skip null / undefined inputs.
      if (input == null) continue;

      const toolName = toolPart.tool ?? "";
      const isInputHeavy = INPUT_HEAVY_TOOLS.has(toolName);

      if (isInputHeavy) {
        // Input-heavy tool — keep filePath, replace all other
        // top-level fields with the error placeholder.
        const stringTrim = trimStringInput(
          input,
          PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
        );
        if (stringTrim) {
          if (toolPart.state) {
            toolPart.state.input = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT;
          }
          replacedInputs.push({ callID, ...stringTrim });
          continue;
        }

        // Plain object input: preserve filePath, replace other fields.
        // Top-level arrays and non-object inputs are skipped by the
        // shared helper.
        const objectTrim = trimInputHeavyObject(
          input,
          PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
        );
        if (objectTrim) {
          replacedInputs.push({ callID, ...objectTrim });
        }
        continue;
      }

      // Non-input-heavy tool: replace string-value fields only (original
      // behavior).
      let beforeLen = 0;
      let stringFieldCount = 0;

      if (typeof input === "string") {
        beforeLen = input.length;
        if (toolPart.state) {
          toolPart.state.input = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT;
        }
        stringFieldCount = 1;
      } else if (typeof input === "object" && !Array.isArray(input)) {
        const record = input as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          if (typeof record[key] === "string") {
            beforeLen += (record[key] as string).length;
            record[key] = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT;
            stringFieldCount++;
          }
        }
      }

      if (stringFieldCount === 0) continue;

      const afterLen =
        PRUNED_TOOL_ERROR_INPUT_REPLACEMENT.length * stringFieldCount;
      replacedInputs.push({ callID, beforeLen, afterLen });
    }
  }

  return replacedInputs;
}
