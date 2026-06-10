/**
 * Todo nudge constants and helper for ZooKeeper OpenCode plugin.
 *
 * Provides the reminder text constants and the `getTodoState` helper used
 * by the post-task-nudge hook to inspect the session's todo list.
 *
 * @module
 */

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

/**
 * Nudge text injected when there are multiple in-progress or pending
 * items, reminding the orchestrator to update the todo list.
 */
export const TODO_GENERAL =
  "**TODO UPDATE REQUIRED — DO THIS NOW**\n" +
  "\n" +
  "A subagent just completed work. Before proceeding, mark finished items as\n" +
  "`completed` and set the next item to `in_progress`.\n" +
  "UNMARKED = UNTRACKED = LOST PROGRESS.";

/**
 * Nudge text injected when exactly 1 task remains `in_progress` and
 * 0 tasks are `pending`, reminding the orchestrator to close it out.
 */
export const TODO_FINAL_ACTIVE =
  "**TODO UPDATE REQUIRED — LAST TASK STILL in_progress**\n" +
  "\n" +
  "1 task remains `in_progress`, 0 `pending`. A subagent just finished work.\n" +
  "Mark it `completed` now, or move unfinished items back to `pending`.\n" +
  "STALE STATUS = INVISIBLE WORK = FORGOTTEN WORK.";

// ---------------------------------------------------------------------------
// Types (local — not exported)
// ---------------------------------------------------------------------------

/**
 * Minimal inline interface for the OpenCode client object.
 * Only the `session.todo` method is needed.
 */
interface TinyClient {
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

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Fetch the todo list for the given session and return pre-computed counts.
 *
 * @param client - OpenCode client (captured via closure in the factory).
 * @param sessionID - Session identifier to query todo items for.
 * @returns An object with the raw `todos` array plus `inProgressCount`
 *   and `pendingCount` tallies.
 */
export async function getTodoState(
  client: TinyClient,
  sessionID: string,
): Promise<{
  todos: Array<{
    content: string;
    status: string;
    priority: string;
    id: string;
  }>;
  inProgressCount: number;
  pendingCount: number;
}> {
  const response = await client.session.todo({
    path: { id: sessionID },
  });
  const todos = response.data;
  const inProgressCount = todos.filter(
    (t: { status: string }) => t.status === "in_progress",
  ).length;
  const pendingCount = todos.filter(
    (t: { status: string }) => t.status === "pending",
  ).length;
  return { todos, inProgressCount, pendingCount };
}
