/**
 * Display helpers of the OpenCode TUI sidebar panel.
 *
 * The subagent state machine this module used to own is gone: run state now
 * lives in the core registry and host facts reach it through the translator
 * (`src/adapters/opencode/subagent-source.ts`).  What remains here are the
 * panel-level pure helpers — the category breakdown shape the context
 * controller writes and the duration formatting the subagent rows render.
 *
 * @module
 */

/** Category values for sidebar breakdown display. */
export interface CategoryInfo {
  user: number;
  assistant: number;
  tool: number;
  system: number;
  total: number;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * - < 60 s  →  "12s"
 * - ≥ 60 s  →  "2m05s" (seconds zero-padded)
 * - negative, NaN, Infinity  →  "—"
 *
 * @param ms - The duration in milliseconds.
 * @returns The formatted duration.
 */
export function formatDuration(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${String(sec).padStart(2, "0")}s`;
}
