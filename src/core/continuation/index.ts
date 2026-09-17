/**
 * Auto-continuation decision module.
 *
 * Re-exports the pure judgment that decides whether a settled agent should
 * be woken to finish its remaining todos, along with its input and output
 * types, the fixed reminder directive, and the shared runner that drives
 * the composed settle contributions.
 *
 * @module
 */

export type {
  Budget,
  Decision,
  SilenceReason,
  StopCause,
  TurnToolCall,
  WorkVocabulary,
} from "./decide.js";
export {
  CONTINUATION_PROMPT,
  decide,
  isAwaitingUserAnswer,
  resolveWorkActions,
} from "./decide.js";
export { runSettled } from "./runner.js";
