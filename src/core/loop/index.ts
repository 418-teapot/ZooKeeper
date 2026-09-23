/**
 * Loop-engine module.
 *
 * Re-exports the shared loop engine (interlock, strategy fan-out, and
 * per-strategy budget bookkeeping) along with the settled-turn facts its
 * strategies consume: the stop cause, the host tool vocabulary, and the
 * turn-analysis helpers.  A strategy (e.g. todo-continuation) contributes
 * a `wake`/`silence` verdict on the `onSettled` slot; the engine decides
 * whether a strategy is consulted at all.
 *
 * @module
 */

export type {
  BudgetStore,
  Decision,
  EngineSilenceReason,
  LoopEngine,
  LoopEngineOptions,
  Wake,
} from "./engine.js";
export { createLoopEngine } from "./engine.js";
export type { StopCause, TurnToolCall, WorkVocabulary } from "./turn.js";
export { isAwaitingUserAnswer, resolveWorkActions } from "./turn.js";
