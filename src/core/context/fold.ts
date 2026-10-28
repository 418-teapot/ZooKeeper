/**
 * Pure fold view construction: transcript + block state → view items.
 *
 * `fold` is stateless and deterministic — the same inputs always produce
 * the same view.  It partitions the transcript into indivisible fold
 * units (a tool call and its result travel together) and walks those
 * units in order, replacing each unit interval covered by a surviving
 * block with a single summary item; every other unit keeps its original
 * item.
 *
 * Coverage invariant: every active block whose span still validates is
 * either rendered as a summary item or reported in `expired` with the
 * cause.  No valid block can leave the view without a trace, so the
 * caller can retire it and the summarised content stays accounted for.
 *
 * Two causes are reported:
 *
 * - `"hash-invalid"` — the span hash no longer matches the transcript
 *   (`validateBlock`).  The block expands back into plain original items
 *   and `viewChanged` is set.
 * - `"boundary"` — the block's interval cannot be located on the unit
 *   grid: a boundary falls inside a unit, or a preceding block already
 *   folded past its start.  The interval likewise expands into original
 *   items.  The compression path builds blocks from resolved view
 *   ranges, whose endpoints are unit boundaries by construction, so this
 *   cause signals a block that no longer matches the current transcript
 *   structure.
 *
 * Blocks already in a terminal status (`consumed`, `stale`) expand the
 * same way but are neither reported nor re-validated — their interval is
 * ordinary content again, and re-checking a hash nothing folds any more
 * would only add work.
 *
 * `viewChanged` therefore signals a change made by THIS fold: an active
 * block dropped out of the view.  Retaining terminal blocks in the
 * state means the same non-folding blocks are seen round after round,
 * so steady-state rounds over them must not report a change (the caller
 * arms a release bypass on this signal, which has to stay a one-shot).
 *
 * The module never mutates its inputs: expired-block reporting returns
 * ids and causes only, and the status transition is the caller's
 * decision.
 *
 * @module
 */

import type { Projection, ViewItem } from "./lens.js";
import { computeUnits } from "./lens.js";
import { validateBlock } from "./spanhash.js";
import type { Block, SessionState } from "./state.js";

/**
 * Why an active block could not be rendered as a view item.
 *
 * - `"hash-invalid"` — its span no longer hashes to the stored value.
 * - `"boundary"` — its interval does not resolve against the unit grid:
 *   a boundary falls inside a unit, or a preceding block folded past its
 *   start.
 */
export type FoldExpiryReason = "hash-invalid" | "boundary";

/**
 * One active block that dropped out of the view, with its cause.
 */
export interface FoldExpiry {
  /** The block id. */
  id: number;
  /** Why the block did not render. */
  reason: FoldExpiryReason;
}

/**
 * Result of one fold pass.
 */
export interface FoldResult {
  /** The folded view, in ordinal order. */
  items: ViewItem[];
  /**
   * True when an active block dropped out of the view in this fold.
   * Signals that the produced view differs from the fully folded
   * expectation, so the caller can notify a pending view change.
   * Blocks already in a terminal status fold out every round and are
   * not a change.
   */
  viewChanged: boolean;
  /** Active blocks that did not render, ascending by id. */
  expired: FoldExpiry[];
}

/**
 * Compute the folded view over the transcript for the given block state.
 *
 * Pure function: never mutates `history` or `state`.  The transcript is
 * first partitioned into indivisible fold units (`computeUnits`) so a
 * tool call and its result stay addressable together; units not covered
 * by any surviving block become `{type: "original"}` items, and a
 * surviving block's interval becomes one `{type: "summary"}` item.
 * Hidden messages are ordinary transcript members and appear inside
 * their unit; fold does no hidden filtering.
 *
 * A block renders only when `start` and `end` both land on a unit seam
 * and no earlier block already folded its start.  Every other active
 * block — hash-invalid or unaddressable — expands into plain original
 * items and is reported in `expired` (see the module docstring).
 *
 * @param snapshot - The current projection snapshot (span validation
 *   resolves tool names through the invocation table).
 * @param state - The session state; only `state.blocks` is read.
 * @returns The folded view plus change and expiry signals.
 */
export function fold(snapshot: Projection, state: SessionState): FoldResult {
  const expired: FoldExpiry[] = [];
  const candidates: Array<{ id: number; block: Block }> = [];
  let viewChanged = false;

  for (const [id, block] of state.blocks) {
    if (block.status !== "active") continue;
    if (!validateBlock(snapshot, block)) {
      viewChanged = true;
      expired.push({ id, reason: "hash-invalid" });
      continue;
    }
    candidates.push({ id, block });
  }
  // Stable sort by start ordinal; equal starts keep block-map order.
  candidates.sort((a, b) => a.block.start - b.block.start);

  const units = computeUnits(snapshot.invocations, snapshot.messages.length);
  const unitStarts = new Set<number>();
  const unitEnds = new Set<number>();
  for (const { start, end } of units) {
    unitStarts.add(start);
    unitEnds.add(end);
  }

  const items: ViewItem[] = [];
  const original = (unit: { start: number; end: number }): ViewItem => ({
    type: "original",
    start: unit.start,
    end: unit.end,
  });

  // Walk the units once, in step with the blocks: a block must never
  // split a tool call from its result, and a folded interval must not
  // skip a unit the walk has not reached yet.
  let unit = 0;
  for (const { id, block } of candidates) {
    if (!(unitStarts.has(block.start) && unitEnds.has(block.end))) {
      viewChanged = true;
      expired.push({ id, reason: "boundary" });
      continue;
    }
    while (unit < units.length && units[unit].start < block.start) {
      items.push(original(units[unit]));
      unit += 1;
    }
    if (unit === units.length || units[unit].start !== block.start) {
      // An earlier block already folded across this start; the interval
      // has no place left in the view.
      viewChanged = true;
      expired.push({ id, reason: "boundary" });
      continue;
    }
    while (unit < units.length && units[unit].end <= block.end) unit += 1;
    items.push({ type: "summary", block });
  }
  while (unit < units.length) {
    items.push(original(units[unit]));
    unit += 1;
  }

  expired.sort((a, b) => a.id - b.id);
  return { items, viewChanged, expired };
}
