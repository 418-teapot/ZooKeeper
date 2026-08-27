/**
 * Host-agnostic lifecycle orchestration for one subagent delegation.
 *
 * Drives a `SubagentDriver` through its full lifecycle: acquiring a
 * module-level concurrency slot, binding the subagent identity, wiring
 * termination (parent abort + timeout), and mapping every possible outcome
 * onto the `SubagentResult` union so a run always ends in a returned result
 * and never in an unhandled rejection.
 *
 * This module owns two invariants that hold regardless of how a driver
 * misbehaves:
 *
 * - **Failure collapse** — any driver throw or rejection collapses into an
 *   `error` result.  A run always ends in a returned `SubagentResult`.
 * - **Inevitable termination** — every run ends: either the driver
 *   resolves, the parent aborts, or the timeout fires.  Termination is
 *   cooperative: abort is delivered via the signal, so the run ends only
 *   when the driver honors it.  A driver that ignores the signal (e.g. a
 *   hung custom tool) holds its concurrency slot until it settles — there
 *   is no escalation-to-dispose hook, a documented residual risk of
 *   cooperative abort.
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

/** The maximum number of subagent runs executing concurrently. */
export const SUBAGENT_MAX_CONCURRENCY = 4;

/** The wall-clock budget of a single subagent run, in milliseconds. */
export const SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Test-only options that override the module constants.
 *
 * Production callers omit `options` entirely and get
 * `SUBAGENT_MAX_CONCURRENCY` / `SUBAGENT_TIMEOUT_MS`.  Only tests supply
 * short timeouts and a reduced concurrency so they never wait real time.
 */
export interface RunSubagentOptions {
  /** Overrides `SUBAGENT_MAX_CONCURRENCY` for tests. */
  concurrency?: number;
  /** Overrides `SUBAGENT_TIMEOUT_MS` for tests. */
  timeoutMs?: number;
}

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

/** The number of concurrency slots currently taken. */
let active = 0;

/** Resolvers of runs blocked waiting for a concurrency slot, FIFO. */
const waiters: Array<() => void> = [];

/**
 * Run one subagent delegation to completion.
 *
 * Orchestrates the driver through its full lifecycle: acquires a
 * module-level concurrency slot (max `SUBAGENT_MAX_CONCURRENCY`), binds the
 * subagent identity via `runWithIdentity`, and wires termination through an
 * internal `AbortController` that the parent signal and the timeout both
 * feed into.  The driver's result passes through unchanged; a driver throw
 * collapses into an `error` result.
 *
 * @param driver - The host driver that executes the subagent.
 * @param request - The subagent request to run.
 * @param ctx - The parent execution context (signal + optional progress).
 * @param options - Test-only overrides of the module constants.
 * @returns A promise of the run's `SubagentResult`.
 */
export async function runSubagent(
  driver: SubagentDriver,
  request: SubagentRequest,
  ctx: SubagentRunContext,
  options: RunSubagentOptions = {},
): Promise<SubagentResult> {
  const concurrency = options.concurrency ?? SUBAGENT_MAX_CONCURRENCY;
  const timeoutMs = options.timeoutMs ?? SUBAGENT_TIMEOUT_MS;

  await acquireSlot(concurrency);
  try {
    return await execute(driver, request, ctx, timeoutMs);
  } finally {
    releaseSlot();
  }
}

/**
 * Acquire a concurrency slot, waiting FIFO when the pool is full.
 *
 * @param concurrency - The active concurrency limit for this invocation.
 * @returns A promise that resolves once a slot is granted.
 */
function acquireSlot(concurrency: number): Promise<void> {
  if (active < concurrency) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
}

/**
 * Release a concurrency slot, transferring it to the longest-waiting run.
 *
 * Runs in every path (success, failure, abort) so the pool can never be
 * starved by a throwing driver.
 */
function releaseSlot(): void {
  active -= 1;
  const next = waiters.shift();
  if (next !== undefined) {
    active += 1;
    next();
  }
}

/**
 * Execute a driver run with termination wiring and outcome mapping.
 *
 * Owns the internal `AbortController` that parent abort and timeout both
 * feed, and guarantees the returned promise always resolves to a
 * `SubagentResult` — never rejects.
 *
 * @param driver - The host driver.
 * @param request - The subagent request.
 * @param ctx - The parent execution context.
 * @param timeoutMs - The timeout budget in milliseconds.
 * @returns A promise of the run's `SubagentResult`.
 */
async function execute(
  driver: SubagentDriver,
  request: SubagentRequest,
  ctx: SubagentRunContext,
  timeoutMs: number,
): Promise<SubagentResult> {
  const controller = new AbortController();
  const parentSignal = ctx.signal;

  // The parent signal and the timeout timer both feed the internal
  // controller so the driver observes a single abort path.
  const onParentAbort = (): void => {
    controller.abort();
  };
  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const result = await runWithIdentity(
      { kind: "subagent", name: request.agent },
      () =>
        driver.run(request, {
          signal: controller.signal,
          onProgress: ctx.onProgress,
        }),
    );

    // Distinguish an internal abort caused by a timeout from one caused by
    // the parent signal so the outcome is classified correctly.  A result
    // from an un-aborted controller passes through verbatim.
    if (controller.signal.aborted) {
      if (parentSignal.aborted) {
        return { kind: "aborted", text: result.text };
      }
      return { kind: "timeout", text: result.text };
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", text: "", errorMessage: message };
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Reset the module-level semaphore state for tests.
 *
 * Drops all taken slots and clears the wait queue.  Test-only; mirrors the
 * `_resetForTesting` convention of the logger.
 */
export function _resetForTesting(): void {
  active = 0;
  waiters.length = 0;
}
