/**
 * Loop engine: safety interlock, strategy fan-out, and per-strategy budget.
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
 * The engine owns the per-(session, strategy) reminder counter — hosts no
 * longer keep a parallel map.  The host records a delivered wake through
 * {@link LoopEngine.record} immediately before dispatch, and resets a
 * session's budgets through {@link LoopEngine.reset} on a real user turn
 * (and, on hosts that emit it, session deletion or restart).  Because the
 * counter lives here, the budget interlock cannot be bypassed by a
 * strategy that forgets to check it.
 *
 * @module
 */

import { log } from "../../utils/logger.js";
import type {
  SettledContribution,
  SettledInput,
  SettleRequest,
} from "../slots.js";

/**
 * Why the engine withheld a wake before consulting a strategy.
 *
 * These reasons belong to the engine alone; a strategy's own silence
 * vocabulary is separate and lives with the strategy.
 */
export type EngineSilenceReason = "not-settled" | "budget-exhausted";

/**
 * A verdict for one settled turn.
 *
 * `wake` carries the text to deliver; `silence` carries a
 * machine-readable reason.  The reason vocabulary is the contributor's:
 * the engine knows only its own {@link EngineSilenceReason}, a strategy
 * names its own gates.  The generic parameter lets a strategy pin its
 * reason type while the engine consumes the widened default.
 */
export type Decision<R extends string = string> =
  | { kind: "wake"; text: string }
  | { kind: "silence"; reason: R };

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
 * The backing budget store: session → strategy name → wakes recorded.
 *
 * A Map iterates in insertion order, so the session level doubles as the
 * eviction order for the optional session cap.
 */
export type BudgetStore = Map<string, Map<string, number>>;

/** Options for {@link createLoopEngine}. */
export interface LoopEngineOptions {
  /**
   * Optional upper bound on tracked sessions.  When set, recording a wake
   * evicts the oldest-inserted session (and all of its strategy counts)
   * once the bound is exceeded.  A Map iterates in insertion order, so
   * this is a cheap LRU bound for hosts that fire no session-deletion
   * event.
   */
  cap?: number;
  /** Test seam: the backing counter store to observe and seed. */
  store?: BudgetStore;
}

/**
 * The loop engine: interlock, strategy fan-out, and budget bookkeeping.
 *
 * The host translates its stop event into a {@link SettleRequest}, calls
 * {@link LoopEngine.run}, records a delivered wake with
 * {@link LoopEngine.record}, and resets budgets with
 * {@link LoopEngine.reset}.
 */
export interface LoopEngine {
  /**
   * Judge a stopped turn and return the first wake verdict.
   *
   * Enforces the cause interlock first: a turn that did not settle logs
   * `not-settled` and returns `null` without consulting any strategy.
   * Otherwise strategies run in registration order; a strategy whose own
   * allowance is spent logs `budget-exhausted` (with its name) and is
   * skipped so later strategies may still win.  Each consulted handler is
   * error-isolated (a throwing handler is logged as `handler_crashed` and
   * never blocks the next), the first `wake` wins and every strategy
   * silence is logged.  `null` means silence — the host must not invent a
   * wake.
   *
   * @param request - The stopped turn's facts (session, cause, progress).
   * @returns The first wake verdict, or `null` when nothing wakes.
   */
  run(request: SettleRequest): Promise<Wake | null>;
  /**
   * Count one delivered wake for a session's strategy.
   *
   * The host calls this immediately before dispatching the wake text, so
   * a delivery failure cannot become an unbounded retry loop.
   *
   * @param sessionID - The session the wake was delivered to.
   * @param name - The winning strategy's name.
   */
  record(sessionID: string, name: string): void;
  /**
   * Start fresh budgets for a session.
   *
   * Called on a real user turn (and on session restart / deletion) so the
   * next settle begins with every strategy's full allowance.
   *
   * @param sessionID - The session whose budgets reset.
   */
  reset(sessionID: string): void;
  /**
   * Observe the wakes already recorded for a session's strategy.
   *
   * @param sessionID - The session to read.
   * @param name - The strategy to read.
   * @returns The number of wakes recorded (zero when none).
   */
  used(sessionID: string, name: string): number;
}

/**
 * Build the loop engine over the composed settle contributions.
 *
 * @param contributions - The composed settle contributions, in registry
 *   order; each carries its own wake allowance.
 * @param options - Optional session cap and the test-seam backing store.
 * @returns The engine.
 */
export function createLoopEngine(
  contributions: SettledContribution[],
  options: LoopEngineOptions = {},
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
  const store = options.store ?? new Map<string, Map<string, number>>();
  const cap = options.cap;

  return {
    async run(request: SettleRequest): Promise<Wake | null> {
      const { sessionID, cause, progress } = request;
      if (cause !== "settled") {
        log("loop", "settle_interlock", sessionID, undefined, "debug", {
          reason: "not-settled",
        });
        return null;
      }

      const input: SettledInput = { sessionID, progress };
      const counts = store.get(sessionID);
      for (const { name, maxWakes, handle } of contributions) {
        if ((counts?.get(name) ?? 0) >= maxWakes) {
          log("loop", "settle_interlock", sessionID, undefined, "debug", {
            reason: "budget-exhausted",
            handler: name,
          });
          continue;
        }
        try {
          const decision = await handle(input);
          if (decision.kind === "wake") return { name, text: decision.text };
          // A silence is otherwise invisible to field diagnosis: record
          // the contributing unit and the gate that suppressed the wake.
          log("loop", "settle_silent", sessionID, undefined, "debug", {
            handler: name,
            reason: decision.reason,
          });
        } catch (err) {
          log("plugin", "handler_crashed", sessionID, undefined, "error", {
            handler: name,
            error: String(err),
          });
        }
      }
      return null;
    },

    record(sessionID: string, name: string): void {
      const counts = store.get(sessionID) ?? new Map<string, number>();
      counts.set(name, (counts.get(name) ?? 0) + 1);
      store.set(sessionID, counts);
      if (cap === undefined) return;
      while (store.size > cap) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },

    reset(sessionID: string): void {
      store.delete(sessionID);
    },

    used(sessionID: string, name: string): number {
      return store.get(sessionID)?.get(name) ?? 0;
    },
  };
}
