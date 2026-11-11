/**
 * Loop engine: safety interlock, strategy fan-out, and per-session budget.
 *
 * The engine is the executor half of the outer loop.  Before consulting
 * any strategy it enforces the interlock that does not depend on a
 * strategy being correct: the turn must have genuinely settled.  It then
 * fans out to the registered strategies in order, skipping any whose own
 * wake allowance is spent (each strategy declares it via
 * `SettledContribution.maxWakes`), converging on the first `wake`
 * (per-handler crash isolation; a crash is silence, never a wake), and
 * hands the winning verdict back to the host, which delivers the text.
 *
 * The engine holds the strategies only.  A session scope owns one
 * {@link LoopSession} handle, created by {@link LoopEngine.createSession},
 * and that handle keeps the session's reminder counters and awaiting
 * locks: the engine never keys state by session, so it caches no handle
 * and needs no session cap.  The handle goes away with its scope, and a
 * new scope of the same session starts empty.
 *
 * The host records a delivered wake through {@link LoopSession.record}
 * immediately before dispatch, and resets the session's budgets through
 * {@link LoopSession.reset} on a real user turn.  Because the counter
 * lives in the handle, the budget interlock cannot be bypassed by a
 * strategy that forgets to check it.
 *
 * A delivered wake also locks that strategy in the handle.  A later
 * settle with no tool activity skips only the locked strategies — no
 * consultation, no budget spent, the lock kept — while unlocked
 * strategies are still consulted, so a text-only reply to one strategy's
 * wake cannot silence another's.  Any tool activity releases every lock
 * the handle holds: one active turn answers all pending wakes.  The lock
 * shares the budget's lifecycle: {@link LoopSession.reset} clears both.
 *
 * @module
 */

import { log } from "../../utils/logger.js";
import type {
  SettledContribution,
  SettledInput,
  SettleRequest,
} from "./settle.js";

/**
 * Why the engine withheld a wake before consulting a strategy.
 *
 * These reasons belong to the engine alone; a strategy's own silence
 * vocabulary is separate and lives with the strategy.
 */
export type EngineSilenceReason =
  | "not-settled"
  | "budget-exhausted"
  | "awaiting-activity";

/**
 * The winning strategy's verdict, labelled with the strategy that won.
 *
 * The host needs the name to charge the delivered wake to the winning
 * strategy's budget and to read that budget back for logging.
 */
export interface Wake {
  /** The contributing strategy's name (the budget account key). */
  name: string;
  /** The text to deliver. */
  text: string;
}

/**
 * One session's loop state: its reminder counters and awaiting locks.
 *
 * A session scope owns one handle.  The handle closes over its own
 * session, so no call names a session and no two sessions share state.
 */
export interface LoopSession {
  /**
   * Judge a stopped turn of this session and return the first wake.
   *
   * Enforces the cause interlock first: a turn that did not settle logs
   * `not-settled` and returns `null` without consulting any strategy.
   * Then the awaiting-progress lock: any tool activity releases every
   * lock this session holds and evaluation continues; a settle without
   * activity skips the locked strategies — each logged
   * `awaiting-activity` with its name, unconsulted and spending no
   * budget — while unlocked strategies still run.  Strategies run in
   * registration order; a strategy whose own allowance is spent logs
   * `budget-exhausted` (with its name) and is skipped so later strategies
   * may still win.  Each consulted handler is error-isolated (a throwing
   * handler is logged as `handler_crashed` and never blocks the next),
   * the first `wake` wins and every strategy silence is logged.  `null`
   * means silence — the host must not invent a wake.
   *
   * @param request - The stopped turn's facts (cause and activity).
   * @returns The first wake verdict, or `null` when nothing wakes.
   */
  run(request: SettleRequest): Promise<Wake | null>;
  /**
   * Count one delivered wake for a strategy and lock it.
   *
   * The host calls this immediately before dispatching the wake text, so
   * a delivery failure cannot become an unbounded retry loop.  The
   * strategy's lock holds until a later settle shows any tool activity
   * (see {@link LoopSession.run}).
   *
   * @param name - The winning strategy's name.
   */
  record(name: string): void;
  /**
   * Start fresh budgets for this session and clear all its locks.
   *
   * Called on a real user turn so the next settle begins with every
   * strategy's full allowance and no lock.
   */
  reset(): void;
  /**
   * Observe the wakes already recorded for a strategy.
   *
   * @param name - The strategy to read.
   * @returns The number of wakes recorded (zero when none).
   */
  used(name: string): number;
}

/**
 * The loop engine: interlock, strategy fan-out, and session handles.
 *
 * The host translates its stop event into a {@link SettleRequest}, calls
 * {@link LoopSession.run} on the session's handle, records a delivered
 * wake with {@link LoopSession.record}, and resets budgets with
 * {@link LoopSession.reset}.
 */
export interface LoopEngine {
  /**
   * Build the loop state of one session.
   *
   * The caller is the session scope owning the handle: the engine keeps
   * no reference to it, so its state ends when the scope releases it.
   *
   * @param sessionID - The session the handle serves.
   * @returns The session's loop handle.
   */
  createSession(sessionID: string): LoopSession;
}

/**
 * Build the loop engine over the composed settle contributions.
 *
 * @param contributions - The composed settle contributions, in registry
 *   order; each carries its own wake allowance.
 * @returns The engine.
 */
export function createLoopEngine(
  contributions: SettledContribution[],
): LoopEngine {
  // Strategy names are the budget account keys: a collision would let
  // one strategy's wakes drain another's allowance.
  const seen = new Set<string>();
  for (const { name } of contributions) {
    if (seen.has(name)) {
      throw new Error(`createLoopEngine: duplicate strategy name "${name}"`);
    }
    seen.add(name);
  }

  return {
    createSession(sessionID: string): LoopSession {
      // Per-strategy counters: the handle's whole budget.
      const counts = new Map<string, number>();
      // Strategies whose delivered wake no tool-active settle answered
      // yet.  Scoped per strategy so a text-only reply to one strategy's
      // wake cannot silence another's; any activity releases all of them,
      // like oh-my-pi's loop lock.  Cleared with the counters on reset.
      const awaiting = new Set<string>();

      return {
        async run(request: SettleRequest): Promise<Wake | null> {
          const { cause, hadActivity } = request;
          if (cause !== "settled") {
            log.debug({
              hook: "loop",
              event: "settle_interlock",
              sessionId: sessionID,
              reason: "not-settled",
            });
            return null;
          }
          if (hadActivity) {
            // Any tool activity is progress on some wake: one active turn
            // answers every pending lock of the session.
            awaiting.clear();
          }

          const input: SettledInput = { sessionID, hadActivity };
          for (const { name, maxWakes, handle } of contributions) {
            if (awaiting.has(name)) {
              // A text-only reply to this strategy's wake is not progress:
              // skip the strategy, spend no budget, keep the lock.  The
              // other strategies are still consulted.
              log.debug({
                hook: "loop",
                event: "settle_interlock",
                sessionId: sessionID,
                reason: "awaiting-activity",
                handler: name,
              });
              continue;
            }
            if ((counts.get(name) ?? 0) >= maxWakes) {
              log.debug({
                hook: "loop",
                event: "settle_interlock",
                sessionId: sessionID,
                reason: "budget-exhausted",
                handler: name,
              });
              continue;
            }
            try {
              const decision = await handle(input);
              if (decision.kind === "wake")
                return { name, text: decision.text };
              // A silence is otherwise invisible to field diagnosis: record
              // the contributing unit and the gate that suppressed the wake.
              log.debug({
                hook: "loop",
                event: "settle_silent",
                sessionId: sessionID,
                handler: name,
                reason: decision.reason,
              });
            } catch (err) {
              log.error({
                hook: "plugin",
                event: "handler_crashed",
                sessionId: sessionID,
                handler: name,
                error: String(err),
              });
            }
          }
          return null;
        },

        record(name: string): void {
          awaiting.add(name);
          counts.set(name, (counts.get(name) ?? 0) + 1);
        },

        reset(): void {
          counts.clear();
          awaiting.clear();
        },

        used(name: string): number {
          return counts.get(name) ?? 0;
        },
      };
    },
  };
}
