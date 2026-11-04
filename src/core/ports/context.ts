/**
 * Context-pruning capability port.
 *
 * Pure types: the unified pruning configuration (`[zoo.context]`), the host
 * adapter the pruning pipeline drives, and the plugin instance's context
 * runtime.  The file imports types only — never an implementation.
 *
 * @module
 */

import type { ContextPruningConfig } from "../config-types.js";
import type { HostAdapter } from "../context/lens.js";
import type { ContextRuntime } from "../context/runtime.js";

/** The context-pruning capability. */
export interface ContextPort {
  /** Unified context-pruning configuration (`[zoo.context]`). */
  contextConfig: ContextPruningConfig;
  /** Host adapter for context-pruning. */
  adapter: HostAdapter<unknown>;
  /**
   * The plugin instance's context records (session state, model limits,
   * round views, pending-view-change flags).
   *
   * The composition root creates exactly one runtime per instance, so no
   * unit reaches another instance's state.
   */
  contextRuntime: ContextRuntime;
}
