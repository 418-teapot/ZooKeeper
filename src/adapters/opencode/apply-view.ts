/**
 * V1 fold-view materialization — `applyView` + `materializeSummary`.
 *
 * `applyView` materializes a `fold` view into the v1 messages array in
 * place: original items keep their message object (text differences
 * already landed through the lens — this phase only restructures),
 * summary items insert a synthetic message at the item's position
 * (dropping the covered interval's messages with it), and every visible
 * item receives its per-round line-number prefix.  `fold` decides what
 * survives; this module renders the decision into the host structure.
 *
 * Line-number placement follows the P1.7 render semantics
 * (`numberView` / `refPrefix`): dense 1..N over the visible items,
 * hidden messages skipped (raw text, no number), summary items numbered
 * like any other.  Injection targets are filtered through the adapter's
 * provenance (`isInjectableRegion`) — only text-derived content and
 * tool-output regions may receive a prefix; thinking, tool-input, and
 * the estimation-only content derived from step-start/snapshot/file
 * parts never do.  Before each injection the region is stripped of
 * previously injected line-start `[mN] ` prefixes via
 * `canon.stripTags`, so a second pass over the same view is
 * idempotent.
 *
 * Summary messages (`materializeSummary`) are shape-equivalent to the
 * legacy `buildSyntheticMessage`: `info.role: "user"`, a placeholder
 * synthetic id, `info.synthetic: true`, and a single text part.  The
 * id is a placeholder only (spec D7) — block identity lives in the
 * `bN` label and the ordinal interval, never in the message id.  The
 * text is the new render label (`formatSummaryLabel`:
 * `[Block bN · K 条] 标题`) followed by the block's summary body; the
 * block-map id is attached by `applyView` so the label renders the
 * `bN` segment.
 *
 * `applyView` never writes message content itself — prune placeholders
 * and released marks reach the v1 parts through the lens `set()`
 * write-back before this phase runs.
 *
 * @module
 */

import { stripTags } from "../../core/context/canon.js";
import type {
  BlockSpan,
  HostMessage,
  TextRegion,
  ViewItem,
} from "../../core/context/lens.js";
import type { SessionState } from "../../core/context/state.js";
import {
  formatSummaryLabel,
  numberView,
  refPrefix,
} from "../../core/context/view-refs.js";
import { isInjectableRegion } from "./history.js";
import type { ContextMessageEntry } from "./types.js";

/**
 * Materialize a block's folded summary as a synthetic v1 message.
 *
 * Shape-equivalent to the legacy `buildSyntheticMessage`: a user-role
 * entry carrying `info.synthetic: true` and a single text part.  The
 * id is the block-derived placeholder `zoo-fold-bN` (same shape as the
 * legacy id) — it carries no addressing semantics (spec D7); the `bN`
 * label and the ordinal interval own block identity.
 *
 * The text is the render label (`formatSummaryLabel`:
 * `[Block bN · K 条] 标题`) followed by the block's summary body.  When
 * `lineNumber` is given, the `[mN] ` prefix is prepended to the first
 * line — summary items occupy a line like any other view item (P1.7).
 *
 * @param block - The surviving block span.  `applyView` attaches the
 *   block-map id so the label renders the `bN` segment; a bare `Block`
 *   without the id (assignable here) renders the label without it —
 *   the defensive path.
 * @param lineNumber - The per-round dense line number of the item, when
 *   visible.
 * @returns The synthetic summary message entry.
 */
export function materializeSummary(
  block: BlockSpan & { id?: number },
  lineNumber?: number,
): ContextMessageEntry {
  const label = formatSummaryLabel(block);
  const body = block.summary.length > 0 ? `\n${block.summary}` : "";
  const text =
    lineNumber === undefined
      ? `${label}${body}`
      : `${refPrefix(lineNumber)}${label}${body}`;
  return {
    info: {
      role: "user",
      id: `zoo-fold-b${block.id ?? 0}`,
      synthetic: true,
    },
    parts: [{ type: "text", text }],
  };
}

/**
 * Pick the region that receives the line-number prefix for an original
 * view item.
 *
 * Placement keeps the P1.7 three-branch priority — the first tool-output
 * region wins over the first content region — filtered through the
 * adapter's injection provenance: only regions `isInjectableRegion`
 * marks may receive the prefix, so a content region derived from a
 * step-start/snapshot/file part is skipped in favor of a later
 * text-derived one, and thinking / tool-input regions never qualify.
 *
 * @param msg - The lens message backing the original item.
 * @returns The injection target, or undefined when no region qualifies.
 */
function pickInjectableRegion(msg: HostMessage): TextRegion | undefined {
  const regions = msg.regions;
  for (const region of regions) {
    if (region.kind === "tool-output" && isInjectableRegion(region)) {
      return region;
    }
  }
  for (const region of regions) {
    if (region.kind === "content" && isInjectableRegion(region)) {
      return region;
    }
  }
  return undefined;
}

/**
 * Look up the block-map id for a fold summary item's span.
 *
 * A `ViewItem` summary carries a `BlockSpan` without its map key; the
 * id is the state map key (`bN`).  A surviving block always matches by
 * interval; a defensively merged summary item references its
 * first-appearing block, which matches the same way.  Returns undefined
 * when nothing matches — the label then renders without the id segment.
 *
 * @param state - The session state (blocks map).
 * @param start - First covered ordinal of the summary item.
 * @param end - Last covered ordinal (exclusive).
 * @returns The block-map id, or undefined.
 */
function blockIdOf(
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
 * Strip previously injected markers, then write the current round's
 * line-number prefix into an original message's injection region.
 *
 * Strip→inject per round: the region is stripped through
 * `canon.stripTags` — removing any previously injected line-start
 * `[mN] ` prefixes — before the prefix is prepended, so a second
 * pass over the same view is idempotent.  Messages without an
 * injectable region keep their text unchanged.
 *
 * @param msg - The lens message backing the original item.
 * @param line - The dense line number of the item.
 */
function injectLinePrefix(msg: HostMessage, line: number): void {
  const region = pickInjectableRegion(msg);
  if (region === undefined) return;
  region.set(refPrefix(line) + stripTags(region.get()));
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
 * prefix (P1.7 hidden semantics); they occupy no line.
 *
 * The input `messages` array is replaced in place (whole-array
 * swap), so callers holding the array reference observe the folded
 * view.
 *
 * **Precondition:** `history` is the lens mapping of `messages` (the
 * opencode adapter's `history`), so ordinals align 1:1 and region
 * write-back reaches the v1 parts.
 *
 * @param messages - The v1 messages array (mutated in place).
 * @param history - The lens transcript mapping `messages`.
 * @param items - The folded view items, in view order.
 * @param state - The session state (block map, for summary ids).
 */
export function applyView(
  messages: ContextMessageEntry[],
  history: HostMessage[],
  items: ViewItem[],
  state: SessionState,
): void {
  const numbered = numberView(items, (ordinal) => history[ordinal].hidden);
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
    const msg = messages[item.ordinal];
    const line = lineByItem.get(item);
    if (line !== undefined) {
      injectLinePrefix(history[item.ordinal], line);
    }
    out.push(msg);
  }
  messages.length = 0;
  messages.push(...out);
}
