/**
 * Compact snapshot text formatting for subagent progress.
 *
 * Progress snapshots streamed during a subagent run must stay small — the
 * full subagent transcript never flows through them.  This module owns the
 * host-agnostic side of that contract: compacting a raw text string into a
 * single capped line, and rendering a `SubagentProgress` snapshot into the
 * one-line text shown in the parent session's tool-call UI.  Host drivers
 * call these helpers when they turn host events into snapshots; nothing
 * here knows how any host emits its events.
 *
 * @module
 */

import type { SubagentProgress } from "./driver.js";

/** The ellipsis marker appended to a truncated snapshot line. */
export const SNAPSHOT_ELLIPSIS = "…";

/** The hard cap on a snapshot's output text, in characters. */
export const SNAPSHOT_OUTPUT_CAP = 200;

/**
 * Compact a raw text string into a single capped snapshot line.
 *
 * Takes the last non-empty line of the text (trailing newlines yield the
 * last non-empty line, never a blank).  When that line is longer than the
 * cap it is truncated and an ellipsis marker is appended, so the result
 * never exceeds the cap.
 *
 * @param text - The raw text to compact (e.g. an assistant message's text).
 * @param cap - The maximum output length in characters (defaults to
 *   `SNAPSHOT_OUTPUT_CAP`).
 * @returns The last non-empty line, truncated to the cap with an ellipsis
 *   marker when needed.
 */
export function formatSnapshotOutput(
  text: string,
  cap: number = SNAPSHOT_OUTPUT_CAP,
): string {
  const lines = text.split("\n");
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length > 0) {
      last = lines[i];
      break;
    }
  }
  if (last.length <= cap) return last;
  const keep = Math.max(0, cap - SNAPSHOT_ELLIPSIS.length);
  return last.slice(0, keep) + SNAPSHOT_ELLIPSIS;
}

/**
 * Render a progress snapshot into a compact one-line text.
 *
 * Prefixes the compact output with the running tool name in brackets when
 * one is present, e.g. `[bash] <last line>`.  An explicit "no tool running"
 * signal (`currentTool: null`) and an absent field ("unchanged") both render
 * no prefix — only a tool name does.  An optional short `label` (e.g. the
 * delegation's description tag) is prepended before any tool name, e.g.
 * `[<label>] [bash] <last line>`.  The output part is capped by
 * `formatSnapshotOutput`; the label and tool prefixes sit outside the cap.
 *
 * @param progress - The snapshot to render.
 * @param cap - The maximum output length in characters (defaults to
 *   `SNAPSHOT_OUTPUT_CAP`).
 * @param label - An optional short label prefixed before the tool name.
 * @returns The one-line snapshot text.
 */
export function formatProgressLine(
  progress: SubagentProgress,
  cap: number = SNAPSHOT_OUTPUT_CAP,
  label?: string,
): string {
  const output = formatSnapshotOutput(progress.output, cap);
  const labelPrefix =
    label !== undefined && label.length > 0 ? `[${label}] ` : "";
  const toolPrefix =
    typeof progress.currentTool === "string"
      ? `[${progress.currentTool}] `
      : "";
  return `${labelPrefix}${toolPrefix}${output}`;
}
