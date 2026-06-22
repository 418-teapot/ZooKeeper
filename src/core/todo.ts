/**
 * Framework-independent todo state logic.
 *
 * Provides the `TinyClient` interface and `getTodoState` helper used
 * to inspect a session's todo list and compute in-progress/pending counts.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal inline interface for the OpenCode client object.
 * Only the `session.todo` method is needed.
 */
export interface TinyClient {
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
