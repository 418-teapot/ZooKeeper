/**
 * Settle commit gate.
 *
 * The one place a host turns a settle verdict into a delivered wake, so no
 * host can record a wake it did not deliver or deliver one it did not
 * record.  The gate runs the strategies, reads the settle's cancellation
 * before and after them, and commits the winning wake — budget charge and
 * host delivery — in one synchronous segment.
 *
 * Cancellation is normal silence: a stop before the verdict consults no
 * strategy, and a stop after it charges and delivers nothing.  A
 * cancellation that arrives once delivery started keeps the charge, so a
 * stop can never become an unbounded retry loop.
 *
 * @module
 */

import { log } from "../../utils/logger.js";
import type { LoopSession, Wake } from "./engine.js";
import type { SettleRequest } from "./settle.js";

/**
 * Run one settle and commit its winning wake.
 *
 * The host supplies the delivery: it receives the wake and the settle's
 * signal, and its result is handed back unchanged.  The strategies run only
 * for a turn that settled and only while the settle is not cancelled.
 *
 * @param loop - The session's loop handle.
 * @param request - The stopped turn's facts, including the cancellation.
 * @param deliver - Starts the delivery of a committed wake.
 * @returns The delivery's result, or `null` when no wake was committed.
 */
export async function commitSettle<Result>(
  loop: LoopSession,
  request: SettleRequest,
  deliver: (wake: Wake, signal: AbortSignal) => Promise<Result>,
): Promise<Result | null> {
  const { signal } = request;
  if (signal.aborted) return null;
  const wake = await loop.run(request);
  // The stop may arrive while the strategies run: the verdict is then
  // dropped instead of being charged and delivered.  A cancelled run
  // already logged its own silence, so only a dropped verdict logs here.
  if (signal.aborted) {
    if (wake !== null) {
      log.debug({
        hook: "loop",
        event: "settle_cancelled",
        handler: wake.name,
      });
    }
    return null;
  }
  if (wake === null) return null;
  // Count and start the delivery in one synchronous segment: no stop can
  // land between the charge and the host's dispatch.
  loop.record(wake.name);
  return deliver(wake, signal);
}
