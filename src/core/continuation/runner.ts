/**
 * Shared settle-contribution runner.
 *
 * Runs the composed `onSettled` contributions for one settled turn and
 * returns the first `wake` verdict.  Both host adapters (OpenCode and pi)
 * delegate here, so the per-handler error isolation and first-wake
 * selection live in a single place.  The runner only reads verdicts — the
 * judgment stays entirely in the contributing units.
 *
 * @module
 */

import { log } from "../../utils/logger.js";
import type { SettledContribution, SettledInput } from "../slots.js";
import type { Decision } from "./decide.js";

/**
 * Run the settle contributions and return the first wake decision.
 *
 * Contributions run in registration order with per-handler error
 * isolation (a throwing handler is logged as `handler_crashed` and never
 * blocks the next).  The first `wake` verdict wins; when every handler
 * stays silent — including an empty contribution list — `null` is
 * returned (fail closed: the host must not invent a wake).
 *
 * @param contributions - The composed settle contributions, in order.
 * @param input - The settled-turn input (session, cause, budget).
 * @returns The first wake decision, or `null` when nothing wakes.
 */
export async function runSettled(
  contributions: SettledContribution[],
  input: SettledInput,
): Promise<Decision | null> {
  for (const { name, handle } of contributions) {
    try {
      const decision = await handle(input);
      if (decision.kind === "wake") return decision;
      // A silence is otherwise invisible to field diagnosis: record the
      // contributing unit and the gate that suppressed the wake.  The
      // wake itself is logged by the host, which knows the delivery
      // budget and outcome.
      log(
        "continuation",
        "settle_silent",
        input.sessionID,
        undefined,
        "debug",
        {
          handler: name,
          reason: decision.reason,
        },
      );
    } catch (err) {
      log("plugin", "handler_crashed", input.sessionID, undefined, "error", {
        handler: name,
        error: String(err),
      });
    }
  }
  return null;
}
