/**
 * Direct Work Nudge hook for ZooKeeper OpenCode plugin.
 *
 * After every edit/write tool call, appends a protocol reminder telling the
 * orchestrator to delegate work via `task()` instead of doing it directly.
 *
 * @module
 */

import { debug } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Full nudge text appended to edit/write tool output.
 *
 * Reminds the orchestrator that direct editing violates protocol and should
 * be delegated via `task()`.
 */
export const DIRECT_WORK_NUDGE = `**DELEGATION REQUIRED** — You just edited a source file directly.

Did you ACTUALLY need to be the one doing that?

- Documentation, design docs, research reports, prompts → **fine, this is your job.** Continue.
- Tiny verification fix during subagent review → fine, continue.
- Anything else → **you violated orchestrator protocol.**
  Revert the change and delegate it via \`task()\`.

**Build does not implement. Build orchestrates.**`;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Append a protocol nudge to edit/write tool output.
 *
 * Fires on EVERY edit/write tool call regardless of the file path.  Non-null
 * output gets the nudge appended.  Non-matching tools are skipped.
 *
 * @param input - Input containing the tool name.
 * @param input.tool - Name of the tool that was executed.
 * @param output - Output object mutated in place.
 * @param output.output - Text output from the tool call.
 */
export function nudgeDirectWork(
  input: { tool: string },
  output: { output?: string },
): void {
  const tool = input.tool.toLowerCase();
  if (tool !== "edit" && tool !== "write") return;
  if (output.output == null) return;

  output.output += `\n\n${DIRECT_WORK_NUDGE}`;

  debug("direct-work-nudge", { tool: input.tool });
}
