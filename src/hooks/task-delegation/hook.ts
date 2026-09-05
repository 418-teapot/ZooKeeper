/**
 * Task delegation judge for the ZooKeeper plugin.
 *
 * The delegation-target strategy, contributed by the task-delegation
 * hook unit as a judge: given the calling agent and the target subagent
 * type, it consults the allowlist in `src/core/delegation.ts` and
 * returns a refusal when the caller may not delegate to the target.
 * The judge is pure — caller resolution and tool filtering happen at
 * the consuming host's gate boundary (OpenCode resolves the caller from
 * the session; pi passes the identity-resolved caller directly).
 *
 * @module
 */

import { isDelegationAllowed } from "../../core/delegation.js";
import type { DelegationRefusal, DelegationRequest } from "../../core/gate.js";

/**
 * Judge a delegation request against the allowlist.
 *
 * Returns a refusal when the caller may not delegate to the target,
 * carrying the allowlist's reason unchanged; `null` otherwise.  A
 * missing caller (could not be resolved from the session) or a missing
 * target (the `subagent_type` argument was not a string) skips the
 * judgment and allows — the original boundary semantics.
 *
 * @param req - The delegation request being judged.
 * @returns The refusal, or `null` to allow (or skip).
 */
export function judgeDelegationTarget(
  req: DelegationRequest,
): DelegationRefusal | null {
  if (!req.caller || !req.target) return null;
  const result = isDelegationAllowed(req.caller, req.target);
  if (!result.allowed) {
    return { reason: result.reason ?? "委派被拒绝。" };
  }
  return null;
}
