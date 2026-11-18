/**
 * Subagent-delegation capability port.
 *
 * Pure types: the host driver that executes a delegated run plus the model
 * input the `subagent` tool reads.  The file imports types only — never an
 * implementation.
 *
 * @module
 */

import type { SubagentDriver } from "../subagent/driver.js";
import type { RunRegistry } from "../subagent/registry.js";

/**
 * The run-record operations the subagent tool writes: start a run, patch its
 * progress, and finish it.
 *
 * Scope creation, subscription, restore, queries and disposal belong to the
 * host assembly — a consumer never reaches them.
 */
export type RunWrites = Pick<RunRegistry, "start" | "update" | "finish">;

/** The subagent-delegation capability. */
export interface SubagentPort {
  /**
   * The subagent run records of this runtime.
   *
   * The tool writes each delegation through this scope (start, progress,
   * terminal finish), so the fleet surfaces of the host render from the
   * same records the tool produced and the runtime's stop ends exactly the
   * runs it started.  Every write enters the same run table the host's
   * process owner keeps, never a second table.  Only the delegation writes
   * are exposed; the registry's management surface stays with the host
   * assembly.
   */
  runs: RunWrites;
  /**
   * Host subagent driver (only on hosts that can execute a delegated run).
   *
   * Absent on hosts without one — the subagent tool unit then contributes
   * no tools, so no `subagent` tool ever registers there (OpenCode keeps
   * its native `task` tool).
   */
  subagentDriver: SubagentDriver;
  /**
   * Per-agent model map for subagent sessions (`~/.pi/agent/agents.json`).
   *
   * Materialised by the installer from `[agent.<name>].model` as a
   * `{provider, model}` pair whose mapped value here is the concatenated
   * `"provider/model"` string (the TS runtime never resolves `{env:}`
   * tokens or reads environment variables).  Strict mode: this map is the
   * SOLE model source — the subagent tool errors (never inherits or falls
   * back) when the target agent's entry is absent.  Empty when the file is
   * missing/invalid (fail-closed — every subagent delegation then reports
   * an actionable error naming agents.json).
   */
  subagentModels: Record<string, string>;
  /**
   * Subagent run timeout in seconds (`[zoo.subagent].timeout`).
   *
   * Absent when the section is absent or failed validation — a run then
   * waits for the driver to settle without a time limit (no default timeout
   * is ever invented).  The timeout is cooperative: it aborts the run, which
   * then reports `timeout` once the driver settles.
   */
  subagentTimeoutSeconds: number;
}
