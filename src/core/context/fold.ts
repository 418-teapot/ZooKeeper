/**
 * Pure fold view construction: transcript + block state → view items.
 *
 * `fold` is stateless and deterministic — the same inputs always produce
 * the same view.  It walks the transcript in ordinal order and replaces
 * each interval covered by a surviving block with a single summary item;
 * every other message keeps its original item.  A block survives only
 * when it is active and its span hash still matches the current content
 * (`validateBlock`).
 *
 * Failure handling is silent by design: an active block that no longer
 * validates expands back into plain original items — its id is reported
 * in `expiredBlockIds` and `viewChanged` is set, but no tombstone or
 * hint is added to the view.  Blocks already in a terminal status
 * (`consumed`, `stale`) expand the same way but are neither reported
 * nor re-validated — their interval is ordinary content again, and
 * re-checking a hash nothing folds any more would only add work.
 *
 * `viewChanged` therefore signals a change made by THIS fold: an active
 * block dropped out of the view.  Retaining terminal blocks in the
 * state means the same non-folding blocks are seen round after round,
 * so steady-state rounds over them must not report a change (the caller
 * arms a release bypass on this signal, which has to stay a one-shot).
 *
 * Defensive merge: surviving blocks whose intervals intersect (a
 * condition the normal compression path prevents via `hasActiveOverlap`)
 * fold into a single summary item over the union of their intervals,
 * rendered from the first-appearing block's reference.
 *
 * The module never mutates its inputs: expired-block reporting returns
 * ids only, and the status transition is the caller's decision.
 *
 * @module
 */

import type { Projection, ViewItem } from "./lens.js";
import { validateBlock } from "./spanhash.js";
import type { Block, SessionState } from "./state.js";

/**
 * Result of one fold pass.
 */
export interface FoldResult {
  /** The folded view, in ordinal order. */
  items: ViewItem[];
  /**
   * True when an active block dropped out of the view in this fold (its
   * span hash no longer matches).  Signals that the produced view
   * differs from the fully folded expectation, so the caller can notify
   * a pending view change.  Blocks already in a terminal status fold
   * out every round and are not a change.
   */
  viewChanged: boolean;
  /** Ids of active blocks that failed span validation, ascending. */
  expiredBlockIds: number[];
}

/**
 * Compute the folded view over the transcript for the given block state.
 *
 * Pure function: never mutates `history` or `state`.  Ordinals not
 * covered by any surviving block become `{type: "original"}` items;
 * covered intervals become one `{type: "summary"}` item per surviving
 * block (or per merged group — see below).  Hidden messages are ordinary
 * transcript members and appear as original items; fold does no hidden
 * filtering.
 *
 * Block survival is `status === "active" && validateBlock(snapshot,
 * block)`.  An active block that fails validation silently expands: its
 * ordinals revert to original items, its id lands in `expiredBlockIds`,
 * and `viewChanged` is set.  A block in a terminal status expands the
 * same way but is never reported and never hash-checked — fold has no
 * path that could re-fold it.
 *
 * Defensive merge: when two surviving blocks' intervals intersect, the
 * view folds the union of their intervals into a single summary item
 * rendered from the first-appearing block (the one with the smallest
 * start ordinal; ties keep block-map order).  The normal compression
 * path prevents overlap via `hasActiveOverlap`, so this branch is
 * defensive — it must not be removed or left untested.
 *
 * @param snapshot - The current projection snapshot (span validation
 *   resolves tool names through the invocation table).
 * @param state - The session state; only `state.blocks` is read.
 * @returns The folded view plus change and expiry signals.
 */
export function fold(snapshot: Projection, state: SessionState): FoldResult {
  const history = snapshot.messages;
  const expiredBlockIds: number[] = [];
  const surviving: Block[] = [];
  let viewChanged = false;

  for (const [id, block] of state.blocks) {
    if (block.status !== "active") continue;
    if (!validateBlock(snapshot, block)) {
      viewChanged = true;
      expiredBlockIds.push(id);
      continue;
    }
    surviving.push(block);
  }
  expiredBlockIds.sort((a, b) => a - b);
  // Stable sort by start ordinal; equal starts keep block-map order.
  surviving.sort((a, b) => a.start - b.start);

  const items: ViewItem[] = [];
  let ordinal = 0;
  let index = 0;
  while (ordinal < history.length) {
    const block = surviving[index];
    if (block === undefined || ordinal < block.start) {
      items.push({ type: "original", ordinal });
      ordinal += 1;
      continue;
    }
    // Absorb every following block whose interval intersects the running
    // union (overlapping / nested defensive branch).
    let end = block.end;
    while (index + 1 < surviving.length && surviving[index + 1].start < end) {
      index += 1;
      if (surviving[index].end > end) end = surviving[index].end;
    }
    items.push({ type: "summary", block });
    ordinal = end;
    index += 1;
  }

  return { items, viewChanged, expiredBlockIds };
}
