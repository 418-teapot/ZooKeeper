/**
 * Auto-continuation capability port.
 *
 * Pure types: the wake budget parsed from `[zoo.continuation]`, which the
 * todo-continuation strategy reads and declares as its own allowance.  The
 * file imports types only — never an implementation.
 *
 * @module
 */

import type { ContinuationConfig } from "../config-types.js";

/** The auto-continuation capability. */
export interface ContinuationPort {
  /**
   * Auto-continuation budget (`[zoo.continuation]`), parsed fail-closed.
   *
   * The continuation strategy reads its own wake allowance from here; a
   * missing/invalid section leaves this capability unprovided and the unit
   * contributes no settle handler at all.
   */
  continuationConfig: ContinuationConfig;
}
