/**
 * Structured progress accumulation for subagent transcript rendering.
 *
 * The pi driver extracts raw facts from the sub-session event stream (a
 * tool started, a tool call finished with a summary, an assistant turn
 * completed, an output line produced) and feeds them to this pure
 * accumulator.  It maintains the bounded structured view — recent tool
 * calls, recent output lines, turn / tool-call counters, and the start
 * time — that the transcript view model (`view.ts`) renders as the live
 * TUI card.  Host-agnostic: nothing here knows how any host emits its
 * events.
 *
 * @module
 */

import { homedir } from "node:os";
import type { SubagentProgress } from "./driver.js";

/** Hard cap on the number of recent tool calls kept in the view. */
export const RECENT_TOOL_CAP = 15;

/** Hard cap on the number of recent output lines kept in the view. */
export const RECENT_OUTPUT_CAP = 15;

/** Hard cap on the one-line summary of a tool call's arguments. */
export const SUMMARY_CAP = 80;

/** Cap on a bash command preview inside a tool-call summary. */
const TOOL_COMMAND_CAP = 60;

/** Cap on the JSON-args preview of an unknown tool inside a summary. */
const TOOL_ARGS_CAP = 40;

/**
 * The mutable accumulator state for one subagent run.
 *
 * Bounded: `toolCalls` and `outputLines` never exceed their caps — the
 * full subagent transcript never flows through here.
 */
export interface StructuredProgressState {
  /** Epoch-millis start time of the run. */
  startedAt: number;
  /** Recent tool calls (name + one-line summary), most recent last. */
  toolCalls: Array<{ name: string; summary: string }>;
  /** Recent output lines, most recent last. */
  outputLines: string[];
  /** Number of completed assistant turns. */
  turnCount: number;
  /** Number of tool calls started. */
  toolCallCount: number;
  /** Total tokens reported by the sub-session's assistant messages, when
   * the provider reports usage.  `undefined` until the first usage-bearing
   * message is observed. */
  tokens?: number;
  /** Arguments of the most recent tool execution start (for the one-line
   * summary at `tool_execution_end`, which pi emits without args). */
  lastToolArgs?: Record<string, unknown>;
}

/**
 * Create a fresh accumulator state.
 *
 * @param startedAt - Epoch-millis start time (defaults to the current time).
 * @returns The empty structured state.
 */
export function createStructuredProgress(
  startedAt: number = Date.now(),
): StructuredProgressState {
  return {
    startedAt,
    toolCalls: [],
    outputLines: [],
    turnCount: 0,
    toolCallCount: 0,
  };
}

/**
 * Push a value onto a bounded list, dropping the oldest entry past the cap.
 *
 * @param list - The bounded list.
 * @param value - The value to append.
 * @param cap - The maximum list length.
 */
function boundedPush<T>(list: T[], value: T, cap: number): void {
  list.push(value);
  if (list.length > cap) list.splice(0, list.length - cap);
}

/**
 * Record a tool call start (advances the tool-call counter only).
 *
 * @param state - The accumulator state.
 * @param args - The tool-call arguments, retained for the one-line summary
 *   at `tool_execution_end`.
 */
export function recordToolStart(
  state: StructuredProgressState,
  args?: Record<string, unknown>,
): void {
  state.toolCallCount += 1;
  state.lastToolArgs = args;
}

/**
 * Record a completed tool call with a one-line summary.
 *
 * @param state - The accumulator state.
 * @param name - The tool name.
 * @param summary - A one-line summary of what the tool did.
 */
export function recordToolCall(
  state: StructuredProgressState,
  name: string,
  summary: string,
): void {
  boundedPush(
    state.toolCalls,
    { name, summary: truncate(summary, SUMMARY_CAP) },
    RECENT_TOOL_CAP,
  );
}

/**
 * Record one completed assistant turn.
 *
 * @param state - The accumulator state.
 */
export function recordTurn(state: StructuredProgressState): void {
  state.turnCount += 1;
}

/**
 * Accumulate a token-usage report from one assistant message.
 *
 * Sums the reported totals into the running count; the first report flips
 * the `tokens` field from `undefined` to a number, so an absent
 * usage-bearing message keeps the field absent (the card omits the token
 * segment).
 *
 * @param state - The accumulator state.
 * @param tokens - The total tokens reported for one assistant message
 *   (may be undefined/NaN when the provider omits usage).
 */
export function recordTokens(
  state: StructuredProgressState,
  tokens: number,
): void {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) {
    return;
  }
  state.tokens = (state.tokens ?? 0) + tokens;
}

/**
 * Record a recent output line (bounded).
 *
 * @param state - The accumulator state.
 * @param line - The output line text.
 */
export function recordOutput(
  state: StructuredProgressState,
  line: string,
): void {
  boundedPush(
    state.outputLines,
    truncate(line, SUMMARY_CAP),
    RECENT_OUTPUT_CAP,
  );
}

/**
 * Truncate a string to a maximum length with an ellipsis marker.
 *
 * @param text - The string to truncate.
 * @param limit - The maximum length.
 * @returns The truncated string.
 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const keep = Math.max(1, limit - 1);
  return `${text.slice(0, keep)}…`;
}

/** The ESC control character, kept out of the regex literal. */
const ESC = "\u001b";

/** Matches an ANSI SGR sequence like `ESC[31m` or `ESC[0m`. */
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/**
 * Strip ANSI escape sequences and collapse whitespace runs.
 *
 * Tool outputs (and sometimes arguments) arrive with terminal color codes
 * and stray whitespace; a one-line TUI summary must render them as plain,
 * single-spaced text.
 *
 * @param text - The raw text.
 * @returns The cleaned text: ANSI `ESC[...m` sequences removed, every
 *   whitespace run collapsed to a single space, trimmed.
 */
function clean(text: string): string {
  return text.replace(ANSI_RE, "").replace(/\s+/g, " ").trim();
}

/**
 * Render a one-line summary of a value (typically tool arguments).
 *
 * A string is returned verbatim (capped); any other value is JSON-stringified
 * and capped; nullish input yields an empty string.  The text is ANSI-cleaned
 * and whitespace-collapsed before truncation.
 *
 * @param value - The value to summarize.
 * @returns The one-line summary.
 */
export function summarizeValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  let text = "";
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    text = String(value);
  }
  return truncate(clean(text), SUMMARY_CAP);
}

/**
 * Render a one-line summary of a tool call from its arguments.
 *
 * Prefers the tool-call *arguments* (what the subagent asked the tool to do)
 * over the result payload, following the pi-subagents `formatToolCall`
 * conventions: bash renders as `$ <command>` (capped at 60), read / write /
 * edit render as `<name> <path>` (the `file_path` or `path` argument, with
 * `$HOME` collapsed to `~`), and any other tool renders as
 * `<name> <JSON.stringify(args)>` (capped at 40).  All text is ANSI-cleaned
 * and whitespace-collapsed before truncation.
 *
 * @param name - The tool name.
 * @param args - The tool-call arguments (may be undefined for malformed
 *   events).
 * @returns The one-line tool-call summary.
 */
export function summarizeToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  const argsObj =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? args
      : {};
  switch (name) {
    case "bash": {
      const command =
        typeof argsObj.command === "string" ? argsObj.command : "";
      return command.length > 0
        ? `$ ${truncate(clean(command), TOOL_COMMAND_CAP)}`
        : "$ …";
    }
    case "read":
    case "write":
    case "edit": {
      const rawPath = argsObj.file_path ?? argsObj.path;
      const path =
        typeof rawPath === "string" && rawPath.length > 0
          ? shortenHome(clean(rawPath))
          : "…";
      return `${name} ${truncate(path, SUMMARY_CAP)}`;
    }
    default: {
      const json = JSON.stringify(argsObj) ?? "";
      return `${name} ${truncate(clean(json), TOOL_ARGS_CAP)}`;
    }
  }
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
 * Project the accumulator state onto the structured snapshot fields of a
 * `SubagentProgress` (the optional structured fields only).
 *
 * @param state - The accumulator state.
 * @returns The structured progress fields.
 */
export function toSnapshot(
  state: StructuredProgressState,
): Partial<SubagentProgress> {
  return {
    toolCalls: state.toolCalls,
    outputLines: state.outputLines,
    turnCount: state.turnCount,
    toolCallCount: state.toolCallCount,
    startedAt: state.startedAt,
    ...(state.tokens !== undefined ? { tokens: state.tokens } : {}),
  };
}
