/**
 * New-core state → v1 projection helpers.
 *
 * The `/dcp` command and the TUI sidebar both consume v1-shaped inputs
 * (message arrays with `{info, parts}` entries) while holding the new
 * core's session state and `ViewItem` fold output.  These two
 * projections bridge the shapes:
 *
 * - `foldedV1Messages` — materialize the folded view as a v1 message
 *   array (summary items rendered through `materializeSummary`, original
 *   items kept verbatim), or `undefined` when nothing was folded.
 * - `effectiveCallIds` — map every effective prune mark back to its v1
 *   tool part's call id, or `undefined` when no effective mark exists.
 *
 * Both live in the v1 adapter layer because they know the v1 message
 * shape AND the new core's state/view shapes; the consumers stay
 * framework-agnostic and share this single copy.
 *
 * @module
 */

import type { ViewItem } from "../../core/context/lens.js";
import type { SessionState } from "../../core/context/state.js";
import { materializeSummary } from "./apply-view.js";
import { type ContextMessageEntry, getCallId } from "./types.js";

/**
 * Look up the block-map id matching a folded summary item's interval.
 *
 * A `ViewItem` summary carries a `BlockSpan` without its map key; the
 * id is the state block-map key (`bN`).  A surviving block always
 * matches by interval; a defensively merged summary item references its
 * first-appearing block.  Returns undefined when nothing matches.
 *
 * @param state - The session state (blocks map).
 * @param start - First covered ordinal of the summary item.
 * @param end - Last covered ordinal (exclusive).
 * @returns The block-map id, or undefined.
 */
export function blockIdOf(
  state: SessionState,
  start: number,
  end: number,
): number | undefined {
  for (const [id, block] of state.blocks) {
    if (block.start === start && block.end === end) return id;
  }
  return undefined;
}

/**
 * Project the folded view items back to a v1 message array.
 *
 * The report's dual-scope message count ("模型可见 vs 存储") needs the
 * model-visible view as a v1 array; `fold` produces `ViewItem`s, so
 * summary items are materialized with the same synthetic shape the v1
 * adapter renders (`materializeSummary`), while original items keep
 * their backing v1 messages.  Returns undefined when no block survives
 * the fold — the view equals storage then.
 *
 * @param items - The folded view items, in view order.
 * @param messages - The v1 messages aligned 1:1 with the lens transcript.
 * @param state - The session state (block map, for summary ids).
 * @returns The folded v1 view, or undefined when nothing was folded.
 */
export function foldedV1Messages(
  items: ViewItem[],
  messages: ContextMessageEntry[],
  state: SessionState,
): ContextMessageEntry[] | undefined {
  let hasSummary = false;
  const folded: ContextMessageEntry[] = [];
  for (const item of items) {
    if (item.type === "summary") {
      hasSummary = true;
      folded.push(
        materializeSummary({
          ...item.block,
          id: blockIdOf(state, item.block.start, item.block.end),
        }),
      );
    } else {
      folded.push(messages[item.ordinal]);
    }
  }
  return hasSummary ? folded : undefined;
}

/**
 * Map every effective mark back to its v1 tool part's call id.
 *
 * The report's pruned-tool accounting keys off v1 call ids
 * (`computeContextReport`'s `prunedCallIDs`), while new-core marks are
 * keyed by `(ordinal, regionIndex)`.  The lens region layout is
 * deterministic per part — a tool part with state contributes exactly a
 * tool-input then a tool-output region, a text part contributes one
 * content region — so each effective mark's region index resolves back
 * to its v1 part and call id.
 *
 * @param messages - The v1 session messages (ordinals align with `history`).
 * @param state - The session state holding the mark map.
 * @returns The effective call ids, or undefined when none exist.
 */
export function effectiveCallIds(
  messages: ContextMessageEntry[],
  state: SessionState,
): Set<string> | undefined {
  const ids = new Set<string>();
  for (const mark of state.marks.values()) {
    if (!mark.effective) continue;
    const msg = messages[mark.anchorOrdinal];
    if (!msg?.parts) continue;
    let regionIdx = 0;
    for (const part of msg.parts) {
      if (!part) continue;
      const toolPart = part as {
        type: string;
        state?: unknown;
        text?: unknown;
      };
      if (toolPart.type === "tool" && toolPart.state) {
        const outputIdx = regionIdx + 1;
        regionIdx += 2;
        if (outputIdx === mark.regionIndex) {
          const cid = getCallId(toolPart);
          if (cid) ids.add(cid);
        }
      } else if (typeof toolPart.text === "string") {
        regionIdx += 1;
      }
    }
  }
  return ids.size > 0 ? ids : undefined;
}
