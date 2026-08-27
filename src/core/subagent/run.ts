/**
 * Host-agnostic lifecycle orchestration for one subagent delegation.
 *
 * Drives a `SubagentDriver` through its lifecycle: binding the subagent
 * identity, wiring termination (parent abort), and mapping every possible
 * outcome onto the `SubagentResult` union so a run always ends in a returned
 * result and never in an unhandled rejection.
 *
 * Runs are intentionally unconstrained: no concurrency cap and no wall-clock
 * timeout.  A run ends only when the driver resolves or the parent aborts.
 *
 * This module owns one invariant that holds regardless of how a driver
 * misbehaves:
 *
 * - **Failure collapse** — any driver throw or rejection collapses into an
 *   `error` result.  A run always ends in a returned `SubagentResult`.
 *
 * Termination is cooperative: abort is delivered via the parent signal, so
 * the run ends only when the driver honors it.  A driver that ignores the
 * signal (e.g. a hung custom tool) holds the run until it settles — there is
 * no escalation-to-dispose hook, a documented residual risk of cooperative
 * abort.
 *
 * The driver owns every host-specific concern (creating the sub-session,
 * streaming messages, honoring the abort signal); orchestration stays
 * framework free.
 *
 * @module
 */

import type {
  SubagentDriver,
  SubagentProgress,
  SubagentRequest,
  SubagentResult,
} from "./driver.js";
import { runWithIdentity } from "./identity.js";

/**
 * The execution context passed alongside a request.
 *
 * `signal` is the parent session's abort signal; aborting it propagates to
 * the driver.  `onProgress` is forwarded to the driver unchanged.
 */
export interface SubagentRunContext {
  signal: AbortSignal;
  onProgress?: (progress: SubagentProgress) => void;
}

/**
 * Run one subagent delegation to completion.
 *
 * Binds the subagent identity via `runWithIdentity` and forwards the parent
 * abort signal to the driver, mapping every possible outcome onto the
 * `SubagentResult` union.  The driver's result passes through unchanged; a
 * driver throw collapses into an `error` result.
 *
 * @param driver - The host driver that executes the subagent.
 * @param request - The subagent request to run.
 * @param ctx - The parent execution context (signal + optional progress).
 * @returns A promise of the run's `SubagentResult`.
 */
export async function runSubagent(
  driver: SubagentDriver,
  request: SubagentRequest,
  ctx: SubagentRunContext,
): Promise<SubagentResult> {
  try {
    return await runWithIdentity(
      { kind: "subagent", name: request.agent },
      () =>
        driver.run(request, {
          signal: ctx.signal,
          onProgress: ctx.onProgress,
        }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", text: "", errorMessage: message };
  }
}
