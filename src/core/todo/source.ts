/**
 * Todo source — the read port progress checks consume.
 *
 * A `TodoSource` answers one question: "give me this session's todo
 * entries as a flat view".  Which backend serves it is decided by the
 * host assembly (OpenCode binds its client adapter, pi binds the state
 * store) and never at read time, so consumers never branch on a backend.
 * The store-backed adapter lives here because it is a pure projection of
 * `TodoStateStore` state.
 *
 * @module
 */

import type { TodoStateStore } from "./store.js";
import type { TodoItemView } from "./types.js";

/**
 * Read a session's todo entries as a flat view.
 *
 * Bound once per composition by the host assembly, which owns the choice
 * of backend; consumers only ever call this port.
 *
 * @param sessionID - Session whose todo entries to read.
 */
export type TodoSource = (sessionID: string) => Promise<TodoItemView[]>;

/**
 * Serve the flat view from the per-session todo state store.
 *
 * Flattens the store's phases into a single list, preserving phase order
 * and task order; the `blocker` note rides along so reminders can state
 * what a blocked task waits on.
 *
 * @param store - Todo state store backing the reads.
 * @returns A `TodoSource` bound to the store.
 */
export function todoSourceFromStore(store: TodoStateStore): TodoSource {
  return async (sessionID) =>
    (await store.get(sessionID)).flatMap((phase) =>
      phase.tasks.map((task) =>
        task.blocker === undefined
          ? { content: task.content, status: task.status }
          : {
              content: task.content,
              status: task.status,
              blocker: task.blocker,
            },
      ),
    );
}
