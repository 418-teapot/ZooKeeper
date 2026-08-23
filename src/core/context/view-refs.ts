/**
 * View-as-address-space render layer.
 *
 * The folded view is the address space the LLM addresses in this round:
 * every view item — an original transcript message or a folded block
 * summary — carries a dense line number injected at line start
 * (`[m1] `, `[m2] `, …).  Numbers are derived from the view alone on
 * every round: no registry, no allocation, no persistence, so a restart
 * re-derives identical numbers from the same fold output without any
 * reconciliation.
 *
 * Three identity layers stay distinct (spec Decision 7): block identity
 * `bN` (persistent, owned by the block map), internal identity = the
 * ordinal interval + span hash (persistent), and the view line number
 * (transient, valid for the current round only).
 *
 * The module renders but never materializes: original items receive
 * their prefix through the lens; summary messages are the adapter's job
 * (`src/adapters/opencode/render.ts`), and their first line is composed
 * as `refPrefix(n) + formatSummaryLabel(block)` followed by the summary
 * text.
 *
 * Hidden messages (spec Decision 3) occupy an ordinal but are skipped by
 * numbering and injection: they stay visible in the view with their raw
 * text and no line number, so the visible numbering stays dense 1..N.
 *
 * @module
 */

import type { BlockSpan, ViewItem } from "./lens.js";

/**
 * A view item paired with its dense line number.
 *
 * The line number is the per-round address of the item: visible original
 * items and summary items both occupy a line; items absent from the
 * view (messages consumed by a swallowing block) and hidden original
 * messages occupy none.
 */
export interface NumberedItem {
  /** Dense line number, 1-based, unique within the round. */
  n: number;
  /** The addressed view item. */
  item: ViewItem;
}

/**
 * Result of resolving a line-number ref against the current view.
 *
 * The `error` variant carries a user-facing Chinese message naming the
 * failure and the valid addressing range — the material the phase-two
 * adapter logs for hallucinated refs.
 */
export type ResolvedEndpoint =
  | { start: number; end: number }
  | { error: string };

/**
 * Number the view items densely 1..N over the visible items.
 *
 * Stateless and deterministic: the same items and hidden predicate
 * always produce the same numbering, and independent calls agree — the
 * property that makes line numbers naturally reproducible across a
 * restart.  An original item whose message is hidden is skipped: it
 * stays in the view (raw text, no marker) but occupies no line, so the
 * numbering has no holes.  Summary items always occupy a line — the
 * folded block covers its interval wholesale, hidden members inside do
 * not matter.
 *
 * @param items - The folded view items, in view order.
 * @param isHidden - Reports whether the message at an ordinal is hidden
 *   (skipped by numbering and injection).
 * @returns The visible items with their 1-based line numbers.
 */
export function numberView(
  items: ViewItem[],
  isHidden: (ordinal: number) => boolean,
): NumberedItem[] {
  const numbered: NumberedItem[] = [];
  for (const item of items) {
    if (item.type === "original" && isHidden(item.ordinal)) continue;
    numbered.push({ n: numbered.length + 1, item });
  }
  return numbered;
}

/**
 * Line-start ref pattern matching a rendered line-number marker: `[mN] `
 * — natural integer, no zero padding, trailing space included.  Matches
 * only an exact line start; bare refs in prose are not matched.
 */
export const LINE_START_REF_PREFIX = /^\[m\d+\] /;

/**
 * Build the line-number prefix `[mN] `.
 *
 * Natural integer, no zero padding, trailing space included, no
 * newline — a marker plus a space (line-number mental model, token
 * cheap), not a heading.
 *
 * @param n - The 1-based line number.
 * @returns The prefix string.
 */
export function refPrefix(n: number): string {
  return `[m${n}] `;
}

/**
 * Render the label of a folded block summary item.
 *
 * Format: `[Block bN · K 条] 标题` where K is the covered message count
 * (`end - start`) — the count is shown because it never expires, the
 * interval line numbers are not, because line numbers are valid only
 * for the current round.  A missing or empty title degrades the label
 * to `[Block bN · K 条]`; a missing block id (defensive) omits the id
 * segment.
 *
 * @param block - The block span plus its persistent block id.
 * @returns The label line.
 */
export function formatSummaryLabel(block: BlockSpan & { id?: number }): string {
  const count = block.end - block.start;
  const idPart = block.id === undefined ? "" : `b${block.id} · `;
  const header = `[Block ${idPart}${count} 条]`;
  const title =
    block.title === undefined || block.title === "" ? undefined : block.title;
  return title === undefined ? header : `${header} ${title}`;
}

/**
 * Parse a line-number ref in either accepted spelling.
 *
 * Both `"m3"` and `"[m3]"` resolve to line 3.  Any other shape (e.g.
 * `"m3]"`, `"[m3"`, `"3"`) is not an mN form and returns null.
 *
 * @param ref - The ref text to parse.
 * @returns The line number, or null when the ref is not an mN form.
 */
function parseLineNumber(ref: string): number | null {
  const bare =
    ref.startsWith("[") && ref.endsWith("]") ? ref.slice(1, -1) : ref;
  const match = /^m(\d+)$/.exec(bare);
  return match === null ? null : Number(match[1]);
}

/**
 * Resolve a line-number ref to its ordinal interval in the view.
 *
 * A ref addressing an original item maps to `[ordinal, ordinal + 1)`; a
 * ref addressing a summary item maps to the block's full interval, so
 * referencing a summary as an endpoint covers the whole block.  A line
 * outside the round (a hallucinated ref) errors with the valid range; a
 * ref that is not an mN form errors naming the expected format.
 *
 * Hidden items carry no line number and therefore cannot be addressed —
 * a ref beyond the visible range (which would have landed on a hidden
 * item's position) falls into the existing out-of-view error, so no
 * hidden-specific error path exists.
 *
 * @param ref - The ref text (`"m3"` or `"[m3]"`).
 * @param items - The numbered view items of the current round.
 * @returns The resolved interval, or an actionable error.
 */
export function resolveEndpoint(
  ref: string,
  items: NumberedItem[],
): ResolvedEndpoint {
  const line = parseLineNumber(ref);
  if (line === null) {
    return {
      error:
        `无法解析行号 "${ref}"：行号格式应为 mN 或 [mN]` +
        `（如 m3 或 [m3]，N 为当轮视图行号）`,
    };
  }
  const target = items.find((item) => item.n === line);
  if (target === undefined) {
    return {
      error:
        items.length === 0
          ? `行号 m${line} 不存在：当轮视图共 0 行，无有效行号`
          : `行号 m${line} 不存在：当轮视图共 ${items.length} 行，` +
            `有效 m1..m${items.length}`,
    };
  }
  if (target.item.type === "original") {
    const ordinal = target.item.ordinal;
    return { start: ordinal, end: ordinal + 1 };
  }
  return {
    start: target.item.block.start,
    end: target.item.block.end,
  };
}

/**
 * Resolve two line-number refs into a single interval.
 *
 * The two endpoints are resolved independently and combined as
 * `start = from.start` and `end = max(from.end, to.end)` — a valid range
 * requires the from endpoint to appear at or before the to endpoint
 * (`from.start <= to.start`).  A reversed ordering (the from ref points
 * at a later view item than the to ref) is rejected with an order error
 * naming both line numbers: refs are addresses, not sequence numbers, so
 * the model must pick the earlier ref as the start.  A right endpoint
 * landing on a summary item covers the whole block via `resolveEndpoint`.
 *
 * @param fromRef - The start endpoint ref.
 * @param toRef - The end endpoint ref.
 * @param items - The numbered view items of the current round.
 * @returns The combined interval, or the first endpoint error.
 */
export function resolveRange(
  fromRef: string,
  toRef: string,
  items: NumberedItem[],
): ResolvedEndpoint {
  const from = resolveEndpoint(fromRef, items);
  if ("error" in from) return from;
  const to = resolveEndpoint(toRef, items);
  if ("error" in to) return to;
  if (from.start > to.start) {
    return {
      error:
        `范围起点与终点顺序颠倒（起点行号 m${parseLineNumber(fromRef)} 位于终点` +
        `行号 m${parseLineNumber(toRef)} 之后）。ref 是地址而非序号——请选择位置更早的` +
        ` ref 作为起点、位置更晚的 ref 作为终点。`,
    };
  }
  return {
    start: from.start,
    end: Math.max(from.end, to.end),
  };
}
