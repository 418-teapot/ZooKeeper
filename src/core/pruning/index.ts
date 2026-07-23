/**
 * Context pruning — framework-agnostic pure logic.
 *
 * Provides the mark-sweep pruning types, state management, and sweep
 * (collect/replace) functions.  OpenCode framework adapter lives in
 * `src/hooks/context-pruning/`.
 *
 * @module
 */

export type { PruneReplacement, SweepMark } from "./prune.js";
export {
  collectSweepCallIDs,
  pruneToolOutputs,
} from "./prune.js";
export type { SessionState } from "./state.js";
export {
  _clearAllSessionsForTesting,
  _removeSessionForTesting,
  deleteSessionState,
  getOrCreateSessionState,
  loadSessionState,
  removeSession,
  saveSessionState,
} from "./state.js";
export type { SweepToolPart } from "./types.js";
export { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "./types.js";
