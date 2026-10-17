/**
 * Subagent-delegation capability port.
 *
 * Pure types: the host driver that executes a delegated run plus the
 * optional renderer, baseline and model inputs the `subagent` tool reads.
 * The file imports types only — never an implementation.
 *
 * @module
 */

import type { SubagentDriver } from "../subagent/driver.js";

/**
 * Structural host renderer for a tool's transcript card.
 *
 * Deliberately loose (never importing pi types in core): the tool unit
 * attaches these callbacks when a host supplies them, so its TUI can draw
 * a live card; a host without a renderer keeps the plain text behaviour.
 */
export interface ToolCardRenderer {
  renderCall(args: unknown, theme: unknown, context?: unknown): unknown;
  renderResult(
    result: unknown,
    options: unknown,
    theme: unknown,
    context?: unknown,
  ): unknown;
}

/** The subagent-delegation capability. */
export interface SubagentPort {
  /**
   * Host subagent driver (only on hosts that can execute a delegated run).
   *
   * Absent on hosts without one — the subagent tool unit then contributes
   * no tools, so no `subagent` tool ever registers there (OpenCode keeps
   * its native `task` tool).
   */
  subagentDriver: SubagentDriver;
  /**
   * Optional host renderer for the subagent tool card.
   *
   * When present the tool attaches its `renderCall` / `renderResult`
   * callbacks so the host TUI draws a live transcript card instead of the
   * plain text snapshot.
   */
  subagentRenderer: ToolCardRenderer;
  /**
   * The host's full untrimmed tool-name baseline for subagent capability
   * computation, as a thunk.
   *
   * Ports carry BEHAVIOR, not data snapshots: a value-typed port would
   * freeze the capture at assembly time, but computing the baseline calls
   * a host action method that may not run while the host is still loading
   * the extension (pi forbids it then).  The thunk makes the timing
   * explicit — the unit invokes it inside `execute`, which is always
   * post-load — and lets the supplier cache the result internally.
   * Mirrors the switch command's baseline source.  Absent (or returning
   * `undefined`) when the host cannot supply it — the subagent tool then
   * runs with whatever `computeCapabilitySet` yields (an empty set,
   * fail-closed; permissions are never invented).
   */
  subagentBaseline?: () => string[] | undefined;
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
   * Called after every subagent run-registry mutation (start / update /
   * finish) so the host can nudge its fleet widget to re-render.
   *
   * Absent on hosts without a fleet widget.
   */
  onSubagentRunChange: () => void;
}
