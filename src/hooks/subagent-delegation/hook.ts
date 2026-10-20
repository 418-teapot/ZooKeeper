/**
 * Subagent delegation judge for the ZooKeeper plugin.
 *
 * The delegation-target strategy, contributed by the subagent-delegation
 * hook unit as a judge: given the calling agent and the target subagent
 * type, it consults the allowlist in `src/core/delegation.ts` and
 * returns a refusal when the caller may not delegate to the target.
 * The judge is pure — caller resolution happens at the consuming host's
 * gate boundary through the `resolveCallerAgent` capability, and an
 * unresolved caller is refused rather than waved through.
 *
 * @module
 */

import { isDelegationAllowed } from "../../core/delegation.js";
import type { DelegationRefusal, DelegationRequest } from "../../core/gate.js";

/**
 * Judge a delegation request against the allowlist.
 *
 * An unresolved (or empty) caller is refused: the allowlist cannot be
 * enforced without knowing who is delegating, so silence must not read
 * as permission.  A missing target (the `subagent_type` argument was not
 * a string) still allows — argument-shape validation belongs to the tool
 * layer and reports its own error.
 *
 * @param req - The delegation request being judged.
 * @returns The refusal, or `null` to allow (or skip).
 */
export function judgeDelegationTarget(
  req: DelegationRequest,
): DelegationRefusal | null {
  if (!req.caller) {
    return {
      reason: "无法确定调用者身份：不能校验委派白名单，已拒绝本次委派。",
    };
  }
  if (!req.target) return null;
  const result = isDelegationAllowed(req.caller, req.target);
  if (!result.allowed) {
    return { reason: result.reason ?? "委派被拒绝。" };
  }
  return null;
}
