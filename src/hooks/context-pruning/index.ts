/**
 * Context pruning hook barrel export.
 *
 * Re-exports the OpenCode framework adapter and the unified
 * config type.  Pure logic (types, state, prune) is at
 * `src/core/pruning/`.
 *
 * @module
 */

export type {
  CompressConfig,
  ContextPruningConfig,
  ProducerGateConfig,
} from "./hook.js";
export { contextPruningTransformHandler } from "./hook.js";
