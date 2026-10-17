/**
 * Context-pruning capability port.
 *
 * Pure types: the unified pruning configuration (`[zoo.context]`) and the
 * host adapter the pruning pipeline drives.  The file imports types only —
 * never an implementation.
 *
 * @module
 */

import type { ContextPruningConfig } from "../config-types.js";
import type { HostAdapter } from "../context/lens.js";

/** The context-pruning capability. */
export interface ContextPort {
  /** Unified context-pruning configuration (`[zoo.context]`). */
  contextConfig: ContextPruningConfig;
  /** Host adapter for context-pruning. */
  adapter: HostAdapter<unknown>;
}
