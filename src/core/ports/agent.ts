/**
 * Agent-identity capability port.
 *
 * Pure types: the parsed per-agent mode map and tool-level deny map that
 * drive primary derivation and capability trimming.  The file imports
 * types only — never an implementation.
 *
 * @module
 */

import type { AgentModeMap } from "../config-types.js";
import type { AgentPermissionMap } from "../permissions/deny-tools.js";

/** The agent-identity capability. */
export interface AgentPort {
  /**
   * Per-agent mode map (`[agent.*].mode`), parsed fail-closed.
   *
   * Maps every agent whose `mode` field parsed successfully to
   * `"primary"` / `"subagent"`; agents with a missing or invalid `mode`
   * are absent.  Consumed by the identity layer (e.g. `derivePrimaries`)
   * — an empty or absent map means no primary agent is configured and
   * the identity machinery stays disabled.
   */
  agentModes: AgentModeMap;
  /**
   * Per-agent tool-level deny map (`[agent.<name>].permission`), parsed
   * fail-closed by `parseAgentPermissions`.
   *
   * Maps every agent with at least one tool-level deny to its sorted
   * denied tool names; agents with none are absent.  Consumed by the
   * primary-switch command to trim the pi active tool set — an empty or
   * absent map leaves the active tool set untouched.
   */
  agentPermissions: AgentPermissionMap;
}
