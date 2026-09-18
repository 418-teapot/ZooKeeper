/**
 * Pure fold view construction: transcript + block state → view items.
 *
 * `fold` is stateless and deterministic — the same inputs always produce
 * the same view.  It partitions the transcript into indivisible fold
 * units (a tool call and its result travel together) and walks those
 * units in order, replacing each unit interval covered by a surviving
 * block with a single summary item; every other unit keeps its original
 * item.  A block survives only
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
 * Unit alignment: a block folds only when its boundaries coincide with
 * unit seams.  The compression path builds blocks from resolved view
 * ranges, whose endpoints are unit boundaries by construction, so an
 * off-seam block cannot arise from normal operation.  The read side does
 * not widen such a block to the nearest seam: it expands into plain
 * original items, silently like a hash-invalid one.
 *
 * Defensive merge: surviving blocks whose aligned intervals intersect (a
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
import { computeUnits } from "./lens.js";
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
 * Pure function: never mutates `history` or `state`.  The transcript is
 * first partitioned into indivisible fold units (`computeUnits`) so a
 * tool call and its result stay addressable together; units not covered
 * by any surviving block become `{type: "original"}` items, and covered
 * unit intervals become one `{type: "summary"}` item per surviving block
 * (or per merged group — see below).  Hidden messages are ordinary
 * transcript members and appear inside their unit; fold does no hidden
 * filtering.
 *
 * Block survival is `status === "active" && validateBlock(snapshot,
 * block)`.  An active block that fails validation silently expands: its
 * ordinals revert to original items, its id lands in `expiredBlockIds`,
 * and `viewChanged` is set.  A block in a terminal status expands the
 * same way but is never reported and never hash-checked — fold has no
 * path that could re-fold it.
 *
 * A block folds only when its `start` and `end` both land on a unit
 * seam: the compression path resolves ranges from view lines
 * (`resolveRange`), so block endpoints are unit boundaries by
 * construction.  A block with a boundary inside a unit expands into
 * plain original items instead — the same silent path as a hash-invalid
 * block — and the read side never widens it to the nearest seam.
 *
 * Defensive merge: when two folding blocks' intervals intersect, the
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

  // Walk the transcript at unit granularity: a fold range must never
  // split a tool call from its result.  Only a block whose `start` and
  // `end` both land on unit seams folds; an off-seam block is dropped
  // from `foldable` and its interval expands into original items, the
  // same silent path a hash-invalid block takes.
  const units = computeUnits(snapshot.invocations, history.length);
  const unitStarts = new Set<number>();
  const unitEnds = new Set<number>();
  for (const { start, end } of units) {
    unitStarts.add(start);
    unitEnds.add(end);
  }
  const foldable = surviving.filter(
    (block) => unitStarts.has(block.start) && unitEnds.has(block.end),
  );

  let unit = 0;
  let index = 0;
  while (unit < units.length) {
    const block = foldable[index];
    if (block === undefined || block.start !== units[unit].start) {
      items.push({
        type: "original",
        start: units[unit].start,
        end: units[unit].end,
      });
      unit += 1;
      continue;
    }
    // Absorb every following block whose interval intersects the running
    // union (overlapping / nested defensive branch).
    let end = block.end;
    while (index + 1 < foldable.length && foldable[index + 1].start < end) {
      index += 1;
      if (foldable[index].end > end) end = foldable[index].end;
    }
    // Skip every unit the merged union covers; the union ends on a seam.
    while (unit < units.length && units[unit].end <= end) unit += 1;
    items.push({ type: "summary", block });
    index += 1;
  }

  return { items, viewChanged, expiredBlockIds };
}
