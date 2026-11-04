/**
 * Test helpers for the per-instance context runtime.
 *
 * @module
 */

import type { WorkPermit } from "../core/lifecycle/index.js";

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
