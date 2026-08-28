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
 * @module
 */

import { homedir } from "node:os";
import type { SubagentProgress } from "./driver.js";

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

/** One display line: the text plus its semantic hue. */
export interface CardLine {
  text: string;
  hue: CardHue;
  /**
   * Whether the line should be rendered as Markdown by the pi adapter.
   *
   * Pure data — core never imports pi.  The pi TUI card (`card.ts`) renders
   * markdown-flagged lines with pi-tui's `Markdown` component; all other
   * lines render as plain `Text`.  Only the terminal final-output line is
   * flagged.
   */
  markdown?: boolean;
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
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
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
 * @param progress - The structured progress snapshot.
 * @param label - The delegation's task description (unused by the running
 *   body — kept for signature stability).
 * @param expanded - Whether the card is expanded (ctrl+o).
 * @param now - The current epoch-millis time (injected for determinism).
 * @param frameSeq - An optional per-render sequence for the spinner frame
 *   (defaults to the tool-call counter); the host advances it per render so
 *   the spinner animates.
 * @returns The display lines for the running card.
 */
export function renderProgressCard(
  progress: SubagentProgress,
  _label: string | undefined,
  expanded = false,
  now: number = Date.now(),
  frameSeq?: number,
): CardLine[] {
  const lines: CardLine[] = [];
  const tool = currentToolLine(progress.currentTool);
  if (tool !== undefined) lines.push(tool);
  lines.push(...toolCallLines(progress.toolCalls, expanded));
  lines.push(...outputLines(progress.outputLines, expanded));
  lines.push(statsLine(progress, now));
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
 * @param progress - The structured progress snapshot (done).
 * @param label - The delegation's task description.
 * @param expanded - Whether the card is expanded (ctrl+o).
 * @returns The display lines for the result card.
 */
export function renderResultCard(
  progress: SubagentProgress,
  label: string | undefined,
  expanded = false,
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
    lines.push({ text: truncate(result.text, 100), hue: "muted" });
  } else {
    lines.push(renderTitle("✓", agent, label, "success", model, stats));
  }

  // Final text summary — the subagent's delivered output.  Marked for
  // Markdown rendering so the pi adapter draws it as formatted output
  // (structure-aware wrapping, code blocks, lists) while staying plain
  // text; the running card keeps plain text throughout.
  const finalText = result?.text ?? progress.output;
  if (finalText.length > 0) {
    lines.push({
      text: truncate(finalText, expanded ? 400 : 120),
      hue: "muted",
      markdown: true,
    });
  } else {
    lines.push({ text: "(no output)", hue: "muted" });
  }

  // The on-disk sub-session file (pi persists sessions).  The user home
  // prefix is collapsed to `~` so the path reads compactly.
  const sessionPath = progress.sessionPath;
  if (sessionPath !== undefined && sessionPath.length > 0) {
    lines.push({ text: `session: ${shortenHome(sessionPath)}`, hue: "muted" });
  }

  return lines;
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
