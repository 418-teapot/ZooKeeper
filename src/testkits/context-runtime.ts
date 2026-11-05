/**
 * Test helpers for the per-instance context runtime.
 *
 * @module
 */

import type { WorkPermit } from "../core/lifecycle/index.js";
import type { ToolCallContext } from "../core/unit.js";

/**
 * Build a {@link WorkPermit} for one session.
 *
 * @param sessionID - The session the permit addresses.
 * @param signal - The signal the permit follows; an aborted signal makes
 *   the permit inactive.  A fresh, never-aborted signal is used when
 *   omitted.
 * @returns The permit.
 */
export function permitFor(sessionID: string, signal?: AbortSignal): WorkPermit {
  const effective = signal ?? new AbortController().signal;
  return {
    sessionID,
    signal: effective,
    isActive: () => !effective.aborted,
  };
}

/**
 * Build a tool call's host-neutral context.
 *
 * @param sessionID - The session the call belongs to.
 * @param overrides - Context fields this call needs beyond the defaults.
 * @returns The call context.
 */
export function callFor(
  sessionID: string,
  overrides: Partial<ToolCallContext> = {},
): ToolCallContext {
  return {
    sessionID,
    signal: new AbortController().signal,
    ...overrides,
  };
}
