/**
 * Pi host adapter — ask-tool visibility.
 *
 * The `ask` tool is registered inactive on pi (`defaultActive: false`), so
 * the model only sees it while a session can actually reach the user.  This
 * module owns that rule for every active-tool writer of the pi adapter: the
 * caller filters the untrimmed baseline by the primary's denies, then this
 * rule decides whether `ask` is added or removed.
 *
 * @module
 */

import { ASK_TOOL_NAME } from "../../core/ask.js";

/**
 * Apply the ask-tool visibility rule to a deny-filtered tool set.
 *
 * The tool is visible only when the host registered it, the session's
 * context yields a question channel, AND the session's primary does not
 * deny it.  A primary deny outranks channel availability: the permission
 * answers first.  A candidate set that carries `ask` from an external host
 * configuration is corrected either way, so the rule never relies on the
 * host's own activation state.
 *
 * @param tools - The candidate set, with the primary's denies applied.
 * @param facts - Whether the host registered `ask`, whether this session
 *   can ask the user, and whether its primary denies `ask`.
 * @returns The tool set to activate: the candidates plus `ask` when it is
 *   visible, the candidates without it otherwise.  Other tools keep their
 *   order.
 */
export function withAskVisibility(
  tools: readonly string[],
  facts: { registered: boolean; available: boolean; denied: boolean },
): string[] {
  const visible = facts.registered && facts.available && !facts.denied;
  if (!visible) return tools.filter((tool) => tool !== ASK_TOOL_NAME);
  return tools.includes(ASK_TOOL_NAME) ? [...tools] : [...tools, ASK_TOOL_NAME];
}
