/**
 * Delegation-target eligibility.
 *
 * A delegation target must be both a configured subagent and an agent the
 * active profile selects.  A configured subagent the profile does not
 * select runs without its role prompt, so delegating to it would execute
 * an agent the host never composed.  The subagent tool and the delegation
 * gate judge both decide through this module, so the two entry points
 * cannot drift.
 *
 * @module
 */

import type { AgentModeMap } from "../config-types.js";

/** Why a target cannot receive a delegation. */
export type TargetRefusalCause = "not-a-subagent" | "not-selected";

/** The verdict on one delegation target. */
export type TargetVerdict =
  | { readonly kind: "ok" }
  | {
      readonly kind: "refused";
      /** Structured reason, for the call's log entry. */
      readonly cause: TargetRefusalCause;
      /** Model-facing reason text. */
      readonly reason: string;
    };

/**
 * Judge whether a target may receive a delegation.
 *
 * A missing modes map leaves no declared role, so nothing is delegatable
 * (fail-closed).  A configured subagent the profile does not select is
 * refused as well: its prompt and tools were never composed.
 *
 * @param target - The requested target agent name.
 * @param modes - The parsed per-agent role map, or `undefined` when the
 *   host has none.
 * @param selected - The agent names the active profile selects.
 * @returns The verdict on the target.
 */
export function checkDelegationTarget(
  target: string,
  modes: AgentModeMap | undefined,
  selected: readonly string[],
): TargetVerdict {
  if (modes?.[target] !== "subagent") {
    return {
      kind: "refused",
      cause: "not-a-subagent",
      reason: `"${target}" 不是可委派的子 agent：仅在配置中声明 mode = "subagent" 的 agent 才能作为委派目标。`,
    };
  }
  if (!selected.includes(target)) {
    return {
      kind: "refused",
      cause: "not-selected",
      reason: `"${target}" 未在当前 profile 的 agents 中启用：只能委派给配置中声明为 subagent 且已启用的 agent。`,
    };
  }
  return { kind: "ok" };
}
