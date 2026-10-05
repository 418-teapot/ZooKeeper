/**
 * Pi host adapter — the terminal tool result's durable `details` payload.
 *
 * pi persists a tool result's `details` (a partial's never do), so this is
 * the only payload a subagent run leaves behind for a view to re-hydrate
 * the run's facts after a restart: the sub-session file path the driver
 * reported mid-run, plus the run's terminal status once it has one.  The
 * merge helper folds a contribution's write-back details under the
 * bridge's own keys so no tool can displace the run's fact pointer.
 *
 * The module also carries the truecolor ANSI foreground helper the pi TUI
 * colorizers reuse for agent-colored text.
 *
 * @module
 */

import { getRun, TERMINAL_STATUSES } from "../../core/subagent/registry.js";

/**
 * Wrap text in a truecolor ANSI foreground sequence for a `#RRGGBB` hex.
 *
 * `\x1b[38;2;<r>;<g>;<b>m<text>\x1b[39m` — the same escape form the widget
 * `colorizeAgent` uses for agent names, reused here so the transcript
 * overlay border can carry the inspected run's agent color.  pi's Text /
 * widget components preserve ANSI codes and are ANSI-width-aware.
 *
 * @param hex - The normalized uppercase `#RRGGBB` hex color.
 * @param text - The text to wrap.
 * @returns The text wrapped in the truecolor foreground sequence.
 */
export function truecolorWrap(hex: string, text: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/**
 * The terminal tool result's persisted `details`.
 *
 * pi writes a tool result's `details` into the session file (a partial's
 * never do), so this is the only durable payload a subagent run leaves
 * behind.  It carries:
 *
 * - `sessionPath` — the sub-session file path the driver reported mid-run,
 *   looked up by run id (the tool-call id) in the process-level run
 *   registry; a view re-hydrates the run's facts from it after a restart.
 * - `outcome` — the run's terminal status (`done` / `error` / `aborted`),
 *   present only when the run has already reached a terminal state.  The
 *   restored-render path uses it to show the true lifecycle status (an
 *   aborted run must not fall back to the green done dot, which the bare
 *   `isError` flag alone cannot distinguish).
 *
 * Tools without a registry run (compress / decompress, or a call id that
 * is not a subagent delegation) contribute an empty object.
 *
 * @param toolCallId - pi's tool-call id for the finished call.
 * @returns The `{ sessionPath?, outcome? }` payload, or `{}` when there
 *   is nothing to point at.
 */
export function terminalToolDetails(
  toolCallId: unknown,
): Record<string, unknown> {
  const run = typeof toolCallId === "string" ? getRun(toolCallId) : undefined;
  if (run === undefined) return {};
  const details: Record<string, unknown> = {};
  if (run.sessionPath !== undefined) details.sessionPath = run.sessionPath;
  if (TERMINAL_STATUSES.has(run.status)) details.outcome = run.status;
  return details;
}

/**
 * Whether a value is a plain object usable as a details record.
 *
 * The bridge merges a contribution's structured details into its own
 * result details; only a non-null object can be spread, anything else
 * (a string, a number, an array) is dropped.
 *
 * @param value - The candidate details payload.
 * @returns True when the value can be spread into the details object.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge a contribution's write-back details into the bridge's own.
 *
 * The contribution's payload adds keys; the bridge's keys always win, so a
 * tool can never displace the run's fact pointer by writing a `details`
 * object that happens to carry the same key.
 *
 * @param toolCallId - pi's tool-call id for the finished call.
 * @param contributionDetails - Whatever the contribution wrote back (a
 *   non-record is dropped).
 * @returns The persisted details record.
 */
export function mergeTerminalToolDetails(
  toolCallId: unknown,
  contributionDetails: unknown,
): Record<string, unknown> {
  return {
    ...(isPlainRecord(contributionDetails) ? contributionDetails : {}),
    ...terminalToolDetails(toolCallId),
  };
}
