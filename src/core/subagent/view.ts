/**
 * Subagent transcript view model — host-agnostic projections over a run's
 * fact log for the pi TUI.
 *
 * A subagent run is an ordered, immutable fact stream (`run-log.ts`);
 * everything here is a *pure projection* of that stream plus run metadata.
 * No information is destroyed before projection: the log keeps full args,
 * results, and message text, and every display decision — which entries
 * are in the recency window, how wide a line may get, how a tool call reads
 * on one line — is made here, at render time, from the options the host
 * passes in.
 *
 * Every line carries a *semantic hue* (`running` / `success` / `error` /
 * `muted` / `accent`) — core never knows pi's concrete theme colors.  The
 * pi adapter owns the one-place mapping from hue to a real `theme.fg`
 * color name (`src/adapters/pi/tui/theme.ts`), so this module stays
 * importable and unit-testable in any TS runtime.
 *
 * The layout contract:
 *   - running: the title is owned by the tool-call card (`renderCall` in
 *     the pi adapter); the running body only carries the current-tool line,
 *     the tool-call lines, the assistant output lines, and a stats line
 *     (`⟳ N turns · M tools · T`) whose counters are derived from the
 *     facts.  The spinner frame advances with each render.
 *   - done ok: `✓ subagent(<name>)` success-hued title (badged with the
 *     run statistics) plus the final message text projected from the log;
 *     error / aborted render their own marker and reason.
 *   - expanded shows every entry; collapsed keeps only the recent
 *     `GLANCE_LINES` entries.
 *
 * The fleet-widget functions (`renderFleetCollapsed` / `renderFleetRows`)
 * derive the pi `zoo` widget lines from the run registry (`registry.ts`):
 * a single-line collapsed summary (status carried purely by color, no
 * ✓/✗ text) and the expanded scrolling row list with nested child runs.
 *
 * @module
 */

import { homedir } from "node:os";
import type { RunStatus, RunSummary, SubagentRun } from "./registry.js";
import type {
  MessageEndFact,
  RunFact,
  RunLog,
  ToolStartFact,
} from "./run-log.js";
import { usageTokens } from "./run-log.js";

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
  /**
   * The agent name this segment renders, when it is an agent-name segment.
   *
   * Pure semantic markup — core never knows the configured color.  The pi
   * adapter translates it into the agent's `[agent.<name>].color` via the
   * host `colorizeAgent` (which returns the plain name when unconfigured,
   * so the current default is preserved).  Absent for every non-agent
   * segment.
   */
  agent?: string;
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

/** Recent entries rendered by a collapsed card per region. See
 * `GLANCE_LINES`. */

/**
 * How many recent entries a collapsed card shows per region (tool calls,
 * output lines).  This is a taste value, not a technical bound — it
 * follows pi's own practice of a small fixed preview window (e.g.
 * `BASH_PREVIEW_LINES = 5`); adjust by eye, never treat it as a contract.
 */
export const GLANCE_LINES = 3;

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
 * Cap a string to a maximum render width with an ellipsis marker.
 *
 * Width is always the render-time width the caller passes in — core keeps
 * no baked-in character caps.
 *
 * @param text - The string to cap.
 * @param limit - The maximum width in characters.
 * @returns The capped string.
 */
function fit(text: string, limit: number): string {
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
 * The ESC control character, kept out of the regex literal.
 */
const ESC = "\u001b";

/** Matches an ANSI SGR sequence like `ESC[31m` or `ESC[0m`. */
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/**
 * Strip ANSI escape sequences and collapse whitespace runs.
 *
 * Tool arguments arrive with terminal color codes and stray whitespace;
 * a one-line TUI summary must render them as plain, single-spaced text.
 *
 * @param text - The raw text.
 * @returns The cleaned text: ANSI `ESC[...m` sequences removed, every
 *   whitespace run collapsed to a single space, trimmed.
 */
function clean(text: string): string {
  return text.replace(ANSI_RE, "").replace(/\s+/g, " ").trim();
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

/**
 * Render a one-line summary of a tool call from its arguments.
 *
 * A display convention, so it lives in the projection — never at
 * collection time.  Following the pi-subagents `formatToolCall`
 * conventions: bash renders as `$ <command>`, read / write / edit render
 * as `<name> <path>` (the `file_path` or `path` argument, with `$HOME`
 * collapsed to `~`), and any other tool renders as
 * `<name> <JSON.stringify(args)>`.  All text is ANSI-cleaned and
 * whitespace-collapsed, then capped to the passed render width — there
 * are no fixed character caps.
 *
 * @param name - The tool name.
 * @param args - The tool-call arguments (may be undefined for malformed
 *   facts).
 * @param width - The render width the summary must fit into.
 * @returns The one-line tool-call summary, capped to the width.
 */
export function summarizeToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  width: number,
): string {
  const argsObj =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? args
      : {};
  let summary: string;
  switch (name) {
    case "bash": {
      const command =
        typeof argsObj.command === "string" ? argsObj.command : "";
      summary = command.length > 0 ? `$ ${clean(command)}` : "$ …";
      break;
    }
    case "read":
    case "write":
    case "edit": {
      const rawPath = argsObj.file_path ?? argsObj.path;
      const path =
        typeof rawPath === "string" && rawPath.length > 0
          ? shortenHome(clean(rawPath))
          : "…";
      summary = `${name} ${path}`;
      break;
    }
    default: {
      const json = JSON.stringify(argsObj) ?? "";
      summary = `${name} ${clean(json)}`;
      break;
    }
  }
  return fit(summary, Math.max(1, Math.floor(width)));
}

/**
 * Run counters derived from the fact stream.
 *
 * Turns count completed assistant messages, tool calls count started tool
 * executions, and tokens sum the per-message usage reports (see
 * `usageTokens` for the per-message rule; a run without any positive report
 * yields `undefined`, so the card omits the token segment).
 *
 * The user-message fact is deliberately excluded from every counter: it is
 * the instruction the run was given, not a turn the agent produced, and it
 * carries no usage report.
 *
 * @param facts - The run's facts (in append order).
 * @returns The derived counters.
 */
export function deriveCounters(facts: readonly RunFact[]): {
  turnCount: number;
  toolCallCount: number;
  tokens?: number;
} {
  let turnCount = 0;
  let toolCallCount = 0;
  let tokens: number | undefined;
  for (const fact of facts) {
    if (fact.type === "tool_start") toolCallCount += 1;
    // Only assistant messages are a turn and report usage: `tool_start`,
    // `tool_end` and `user_message` all contribute nothing to these counters
    // (the user fact is the instruction the run was given, not output).
    if (fact.type !== "message_end") continue;
    turnCount += 1;
    const reported = usageTokens(fact.usage);
    if (reported === undefined) continue;
    tokens = (tokens ?? 0) + reported;
  }
  return {
    turnCount,
    toolCallCount,
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

/**
 * The text of one completed assistant message (its text parts joined).
 *
 * @param fact - The message fact.
 * @returns The concatenated message text.
 */
function messageText(fact: MessageEndFact): string {
  return fact.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

/**
 * The last non-empty line of a text block.
 *
 * The card's output regions show one line per assistant message — its
 * last non-empty line, the same compaction the snapshot formatter used
 * for the compact progress line, derived here at projection time.
 *
 * @param text - The multi-line text block.
 * @returns The last non-empty line, or `undefined` when there is none.
 */
function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return lines[i].trim();
  }
  return undefined;
}

/**
 * Build the assistant output lines projected from the message facts.
 *
 * Only assistant messages are projected: a `user_message` fact holds the
 * delegation instruction, which the card never shows (the caller already
 * knows it) and which would otherwise masquerade as agent output.
 *
 * @param facts - The run's facts.
 * @param expanded - Whether the card is expanded (shows every message).
 * @param glance - The collapsed recency window size.
 * @param width - The render width for line capping.
 * @returns The output lines.
 */
function outputLines(
  facts: readonly RunFact[],
  expanded: boolean,
  glance: number,
  width: number,
): CardLine[] {
  const messages = facts.filter(
    (fact): fact is MessageEndFact => fact.type === "message_end",
  );
  const projected = messages
    .map((fact) => lastNonEmptyLine(messageText(fact)))
    .filter((line): line is string => line !== undefined);
  const window = expanded ? projected : projected.slice(-glance);
  if (window.length === 0) {
    return [{ text: "(no output yet)", hue: "muted" }];
  }
  return window.map((line) => ({
    text: fit(line, width),
    hue: "muted" as const,
  }));
}

/**
 * Build the tool-call lines projected from the tool-start facts.
 *
 * Each line renders the one-line summary verbatim after the arrow — the
 * tool name is never re-prefixed (that would duplicate the name already
 * embedded in the summary).  The predicate selects `tool_start` facts only,
 * so `user_message` / `tool_end` / `message_end` facts contribute no line.
 *
 * @param facts - The run's facts.
 * @param expanded - Whether the card is expanded (shows every call).
 * @param glance - The collapsed recency window size.
 * @param width - The render width for line capping.
 * @returns The tool-call lines.
 */
function toolCallLines(
  facts: readonly RunFact[],
  expanded: boolean,
  glance: number,
  width: number,
): CardLine[] {
  const starts = facts.filter(
    (fact): fact is ToolStartFact => fact.type === "tool_start",
  );
  const window = expanded ? starts : starts.slice(-glance);
  // Two characters of the render width belong to the `→ ` marker.
  const summaryWidth = Math.max(1, width - 2);
  return window.map((fact) => ({
    text: `→ ${summarizeToolCall(fact.toolName, fact.args, summaryWidth)}`,
    hue: "accent" as const,
  }));
}

/**
 * Build the run-statistics text (`⟳ N turns · M tools · …`).
 *
 * Counters are derived from the fact stream, not read off a pre-aggregated
 * snapshot.  Shared by the running card's stats line and the terminal
 * title badge so the run statistics survive the transition from running
 * to terminal in the same format.
 *
 * @param facts - The run's facts.
 * @param startedAt - Epoch-millis start time of the run.
 * @param now - The current epoch-millis time (injected for determinism).
 * @returns The `⟳ …` statistics text.
 */
function statsText(
  facts: readonly RunFact[],
  startedAt: number,
  now: number,
): string {
  const counters = deriveCounters(facts);
  const elapsed = formatElapsed(startedAt, now);
  const parts = [
    `${counters.turnCount} ${plural(counters.turnCount, "turn")}`,
    `${counters.toolCallCount} ${plural(counters.toolCallCount, "tool")}`,
  ];
  if (counters.tokens !== undefined && counters.tokens > 0) {
    parts.push(`${formatTokenCount(counters.tokens)} tok`);
  }
  parts.push(elapsed);
  return `⟳ ${parts.join(" · ")}`;
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
 * Run metadata a card projection needs beyond the fact log.
 *
 * Identity and lifecycle facts the log itself does not carry: who the run
 * is, which model it uses, where it stands in its lifecycle, and — while
 * running — which tool is currently executing (the host announces a tool
 * start before its fact pair completes).
 */
export interface CardMeta {
  /** The delegated subagent name. */
  agent?: string;
  /** The model id actually used by the sub-session, when resolved. */
  model?: string;
  /** The lifecycle status (`running` renders the live body, a terminal
   * status renders the terminal card). */
  status: RunStatus;
  /** Epoch-millis start time of the run. */
  startedAt: number;
  /** Epoch-millis end time (terminal runs; elapsed falls back to `now`). */
  endedAt?: number;
  /** The tool name the run is currently executing, when any. */
  currentTool?: string;
  /** The failure reason (rendered when `status` is `error`). */
  error?: string;
}

/** Render-time options for a card projection. */
export interface CardOptions {
  /** The render width in characters the lines must fit into. */
  width: number;
  /** Whether the card is expanded (shows every entry, no recency window). */
  expanded: boolean;
  /** The collapsed recency window size (defaults to `GLANCE_LINES`). */
  glanceLines?: number;
  /** The current epoch-millis time (injected for determinism). */
  now?: number;
  /** The shared spinner frame sequence (for nested-child spinners). */
  frame?: number;
  /** This run's nested subagent runs (rendered one level deep). */
  children?: SubagentRun[];
}

/**
 * Project a run's fact log into the card's display lines.
 *
 * The single card projection, live or terminal:
 *   - running: no title line (the tool-call card's `renderCall` owns
 *     it); the body is the current-tool line, the tool-call lines, the
 *     assistant output lines, the stats line, and the nested-child lines.
 *   - terminal: a static title (`✓` / `✗` / `⏹`) badged with
 *     the run statistics, the error reason when the run failed, the final
 *     assistant text projected from the last message fact, and the
 *     nested-child lines.
 *
 * Collapsed mode windows each region to the last `glanceLines` entries;
 * expanded mode shows every entry.  Width is never baked into the log —
 * previews are capped to `opts.width` here, and the final-output preview
 * carries the `truncateToWidth` flag so the adapter clips it at the real
 * terminal width.
 *
 * @param log - The run's append-only fact log.
 * @param meta - The run metadata (identity, lifecycle, current tool).
 * @param opts - Render-time options (width, expansion, recency window,
 *   clock, spinner frame, children).
 * @returns The display lines for the card.
 */
export function projectCard(
  log: RunLog,
  meta: CardMeta,
  opts: CardOptions,
): CardLine[] {
  const facts = log.facts();
  const now = opts.now ?? Date.now();
  const glance = opts.glanceLines ?? GLANCE_LINES;
  const frame = opts.frame ?? 0;
  const lines: CardLine[] = [];

  if (meta.status === "running") {
    // The running body emits no title line — the tool-call card owns it,
    // and the tool-execution component stacks both cards, so a title here
    // would duplicate it.
    const tool = currentToolLine(meta.currentTool);
    if (tool !== undefined) lines.push(tool);
    lines.push(...toolCallLines(facts, opts.expanded, glance, opts.width));
    lines.push(...outputLines(facts, opts.expanded, glance, opts.width));
    lines.push({
      text: statsText(facts, meta.startedAt, now),
      hue: "muted",
    });
    // Nested subagent runs (this run's own delegations), rendered one
    // level deep after the tool-call region.
    lines.push(...fleetCardChildLines(opts.children ?? [], frame));
    return lines;
  }

  // Terminal card: the tool-call list is not repeated — the statistics
  // badge already summarizes the run's tools.
  const marker =
    meta.status === "done" ? "✓" : meta.status === "error" ? "✗" : "⏹";
  const hue: CardHue =
    meta.status === "done"
      ? "success"
      : meta.status === "error"
        ? "error"
        : "muted";
  lines.push(
    renderTitle(
      marker,
      meta.agent,
      undefined,
      hue,
      meta.model,
      statsText(facts, meta.startedAt, meta.endedAt ?? now),
    ),
  );
  if (meta.status === "error" && meta.error !== undefined) {
    lines.push({ text: meta.error, hue: "error", truncateToWidth: true });
  }

  // Final text summary — the last completed assistant message projected
  // from the log.  Expanded shows the delivered result in full — an
  // arbitrary cap would silently hide the rest of the text with no way to
  // reach it (the terminal card owns the whole pi result render).  The
  // full text (newlines included) flows through the `markdown` path,
  // which splits logical lines and width-wraps them.
  //
  // Collapsed previews only the first non-empty line — leading blank
  // lines are skipped, matching the pi-subagents fold — and flags it for
  // render-boundary width truncation (the projection never
  // character-caps: the adapter truncates to the terminal width with
  // pi's own width-aware `truncateToWidth` semantics).  The preview is
  // plain text, not markdown: a markdown source line truncated mid-stream
  // would leave inline markers unclosed, so the collapsed fold stays
  // literal.
  let finalText = "";
  for (let i = facts.length - 1; i >= 0; i--) {
    const fact = facts[i];
    // The scan stops at the last ASSISTANT message: a `user_message` fact is
    // an input, never the run's final text, so it must not end the search
    // (a run can be steered mid-flight).
    if (fact.type === "message_end") {
      finalText = messageText(fact);
      break;
    }
  }
  if (finalText.trim().length === 0) {
    lines.push({ text: "(no output)", hue: "muted" });
  } else if (opts.expanded) {
    lines.push({ text: finalText, hue: "muted", markdown: true });
  } else {
    lines.push({
      text: firstNonEmptyLine(finalText) ?? "",
      hue: "muted",
      truncateToWidth: true,
    });
  }

  // Nested subagent runs (this run's own delegations), rendered one
  // level deep after the output region.  Absent when the run has no
  // children.
  lines.push(...fleetCardChildLines(opts.children ?? [], frame));
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

  // Each running run produces five segments — the ` · ` separator, the bare
  // spinner frame, a space, the bare agent name (marked with its `agent` so
  // the adapter colorizes it with the configured `[agent.<name>].color`), and
  // the ` <m:ss>` elapsed — so only the spinner carries the running hue and
  // the agent name is marked (same convention as the count dots: only the
  // symbol is colored, the separators and text stay default).  Multiple runs
  // are listed one after another in the given order.
  if (summary.running > 0 && currentRunning !== undefined) {
    const spinner = SPINNER_FRAMES[spinnerFrameIndex(frameSeq)];
    for (const run of currentRunning) {
      segments.push({ text: " · " });
      segments.push({ text: spinner, hue: "running" });
      segments.push({ text: " " });
      segments.push({ text: run.agent, agent: run.agent });
      const elapsed =
        run.elapsedMs === undefined
          ? "-:--"
          : formatSeconds(Math.max(0, Math.floor(run.elapsedMs / 1000)));
      segments.push({ text: ` ${elapsed}` });
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
 * only the status glyph (`<spinner|●>`) carries the status hue.  The body
 * splits into the bare agent name (marked with its `agent` so the adapter
 * colorizes it with the configured `[agent.<name>].color`) and the plain
 * ` · <label> · <duration>` remainder, so a terminal row does not tint the
 * whole line green/red (visual-noise fix) while the agent name keeps its own
 * color.  The flat `text` is the segment concatenation, so the uncolored
 * card path renders identically.
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
  ];
  // The leading `<agent>` of the body is split out and marked, so the
  // adapter colorizes exactly the agent name and leaves the label /
  // duration plain.  When the body has no agent prefix (never in practice)
  // the whole body stays one plain segment.
  const agentName = agentPrefixOf(body);
  if (agentName === undefined) {
    segments.push({ text: ` ${body}` });
  } else {
    segments.push({ text: " " });
    segments.push({ text: agentName, agent: agentName });
    segments.push({ text: body.slice(agentName.length) });
  }
  return {
    text: segments.map((s) => s.text).join(""),
    hue,
    segments,
  };
}

/**
 * The leading agent name of a fleet row body, when the body starts with one.
 *
 * `fleetRowBody` always renders `<agent>` first (optionally followed by
 * ` · <label> · <duration>`), so the leading run of non-whitespace, non-`·`
 * characters is the agent name.  Returns `undefined` when the body does not
 * start with an agent name (defensive-only — never the case for real runs).
 *
 * @param body - The row body text.
 * @returns The leading agent name, or `undefined`.
 */
function agentPrefixOf(body: string): string | undefined {
  const match = /^[^\s·]+/.exec(body);
  return match?.[0];
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
 * Build the nested-child lines for a card (`projectCard`).
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
