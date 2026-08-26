/**
 * Host-agnostic agent-identity infrastructure.
 *
 * Distinguishes the two roles an agent session can play — the primary
 * orchestrator agent (whose prompt is injected for a normal session) and a
 * delegated subagent (whose prompt is injected when a tool spawns a
 * sub-session).  The extension runs as a process-wide singleton across the
 * parent and sub-sessions of the pi host, so a module-level
 * `AsyncLocalStorage` store is shared: a tool's `execute` wraps a sub-session
 * in `runWithIdentity`, and the `before_agent_start` handler resolves the
 * identity to decide which prompt to inject.  AsyncLocalStorage binds the
 * store to the async call chain, so concurrent sub-sessions keep their own
 * identity without cross-talk.
 *
 * pi has no built-in primary-agent concept, so the module also keeps the
 * extension's self-maintained `currentPrimary` state (switched by slash
 * commands).  Resolution prefers the AsyncLocalStorage store; outside a
 * `runWithIdentity` scope it falls back to `currentPrimary`, and when no
 * primary has been set yet it resolves to `undefined` so callers fail
 * closed.
 *
 * This module is framework-free: no host imports, and no agent-name string
 * literals — names are supplied by the caller (config-derived).
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The identity of an agent session.
 *
 * A primary identity is the session's current orchestrator agent; a
 * subagent identity names the delegated agent a tool is driving in a
 * sub-session.  Names are config-derived and supplied by the caller.
 */
export type Identity =
  | { kind: "primary"; name: string }
  | { kind: "subagent"; name: string };

/** Async-local identity store shared across the process. */
const store = new AsyncLocalStorage<Identity>();

/**
 * Run `fn` with the given identity bound to its async call chain.
 *
 * A tool's `execute` wraps a sub-session's `prompt()` in this so the
 * sub-session's `before_agent_start` handler resolves the subagent identity
 * via `resolveIdentity()`.  Concurrent runs each observe their own store —
 * AsyncLocalStorage scopes the value to the async context of `fn`.
 *
 * @param identity - The identity to bind (e.g. a subagent identity).
 * @param fn - The callback to run within the identity scope.
 * @returns Whatever `fn` returns.
 */
export function runWithIdentity<T>(identity: Identity, fn: () => T): T {
  return store.run(identity, fn);
}

/**
 * The self-maintained active primary agent, or `undefined` when none has
 * been set yet.
 */
let currentPrimary: string | undefined;

/**
 * Return the extension's self-maintained active primary agent name.
 *
 * @returns The current primary agent name, or `undefined` when unset.
 */
export function getPrimary(): string | undefined {
  return currentPrimary;
}

/**
 * Set the active primary agent name.
 *
 * Called when the user switches the primary agent (e.g. a slash command) —
 * pi has no built-in primary concept, so the extension self-maintains it.
 *
 * @param name - The primary agent name.
 */
export function setPrimary(name: string): void {
  currentPrimary = name;
}

/**
 * Resolve the identity for the current async context.
 *
 * Prefers the AsyncLocalStorage store (a subagent identity bound by a
 * tool's `execute`); outside such a scope it falls back to the active
 * primary agent.  When no primary has been set, resolves to `undefined` so
 * callers fail closed.
 *
 * @returns The resolved identity, or `undefined` when no identity is
 *   available.
 */
export function resolveIdentity(): Identity | undefined {
  const stored = store.getStore();
  if (stored !== undefined) return stored;

  if (currentPrimary !== undefined) {
    return { kind: "primary", name: currentPrimary };
  }
  return undefined;
}

/**
 * Derive the ordered set of primary agent names for a profile.
 *
 * Walks the profile's ordered agents array and keeps the names that the
 * modes map marks as primaries.  The first kept name in array order is the
 * default primary.  Agents missing from the modes map are never primaries,
 * and an empty result is a valid return (the caller fails closed).
 *
 * @param agents - The profile's ordered agent-name array.
 * @param modes - Per-agent role map (`"primary"` or `"subagent"`).
 * @returns The ordered primary names, possibly empty.
 */
export function derivePrimaries(
  agents: string[],
  modes: Record<string, "primary" | "subagent">,
): string[] {
  return agents.filter((name) => modes[name] === "primary");
}

/**
 * Reset the module-level identity state for tests.
 *
 * `currentPrimary` is module-scoped and persists for the process lifetime,
 * so tests that share the process (bun runs every test file in the same
 * isolate) must reset it deterministically rather than rely on pristine
 * state.  Mirrors the `_resetForTesting` convention of the logger.
 */
export function _resetForTesting(): void {
  currentPrimary = undefined;
}
