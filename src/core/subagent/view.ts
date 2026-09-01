/**
 * Subagent transcript view model — host-agnostic card layout for the pi TUI.
 *
 * Pure functions only: given a structured `SubagentProgress` snapshot and
 * the delegation label, they derive the display lines for the live tool
 * card (collapsed or expanded).  Every line carries a *semantic hue*
 * (`running` / `success` / `error` / `muted` / `accent`) — core never
 * knows pi's concrete theme colors.  The pi adapter owns the one-place
 * mapping from hue to a real `theme.fg` color name (`src/adapters/pi/tui/theme.ts`),
 * so this module stays importable and unit-testable in any TS runtime.
 *
 * The layout mirrors the visual contract:
 *   - running: the title is owned by the tool-call card (`renderCall` in
 *     the pi adapter); the running body only carries the current-tool line,
 *     the recent tool lines, recent output lines, and a stats line
 *     (`⟳ N turns · M tools · T`).  The spinner frame advances with each
 *     render.
 *   - done ok: `✓ subagent(<name>)` success-hued title (badged with the
 *     run statistics) plus the final text summary; error / abort render
 *     their own marker and reason.  The recent tool list is not repeated —
 *     the statistics badge already summarizes the run's tools.
 *   - expanded (pi's ctrl+o) shows more recent tools and output lines.
 *
 * The fleet-widget functions (`renderFleetCollapsed` / `renderFleetRows`)
 * derive the pi `zoo` widget lines from the run registry (`registry.ts`):
 * a single-line collapsed summary (status carried purely by color, no
 * ✓/✗ text) and the expanded scrolling row list with nested child runs.
 *
 * @module
 */

import { homedir } from "node:os";
import type { SubagentProgress } from "./driver.js";
import type { RunSummary, SubagentRun } from "./registry.js";

/**
 * Humanize a token count for the stats line.
 *
 * Follows the compact thousand-abbreviation convention (`12.4k`, `1.0k`,
 * `999`): below 1000 the bare number, at or above 1000 a one-decimal `k`
 * suffix (rounded up to whole `k` past 999.9k).  The lowercase `k` matches
 * the agreed visual contract (`· 12.4k tok`).
 *
 * @param n - The token count.
 * @returns The formatted token string.
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const val = n / 1000;
  if (val >= 1000) return `${Math.round(val)}k`;
  return `${val.toFixed(1)}k`;
}

/** The canonical ten-frame braille spinner. */
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/** Semantic hues a display line can carry. */
export type CardHue = "running" | "success" | "error" | "muted" | "accent";

/** One colorizable segment of a display line. */
export interface CardSegment {
  /** The segment text (may embed its own ANSI color sequences). */
  text: string;
  /** The segment's semantic hue — absent means default color (unwrapped). */
  hue?: CardHue;
}

/** One display line: the text plus its semantic hue. */
export interface CardLine {
  /** The flat, concatenated line text (rendered verbatim by the card). */
  text: string;
  /**
   * The line's dominant semantic hue.
   *
   * For a line that also carries `segments`, the adapter uses the per-segment
   * hues instead of wrapping the whole line — see `segments`.
   */
  hue: CardHue;
  /**
   * Optional per-segment hues for lines composed of independently colorized
   * parts (the fleet-widget lines).
   *
   * The segments' `text`s concatenate to exactly `text` (backward compatible:
   * a consumer that only reads `text` renders the same content).  A segment
   * with no `hue` is not wrapped by the adapter at all, so a pre-colorized
   * segment (e.g. the primary agent name carrying its own embedded ANSI
   * sequence) keeps its own colors instead of being washed out by an outer
   * wrap.
   */
  segments?: CardSegment[];
  /**
   * Whether the line should be rendered as Markdown by the pi adapter.
   *
   * Pure data — core never imports pi.  The pi TUI card (`card.ts`) renders
   * markdown-flagged lines with pi-tui's `Markdown` component; all other
   * lines render as plain `Text`.  Only the terminal final-output line is
   * flagged.
   */
  markdown?: boolean;
  /**
   * Whether the pi adapter should truncate this single-line preview to the
   * terminal width at render time.
   *
   * Width is a render-boundary concern that host-agnostic core cannot know,
   * so core only flags the line; the adapter (`card.ts`) applies its
   * width-aware truncation with pi's own `truncateToWidth` semantics.  The
   * flag implies a plain, single-line preview (never markdown): the
   * collapsed terminal card shows the first non-empty line of the final
   * text, truncated to fit the viewport.
   */
  truncateToWidth?: boolean;
}

/** Recent tool-call entries rendered by the card. */
export interface ToolCallLine {
  name: string;
  summary: string;
}

/** Recent output lines rendered by the card. */
export interface OutputLine {
  text: string;
}

/** Recent tool-call entries rendered when collapsed. */
const COLLAPSED_TOOL_CAP = 3;

/** Recent tool-call entries rendered when expanded. */
const EXPANDED_TOOL_CAP = 15;

/** Recent output lines rendered when collapsed. */
const COLLAPSED_OUTPUT_CAP = 3;

/** Recent output lines rendered when expanded. */
const EXPANDED_OUTPUT_CAP = 15;

export { COLLAPSED_TOOL_CAP, EXPANDED_TOOL_CAP };

/**
 * Format a whole-second duration as `MM:SS`.
 *
 * @param seconds - The non-negative duration in seconds.
 * @returns The `MM:SS` duration string.
 */
function formatSeconds(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Format the elapsed time of a run from its start timestamp.
 *
 * @param startedAt - Epoch-millis start time (0 means unknown).
 * @param now - The current epoch-millis time (injected for determinism).
 * @returns A compact `MM:SS` duration, or `-:--` when unknown.
 */
export function formatElapsed(
  startedAt: number,
  now: number = Date.now(),
): string {
  if (!startedAt || startedAt <= 0) return "-:--";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return formatSeconds(seconds);
}

/**
 * Compute the display index of the current spinner frame.
 *
 * @param seq - A monotonically increasing sequence counter.
 * @returns The frame index into `SPINNER_FRAMES`.
 */
export function spinnerFrameIndex(seq: number): number {
  return (
    ((Math.max(0, seq) % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) %
    SPINNER_FRAMES.length
  );
}

/**
 * Cap a string to a maximum width with an ellipsis marker.
 *
 * @param text - The string to cap.
 * @param limit - The maximum length.
 * @returns The capped string.
 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const keep = Math.max(1, limit - 1);
  return `${text.slice(0, keep)}…`;
}

/**
 * The first non-empty line of a block of text.
 *
 * Skips any leading lines that are empty or contain only whitespace, so a
 * collapsed preview never starts with blank space.  The returned line has
 * its leading and trailing whitespace trimmed (matching the pi-subagents
 * fold, which trims the block before taking its first line).  Returns
 * `undefined` when the block has no non-whitespace content.
 *
 * @param text - The multi-line text block.
 * @returns The first non-empty line, or `undefined`.
 */
function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * Build the current-tool line.
 *
 * @param tool - The running tool name.
 * @returns The line, or `undefined` when idle.
 */
function currentToolLine(tool: string | undefined): CardLine | undefined {
  if (tool === undefined || tool.length === 0) return undefined;
  return { text: tool, hue: "accent" };
}

/**
 * Build the recent output lines.
 *
 * @param outputLines - The recent output line texts.
 * @param expanded - Whether the card is expanded.
 * @returns The output lines.
 */
function outputLines(
  outputLines: string[] | undefined,
  expanded: boolean,
): CardLine[] {
  const cap = expanded ? EXPANDED_OUTPUT_CAP : COLLAPSED_OUTPUT_CAP;
  const lines = (outputLines ?? []).slice(-cap);
  if (lines.length === 0) return [{ text: "(no output yet)", hue: "muted" }];
  return lines.map((line) => ({ text: truncate(line, 80), hue: "muted" }));
}

/**
 * Build the recent tool-call lines.
 *
 * The summary is self-contained (`read <path>` / `$ <cmd>` / `<name> <json>`,
 * see `summarizeToolCall`), so each line renders the summary verbatim after
 * the arrow — the tool name is never re-prefixed (that would duplicate the
 * name already embedded in the summary).
 *
 * @param toolCalls - The recent tool-call entries.
 * @param expanded - Whether the card is expanded.
 * @returns The tool-call lines.
 */
function toolCallLines(
  toolCalls: ToolCallLine[] | undefined,
  expanded: boolean,
): CardLine[] {
  const cap = expanded ? EXPANDED_TOOL_CAP : COLLAPSED_TOOL_CAP;
  const entries = (toolCalls ?? []).slice(-cap);
  return entries.map((entry) => ({
    text: `→ ${truncate(entry.summary, 60)}`,
    hue: "accent" as const,
  }));
}

/**
 * Build the run-statistics text (`⟳ N turns · M tools · …`).
 *
 * Shared by the running card's stats line and the terminal title badge so
 * the run statistics survive the transition from running to terminal in the
 * same format.
 *
 * @param progress - The structured progress snapshot.
 * @param now - The current epoch-millis time (injected for determinism).
 * @returns The `⟳ …` statistics text.
 */
function statsText(progress: SubagentProgress, now: number): string {
  const turns = progress.turnCount ?? 0;
  const tools = progress.toolCallCount ?? 0;
  const elapsed = formatElapsed(progress.startedAt ?? 0, now);
  const parts = [
    `${turns} ${plural(turns, "turn")}`,
    `${tools} ${plural(tools, "tool")}`,
  ];
  if (progress.tokens !== undefined && progress.tokens > 0) {
    parts.push(`${formatTokenCount(progress.tokens)} tok`);
  }
  parts.push(elapsed);
  return `⟳ ${parts.join(" · ")}`;
}

/**
 * Build the stats line.
 *
 * `⟳ N turns · M tools · <elapsed>` with an optional token segment
 * (`· 12.4k tok`) inserted before the elapsed time when the run has
 * accumulated token usage.
 *
 * @param progress - The structured progress snapshot.
 * @param now - The current epoch-millis time (injected for determinism).
 * @returns The stats line.
 */
function statsLine(progress: SubagentProgress, now: number): CardLine {
  return { text: statsText(progress, now), hue: "muted" };
}

/**
 * Pluralize a noun for a count (`1 turn`, `2 turns`).
 *
 * @param count - The count.
 * @param singular - The singular noun form.
 * @returns The noun with the correct plural suffix.
 */
function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

/**
 * Build the running title line for the tool-call card.
 *
 * This is the single animated title the pi adapter renders via `renderCall`
 * while a run streams partial results.  The spinner glyph is derived from a
 * per-render frame sequence (shared with the running body card, which owns
 * the counter) so a card rebuilt on each `invalidate()` visibly animates.
 *
 * Layout: `⠋ subagent(<agent>) · <model-id> · <label>` — the model id
 * segment appears only when a model was actually resolved (strict mode:
 * always, since the configured model is required and resolved before the
 * run), so an unconfigured run never shows a placeholder.
 *
 * @param agent - The delegated subagent name (falls back to a placeholder).
 * @param label - The delegation's task description (omitted when absent).
 * @param frameSeq - The shared spinner frame sequence (indexed into
 *   `SPINNER_FRAMES`).
 * @param model - The model id actually used by the sub-session (the id part
 *   of a `"provider/id"` string), omitted when unknown.
 * @returns The running title line.
 */
export function renderProgressTitle(
  agent: string | undefined,
  label: string | undefined,
  frameSeq: number,
  model?: string,
): CardLine {
  const name = agent ?? "…";
  const labelPart =
    label !== undefined && label.length > 0 ? ` · ${label}` : "";
  const modelPart =
    model !== undefined && model.length > 0 ? ` · ${model}` : "";
  return {
    text: `${SPINNER_FRAMES[spinnerFrameIndex(frameSeq)]} subagent(${name})${modelPart}${labelPart}`,
    hue: "running",
  };
}

/**
 * Build a terminal title line for the subagent card.
 *
 * Mirrors the layout of `renderProgressTitle` (same `subagent(<agent>) ·
 * <model-id> · <label>` structure) with a static terminal marker (`✓` /
 * `✗` / `⏹`), so the title handed over from `renderCall` to `renderResult`
 * reads as the same line throughout the run.  The model-id segment appears
 * only when a model was actually resolved.
 *
 * The optional `stats` segment (`⟳ N turns · M tools · …`) appends the run
 * statistics to the title badge on the terminal card, so the stats the
 * running card showed in its own line survive the transition.
 *
 * @param marker - The terminal marker (`✓` / `✗` / `⏹`).
 * @param agent - The delegated subagent name (falls back to a placeholder).
 * @param label - The delegation's task description (omitted when absent).
 * @param hue - The terminal title's semantic hue (defaults to `success`;
 *   `⏹` aborted titles stay `muted`).
 * @param model - The model id actually used by the sub-session (the id part
 *   of a `"provider/id"` string), omitted when unknown.
 * @param stats - The run-statistics text (omitted when absent).
 * @returns The terminal title line.
 */
export function renderTitle(
  marker: string,
  agent: string | undefined,
  label: string | undefined,
  hue: CardHue = "success",
  model?: string,
  stats?: string,
): CardLine {
  const name = agent ?? "…";
  const labelPart =
    label !== undefined && label.length > 0 ? ` · ${label}` : "";
  const modelPart =
    model !== undefined && model.length > 0 ? ` · ${model}` : "";
  const statsPart =
    stats !== undefined && stats.length > 0 ? ` · ${stats}` : "";
  return {
    text: `${marker} subagent(${name})${modelPart}${labelPart}${statsPart}`,
    hue,
  };
}

/**
 * Build the display lines for a running (partial) subagent card.
 *
 * The card's title is owned by the tool-call card (`renderCall` in the pi
 * adapter), so the running body never emits a title line — the tool-execution
 * component stacks both cards and a second title would duplicate it.
 *
 * The optional `children` parameter appends this run's nested subagent
 * delegations (one level deep) after the tool-call region; an empty or
 * absent list leaves the card output unchanged.
 *
 * @param progress - The structured progress snapshot.
 * @param label - The delegation's task description (unused by the running
 *   body — kept for signature stability).
 * @param expanded - Whether the card is expanded (ctrl+o).
 * @param now - The current epoch-millis time (injected for determinism).
 * @param frameSeq - An optional per-render sequence for the spinner frame
 *   (defaults to the tool-call counter); the host advances it per render so
 *   the spinner animates.
 * @param children - This run's nested subagent runs (optional).
 * @returns The display lines for the running card.
 */
export function renderProgressCard(
  progress: SubagentProgress,
  _label: string | undefined,
  expanded = false,
  now: number = Date.now(),
  frameSeq?: number,
  children?: SubagentRun[],
): CardLine[] {
  const lines: CardLine[] = [];
  const tool = currentToolLine(progress.currentTool);
  if (tool !== undefined) lines.push(tool);
  lines.push(...toolCallLines(progress.toolCalls, expanded));
  lines.push(...outputLines(progress.outputLines, expanded));
  lines.push(statsLine(progress, now));
  for (const line of fleetCardChildLines(children ?? [], frameSeq)) {
    lines.push(line);
  }
  return lines;
}

/**
 * Build the display lines for a terminal (done) subagent card.
 *
 * The terminal card shows the title (with the model badge, the run
 * statistics, and the task label), the final output text, and the session
 * path.  Unlike the running card it no longer lists the recent tool calls —
 * the run's tools are already summarized by the statistics badge.
 *
 * The optional `children` parameter appends this run's nested subagent
 * delegations (one level deep) after the tool-call region; an empty or
 * absent list leaves the card output unchanged.
 *
 * @param progress - The structured progress snapshot (done).
 * @param label - The delegation's task description.
 * @param expanded - Whether the card is expanded (ctrl+o).
 * @param children - This run's nested subagent runs (optional).
 * @param frameSeq - An optional per-render sequence for the spinner frame
 *   (defaults to 0 when the host does not advance one); forwarded to the
 *   nested-child lines so a running child's spinner animates.  The pi
 *   adapter has no animation timer on the terminal card, so the result
 *   card's children keep the last live frame — still better than a frozen
 *   frame-0 glyph when a host does pass a sequence.
 * @returns The display lines for the result card.
 */
export function renderResultCard(
  progress: SubagentProgress,
  label: string | undefined,
  expanded = false,
  children?: SubagentRun[],
  frameSeq: number = 0,
): CardLine[] {
  const agent = progress.agent ?? "…";
  const result = progress.result;
  const model = progress.model;
  const stats = statsText(progress, Date.now());
  const lines: CardLine[] = [];

  if (result?.kind === "error") {
    lines.push(renderTitle("✗", agent, label, "error", model, stats));
    lines.push({
      text: truncate(result.errorMessage, 100),
      hue: "error",
    });
  } else if (result?.kind === "aborted") {
    lines.push(renderTitle("⏹", agent, label, "muted", model, stats));
  } else {
    lines.push(renderTitle("✓", agent, label, "success", model, stats));
  }

  // Final text summary — the subagent's delivered output.  Expanded shows
  // the delivered result in full — an arbitrary cap would silently hide the
  // rest of the text with no way to reach it (the result card owns the whole
  // pi result render).  The full text (newlines included) flows through the
  // `markdown` path, which splits logical lines and width-wraps them.
  //
  // Collapsed previews only the first non-empty line — leading blank lines
  // are skipped, matching the pi-subagents fold — and flags it for
  // render-boundary width truncation (the view model never character-caps:
  // the adapter truncates to the terminal width with pi's own width-aware
  // `truncateToWidth` semantics).  The preview is plain text, not markdown:
  // a markdown source line truncated mid-stream would leave inline markers
  // unclosed, so the collapsed fold stays literal.
  const finalText = result?.text ?? progress.output;
  if (finalText.trim().length === 0) {
    lines.push({ text: "(no output)", hue: "muted" });
  } else if (expanded) {
    lines.push({ text: finalText, hue: "muted", markdown: true });
  } else {
    lines.push({
      text: firstNonEmptyLine(finalText) ?? "",
      hue: "muted",
      truncateToWidth: true,
    });
  }

  // The on-disk sub-session file (pi persists sessions).  The user home
  // prefix is collapsed to `~` so the path reads compactly.
  const sessionPath = progress.sessionPath;
  if (sessionPath !== undefined && sessionPath.length > 0) {
    lines.push({ text: `session: ${shortenHome(sessionPath)}`, hue: "muted" });
  }

  // Nested subagent runs (this run's own delegations), rendered one level
  // deep after the tool-call region.  Absent when the run has no children.
  for (const line of fleetCardChildLines(children ?? [], frameSeq)) {
    lines.push(line);
  }

  return lines;
}

/**
 * The currently-running delegation summary for the collapsed fleet line.
 *
 * Carried separately from the status counts so the collapsed one-liner can
 * show *which* delegation is running and for how long — the spinner frames
 * come from the shared `SPINNER_FRAMES` sequence.  Multiple delegations can
 * run concurrently, so the collapsed line accepts a list — each entry renders
 * its own ` · <spinner> <agent> <m:ss>` group.
 */
export interface FleetRunningSummary {
  /** The delegated subagent name. */
  agent: string;
  /** The delegation's task description (omitted from the collapsed line). */
  label?: string;
  /** The run's elapsed duration in milliseconds (unknown when absent). */
  elapsedMs?: number;
}

/**
 * Build the single collapsed fleet-widget line for a main session.
 *
 * Layout: `◆ <primary> · <spinner> <agent> <elapsed> · ● <done> ● <failed>`.
 * The spinner segment appears only while something is running; a zero count
 * omits that segment; with no activity at all the line is just
 * `◆ <primary>`.  The line is produced as per-segment hues (the `◆ <primary>`
 * part carries no hue, the running part carries its hue, and each done/failed
 * count is three segments — a separator, a colored dot, and an uncolored
 * number), so the widget colors only the status symbols independently: the
 * primary keeps its own host color, the dots stay colored, and the
 * separators / counts stay default.  The flat `text` field remains the
 * segment concatenation (backward compatible with the uncolored card).  The
 * line's dominant `hue` conveys the status
 * priority — running > error > success > muted (no ✓/✗ text, per the visual
 * contract).
 *
 * @param primary - The active primary agent name (plain).
 * @param primaryColorized - The same name pre-colorized by the host adapter
 *   (used verbatim when provided).
 * @param summary - The per-session status counts.
 * @param currentRunning - The running delegation summaries, one per
 *   concurrently running run (absent or empty when nothing runs).
 * @param frameSeq - The shared spinner frame sequence.
 * @returns The single widget line.
 */
export function renderFleetCollapsed(
  primary: string,
  primaryColorized: string | undefined,
  summary: RunSummary,
  currentRunning?: FleetRunningSummary[],
  frameSeq: number = 0,
): CardLine {
  const primaryPart = primaryColorized ?? primary;
  const segments: CardSegment[] = [{ text: `◆ ${primaryPart}` }];

  // Each running run produces three segments — the ` · ` separator, the bare
  // spinner frame, and the ` <agent> <m:ss>` label — so only the spinner
  // carries the running hue (same convention as the count dots: only the
  // symbol is colored, the separators and text stay default).  Multiple runs
  // are listed one after another in the given order.
  if (summary.running > 0 && currentRunning !== undefined) {
    const spinner = SPINNER_FRAMES[spinnerFrameIndex(frameSeq)];
    for (const run of currentRunning) {
      segments.push({ text: " · " });
      segments.push({ text: spinner, hue: "running" });
      const elapsed =
        run.elapsedMs === undefined
          ? "-:--"
          : formatSeconds(Math.max(0, Math.floor(run.elapsedMs / 1000)));
      segments.push({ text: ` ${run.agent} ${elapsed}` });
    }
  }
  // Each done/failed count splits into three segments — the ` · ` separator,
  // the bare dot, and the number (` · ● 2`), so only the dot carries the
  // status hue.  The first dot's separator leads with ` · `; a second dot
  // (both counts present) is separated by a single space.  Only the dot
  // carries the status hue — the separator and the number stay default so
  // the punctuation is never tinted green/red.
  if (summary.done > 0) {
    segments.push({ text: " · " });
    segments.push({ text: "●", hue: "success" });
    segments.push({ text: ` ${summary.done}` });
  }
  if (summary.failed > 0) {
    segments.push({ text: summary.done > 0 ? " " : " · " });
    segments.push({ text: "●", hue: "error" });
    segments.push({ text: ` ${summary.failed}` });
  }

  const hue: CardHue =
    summary.running > 0
      ? "running"
      : summary.failed > 0
        ? "error"
        : summary.done > 0
          ? "success"
          : "muted";

  return { text: segments.map((s) => s.text).join(""), hue, segments };
}

/**
 * The status glyph and hue for one fleet row.
 *
 * A running run shows the spinner glyph (frame-indexed, so consecutive
 * renders animate) with the `running` hue; every terminal status shows a
 * static `●` — `success` for done, `error` for error/aborted.  Status is
 * carried purely by color + the spinner, never by ✓/✗ text.
 *
 * @param run - The run.
 * @param frameSeq - The shared spinner frame sequence.
 * @returns The glyph and its semantic hue.
 */
function fleetGlyph(
  run: SubagentRun,
  frameSeq: number,
): { glyph: string; hue: CardHue } {
  if (run.status === "running") {
    return {
      glyph: SPINNER_FRAMES[spinnerFrameIndex(frameSeq)],
      hue: "running",
    };
  }
  return { glyph: "●", hue: run.status === "done" ? "success" : "error" };
}

/**
 * Build the display lines for the expanded fleet widget.
 *
 * Each run renders one row: `▸ <spinner|●> <agent> · <label> · <duration>`
 * (a space in place of `▸` when not selected).  A run's nested children
 * (from `childrenByParent`) render immediately beneath it, indented one
 * level with `├─` for all but the last child and `└─` for the last.  A
 * selected child row carries the `▸` marker in its own slot.
 *
 * The `entries` list is expected to be the windowed, sorted top-level runs
 * (`registry.windowRuns`); `childrenByParent` is a precomputed map of
 * parent-run id → child runs.  Durations reuse `formatElapsed`.
 *
 * @param entries - The visible top-level runs (already windowed and sorted).
 * @param childrenByParent - Parent-run id → its child runs.
 * @param selectedId - The selected run id, or `undefined` for no selection.
 * @param frameSeq - The shared spinner frame sequence.
 * @param now - The current epoch-millis time (injected for determinism).
 * @returns The display lines for the expanded fleet widget.
 */
export function renderFleetRows(
  entries: SubagentRun[],
  childrenByParent: Map<string, SubagentRun[]>,
  selectedId: string | undefined,
  frameSeq: number,
  now: number,
): CardLine[] {
  const lines: CardLine[] = [];
  for (const run of entries) {
    const marker = run.id === selectedId ? "▸" : " ";
    const { glyph, hue } = fleetGlyph(run, frameSeq);
    lines.push(fleetRowLine(marker, " ", glyph, hue, fleetRowBody(run, now)));
    const children = childrenByParent.get(run.id);
    if (children === undefined) continue;
    children.forEach((child, index) => {
      const branch = index === children.length - 1 ? "└─" : "├─";
      const childMarker = child.id === selectedId ? "▸" : " ";
      const childGlyph = fleetGlyph(child, frameSeq);
      lines.push(
        fleetRowLine(
          childMarker,
          ` ${branch} `,
          childGlyph.glyph,
          childGlyph.hue,
          fleetRowBody(child, now),
        ),
      );
    });
  }
  return lines;
}

/**
 * Build one fleet row line as colorized segments.
 *
 * The marker and the branch/prefix characters carry no hue (default color);
 * only the status glyph (`<spinner|●>`) carries the status hue; the body
 * (`<agent> · <label> · <duration>`) stays default so a terminal row does not
 * tint the whole line green/red (visual-noise fix).  The flat `text` is the
 * segment concatenation, so the uncolored card path renders identically.
 *
 * @param marker - The selection marker (`▸` / ` `).
 * @param prefix - The separator between the marker and the glyph (` ` for a
 *   top-level row, ` ├─ ` / ` └─ ` for a nested child).
 * @param glyph - The status glyph (`<spinner|●>`).
 * @param hue - The glyph's semantic hue.
 * @param body - The row body (`<agent> · <label> · <duration>`).
 * @returns The row line with its per-segment hues.
 */
function fleetRowLine(
  marker: string,
  prefix: string,
  glyph: string,
  hue: CardHue,
  body: string,
): CardLine {
  const segments: CardSegment[] = [
    { text: marker },
    { text: prefix },
    { text: glyph, hue },
    { text: ` ${body}` },
  ];
  return {
    text: segments.map((s) => s.text).join(""),
    hue,
    segments,
  };
}

/**
 * Build the body of one fleet row: `<agent> · <label> · <duration>`.
 *
 * The duration freezes at the run's `endedAt` once the run is terminal —
 * `run.endedAt ?? now` — so a finished row's clock stops advancing; a
 * running row keeps counting against `now`.
 *
 * @param run - The run.
 * @param now - The current epoch-millis time (injected for determinism).
 * @returns The row body text.
 */
function fleetRowBody(run: SubagentRun, now: number): string {
  const labelPart =
    run.label !== undefined && run.label.length > 0 ? ` · ${run.label}` : "";
  // A restored aborted run whose `endedAt` equals its `startedAt` carries no
  // real interruption time — rendering `· 0:00` would imply the run finished
  // instantly.  Omit the duration segment entirely for such runs; the rest
  // of the row (agent + label) stays intact.
  if (
    run.status === "aborted" &&
    run.endedAt !== undefined &&
    run.endedAt === run.startedAt
  ) {
    return `${run.agent}${labelPart}`;
  }
  const elapsed = formatElapsed(run.startedAt, run.endedAt ?? now);
  return `${run.agent}${labelPart} · ${elapsed}`;
}

/**
 * Build the nested-child lines for a card (`renderProgressCard` /
 * `renderResultCard`).
 *
 * Each child run renders one line, indented one level:
 * `├─ <spinner|●> subagent(<agent>) · <label>` (the label when present).
 * A running child shows the spinner with the `running` hue; terminal
 * children show `●` with the `success` / `error` hue.  An empty list yields
 * no lines, so the card output is unchanged when there are no children.
 *
 * @param children - The run's nested subagent runs.
 * @param frameSeq - The shared spinner frame sequence (defaults to 0 when
 *   the host does not advance one).
 * @returns The child display lines.
 */
function fleetCardChildLines(
  children: SubagentRun[],
  frameSeq: number = 0,
): CardLine[] {
  return children.map((child) => {
    const { glyph, hue } = fleetGlyph(child, frameSeq);
    const labelPart =
      child.label !== undefined && child.label.length > 0
        ? ` · ${child.label}`
        : "";
    return {
      text: `├─ ${glyph} subagent(${child.agent})${labelPart}`,
      hue,
    };
  });
}

/**
 * Collapse a user-home prefix in a path to a leading `~`.
 *
 * @param path - The absolute path.
 * @returns The path with a `$HOME` prefix shortened to `~`.
 */
function shortenHome(path: string): string {
  const home = homedir();
  if (home.length > 0 && path.startsWith(home)) {
    const rest = path.slice(home.length);
    return rest.length === 0 ? "~" : `~${rest}`;
  }
  return path;
}
