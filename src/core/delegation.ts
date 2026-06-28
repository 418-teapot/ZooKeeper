/**
 * Framework-independent delegation allowlist logic.
 *
 * Determines whether a given agent may delegate to a target subagent type.
 * The allowlist is a static data structure — extend it when new agents
 * need restricted delegation targets.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Per-agent map of allowed subagent types.
 *
 * Entries here restrict delegation targets for that agent. Agents not listed
 * (e.g. dolphin) have unrestricted delegation — `isDelegationAllowed` returns
 * `{ allowed: true }` for those callers.
 *
 * The keys are agent names; values are arrays of allowed `subagent_type`
 * strings that the agent may pass to `task()`.
 */
const DELEGATION_ALLOWLIST: Record<string, string[]> = {
  mola: ["lynx", "spider"],
  beaver: ["lynx", "spider"],
};

// ---------------------------------------------------------------------------
// Caller-aware guidance map
// ---------------------------------------------------------------------------

/**
 * Per-caller guidance suffix appended to blocked delegation reasons.
 *
 * Agents not listed here fall back to the beaver executor wording,
 * which is the safest default for restricted callers.
 */
const CALLER_GUIDANCE: Record<string, string> = {
  mola: "For implementation work, add to the plan TODOs — execution belongs to dolphin.",
  beaver:
    "For needs beyond codebase search or web research, surface the gap to your orchestrator rather than delegating to another agent.",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result of a delegation allowlist check.
 */
export interface DelegationResult {
  /** Whether the caller is permitted to delegate to the target. */
  allowed: boolean;
  /**
   * Human-readable reason for a blocked delegation.
   * Only present when `allowed` is `false`.
   */
  reason?: string;
}

/**
 * Check whether a calling agent is allowed to delegate to a target subagent.
 *
 * Agents not listed in the allowlist are unrestricted. For restricted agents,
 * the target must match one of the allowlisted subagent types.
 *
 * @param callerAgent - Name of the agent calling `task()` (e.g. "mola").
 * @param targetSubagent - The `subagent_type` argument passed to `task()`.
 * @returns A result object indicating whether delegation is permitted.
 */
export function isDelegationAllowed(
  callerAgent: string,
  targetSubagent: string,
): DelegationResult {
  const allowed = DELEGATION_ALLOWLIST[callerAgent];
  if (!allowed) return { allowed: true };

  if (!allowed.includes(targetSubagent)) {
    const list = allowed.join(" and ");
    const guidance =
      CALLER_GUIDANCE[callerAgent] ??
      "For needs beyond codebase search or web research, surface the gap to your orchestrator rather than delegating to another agent.";
    return {
      allowed: false,
      reason:
        `${callerAgent} can only delegate to ${list}. ` +
        `"${targetSubagent}" is not allowed.\n\n` +
        `Allowed targets:\n` +
        `- lynx — codebase search, file discovery, structural analysis\n` +
        `- spider — web research, API documentation lookup\n\n` +
        `${guidance}`,
    };
  }

  return { allowed: true };
}
