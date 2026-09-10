/**
 * Framework-independent todo state logic.
 *
 * Provides the `TinyClient` interface — the minimal host contract for
 * reading a session's todo list — plus the `TodoSource` port: a single
 * "give me the session's todo entries as a flat view" contract with thin
 * adapters over the state store and the host client backends.
 *
 * @module
 */

import type { TodoStateStore } from "../todo/store.js";
import type { TodoItemView, TodoStatus } from "../todo/types.js";
import { isTodoStatus } from "../todo/types.js";

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
// TodoSource port
// ---------------------------------------------------------------------------

/**
 * Read a session's todo entries as a flat view.
 *
 * Which backend serves the read (state store or host client) is decided
 * once per composition by `resolveTodoSource`; consumers only ever call
 * this port.
 *
 * @param sessionID - Session whose todo entries to read.
 */
export type TodoSource = (sessionID: string) => Promise<TodoItemView[]>;

/**
 * Serve the flat view from the per-session todo state store.
 *
 * Flattens the store's phases into a single list, preserving phase
 * order and task order; the `blocker` note is dropped since the view
 * only carries content and status.
 *
 * @param store - Todo state store backing the reads.
 * @returns A `TodoSource` bound to the store.
 */
export function todoSourceFromStore(store: TodoStateStore): TodoSource {
  return async (sessionID) =>
    (await store.get(sessionID)).flatMap((phase) =>
      phase.tasks.map((task) => ({
        content: task.content,
        status: task.status,
      })),
    );
}

/**
 * Resolve the single todo source for a composition.
 *
 * THE single place where the todo read backend is picked — hook units
 * must not re-implement this rule. Precedence: the state store the host
 * injects wins; otherwise a client exposing `session.todo` serves the
 * read; otherwise resolution fails closed to `null` (no todo reads).
 *
 * @param deps - Composition deps: an optional host-injected state store
 *   and an optional host client (callers pass the loosely typed
 *   `Deps["client"]`, so `any` is accepted here).
 * @returns The chosen `TodoSource`, or `null` when neither backend is
 *   available.
 */
export function resolveTodoSource(deps: {
  todoStore?: TodoStateStore;
  client?: TinyClient | null;
}): TodoSource | null {
  if (deps.todoStore) {
    return todoSourceFromStore(deps.todoStore);
  }
  if (typeof deps.client?.session?.todo === "function") {
    return todoSourceFromClient(deps.client);
  }
  return null;
}

/**
 * Map a host status string into the core five-status vocabulary.
 *
 * The host contract only produces `pending`, `in_progress`,
 * `completed`, and `cancelled`; `cancelled` becomes `abandoned` and the
 * other three pass through. Anything unrecognized maps to `null` and is
 * dropped from the view, matching the legacy counting where an unknown
 * status was never active.
 */
function toCoreStatus(status: string): TodoStatus | null {
  if (status === "cancelled") {
    return "abandoned";
  }
  return isTodoStatus(status) ? status : null;
}

/**
 * Serve the flat view from the host client.
 *
 * Fetches the session's todo list through `client.session.todo` and maps
 * each entry into the core status vocabulary. Fetch errors propagate: the
 * returned source rejects when the underlying client call fails.
 *
 * @param client - Host client exposing `session.todo`.
 * @returns A `TodoSource` bound to the client.
 */
export function todoSourceFromClient(client: TinyClient): TodoSource {
  return async (sessionID) => {
    const response = await client.session.todo({
      path: { id: sessionID },
    });
    return response.data.flatMap((todo) => {
      const status = toCoreStatus(todo.status);
      return status === null ? [] : [{ content: todo.content, status }];
    });
  };
}
