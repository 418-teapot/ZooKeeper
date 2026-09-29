/**
 * Loop-engine module.
 *
 * Re-exports the shared loop engine (interlock, strategy fan-out, and
 * per-strategy budget bookkeeping) along with the settled-turn fact its
 * hosts and strategies consume: the stop cause.  A strategy (e.g.
 * todo-continuation) contributes a `wake`/`silence` verdict on the
 * `onSettled` slot; the engine decides whether a strategy is consulted
 * at all.
 *
 * @module
 */

export type {
  BudgetStore,
  Decision,
  EngineSilenceReason,
  LoopEngine,
  LoopEngineOptions,
  StopCause,
  Wake,
} from "./engine.js";
export { createLoopEngine } from "./engine.js";
