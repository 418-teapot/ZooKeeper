/**
 * OpenCode todo source — the client-backed `TodoSource` adapter.
 *
 * Translates the OpenCode SDK todo read into the core flat view: the
 * host's `session.todo` shape (`{ path: { id } }` in, `{ data: [...] }`
 * out) and its four-status vocabulary (`cancelled` → `abandoned`) are
 * OpenCode facts, so they stay in this adapter and never reach core.
 * Core only sees a `TodoSource`; the assembly binds this one on OpenCode.
 *
 * @module
 */

import type { TodoSource } from "../../core/todo/source.js";
import type { TodoStatus } from "../../core/todo/types.js";
import { isTodoStatus } from "../../core/todo/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A todo entry as the OpenCode SDK reports it. */
export interface HostTodoItem {
  content: string;
  status: string;
  priority: string;
  id: string;
}

/**
 * Minimal inline interface for the OpenCode client object.
 * Only the `session.todo` method is needed.
 */
export interface TinyClient {
  session: {
    todo: (opts: { path: { id: string } }) => Promise<{
      data: HostTodoItem[];
    }>;
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

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
 * Serve the flat view from the OpenCode client.
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
