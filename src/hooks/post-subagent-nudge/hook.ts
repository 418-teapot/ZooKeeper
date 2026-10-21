/**
 * Post-subagent nudge hook for ZooKeeper plugin.
 *
 * After every subagent tool execution, appends a verification reminder and
 * delegates todo and plan progress nudges to `checkTodoProgress` and
 * `checkPlanProgress` from `src/core/checks.ts`.
 *
 * @module
 */

import { checkPlanProgress, checkTodoProgress } from "../../core/checks.js";
import { applyNudge } from "../../core/nudge.js";
import { VERIFY_REMINDER } from "../../core/prompts.js";
import type { TodoSource } from "../../core/todo/source.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Nudge dolphin after a subagent call.
 *
 * Injects `VERIFY_REMINDER`, then delegates to `checkTodoProgress` and
 * `checkPlanProgress` for additional nudges. Both check functions handle
 * their own error logging; this function only assembles the output.
 *
 * The todo entries are read through `source`; which backend serves that
 * read is decided by the caller once at composition time. When `source`
 * is `null` the todo nudge contribution is skipped, while the verification
 * reminder and the plan nudge still run — neither depends on todo state.
 *
 * @param source - Port reading the session's todo entries, or `null` to
 *   skip the todo nudge.
 * @param input - Hook input containing the tool name and session ID.
 * @param input.tool - Name of the tool that was executed.
 * @param input.sessionID - Session identifier for todo/plan lookup.
 * @param output - Hook output object mutated in place.
 * @param output.output - Text output from the tool call.
 * @param planDir - Workspace base directory containing `.zoo/plans/`.
 */
export async function nudgePostSubagent(
  source: TodoSource | null,
  input: { tool: string; sessionID: string; callID?: string },
  output: { output?: string },
  planDir: string,
): Promise<void> {
  // Facts exposed to the injected log; filled by the text provider.
  let hasTodo = false;
  let hasPlan = false;

  await applyNudge({
    hook: "post-subagent-nudge",
    sessionID: input.sessionID,
    callID: input.callID,
    tool: input.tool,
    output,
    rules: [
      {
        // Skip non-delegation tools.
        matches: (tool) => tool === "subagent",
        // Skip null / undefined output (silently — only the direct-work
        // nudge logs this skip).
        guards: [() => (output.output == null ? {} : null)],
        text: async () => {
          // Todo progress check (async — read through the injected source).
          const todoNudge = source
            ? await checkTodoProgress(source, input.sessionID)
            : null;
          // Plan progress check (sync — filesystem read).
          const planNudge = checkPlanProgress(input.sessionID, planDir);
          hasTodo = !!todoNudge;
          hasPlan = !!planNudge;
          return [VERIFY_REMINDER, todoNudge, planNudge]
            .filter((part): part is string => part != null)
            .join("\n\n");
        },
        event: "nudge_injected",
        fields: () => ({ has_todo: hasTodo, has_plan: hasPlan }),
      },
    ],
  });
}
