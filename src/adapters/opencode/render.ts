/**
 * V1 render entry points — region edits + fold-view materialization.
 *
 * `render` materializes a pruning round into the v1 messages array:
 * each `RegionEdit` is written through the lens (`history`'s writable
 * regions, so the backing v1 part is mutated in place), then the folded
 * view is rendered — dense line-number prefixes, synthetic summary
 * messages, and the in-place array restructure.  The input `entries`
 * array is mutated in place and returned.
 *
 * The two steps are also exported separately so a caller can apply the
 * release-phase edits early and render the view later (`applyEdits` +
 * `renderView` — the ordering hook.ts uses: edit application must
 * precede the producers and the nudge eligibility scan, which read the
 * placeholder text through the lens).  Splitting the steps changes
 * nothing observable: the combined `render` applies the same edits and
 * renders the same view.
 *
 * @module
 */

import type {
  HostMessage,
  RegionEdit,
  ViewItem,
} from "../../core/context/lens.js";
import type { SessionState } from "../../core/context/state.js";
import { numberView, refPrefix } from "../../core/context/view-refs.js";
import { materializeSummary } from "./apply-view.js";
import { history, isInjectableRegion, type WritableRegion } from "./history.js";
import { blockIdOf } from "./projection.js";
import type { ContextMessageEntry } from "./types.js";

/**
 * Apply region edits to the v1 messages array in place.
 *
 * Edits are written through a fresh lens binding of `entries`, so each
 * edit text lands in the addressed v1 part (tool state, text, or tool
 * input) without the caller keeping a lens around.  An edit whose
 * anchor cannot be resolved — out-of-range message ordinal,
 * out-of-range region index, or a missing region index — is skipped
 * defensively.
 *
 * @param entries - The v1 messages array (mutated in place).
 * @param edits - Region text replacements.
 */
export function applyEdits(
  entries: ContextMessageEntry[],
  edits: RegionEdit[],
): void {
  const lens = history(entries);
  for (const edit of edits) {
    if (edit.regionIndex === undefined) continue;
    const region = lens[edit.messageOrdinal]?.regions?.[edit.regionIndex];
    if (!region) continue;
    (region as WritableRegion).set(edit.text);
  }
}

/**
 * Pick the region that receives the line-number prefix for an original
 * view item.
 *
 * Placement keeps the three-branch priority — the first tool-output
 * region wins over the first content region — filtered through the
 * adapter's injection provenance: only regions `isInjectableRegion`
 * marks may receive the prefix, so a content region derived from a
 * step-start/snapshot/file part is skipped in favor of a later
 * text-derived one, and thinking / tool-input regions never qualify.
 *
 * @param msg - The lens message backing the original item.
 * @returns The injection target, or undefined when no region qualifies.
 */
function pickInjectableRegion(msg: HostMessage): WritableRegion | undefined {
  const regions = msg.regions;
  for (const region of regions) {
    if (region.kind === "tool-output" && isInjectableRegion(region)) {
      return region as WritableRegion;
    }
  }
  for (const region of regions) {
    if (region.kind === "content" && isInjectableRegion(region)) {
      return region as WritableRegion;
    }
  }
  return undefined;
}

/**
 * Write the current round's line-number prefix into an original
 * message's injection region.
 *
 * Pure prepend: `refPrefix(line)` is placed before the region text as
 * it stands, with no marker stripping.  The input carries no prior-round
 * markers — hosts deliver a fresh per-turn message array, so the render
 * output is never seen as input again.  Messages without an injectable
 * region keep their text unchanged.
 *
 * @param msg - The lens message backing the original item.
 * @param line - The dense line number of the item.
 */
function injectLinePrefix(msg: HostMessage, line: number): void {
  const region = pickInjectableRegion(msg);
  if (region === undefined) return;
  region.set(refPrefix(line) + region.get());
}

/**
 * Materialize a folded view into the v1 messages array in place.
 *
 * Walks the view items in order and rebuilds the array: original items
 * keep their v1 message object (content differences already landed via
 * the lens — this phase only restructures), summary items insert the
 * synthetic message of `materializeSummary` at the item's position
 * (the covered interval's messages are dropped with it), and every
 * visible item — original or summary — receives its per-round line
 * number.  Hidden original items stay in the view with raw text and no
 * prefix; they occupy no line.
 *
 * The input `entries` array is replaced in place (whole-array swap), so
 * callers holding the array reference observe the folded view.
 *
 * @param entries - The v1 messages array (mutated in place).
 * @param items - The folded view items, in view order.
 * @param state - The session state (block map, for summary ids).
 * @returns The mutated `entries` array.
 */
export function renderView(
  entries: ContextMessageEntry[],
  items: ViewItem[],
  state: SessionState,
): ContextMessageEntry[] {
  const lens = history(entries);
  const numbered = numberView(items, (ordinal) => lens[ordinal].hidden);
  const lineByItem = new Map<ViewItem, number>();
  for (const { n, item } of numbered) {
    lineByItem.set(item, n);
  }

  const out: ContextMessageEntry[] = [];
  for (const item of items) {
    if (item.type === "summary") {
      const id = blockIdOf(state, item.block.start, item.block.end);
      out.push(materializeSummary({ ...item.block, id }, lineByItem.get(item)));
      continue;
    }
    const msg = entries[item.ordinal];
    const line = lineByItem.get(item);
    if (line !== undefined) {
      injectLinePrefix(lens[item.ordinal], line);
    }
    out.push(msg);
  }
  entries.length = 0;
  entries.push(...out);
  return entries;
}

/**
 * Render a pruning round into the v1 messages array in place.
 *
 * Applies the region edits, then renders the folded view (see
 * `applyEdits` and `renderView` — this is their sequence in one call).
 *
 * @param entries - The v1 messages array (mutated in place).
 * @param items - The folded view items, in view order.
 * @param edits - Region text replacements, applied before the view
 *   render.
 * @param state - The session state (block map, for summary ids).
 * @returns The mutated `entries` array.
 */
export function render(
  entries: ContextMessageEntry[],
  items: ViewItem[],
  edits: RegionEdit[],
  state: SessionState,
): ContextMessageEntry[] {
  applyEdits(entries, edits);
  return renderView(entries, items, state);
}
