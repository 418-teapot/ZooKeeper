/**
 * Tool-host capability port.
 *
 * Pure types: the host tool services (session resolution, notification)
 * used by tool adapters and command handlers.  The file imports types
 * only — never an implementation.
 *
 * @module
 */

import type { ToolHost } from "../client/tool-host.js";

/** The tool-host capability. */
export interface ToolHostPort {
  /** Host tool services used by tool adapters. */
  toolHost: ToolHost;
}
