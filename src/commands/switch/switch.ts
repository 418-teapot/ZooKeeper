/**
 * Primary-agent switch on the pi host.
 *
 * Each `/<agent>` command replaces the current session with a fresh one
 * re-bound to the target identity, instead of switching in place.  This
 * makes all four identity facets correct at bind time — prompt
 * (`before_agent_start` resolves the new primary), skills
 * (`resources_discover` filters by the new primary's permission.skill
 * rules), tools (extension-tool trim), and the widget — because pi's
 * skill filtering is merge-only and cannot be retracted mid-session.
 *
 * The order is deliberate: `setPrimary(target)` runs FIRST so the new
 * session's bind-time handlers already resolve the new identity; the
 * untrimmed tool baseline is captured BEFORE the replacement (the old
 * API is still valid up to `newSession`); then `newSession` replaces the
 * session with the target as parent.  All post-replacement work (tool
 * trim, widget) runs inside the `withSession` callback through the
 * per-fresh-session facade — never through this module's host methods,
 * which close over the pre-replacement API that pi invalidates after
 * `newSession`.  No message is delivered: the user types into the fresh
 * session themselves (the plan workflow is file-mediated, so transcript
 * continuity is not needed).  Trimming is TOOL-LEVEL only — the
 * fine-grained bash-pattern / edit-glob rules of `[agent.<name>].permission`
 * are not implemented here.
 *
 * @module
 */

import type { PiSwitchHost, PiSwitchNewSessionOps } from "../../core/slots.js";
import { getPrimary, setPrimary } from "../../core/subagent/identity.js";
import { log } from "../../utils/logger.js";

export type { PiSwitchHost } from "../../core/slots.js";

/**
 * Apply the primary-agent switch to the pi host.
 *
 * 1. `setPrimary(name)` persists the new active primary in the identity
 *    core FIRST — it must precede `newSession` so the replacement
 *    session's bind-time `resources_discover` filter and first
 *    `before_agent_start` already resolve the new identity.
 * 2. The tool baseline is captured BEFORE the replacement (the old API
 *    is still valid) and the target's trim is precomputed as
 *    `baseline minus deniedTools(target)`, where `baseline` is the full
 *    untrimmed tool universe captured once before any switch trims it
 *    (deferred to the first switch, then cached — pi forbids calling
 *    action methods at extension-load time).  Filtering the FIXED
 *    baseline (rather than the current, possibly already-trimmed active
 *    set) means a tool denied by one primary is restored when switching
 *    to a primary that does not deny it — denies never accumulate across
 *    switches.  When the baseline is unavailable OR empty the trim is
 *    skipped (never guess — an empty filter would wipe every tool).
 * 3. `newSession` replaces the current session (parented to the current
 *    session id) with a fresh one bound to the target identity.  Inside
 *    the `withSession` callback the trim and the widget are applied
 *    through the per-fresh-session facade — the old API is stale by then,
 *    so no process-level host method may run there.  The widget already
 *    shows the active primary immediately after the switch, so no
 *    confirmation entry is appended.
 *
 * Fail-closed behaviour: a missing `newSession` API throws before any
 * state change (the previous primary is left untouched).  A cancelled
 * replacement (the session was never created) rolls back the primary to
 * the previous value and throws, so the identity state stays consistent
 * with the session that actually exists.
 *
 * @param name - The target primary agent name.
 * @param deniedTools - The target agent's tool-level denied tool names.
 * @param host - The pi switch surfaces.
 * @param sessionID - The current session identifier (parentage + logging).
 * @returns A promise resolving when the replacement completes.
 * @throws Error when the replacement API is missing or the replacement
 *   is cancelled (after rolling back the primary).
 */
export async function applySwitch(
  name: string,
  deniedTools: readonly string[],
  host: PiSwitchHost,
  sessionID: string,
): Promise<void> {
  const previous = getPrimary();

  // Same-agent no-op: the identity is already the target, so no
  // replacement session is needed.
  if (previous === name) {
    log("switch-command", "primary_switched", sessionID, undefined, "info", {
      name,
      skipped: true,
    });
    return;
  }

  // Fail closed BEFORE any state change: without the replacement API the
  // switch cannot re-bind, so the primary must stay untouched.
  if (typeof host.newSession !== "function") {
    throw new Error(
      "pi session replacement API is not available. " +
        "Ensure the pi command context exposes newSession.",
    );
  }

  // 1. Persist the new primary FIRST — the replacement session's
  // bind-time handlers resolve it.  `previous` is always set here (the
  // same-agent no-op above guarantees `previous !== name`), but a
  // defensive fallback keeps the rollback type-clean.
  setPrimary(name);

  // 2. Capture the baseline and precompute the trim BEFORE the
  // replacement: `getBaselineTools` reads the CURRENT (still valid) API,
  // which pi invalidates once `newSession` replaces the session.
  const removed: string[] = [];
  let nextTools: string[] | undefined;
  const baseline = host.getBaselineTools();
  // An empty baseline is treated the same as an unavailable one:
  // filtering it would compute `[].filter(...) = []` and wipe every tool
  // on the first switch — a fail-open outcome.  Skip the trim
  // (fail-closed; never guess an empty filter).
  if (baseline !== undefined && baseline.length > 0) {
    const denied = new Set(deniedTools);
    nextTools = baseline.filter((tool) => {
      if (denied.has(tool)) {
        removed.push(tool);
        return false;
      }
      return true;
    });
  }

  let result: { cancelled: boolean };
  try {
    result = await host.newSession({
      parentSession: sessionID,
      withSession: (ops: PiSwitchNewSessionOps) => {
        // 3. Post-replacement work runs through the per-fresh-session
        // facade only — the process-level host API is stale here.
        if (nextTools !== undefined) {
          ops.setActiveTools(nextTools);
        }
        // The widget (rendered above the editor by the pi facade) shows
        // the active primary immediately after the switch.
        ops.setWidget("zoo", [name]);
      },
    });
  } catch (err) {
    // The replacement threw (not merely cancelled): the session was never
    // created, so restore the previous primary before propagating.
    if (previous !== undefined) setPrimary(previous);
    throw err;
  }

  if (result.cancelled === true) {
    // Cancelled after setPrimary: the session never changed, so roll the
    // primary back to the value that matches the surviving session.
    if (previous !== undefined) setPrimary(previous);
    throw new Error(
      "Primary switch cancelled: the new session was not created.",
    );
  }

  log("switch-command", "primary_switched", sessionID, undefined, "info", {
    name,
    removed,
  });
}
