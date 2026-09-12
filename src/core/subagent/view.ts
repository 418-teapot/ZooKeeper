/**
 * Subagent transcript view model — host-agnostic projections over a run's
 * fact log for the pi TUI.
 *
 * A subagent run is an ordered, immutable fact stream (`run-log.ts`);
 * most functions here are *pure projections* of that stream plus run
 * metadata.  The fleet-widget projections (`renderFleetCollapsed` /
 * `renderFleetRows`) and the card's nested subtrees are the exception:
 * they also read the process-global run registry (`registry.ts`) through
 * `childrenOf` to reach a run's descendants.  No information is destroyed
 * before projection: the log keeps full args,
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
 *   - done ok: `● subagent(<name>)` success-hued title (badged with the
 *     run statistics) plus the final message text projected from the log;
 *     terminal titles carry the square marker (red for error, muted for
 *     aborted — a cancellation is not a failure), and error additionally
 *     renders its reason line below the title.
 *   - expanded shows every entry; collapsed keeps only the recent
 *     `GLANCE_LINES` entries.
 *
 * The fleet-widget functions (`renderFleetCollapsed` / `renderFleetRows`)
 * derive the pi `zoo` widget lines from the run registry (`registry.ts`):
 * a single-line collapsed summary (status carried purely by color, never
 * by text markers) and the expanded scrolling row list with nested child
 * runs at every generation.
 *
 * @module
 */

import { homedir } from "node:os";
import {
  type DisplayHue,
  type PresentationStatus,
  SPINNER_FRAMES,
  STATUS_PRESENTATION,
  spinnerFrameIndex,
  TREE_BRANCH,
  TREE_LAST,
  TREE_PIPE,
} from "../display.js";
import {
  childrenOf,
  type RunStatus,
  type RunSummary,
  type SubagentRun,
} from "./registry.js";
import type {
  MessageEndFact,
  RunFact,
  RunLog,
  ToolStartFact,
} from "./run-log.js";
import { contextTokens } from "./run-log.js";

/**
 * The run-status → presentation mapping for the subagent domain.
 *
 * The domain maps its lifecycle states onto the canonical presentation
 * statuses: a run in flight is `active`, a finished run is `succeeded` or
 * `failed` — an interruption (aborted) is a `cancelled` stop, not a
 * failure (the user's intent stays visually distinct from an exception,
 * matching the todo domain's treatment of abandoned work).  Both the card
 * title and the fleet rows resolve their glyph/hue through this mapping.
 */
export const RUN_PRESENTATION: Record<RunStatus, PresentationStatus> = {
  running: "active",
  done: "succeeded",
  error: "failed",
  aborted: "cancelled",
};

/**
 * Format a token count for the stats line.
 *
 * Follows the compact thousand-abbreviation convention (`12.4k`, `1.0k`,
 * `999`): below 1000 the bare number, at or above 1000 a one-decimal `k`
 * suffix (rounded up to whole `k` past 999.9k).  The lowercase `k` matches
 * the agreed visual contract (`· 12.4k token`).
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

/** One colorizable segment of a display line. */
export interface CardSegment {
  /** The segment text (may embed its own ANSI color sequences). */
  text: string;
  /** The segment's semantic hue — absent means default color (unwrapped). */
  hue?: DisplayHue;
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
  hue: DisplayHue;
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
  /**
   * Whether this line is the fleet widget's transiently selected row.
   *
   * Selection is a widget-only presentation state: the pi adapter renders
   * the row in reverse video at widget render time, and the static
   * transcript card ignores this field entirely (history never shows a
   * selection).  Selection is never carried as a text marker — the
   * structural `▸/▾` glyphs stay reserved for folding.
   */
  selected?: boolean;
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
 * executions, and tokens hold the context length of the latest assistant
 * message that reported usable usage (see `contextTokens` for the per-
 * message rule; a run without any such report yields `undefined`, so the
 * card omits the token segment).
 *
 * The user-message fact is deliberately excluded from every counter: it is
 * the instruction the run was given, not a turn the agent produced, and it
 * carries no usage report.
 *
 * A tool-start fact that is an inner delegation already mirrored by a
 * registered child run is excluded from the tool count: the child's own
 * row is the visible record of that call, so counting it here would make
 * the parent's `N tools` disagree with the rows the card shows.
 *
 * @param facts - The run's facts (in append order).
 * @param excludeToolCallIds - Tool-call ids of inner delegations that have
 *   a registered child run (absent / empty when the caller has none).
 * @returns The derived counters.
 */
export function deriveCounters(
  facts: readonly RunFact[],
  excludeToolCallIds?: ReadonlySet<string>,
): {
  turnCount: number;
  toolCallCount: number;
  tokens?: number;
} {
  let turnCount = 0;
  let toolCallCount = 0;
  let tokens: number | undefined;
  for (const fact of facts) {
    if (
      fact.type === "tool_start" &&
      !isExcludedDelegation(fact, excludeToolCallIds)
    ) {
      toolCallCount += 1;
    }
    // Only assistant messages are a turn and report usage: `tool_start`,
    // `tool_end` and `user_message` all contribute nothing to these counters
    // (the user fact is the instruction the run was given, not output).
    if (fact.type !== "message_end") continue;
    turnCount += 1;
    // The context length is the newest valid report, not a sum: each report
    // already covers the whole conversation up to that request.
    const reported = contextTokens(fact.usage);
    if (reported !== undefined) tokens = reported;
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
 * One entry on the card's merged timeline.
 *
 * A card body is a chronological merge of fact-derived lines (tool calls,
 * assistant output) and child subtrees: each entry carries the timestamp
 * its lines anchor to, so a nested run's row lands where the run started
 * and the parent's later lines render below it.
 */
interface TimelineEntry {
  /** Epoch-millis timestamp the entry anchors to. */
  at: number;
  /** The display lines belonging to this entry. */
  lines: CardLine[];
}

/**
 * Whether a tool-start fact is an inner delegation already mirrored by a
 * registered child run.
 *
 * Each nested delegation is registered under the tool-call id of the
 * `subagent` call that started it, so a `subagent` tool-start whose id
 * matches a known child run would otherwise render twice — once as a raw
 * `→ subagent {…}` line, once as the child's own tree row.  A call with no
 * matching child run (or no tool-call id) is kept: dropping it would
 * silently lose the only record of the delegation.
 *
 * @param fact - The tool-start fact.
 * @param childIds - The registered child run ids, when known.
 * @returns True when the fact must not be projected (or counted) again.
 */
function isExcludedDelegation(
  fact: ToolStartFact,
  childIds: ReadonlySet<string> | undefined,
): boolean {
  if (childIds === undefined || childIds.size === 0) return false;
  if (fact.toolName !== "subagent") return false;
  return fact.toolCallId !== undefined && childIds.has(fact.toolCallId);
}

/**
 * Project the assistant output facts into timed timeline entries.
 *
 * Only assistant messages are projected: a `user_message` fact holds the
 * delegation instruction, which the card never shows (the caller already
 * knows it) and which would otherwise masquerade as agent output.
 *
 * @param facts - The run's facts.
 * @param expanded - Whether the card is expanded (shows every message).
 * @param glance - The collapsed recency window size.
 * @param width - The render width for line capping.
 * @returns The output entries (empty when no message carries text).
 */
function outputEntries(
  facts: readonly RunFact[],
  expanded: boolean,
  glance: number,
  width: number,
): TimelineEntry[] {
  const messages = facts.filter(
    (fact): fact is MessageEndFact => fact.type === "message_end",
  );
  const projected = messages
    .map((fact) => ({
      at: fact.at,
      line: lastNonEmptyLine(messageText(fact)),
    }))
    .filter(
      (entry): entry is { at: number; line: string } =>
        entry.line !== undefined,
    );
  const window = expanded ? projected : projected.slice(-glance);
  return window.map((entry) => ({
    at: entry.at,
    lines: [{ text: fit(entry.line, width), hue: "muted" as const }],
  }));
}

/**
 * Project the tool-start facts into timed timeline entries.
 *
 * Each line renders the one-line summary verbatim after the arrow — the
 * tool name is never re-prefixed (that would duplicate the name already
 * embedded in the summary).  A `subagent` call already mirrored by a child
 * run is skipped (see `isExcludedDelegation`).
 *
 * @param facts - The run's facts.
 * @param expanded - Whether the card is expanded (shows every call).
 * @param glance - The collapsed recency window size.
 * @param width - The render width for line capping.
 * @param childIds - The registered child run ids.
 * @returns The tool-call entries.
 */
function toolEntries(
  facts: readonly RunFact[],
  expanded: boolean,
  glance: number,
  width: number,
  childIds: ReadonlySet<string>,
): TimelineEntry[] {
  const starts = facts
    .filter((fact): fact is ToolStartFact => fact.type === "tool_start")
    .filter((fact) => !isExcludedDelegation(fact, childIds));
  const window = expanded ? starts : starts.slice(-glance);
  // Two characters of the render width belong to the `→ ` marker.
  const summaryWidth = Math.max(1, width - 2);
  return window.map((fact) => ({
    at: fact.at,
    lines: [
      {
        text: `→ ${summarizeToolCall(fact.toolName, fact.args, summaryWidth)}`,
        hue: "accent" as const,
      },
    ],
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
 * @param excludeToolCallIds - Tool-call ids of inner delegations mirrored
 *   by registered child runs (excluded from the tool count).
 * @returns The `⟳ …` statistics text.
 */
function statsText(
  facts: readonly RunFact[],
  startedAt: number,
  now: number,
  excludeToolCallIds?: ReadonlySet<string>,
): string {
  const counters = deriveCounters(facts, excludeToolCallIds);
  const elapsed = formatElapsed(startedAt, now);
  const parts = [
    `${counters.turnCount} ${plural(counters.turnCount, "turn")}`,
    `${counters.toolCallCount} ${plural(counters.toolCallCount, "tool")}`,
  ];
  if (counters.tokens !== undefined) {
    parts.push(`${formatTokenCount(counters.tokens)} token`);
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
 * <model-id> · <label>` structure) with a static terminal marker glyph
 * (from the canonical `STATUS_PRESENTATION` table), so the title handed
 * over from `renderCall` to `renderResult` reads as the same line
 * throughout the run.  The model-id segment appears only when a model was
 * actually resolved.
 *
 * The optional `stats` segment (`⟳ N turns · M tools · …`) appends the run
 * statistics to the title badge on the terminal card, so the stats the
 * running card showed in its own line survive the transition.
 *
 * The status marker is carried as a separate segment with the title's hue:
 * both the fleet widget AND the transcript card colorize per-segment hues,
 * so the dot renders in the status color on every surface while the rest
 * of the title stays default-colored.  The flat `text` remains the segment
 * concatenation (backward compatible with consumers that only read it).
 *
 * @param marker - The terminal marker glyph (`●`, from the canonical table).
 * @param agent - The delegated subagent name (falls back to a placeholder).
 * @param label - The delegation's task description (omitted when absent).
 * @param hue - The terminal title's semantic hue (defaults to `success`).
 * @param model - The model id actually used by the sub-session (the id part
 *   of a `"provider/id"` string), omitted when unknown.
 * @param stats - The run-statistics text (omitted when absent).
 * @returns The terminal title line.
 */
export function renderTitle(
  marker: string,
  agent: string | undefined,
  label: string | undefined,
  hue: DisplayHue = "success",
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
  const rest = ` subagent(${name})${modelPart}${labelPart}${statsPart}`;
  return {
    text: `${marker}${rest}`,
    hue,
    segments: [{ text: marker, hue }, { text: rest }],
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
  /** This run's nested subagent runs (rendered as a recursive,
   * time-anchored tree). */
  children?: SubagentRun[];
}

/**
 * Project a run's fact log into the card's display lines.
 *
 * The single card projection, live or terminal:
 *   - running: no title line (the tool-call card's `renderCall` owns
 *     it); the body merges the current-tool line, the tool-call lines,
 *     the assistant output lines, and the nested subtrees into one
 *     timeline, then closes with the stats line.
 *   - terminal: a static title (`●`, hue from the canonical presentation
 *     table) badged with the run statistics and the descendant-failure
 *     count, the error reason when the run failed, the nested subtrees,
 *     and the final assistant text projected from the last message fact.
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
  const children = opts.children ?? [];
  const childIds = new Set(children.map((child) => child.id));
  const childGroups = childEntries(children, frame);

  if (meta.status === "running") {
    // The running body emits no title line — the tool-call card owns it,
    // and the tool-execution component stacks both cards, so a title here
    // would duplicate it.
    // The current activity is the youngest timeline entry: anchored at
    // `now`, it sorts after every recorded fact and every child already
    // started, so a parent that resumes work after delegating shows its
    // live tool name below the child rows instead of above them.
    const tool = currentToolLine(meta.currentTool);
    const current: TimelineEntry[] =
      tool !== undefined ? [{ at: now, lines: [tool] }] : [];
    // Merge the fact-derived lines with the child subtrees by timestamp: a
    // nested run's row lands where the run started, and the parent's later
    // tool / output lines render below it instead of above it.
    const output = outputEntries(facts, opts.expanded, glance, opts.width);
    const timeline = [
      ...toolEntries(facts, opts.expanded, glance, opts.width, childIds),
      ...output,
      ...childGroups.anchored,
      ...current,
    ].sort((a, b) => a.at - b.at);
    for (const entry of timeline) lines.push(...entry.lines);
    // A child without a usable time anchor degrades to trailing rows just
    // above the stats line.
    lines.push(...childGroups.unanchored);
    if (output.length === 0) {
      lines.push({ text: "(no output yet)", hue: "muted" });
    }
    lines.push({
      text: statsText(facts, meta.startedAt, now, childIds),
      hue: "muted",
    });
    return lines;
  }

  // Terminal card: the tool-call list is not repeated — the statistics
  // badge already summarizes the run's tools.  The title's marker and hue
  // come from the canonical presentation table through the domain mapping;
  // a run never renders its own ad-hoc marker.
  const presentation = STATUS_PRESENTATION[RUN_PRESENTATION[meta.status]];
  const title = renderTitle(
    presentation.glyph,
    meta.agent,
    undefined,
    presentation.hue,
    meta.model,
    statsText(facts, meta.startedAt, meta.endedAt ?? now, childIds),
  );
  // A successful run still flags a failure anywhere in its subtree; an
  // error parent already carries the failure marker and an aborted run is a
  // cancellation, not a failure, so neither gets the descendant badge.
  lines.push(
    meta.status === "done"
      ? badgeFailures(title, countDescendantErrors(children))
      : title,
  );
  if (meta.status === "error" && meta.error !== undefined) {
    lines.push({ text: meta.error, hue: "error", truncateToWidth: true });
  }
  // Nested subtrees render before the delivered result: the result is the
  // card's trailing region, and the child rows are anchored in the run's
  // earlier timeline.
  for (const entry of [...childGroups.anchored].sort((a, b) => a.at - b.at)) {
    lines.push(...entry.lines);
  }
  lines.push(...childGroups.unanchored);

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
 * Layout: `◆ <primary> · <spinner> <agent> <elapsed> · ● <done> ■ <failed>
 * ■ <aborted>`.  The spinner segment appears only while something is running; a zero count
 * omits that segment; with no activity at all the line is just
 * `◆ <primary>`.  The line is produced as per-segment hues (the `◆ <primary>`
 * part carries no hue, the running part carries its hue, and each done/failed
 * count is three segments — a separator, a colored dot, and an uncolored
 * number), so the widget colors only the status symbols independently: the
 * primary keeps its own host color, the dots stay colored, and the
 * separators / counts stay default.  The flat `text` field remains the
 * segment concatenation (backward compatible with the uncolored card).  The
 * line's dominant `hue` conveys the status priority — running > error >
 * success > muted (status is carried purely by color, never by text
 * markers, per the visual contract).
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
    const runningHue = STATUS_PRESENTATION.active.hue;
    for (const run of currentRunning) {
      segments.push({ text: " · " });
      segments.push({ text: spinner, hue: runningHue });
      segments.push({ text: " " });
      segments.push({ text: run.agent, agent: run.agent });
      const elapsed =
        run.elapsedMs === undefined
          ? "-:--"
          : formatSeconds(Math.max(0, Math.floor(run.elapsedMs / 1000)));
      segments.push({ text: ` ${elapsed}` });
    }
  }
  // Each done/failed/aborted count splits into three segments — the ` · `
  // separator, the bare glyph, and the number (` · ● 2`), so only the glyph
  // carries the status hue.  The first glyph's separator leads with ` · `;
  // each further glyph (any earlier count present) is separated by a single
  // space.  Only the glyph carries the status hue — the separator and the
  // number stay default so the punctuation is never tinted green/red/gray.
  if (summary.done > 0) {
    segments.push({ text: " · " });
    segments.push({
      text: STATUS_PRESENTATION.succeeded.glyph,
      hue: STATUS_PRESENTATION.succeeded.hue,
    });
    segments.push({ text: ` ${summary.done}` });
  }
  if (summary.failed > 0) {
    segments.push({ text: summary.done > 0 ? " " : " · " });
    segments.push({
      text: STATUS_PRESENTATION.failed.glyph,
      hue: STATUS_PRESENTATION.failed.hue,
    });
    segments.push({ text: ` ${summary.failed}` });
  }
  if (summary.aborted > 0) {
    segments.push({
      text: summary.done > 0 || summary.failed > 0 ? " " : " · ",
    });
    segments.push({
      text: STATUS_PRESENTATION.cancelled.glyph,
      hue: STATUS_PRESENTATION.cancelled.hue,
    });
    segments.push({ text: ` ${summary.aborted}` });
  }

  const hue: DisplayHue =
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
 * Both resolve through the canonical `STATUS_PRESENTATION` table via the
 * `RUN_PRESENTATION` mapping: an `active` run shows the spinner glyph
 * (frame-indexed, so consecutive renders animate) with the table's `running`
 * hue; every terminal status shows the table's static glyph with its hue —
 * success for a finished run, error for a failed one, muted for an
 * interrupted one.  The
 * spinner flag is what separates the animated running row from the static
 * blocked-style one.
 *
 * @param run - The run.
 * @param frameSeq - The shared spinner frame sequence.
 * @returns The glyph and its semantic hue.
 */
function fleetGlyph(
  run: SubagentRun,
  frameSeq: number,
): { glyph: string; hue: DisplayHue } {
  const presentation = STATUS_PRESENTATION[RUN_PRESENTATION[run.status]];
  if (presentation.spinner === true) {
    return {
      glyph: SPINNER_FRAMES[spinnerFrameIndex(frameSeq)],
      hue: presentation.hue,
    };
  }
  return { glyph: presentation.glyph, hue: presentation.hue };
}

/**
 * Build the display lines for the expanded fleet widget.
 *
 * Each run renders one row: `<spinner|●> <agent> · <label> · <duration>`.
 * The selected row is flagged with `selected` (the adapter applies a
 * reverse-video highlight — selection is never a text marker, so the
 * structural `▸/▾` glyphs stay reserved for folding).  A run's nested
 * children (from `childrenByParent`) render immediately beneath it, and the
 * recursion continues through every generation: each level indents one more
 * step with `TREE_BRANCH` for all but the last sibling and `TREE_LAST` for
 * the last, while the ancestors' indent accumulates `TREE_PIPE` (a still-
 * open level) or three spaces (a closed level).  A selected row at any
 * depth is flagged the same way.
 *
 * The `entries` list is expected to be the windowed, sorted top-level runs
 * (`registry.windowRuns`); `childrenByParent` is a precomputed map of
 * parent-run id → child runs that must cover every run with children, not
 * only the top-level ones.  Durations reuse `formatElapsed`.
 *
 * @param entries - The visible top-level runs (already windowed and sorted).
 * @param childrenByParent - Parent-run id → its child runs (all depths).
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
    const { glyph, hue } = fleetGlyph(run, frameSeq);
    lines.push(
      fleetRowLine(
        "",
        glyph,
        hue,
        fleetRowBody(run, now),
        run.id === selectedId,
      ),
    );
    lines.push(
      ...fleetChildRows(
        childrenByParent.get(run.id) ?? [],
        "",
        childrenByParent,
        selectedId,
        frameSeq,
        now,
      ),
    );
  }
  return lines;
}

/**
 * Render one sibling group's rows and, recursively, their descendants.
 *
 * Mirrors the card subtree's indent rules (`childSubtreeLines`): each row is
 * prefixed with its sibling branch glyph (`TREE_BRANCH` / `TREE_LAST`) and a
 * space, and the indent handed to the next generation extends the ancestor
 * prefix with `TREE_PIPE` while a later sibling remains below, or three
 * spaces when the ancestor was last.
 *
 * @param children - The sibling group to render (oldest first).
 * @param ancestorPrefix - The indent accumulated from ancestor levels.
 * @param childrenByParent - Parent-run id → its child runs (all depths).
 * @param selectedId - The selected run id, or `undefined` for no selection.
 * @param frameSeq - The shared spinner frame sequence.
 * @param now - The current epoch-millis time (injected for determinism).
 * @returns The rendered rows for the group and its descendants.
 */
function fleetChildRows(
  children: SubagentRun[],
  ancestorPrefix: string,
  childrenByParent: Map<string, SubagentRun[]>,
  selectedId: string | undefined,
  frameSeq: number,
  now: number,
): CardLine[] {
  const lines: CardLine[] = [];
  children.forEach((child, index) => {
    const isLast = index === children.length - 1;
    const branch = isLast ? TREE_LAST : TREE_BRANCH;
    const { glyph, hue } = fleetGlyph(child, frameSeq);
    lines.push(
      fleetRowLine(
        `${ancestorPrefix}${branch} `,
        glyph,
        hue,
        fleetRowBody(child, now),
        child.id === selectedId,
      ),
    );
    const nested = childrenByParent.get(child.id);
    if (nested === undefined || nested.length === 0) return;
    const childPrefix = `${ancestorPrefix}${isLast ? "   " : TREE_PIPE}`;
    lines.push(
      ...fleetChildRows(
        nested,
        childPrefix,
        childrenByParent,
        selectedId,
        frameSeq,
        now,
      ),
    );
  });
  return lines;
}

/**
 * Build one fleet row line as colorized segments.
 *
 * The tree/prefix characters carry no hue (default color); only the status
 * glyph (`<spinner|●>`) carries the status hue.  The body splits into the
 * bare agent name (marked with its `agent` so the adapter colorizes it with
 * the configured `[agent.<name>].color`) and the plain
 * ` · <label> · <duration>` remainder, so a terminal row does not tint the
 * whole line green/red (visual-noise fix) while the agent name keeps its own
 * color.  The flat `text` is the segment concatenation, so the uncolored
 * card path renders identically.  Selection is carried only as the line's
 * `selected` flag — no marker text is emitted.
 *
 * @param prefix - The characters between the line start and the glyph (` `
 *   for a top-level row, `${TREE_BRANCH} ` / `${TREE_LAST} ` for a nested
 *   child).
 * @param glyph - The status glyph (`<spinner|●>`).
 * @param hue - The glyph's semantic hue.
 * @param body - The row body (`<agent> · <label> · <duration>`).
 * @param selected - Whether the row is the widget's selected row.
 * @returns The row line with its per-segment hues.
 */
function fleetRowLine(
  prefix: string,
  glyph: string,
  hue: DisplayHue,
  body: string,
  selected: boolean,
): CardLine {
  const segments: CardSegment[] = [{ text: prefix }, { text: glyph, hue }];
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
    selected,
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
 * The current activity of a running child run, when it has one.
 *
 * The delegating driver patches the registry run's `currentTool` as it
 * observes tool events, so that field is the primary source; a run whose
 * tool field is unset (a restored or hand-built run) falls back to the
 * newest tool-start fact with no matching tool-end.  A terminal run reports
 * no activity — its work is over, and the row must stop advertising a tool
 * that will never advance.
 *
 * @param child - The child run.
 * @returns The activity text, or `undefined` when the run is idle/terminal.
 */
function childActivity(child: SubagentRun): string | undefined {
  if (child.status !== "running") return undefined;
  if (child.currentTool !== undefined && child.currentTool.length > 0) {
    return child.currentTool;
  }
  return lastUnfinishedTool(child.log.facts());
}

/**
 * The tool name of the newest unfinished tool-start fact.
 *
 * A tool-start with no later matching tool-end is the call still in flight.
 * The match is by tool name (facts without a tool-call id cannot be matched
 * by id), which is exact for the sequential execution the host performs.
 *
 * @param facts - The child run's facts.
 * @returns The tool name, or `undefined` when every call finished.
 */
function lastUnfinishedTool(facts: readonly RunFact[]): string | undefined {
  const open: string[] = [];
  for (const fact of facts) {
    if (fact.type === "tool_start") {
      open.push(fact.toolName);
    } else if (fact.type === "tool_end") {
      const index = open.lastIndexOf(fact.toolName);
      if (index !== -1) open.splice(index, 1);
    }
  }
  return open.length > 0 ? open[open.length - 1] : undefined;
}

/**
 * Build the card lines for one child run and, recursively, its descendants.
 *
 * The child renders one row — `<branch> <spinner|●> subagent(<agent>) ·
 * <label> · <activity>` — with the branch glyph chosen from the child's
 * position among its siblings (`TREE_LAST` for the last, `TREE_BRANCH`
 * otherwise) and the indent accumulated from every ancestor level.  The
 * activity segment appears only while the run is live.  Descendants come
 * from the registry (`childrenOf`), one level deeper with the ancestor's
 * indent extended, so the whole subtree renders as a tree.
 *
 * @param child - The child run.
 * @param isLast - Whether the child is the last of its siblings.
 * @param ancestorPrefix - The indent accumulated from ancestor levels.
 * @param frameSeq - The shared spinner frame sequence.
 * @returns The subtree's display lines (the child row first).
 */
function childSubtreeLines(
  child: SubagentRun,
  isLast: boolean,
  ancestorPrefix: string,
  frameSeq: number,
): CardLine[] {
  const { glyph, hue } = fleetGlyph(child, frameSeq);
  const labelPart =
    child.label !== undefined && child.label.length > 0
      ? ` · ${child.label}`
      : "";
  const activity = childActivity(child);
  const activityPart = activity !== undefined ? ` · ${activity}` : "";
  const branch = isLast ? TREE_LAST : TREE_BRANCH;
  const body = `subagent(${child.agent})${labelPart}${activityPart}`;
  const lines: CardLine[] = [
    { text: `${ancestorPrefix}${branch} ${glyph} ${body}`, hue },
  ];
  const children = childrenOf(child.id);
  const childPrefix = `${ancestorPrefix}${isLast ? "   " : TREE_PIPE}`;
  children.forEach((descendant, index) => {
    lines.push(
      ...childSubtreeLines(
        descendant,
        index === children.length - 1,
        childPrefix,
        frameSeq,
      ),
    );
  });
  return lines;
}

/**
 * Split the child runs into timeline-anchored groups and trailing lines.
 *
 * A child whose `startedAt` is known anchors its subtree group on the
 * parent's timeline; a child without a usable anchor (a restored entry
 * whose timestamp is zero) degrades to trailing lines the caller appends
 * just before its trailing region.
 *
 * @param children - The run's direct child runs (oldest first).
 * @param frameSeq - The shared spinner frame sequence.
 * @returns The anchored groups and the unanchored lines.
 */
function childEntries(
  children: SubagentRun[],
  frameSeq: number,
): { anchored: TimelineEntry[]; unanchored: CardLine[] } {
  const anchored: TimelineEntry[] = [];
  const unanchored: CardLine[] = [];
  children.forEach((child, index) => {
    const lines = childSubtreeLines(
      child,
      index === children.length - 1,
      "",
      frameSeq,
    );
    if (child.startedAt > 0) {
      anchored.push({ at: child.startedAt, lines });
    } else {
      unanchored.push(...lines);
    }
  });
  return { anchored, unanchored };
}

/**
 * Count every descendant run (all generations) that finished with an error.
 *
 * Recurses through `childrenOf`, so a failure buried under a successful
 * intermediate run still surfaces on the top-level card's title.
 *
 * @param children - The direct child runs.
 * @returns The number of error descendants.
 */
function countDescendantErrors(children: SubagentRun[]): number {
  let count = 0;
  for (const child of children) {
    if (child.status === "error") count += 1;
    count += countDescendantErrors(childrenOf(child.id));
  }
  return count;
}

/**
 * Append the descendant-failure badge to a terminal title.
 *
 * The badge (`■ N failed`, error-hued) marks that a run which itself
 * succeeded still has a failed run somewhere beneath it.  Only a `done`
 * parent gets the badge: an error parent already carries the failure marker
 * and an aborted run is a cancellation, not a failure.
 *
 * @param title - The terminal title line.
 * @param failures - The number of error descendants.
 * @returns The title, badged when failures were counted.
 */
function badgeFailures(title: CardLine, failures: number): CardLine {
  if (failures <= 0) return title;
  const badge = `■ ${failures} failed`;
  const segments: CardSegment[] = [
    ...(title.segments ?? []),
    { text: " · " },
    { text: badge, hue: "error" },
  ];
  return { ...title, text: segments.map((s) => s.text).join(""), segments };
}
