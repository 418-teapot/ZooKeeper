/**
 * Snapshot capture helpers — host-agnostic projections of core state and
 * prune-placeholder strings.
 *
 * Three noise classes are excluded here (they never reach the JSON):
 * host message ids (only the sentinel zoo-* ids survive, enforced by the
 * host lane's message projection), refs (they stay raw in text and are
 * normalised at compare time), and compaction boundary / anchor
 * internals (blocks are projected to their semantic subset, timestamps
 * dropped).
 *
 * Everything here operates on core state (`SessionState`, `Block`) and
 * plain strings — no host message shape is read.  The host-specific
 * message projection lives in each lane's `capture.ts`, which composes
 * these helpers.
 *
 * @module
 */

import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../../src/core/context/message-parts.js";
import {
  pendingCount,
  pendingTokens,
  reclaimedTokens,
} from "../../../src/core/context/release.js";
import type { Block, SessionState } from "../../../src/core/context/state.js";
import { LINE_START_REF_PREFIX } from "../../../src/core/context/view-refs.js";
import type {
  BlockProjection,
  StateCapture,
  ViewToolPartCapture,
} from "./types.js";

/** Preview length for non-pruned tool outputs. */
const TOOL_OUTPUT_PREVIEW = 80;

/** All prune placeholder strings (output + error-input variant). */
const PRUNE_PLACEHOLDERS = [
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
];

/**
 * Project a single compression block to its stable semantic subset.
 *
 * The block-map key (passed in by the caller) is the persistent
 * identifier; the visible covered-message count is `end - start`.
 * The runner translates id-keyed plans into consecutive ordinals, so
 * the projection's covered-message count equals the wider-message
 * span the historical fixtures captured.
 *
 * @param blockId - The persistent block-map key.
 * @param block - The block record from the core state.
 * @returns The projection (title null when undefined).
 */
export function projectBlock(blockId: number, block: Block): BlockProjection {
  return {
    blockId,
    active: block.active,
    title: block.title ?? null,
    coveredMessages: block.end - block.start,
    compressedTokens: block.compressedTokens,
    summaryTokens: block.summaryTokens,
  };
}

/**
 * Project a session state to its captured subset.
 *
 * Reads directly from the `SessionState` carried by the shared
 * `SessionStateManager` — block map keyed by integer ids, mark map
 * keyed by `(ordinal, regionIndex?)` strings.  Effective-vs-pending
 * marks are derived via the core's `pendingCount` /
 * `reclaimedTokens` (pending is `effective === false`, reclaimed is
 * `effective === true`).
 *
 * @param state - The live session state.
 * @returns The projected state.
 */
export function captureState(state: SessionState): StateCapture {
  const blocks: BlockProjection[] = [];
  for (const [blockId, block] of state.blocks) {
    blocks.push(projectBlock(blockId, block));
  }
  blocks.sort((a, b) => a.blockId - b.blockId);
  let effectiveCount = 0;
  for (const [, mark] of state.marks) {
    if (mark.effective) effectiveCount++;
  }
  return {
    blocks,
    marks: {
      pending: pendingCount(state),
      pendingTokens: pendingTokens(state),
      effective: effectiveCount,
      effectiveTokens: reclaimedTokens(state),
    },
    pendingViewChange: false,
    nudgeAnchor: state.nudges?.lastNudgeTokens ?? null,
  };
}

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
