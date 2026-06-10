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
  "**VERIFY NOW — NO EXCEPTIONS**\n" +
  "\n" +
  "Run build, tests, and lint to verify the subagent's work.\n" +
  '- "The subagent already tested it" — you must verify independently\n' +
  '- "It\'s just a one-liner" — one-liners break builds\n' +
  '- "The change is trivial" — trivial changes still need verification\n' +
  "- If verification fails: resume the same task_id to fix it";

/**
 * Nudge text injected when there are multiple in-progress or pending
 * items, reminding the orchestrator to update the todo list.
 */
export const TODO_GENERAL =
  "**TODO UPDATE REQUIRED — DO THIS NOW**\n" +
  "\n" +
  "A subagent just completed work. Before proceeding, mark finished items as\n" +
  "`completed` and set the next item to `in_progress`.\n" +
  "Unmarked = Untracked = Lost progress.";

/**
 * Nudge text injected when exactly 1 task remains `in_progress` and
 * 0 tasks are `pending`, reminding the orchestrator to close it out.
 */
export const TODO_FINAL_ACTIVE =
  "**TODO UPDATE REQUIRED — LAST TASK STILL in_progress**\n" +
  "\n" +
  "1 task remains `in_progress`, 0 `pending`. A subagent just finished work.\n" +
  "Mark it `completed` now, or move unfinished items back to `pending`.\n" +
  "Stale status = Invisible work = Forgotten work.";

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
