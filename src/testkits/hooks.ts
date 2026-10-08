/**
 * hook-testkit — shared host-shaped fixtures for hook and client tests.
 *
 * The nudge and continuation hook tests exercise their units against the
 * same host boundary: a client whose `session.todo` returns host-shaped
 * items, the `TodoSource` adapter over that client, and a store-shaped
 * fake. Those fixtures live here so the shape is maintained once.
 */
import {
  type TinyClient,
  type TodoSource,
  todoSourceFromClient,
} from "../core/client/todo.js";
import type { TodoStateStore } from "../core/todo/store.js";
import type { TodoPhase } from "../core/todo/types.js";

/** Host-shaped todo item as returned by `client.session.todo`. */
export interface HostTodo {
  content: string;
  status: string;
  priority: string;
  id: string;
}

/**
 * Build a mock client whose `session.todo` resolves to the given items.
 *
 * @param items - Todo items to return.
 * @returns A mock client object.
 */
export function mockClient(items: HostTodo[]): TinyClient {
  return {
    session: {
      todo: async () => ({ data: items }),
    },
  };
}

/**
 * Build a todo source serving the given host-shaped items through the
 * client adapter.
 *
 * @param items - Todo items to return.
 * @returns A `TodoSource` over a mock client.
 */
export function sourceOf(items: HostTodo[]): TodoSource {
  return todoSourceFromClient(mockClient(items));
}

/**
 * Build a store-shaped fake serving the given phases on every read.
 *
 * @param phases - Phases the store hands out.
 * @returns A `TodoStateStore`-shaped object.
 */
export function fakeStore(phases: TodoPhase[]): TodoStateStore {
  return {
    get: async () => phases,
    set: () => {},
    invalidate: () => {},
    serialize: <T>(fn: () => Promise<T>) => fn(),
  };
}
