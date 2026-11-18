/**
 * Host-agnostic lifecycle orchestration for one subagent delegation.
 *
 * Drives a `SubagentDriver` through its lifecycle: wiring termination
 * (parent abort, configured timeout) and mapping every possible outcome onto
 * the `SubagentResult` union so a run always ends in a returned result and
 * never in an unhandled rejection.
 *
 * A run is unconstrained unless the caller passes a timeout: no concurrency
 * cap is applied, and with no timeout the run ends only when the driver
 * resolves or the parent aborts.
 *
 * This module owns one invariant that holds regardless of how a driver
 * misbehaves:
 *
 * - **Failure collapse** — any driver throw or rejection collapses into an
 *   `error` result.  A run always ends in a returned `SubagentResult`.
 *
 * Termination is cooperative: abort is delivered as a signal, so the run
 * ends only when the driver honors it.  A configured timeout therefore only
 * aborts the driver; the run still waits for the driver to settle and clean
 * up, and the settled outcome is then reported as `timeout`.  A driver that
 * ignores the signal (e.g. a hung custom tool) holds the run until it
 * settles — there is no escalation-to-dispose hook, a documented residual
 * risk of cooperative abort.
 *
 * The driver owns every host-specific concern (creating the sub-session,
 * streaming messages, honoring the abort signal); orchestration stays
 * framework free.
 *
 * @module
 */

import { log } from "../../utils/logger.js";
import type {
  SubagentDriver,
  SubagentProgress,
  SubagentRequest,
  SubagentResult,
} from "./driver.js";
import type { RunLog } from "./run-log.js";

/**
 * The execution context passed alongside a request.
 *
 * `signal` is the parent session's abort signal; aborting it propagates to
 * the driver.  `timeoutMs` is the configured run budget in milliseconds —
 * absent means no timeout is enforced.  `onProgress` and `log` are forwarded
 * to the driver unchanged — the log is the run's append-only fact log owned
 * by the caller (the run registry), which the driver appends observed facts
 * to.
 */
export interface SubagentRunContext {
  signal: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: SubagentProgress) => void;
  log?: RunLog;
}

/**
 * Run the driver and collapse every failure into a result.
 *
 * @param driver - The host driver that executes the subagent.
 * @param request - The subagent request to run.
 * @param ctx - The parent execution context.
 * @param signal - The signal handed to the driver.
 * @returns The driver's result, or an `error` result when it throws.
 */
async function awaitDriver(
  driver: SubagentDriver,
  request: SubagentRequest,
  ctx: SubagentRunContext,
  signal: AbortSignal,
): Promise<SubagentResult> {
  try {
    return await driver.run(request, {
      signal,
      onProgress: ctx.onProgress,
      log: ctx.log,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", text: "", errorMessage: message };
  }
}

/**
 * Run one subagent delegation to completion.
 *
 * Without a configured timeout the parent abort signal is forwarded to the
 * driver unchanged and its result passes through; a driver throw collapses
 * into an `error` result.
 *
 * With a timeout, an internal signal is handed to the driver instead: the
 * parent abort propagates to it, and the timer aborts it when the budget
 * elapses.  The run still awaits the driver, so its cleanup completes.  A
 * run that settles after the timer fired is reported as `timeout` whatever
 * the driver returned — including a rejection, whose message must not hide
 * the timeout reason.  A parent abort that fires first owns the outcome.
 *
 * The request's agent is the sub-session's identity: the driver hands it to
 * the extension it builds for that session.
 *
 * @param driver - The host driver that executes the subagent.
 * @param request - The subagent request to run.
 * @param ctx - The parent execution context (signal, optional timeout,
 *   progress).
 * @returns A promise of the run's `SubagentResult`.
 */
export async function runSubagent(
  driver: SubagentDriver,
  request: SubagentRequest,
  ctx: SubagentRunContext,
): Promise<SubagentResult> {
  const timeoutMs = ctx.timeoutMs;
  if (timeoutMs === undefined) {
    return awaitDriver(driver, request, ctx, ctx.signal);
  }

  const controller = new AbortController();
  // The parent abort owns the outcome once it fires: a later timer must not
  // relabel an aborted run as a timeout.
  let parentAborted = ctx.signal.aborted;
  let timedOut = false;
  const onParentAbort = (): void => {
    parentAborted = true;
    controller.abort();
  };
  if (parentAborted) {
    controller.abort();
  } else {
    ctx.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    if (parentAborted) return;
    timedOut = true;
    log.warn({
      hook: "subagent-run",
      event: "subagent_timeout",
      agent: request.agent,
      timeoutMs,
    });
    controller.abort();
  }, timeoutMs);
  // The pending budget alone must not keep the host process alive.
  timer.unref();

  try {
    const result = await awaitDriver(driver, request, ctx, controller.signal);
    if (!timedOut) return result;
    return { kind: "timeout", text: result.text };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onParentAbort);
  }
}
