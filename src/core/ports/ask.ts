/**
 * Ask capability port.
 *
 * Pure types: the host form presentation for the `ask` tool and its
 * timeout budget.  The file imports types only — never an implementation.
 *
 * @module
 */

import type { AskFormHost } from "../ask.js";

/** The ask capability. */
export interface AskPort {
  /**
   * Host form presentation for the ask tool.
   *
   * Absent on hosts without one — the ask tool unit then contributes no
   * tools, so `ask` never registers there.  The form host owns the dialog
   * lifecycle: it mounts the host's component surface, waits for the user,
   * and applies the timeout/abort.
   */
  askFormHost: AskFormHost;
  /**
   * Ask-tool timeout in seconds (`[zoo.ask].timeout`).
   *
   * Absent when the section is absent or failed validation — the ask tool
   * then waits for the user indefinitely (no default timeout is ever
   * invented).
   */
  askTimeoutSeconds: number;
}
