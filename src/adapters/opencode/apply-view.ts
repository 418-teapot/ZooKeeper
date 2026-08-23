/**
 * V1 synthetic summary message — `materializeSummary`.
 *
 * Renders a fold summary item into the v1 messages shape: a user-role
 * entry carrying `info.synthetic: true` and a single text part.  The
 * text is the render label (`formatSummaryLabel`:
 * `[Block bN · K 条] 标题`) followed by the block's summary body, with
 * the per-round `[mN] ` line prefix prepended to the first line when a
 * line number is given.
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
import { formatSummaryLabel, refPrefix } from "../../core/context/view-refs.js";
import type { ContextMessageEntry } from "./types.js";

/**
 * Materialize a block's folded summary as a synthetic v1 message.
 *
 * A user-role entry carrying `info.synthetic: true` and a single text
 * part.  The id is the block-derived placeholder `zoo-fold-bN` (same
 * shape as the legacy id) — it carries no addressing semantics (spec
 * D7); the `bN` label and the ordinal interval own block identity.
 *
 * The text is the render label (`formatSummaryLabel`:
 * `[Block bN · K 条] 标题`) followed by the block's summary body.  When
 * `lineNumber` is given, the `[mN] ` prefix is prepended to the first
 * line — summary items occupy a line like any other view item (P1.7).
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
