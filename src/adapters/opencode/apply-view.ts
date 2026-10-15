/**
 * V1 synthetic summary message — `materializeSummary`.
 *
 * Renders a fold summary item into the v1 messages shape: a user-role
 * entry carrying `info.synthetic: true` and a single text part.  The
 * text comes from the core render layer (`formatSummaryText`: the
 * `[Block bN · K 条] 标题` label, an optional leading `[mN] ` line
 * prefix, and the block's summary body); this module only wraps that
 * text into a v1 entry.
 *
 * Full fold-view materialization (original items, line-prefix injection,
 * in-place array restructure) lives in `src/adapters/opencode/render.ts`;
 * this module provides only the synthetic message builder shared by that
 * renderer and the projection helpers (`src/adapters/opencode/
 * projection.ts`).
 *
 * @module
 */

import type { BlockSpan } from "../../core/context/lens.js";
import { formatSummaryText } from "../../core/context/view-refs.js";
import type { ContextMessageEntry } from "./types.js";

/**
 * Materialize a block's folded summary as a synthetic v1 message.
 *
 * A user-role entry carrying `info.synthetic: true` and a single text
 * part.  The id is the block-derived placeholder `zoo-fold-bN` — it
 * carries no addressing semantics; the `bN` label and the ordinal
 * interval own block identity.
 *
 * The text comes from `formatSummaryText` (label, optional `[mN] `
 * prefix, summary body) — summary items occupy a line like any other
 * view item.
 *
 * @param block - The surviving block span.  The caller attaches the
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
  const text = formatSummaryText(block, lineNumber);
  return {
    info: {
      role: "user",
      id: `zoo-fold-b${block.id ?? 0}`,
      synthetic: true,
    },
    parts: [{ type: "text", text }],
  };
}
