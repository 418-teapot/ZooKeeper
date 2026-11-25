/**
 * `/view` page formatting.
 *
 * The page shows the messages the context transform will send in the
 * current round: one complete logical line per `mN`, carrying the line's
 * token estimate, its role, the ref and a single-line preview.  Rows align
 * on the page's widest token, role and ref, so every `│` separator and
 * every body starts in one column; the client truncates these lines to the
 * width it currently shows and never re-flows the columns.
 *
 * The preview is read from the rendered conversation, not from the
 * pre-render transcript: a tool call shows its name and arguments, a tool
 * result shows its text, and a folded block shows the summary text the
 * model reads (including the block label).  Content and tool segments come
 * first and thinking comes last, so a long reasoning trace never hides the
 * tool call behind it; thinking is the preview only when a line carries
 * nothing else.  The ref the render injected is dropped from the preview
 * because the ref column carries it: the page locates that ref through the
 * round's render plan, so text that merely looks like a line ref — a
 * tool result starting with `[m7] `, a thinking trace, an appended
 * reminder — keeps its own characters exactly as the model reads them.
 *
 * Token accounting reuses the existing estimators: an original row sums
 * `estimateMessageHeuristic` over its unit interval (the same sum the nudge
 * window takes), while a summary row and a message the transform appended
 * after rendering measure their own text with the same estimator.  Only
 * whitespace runs collapse in a preview, so no content is lost before the
 * client decides how much to show.
 *
 * @module
 */

import type {
  HostMessage,
  Projection,
  RenderEntry,
  TextRegion,
  ViewItem,
} from "./lens.js";
import { invocationForRegion } from "./lens.js";
import { estimateMessageHeuristic, estimateTokenCount } from "./measure.js";
import type { RoundPreview } from "./pipeline.js";
import { planEntryCount } from "./render-plan.js";
import type { NumberedItem } from "./view-refs.js";
import { itemInterval, refPrefix } from "./view-refs.js";
import { pickInjectableRegion } from "./writable-regions.js";

/** Shown in place of an empty preview. */
const EMPTY_PREVIEW = "（无内容）";

/** Shown when the session holds no message to preview. */
const NO_MESSAGES_HINT = "当前会话还没有可显示的消息。";

/** Shown when the round carries no visible line. */
const EMPTY_VIEW_HINT = "当轮上下文视图没有可显示的行。";

/** One page row, before the page-wide column widths apply. */
interface PageRow {
  /** The line's ref, with its trailing separator space; empty when the
   * message carries none. */
  ref: string;
  /** The line's token estimate. */
  tokens: number;
  /** The line's role label (role plus colon, or the summary pseudo-role). */
  role: string;
  /** The line's single-line preview. */
  preview: string;
}

/** The readable text of one row, split by how it is shown. */
interface RowText {
  /** The unit's first visible role. */
  role: string;
  /** Content and tool segments, in view order. */
  body: string[];
  /** Thinking segments, used only when the row carries no body. */
  thinking: string[];
}

/**
 * Collapse every whitespace run into one space.
 *
 * @param text - The raw preview text.
 * @returns The single-line preview, trimmed.
 */
function singleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Find the region that received the plan's line ref.
 *
 * The placement rule that chose the region during materialization
 * (`pickInjectableRegion`) names it again on the rendered projection.  A
 * region that does not carry the injected prefix yields undefined, so no
 * other text is ever touched.
 *
 * @param message - The rendered message the plan injected into.
 * @param prefix - The `[mN] ` prefix the plan injected.
 * @returns The injected region, or undefined.
 */
function injectedRegion(
  message: HostMessage,
  prefix: string,
): TextRegion | undefined {
  const region = pickInjectableRegion(message);
  return region?.get().startsWith(prefix) === true ? region : undefined;
}

/**
 * Record the line refs the round's plan injected, by rendered index.
 *
 * A source entry carries the ref its message received; a summary entry
 * carries the ref in front of its own text, at the item's line.  An entry
 * without a ref injected nothing and records nothing.
 *
 * @param plan - The round's render plan, in view order.
 * @param start - First rendered index of the item (inclusive).
 * @param end - Last rendered index of the item (exclusive).
 * @param line - The item's line number.
 * @param prefixes - Output map: rendered index to the injected prefix.
 */
function collectPrefixes(
  plan: readonly RenderEntry[],
  start: number,
  end: number,
  line: number,
  prefixes: Map<number, string>,
): void {
  for (let index = start; index < end; index++) {
    const entry = plan[index];
    if (entry === undefined) continue;
    const injected = entry.kind === "source" ? entry.line : line;
    if (injected === undefined) continue;
    prefixes.set(index, refPrefix(injected));
  }
}

/**
 * Read the text of one rendered message range.
 *
 * Hidden messages are skipped: the host excludes them from the model view,
 * so they hold neither a role nor a segment.  A tool call is labelled with
 * the name the invocation table paired it with; a call the adapter could
 * not pair keeps a plain label.  The one region the plan injected a line
 * ref into drops that exact prefix — and nothing else, so the region's own
 * leading text stays verbatim.
 *
 * @param rendered - The projection of the rendered conversation.
 * @param prefixes - The `[mN] ` prefixes the plan injected, by rendered
 *   index.
 * @param start - First rendered message index (inclusive).
 * @param end - Last rendered message index (exclusive).
 * @returns The row's role and its segments.
 */
function rowText(
  rendered: Projection,
  prefixes: ReadonlyMap<number, string>,
  start: number,
  end: number,
): RowText {
  let role = "";
  const body: string[] = [];
  const thinking: string[] = [];
  for (let index = start; index < end; index++) {
    const message = rendered.messages[index];
    if (message === undefined || message.hidden) continue;
    if (role === "") role = message.role;
    const prefix = prefixes.get(index);
    const injected =
      prefix === undefined ? undefined : injectedRegion(message, prefix);
    for (
      let regionIndex = 0;
      regionIndex < message.regions.length;
      regionIndex++
    ) {
      const region = message.regions[regionIndex];
      if (region === undefined) continue;
      const raw = region.get();
      const text =
        prefix !== undefined && region === injected
          ? raw.slice(prefix.length)
          : raw;
      if (text.trim() === "") continue;
      if (region.kind === "thinking") {
        thinking.push(text);
        continue;
      }
      if (region.kind === "tool-input") {
        const name = invocationForRegion(rendered, index, regionIndex)?.name;
        body.push(
          name === undefined ? `[tool] ${text}` : `[tool ${name}] ${text}`,
        );
        continue;
      }
      if (region.kind === "tool-output") {
        body.push(`[result] ${text}`);
        continue;
      }
      body.push(text);
    }
  }
  return { role, body, thinking };
}

/**
 * Pick the segments a row shows.
 *
 * @param text - The row's readable text.
 * @returns The segments, body first and thinking only as a fallback.
 */
function previewSegments(text: RowText): string[] {
  return text.body.length > 0 ? text.body : text.thinking;
}

/**
 * Build the row of one numbered view item.
 *
 * @param round - The round the item belongs to.
 * @param view - The numbered item (its ref and its interval).
 * @param start - First rendered message index of the item (inclusive).
 * @param prefixes - The `[mN] ` prefixes the plan injected, by rendered
 *   index.
 * @returns The row's fields.
 */
function itemRow(
  round: RoundPreview,
  view: NumberedItem,
  start: number,
  prefixes: ReadonlyMap<number, string>,
): PageRow {
  const { item } = view;
  const interval = itemInterval(item);
  const text = rowText(
    round.rendered,
    prefixes,
    start,
    start + planEntryCount(item),
  );
  const segments = previewSegments(text);
  return {
    ref: refPrefix(view.n),
    tokens:
      item.type === "summary"
        ? estimateTokenCount(segments.join("\n"))
        : sumTokens(round.lens, interval.start, interval.end),
    role: item.type === "summary" ? "summary:" : `${text.role}:`,
    preview: singleLine(segments.join(" ")),
  };
}

/**
 * Sum the token estimate of the lens messages in one interval.
 *
 * @param lens - The pre-render transcript.
 * @param start - First ordinal (inclusive).
 * @param end - Last ordinal (exclusive).
 * @returns The interval's token estimate.
 */
function sumTokens(
  lens: readonly HostMessage[],
  start: number,
  end: number,
): number {
  let tokens = 0;
  for (let ordinal = start; ordinal < end; ordinal++) {
    const message = lens[ordinal];
    if (message === undefined) continue;
    tokens += estimateMessageHeuristic(message);
  }
  return tokens;
}

/**
 * Build the row of one message the transform appended after rendering.
 *
 * The context nudge is appended at the end and carries no line ref, so its
 * row keeps the ref column empty instead of inventing a number.
 *
 * @param rendered - The projection of the rendered conversation.
 * @param prefixes - The `[mN] ` prefixes the plan injected, by rendered
 *   index.
 * @param index - The message's index in the rendered conversation.
 * @returns The row's fields.
 */
function appendedRow(
  rendered: Projection,
  prefixes: ReadonlyMap<number, string>,
  index: number,
): PageRow {
  const text = rowText(rendered, prefixes, index, index + 1);
  const message = rendered.messages[index];
  return {
    ref: "",
    tokens: message === undefined ? 0 : estimateMessageHeuristic(message),
    role: `${text.role}:`,
    preview: singleLine(previewSegments(text).join(" ")),
  };
}

/**
 * Build every row of the page, in view order.
 *
 * The plan renders one message per covered unit member and one per folded
 * block, so a plan entry's index is its rendered message index: the page
 * walks the rendered conversation in step with the view items (each item
 * owns `planEntryCount(item)` messages) and reads the refs the plan
 * injected from the same position.  A hidden unit keeps its messages in
 * the conversation but occupies no row.
 *
 * @param round - The round to show.
 * @returns The rows, in view order.
 */
function buildRows(round: RoundPreview): PageRow[] {
  const lineByItem = new Map<ViewItem, number>();
  for (const { n, item } of round.numbered) lineByItem.set(item, n);

  const prefixes = new Map<number, string>();
  const rows: PageRow[] = [];
  let cursor = 0;
  for (const item of round.items) {
    const start = cursor;
    cursor += planEntryCount(item);
    const n = lineByItem.get(item);
    if (n === undefined) continue;
    collectPrefixes(round.plan, start, cursor, n, prefixes);
    rows.push(itemRow(round, { n, item }, start, prefixes));
  }
  while (cursor < round.rendered.messages.length) {
    rows.push(appendedRow(round.rendered, prefixes, cursor));
    cursor += 1;
  }
  return rows;
}

/**
 * Format one round's transform view as the `/view` page.
 *
 * Returns one complete logical line per visible `mN`, aligned over the
 * whole page, plus one line for each message the transform appended after
 * rendering.  A session with no message to preview, or a round whose view
 * carries no visible line, gets a single hint line instead — an empty page
 * is never presented as a successful view.
 *
 * @param round - The round's preview, or undefined when the session holds
 *   no message.
 * @returns The page's logical lines.
 */
export function formatViewPage(round: RoundPreview | undefined): string[] {
  if (round === undefined) return [NO_MESSAGES_HINT];
  const rows = buildRows(round);
  if (rows.length === 0) return [EMPTY_VIEW_HINT];

  const tokenWidth = Math.max(...rows.map((row) => String(row.tokens).length));
  const roleWidth = Math.max(...rows.map((row) => row.role.length));
  const refWidth = Math.max(...rows.map((row) => row.ref.length));

  return rows.map(
    (row) =>
      `${String(row.tokens).padStart(tokenWidth)} tokens  ` +
      `${row.role.padEnd(roleWidth)} │ ` +
      `${row.ref.padEnd(refWidth)}` +
      `${row.preview === "" ? EMPTY_PREVIEW : row.preview}`,
  );
}
