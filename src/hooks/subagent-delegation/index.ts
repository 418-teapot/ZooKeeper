/**
 * Subagent delegation judge hook barrel export.
 *
 * Re-exports the judge function from the hook module.
 *
 * @module
 */

import { checkDelegationTarget } from "../../core/subagent/target.js";
import { defineHook } from "../../core/unit.js";
import { judgeDelegationTarget } from "./hook.js";

export { judgeDelegationTarget };

/**
 * Subagent-delegation hook unit descriptor.
 *
 * Contributes the delegation-target judge; all handler slots stay
 * empty.  The judge is composed into the host gate by the selection
 * engine and runs only for `subagent` tool calls at the gate
 * boundary.  The unit requires the host's asynchronous caller resolver
 * and the parsed agent-mode map: without the resolver the judge could
 * never identify the caller, and without the role map it could not tell
 * a subagent from a primary, so the assembly-time capability check
 * disables the unit instead of letting it decide from absent facts.
 *
 * The gate judges the caller's allowlist first, then the target's
 * eligibility — a target must be a configured subagent the active profile
 * selects (see `core/subagent/target.ts`).  Both hosts apply the same
 * composed gate, so the refusal is identical on OpenCode's native `task`
 * and on pi's `tool_call`.
 */
export const unit = defineHook({
  name: "subagent-delegation",
  needs: ["resolveCallerAgent", "agentModes"],
  uses: ["agents"],
  create(caps, uses) {
    return {
      delegation: [
        {
          name: "judgeDelegationTarget",
          needsCaller: true,
          judge(req) {
            const refusal = judgeDelegationTarget(req);
            if (refusal !== null || !req.target) return refusal;
            const verdict = checkDelegationTarget(
              req.target,
              caps.agentModes,
              uses.agents,
            );
            return verdict.kind === "refused"
              ? { reason: verdict.reason, cause: verdict.cause }
              : null;
          },
        },
      ],
    };
  },
});
