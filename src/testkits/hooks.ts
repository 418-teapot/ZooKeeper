/**
 * hook-testkit — shared host-shaped fixtures for hook and client tests.
 *
 * The nudge and continuation hook tests exercise their units against the
 * same host boundary: a client whose `session.todo` returns OpenCode-shaped
 * items plus the `TodoSource` adapter over it, and the store-shaped fake
 * with its `TodoSource` adapter. Those fixtures live here so the shape is
 * maintained once.
 */
import {
  type HostTodoItem,
  type TinyClient,
  todoSourceFromClient,
} from "../adapters/opencode/todo-source.js";
import type { TodoSource } from "../core/todo/source.js";
import { todoSourceFromStore } from "../core/todo/source.js";
import type { TodoStateStore } from "../core/todo/store.js";
import type { TodoPhase } from "../core/todo/types.js";

/** Host-shaped todo item as returned by `client.session.todo`. */
export type HostTodo = HostTodoItem;

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

/**
 * Build the store-backed `TodoSource` the pi assembly binds, over a fake
 * store holding the given phases.
 *
 * @param phases - Phases the source serves.
 * @returns A `TodoSource` over a fake store.
 */
export function storeSource(phases: TodoPhase[]): TodoSource {
  return todoSourceFromStore(fakeStore(phases));
}
