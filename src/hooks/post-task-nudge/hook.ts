/**
 * Post-task nudge hook for ZooKeeper OpenCode plugin.
 *
 * After every `task()` tool execution, appends a verification reminder and,
 * based on the session's todo list state, a todo-update nudge to the
 * tool output. This guides the orchestrator LLM to verify subagent work
 * and keep the todo list in sync.
 *
 * @module
 */

import { log } from "../../utils/logger.js";
import { TODO_FINAL_ACTIVE, TODO_GENERAL } from "../utils/prompts.js";
import { getTodoState } from "../utils/todo-state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Reminder text injected after every task() call, instructing the
 * orchestrator to verify the subagent's work before proceeding.
 */
export const VERIFY_REMINDER =
  "**THE SUBAGENT JUST CLAIMED THIS TASK IS DONE. THEY ARE PROBABLY LYING.**\n" +
  "\n" +
  'Subagents say "done" when code has errors, tests pass trivially, logic is wrong,\n' +
  "or they quietly added features nobody asked for. This happens EVERY TIME.\n" +
  "Assume the work is broken until YOU prove otherwise.\n" +
  "\n" +
  "**PHASE 1: READ THE CODE FIRST (before running anything)**\n" +
  "\n" +
  "1. See exactly which files changed. Any file outside expected scope = scope creep.\n" +
  "2. `Read` EVERY changed file - no exceptions, no skimming.\n" +
  "3. For EACH file, critically ask:\n" +
  "   - Does this code ACTUALLY do what the task required?\n" +
  "   - Any stubs, TODOs, placeholders, hardcoded values?\n" +
  "   - Logic errors? Trace the happy path AND the error path in your head.\n" +
  "   - Scope creep? Did the subagent touch things or add features NOT in the task spec?\n" +
  "4. Cross-check every claim:\n" +
  '   - Said "Updated X" - READ X. Actually updated, or just superficially touched?\n' +
  '   - Said "Added tests" - READ the tests. Do they test REAL behavior or just `expect(true).toBe(true)`?\n' +
  '   - Said "Follows patterns" - OPEN a reference file. Does it ACTUALLY match?\n' +
  "\n" +
  "**If you cannot explain what every changed line does, you have NOT reviewed it.**\n" +
  "\n" +
  "**PHASE 2: RUN AUTOMATED CHECKS (targeted, then broad)**\n" +
  "\n" +
  "1. `lsp_diagnostics` on EACH changed file - ZERO new errors\n" +
  "2. Run tests for changed modules FIRST, then full suite\n" +
  "3. Build/typecheck - exit 0\n" +
  "\n" +
  "If Phase 1 found issues but Phase 2 passes: Phase 2 is WRONG. The code has bugs that tests don't cover. Fix the code.\n" +
  "\n" +
  "**PHASE 3: GATE DECISION - Should you proceed to the next task?**\n" +
  "\n" +
  "Answer honestly:\n" +
  "1. Can I explain what EVERY changed line does? (If no - back to Phase 1)\n" +
  "2. Did I SEE it work with my own eyes? (If user-facing and no - run it yourself)\n" +
  "3. Am I confident nothing existing is broken? (If no - run broader tests)\n" +
  "\n" +
  'ALL three must be YES. "Probably" = NO. "I think so" = NO. Investigate until CERTAIN.\n' +
  "\n" +
  "- **All 3 YES** - Proceed: mark task complete, move to next.\n" +
  "- **Any NO** - Reject: resume with `task_id`, fix the specific issue.\n" +
  '- **Unsure** - Reject: "unsure" = "no". Investigate until you have a definitive answer.\n' +
  "\n" +
  "**DO NOT proceed to the next task until all 3 phases are complete and the gate passes.";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Nudge the orchestrator after a task() call.
 *
 * Always appends `VERIFY_REMINDER`. Then fetches the session's todo list
 * and decides which todo nudge (if any) to append:
 *
 * - All items completed / cancelled → VERIFY only (no todo nudge).
 * - 1 item `in_progress`, 0 `pending` → TODO_FINAL_ACTIVE.
 * - Any other active state          → TODO_GENERAL.
 * - API failure when fetching todos → TODO_GENERAL (fallback).
 *
 * @param client - OpenCode client captured via closure in the plugin factory.
 * @param input - Hook input containing the tool name and session ID.
 * @param input.tool - Name of the tool that was executed.
 * @param input.sessionID - Session identifier for todo lookup.
 * @param output - Hook output object mutated in place.
 * @param output.output - Text output from the tool call.
 */
export async function nudgePostTask(
  client:
    | {
        session: {
          todo: (opts: { path: { id: string } }) => Promise<{
            data: Array<{
              content: string;
              status: string;
              priority: string;
              id: string;
            }>;
          }>;
        };
      }
    | null
    | undefined,
  input: { tool: string; sessionID: string; callID?: string },
  output: { output?: string },
): Promise<void> {
  // Skip non-task tools
  if (input.tool.toLowerCase() !== "task") return;

  // Skip null / undefined output
  if (output.output == null) return;

  // Skip if no client available — OpenCode runtime may not provide one
  if (!client) return;

  // Always inject VERIFY_REMINDER for task tools
  let suffix = `\n\n${VERIFY_REMINDER}`;

  try {
    const state = await getTodoState(client, input.sessionID);

    // Determine if any items are still active (in_progress or pending)
    const activeStatuses = new Set(["in_progress", "pending"]);
    const activeCount = state.todos.filter((t) =>
      activeStatuses.has(t.status),
    ).length;

    if (activeCount === 0) {
      // All completed / cancelled — VERIFY only
      output.output += suffix;
      log(
        "post-task-nudge",
        "verify_injected",
        input.sessionID,
        input.callID,
        "info",
        {
          todo_state: "none_active",
        },
      );
      return;
    }

    // Pick the appropriate todo nudge
    if (state.inProgressCount === 1 && state.pendingCount === 0) {
      suffix += `\n\n${TODO_FINAL_ACTIVE}`;
    } else {
      suffix += `\n\n${TODO_GENERAL}`;
    }
  } catch (err) {
    // API failure: fallback to VERIFY + TODO_GENERAL
    log(
      "post-task-nudge",
      "todo_api_failed",
      input.sessionID,
      input.callID,
      "error",
      {
        error: String(err),
      },
    );
    suffix += `\n\n${TODO_GENERAL}`;
  }

  output.output += suffix;
  const todoNudge = suffix.includes(TODO_FINAL_ACTIVE)
    ? "final_active"
    : "general";
  log(
    "post-task-nudge",
    "verify_injected",
    input.sessionID,
    input.callID,
    "info",
    {
      todo_state: todoNudge,
    },
  );
}
