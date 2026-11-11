/**
 * Loop-engine module.
 *
 * Re-exports the shared loop engine (interlock, strategy fan-out, and the
 * per-session handles that keep each session's budget and awaiting locks)
 * along with the settled-turn contract its hosts and strategies consume.
 * A strategy (e.g. todo-continuation) contributes a `wake`/`silence`
 * verdict on the `onSettled` slot; the engine decides whether a strategy
 * is consulted at all.
 *
 * @module
 */

export type {
  EngineSilenceReason,
  LoopEngine,
  LoopSession,
  Wake,
} from "./engine.js";
export { createLoopEngine } from "./engine.js";
export type {
  Decision,
  SettledContribution,
  SettledInput,
  SettleRequest,
  StopCause,
} from "./settle.js";
