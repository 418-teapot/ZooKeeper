/**
 * Snapshot capture — turns live messages / session state into the
 * semantic projections that get persisted as golden snapshots.
 *
 * Three noise classes are excluded here (they never reach the JSON):
 * host message ids (only the sentinel zoo-* ids survive), refs (they
 * stay raw in text and are normalised at compare time), and compaction
 * boundary / anchor internals (blocks are projected to their semantic
 * subset, timestamps dropped).
 *
 * The capture source is the host-agnostic core
 * (`src/core/context/`): block and mark collections live on a
 * `SessionState` reached through the shared `SessionStateManager`.
 *
 * @module
 */

import type { ContextMessageEntry } from "../../../src/adapters/opencode/types.js";
import { isMessageIgnored } from "../../../src/adapters/opencode/types.js";
import { LINE_START_REF_PREFIX } from "../../../src/core/context/canon.js";
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
import type {
  BlockProjection,
  StateCapture,
  ViewMessageCapture,
  ViewToolPartCapture,
} from "./types.js";

/** Preview length for non-pruned tool outputs. */
const TOOL_OUTPUT_PREVIEW = 80;

/** Sentinel synthetic message id prefixes kept in the snapshot. */
const SENTINEL_PREFIXES = ["zoo-fold-b", "zoo-nudge", "zoo-manual-compress"];

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
 * The render layer (`apply-view.ts` → `injectLinePrefix`) prepends a
 * line-start `[mN] ` ref marker to every visible item's injection
 * region before the snapshot is read back, so a placeholder may arrive
 * with that prefix in front of it.  Strip one (and only one — the
 * marker is per-round and the capture sees the current round's
 * prefix) with the same `LINE_START_REF_PREFIX` rule the render layer
 * strips with `canon.stripTags`, so
 * the placeholder contract stays the single source of truth.
 *
 * @param output - The tool output string.
 * @returns The preview capture.
 */
function captureToolOutput(output: string | undefined): ViewToolPartCapture {
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
function captureToolInput(input: unknown): {
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

/**
 * Capture one message's observable view shape.
 *
 * @param entry - The (possibly mutated) message entry.
 * @returns The view capture.
 */
export function captureMessage(entry: ContextMessageEntry): ViewMessageCapture {
  const info = entry.info as unknown as Record<string, unknown>;
  const capture: ViewMessageCapture = {
    role: entry.info.role,
    toolParts: [],
  };
  if (info.synthetic === true) capture.synthetic = true;
  if (info.summary === true) capture.boundary = true;
  if (isMessageIgnored(entry) || info.ignored === true) capture.ignored = true;

  const sentinel = SENTINEL_PREFIXES.find((p) =>
    String(entry.info.id).startsWith(p),
  );
  if (sentinel) {
    // Keep the sentinel identity (the numeric suffix is the stable
    // block id / a fixed marker) so the snapshot reader can tell
    // synthetic messages apart from ordinary user text.
    (capture as unknown as Record<string, unknown>).sentinelId = String(
      entry.info.id,
    );
  }

  const textParts: string[] = [];
  const parts = entry.parts ?? [];
  for (const part of parts) {
    const p = part as unknown as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      textParts.push(p.text);
    } else if (p.type === "tool") {
      const state = p.state as Record<string, unknown> | undefined;
      const output = typeof state?.output === "string" ? state.output : "";
      capture.toolParts.push({
        tool: typeof p.tool === "string" ? p.tool : undefined,
        ...captureToolOutput(output),
        ...captureToolInput(state?.input),
      });
    }
  }
  if (textParts.length > 0) capture.text = textParts.join("\n");
  return capture;
}

/**
 * Capture the final view structure of a (mutated) message array.
 *
 * @param messages - The messages after the transform ran.
 * @returns Ordered view captures.
 */
export function captureView(
  messages: ContextMessageEntry[],
): ViewMessageCapture[] {
  return messages.map(captureMessage);
}
