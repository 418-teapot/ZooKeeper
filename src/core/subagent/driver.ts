/**
 * Host-agnostic subagent execution contract.
 *
 * Defines the request, progress, and result types produced by a subagent
 * run, plus the `SubagentDriver` interface a host implements to execute a
 * subagent.  All host-specific behaviour — how a sub-session is created,
 * how its messages stream, how termination is wired — lives behind this
 * interface, so core orchestration drives a subagent run without knowing
 * which host backs it.  A new host only needs a new driver implementation;
 * nothing in core changes.
 *
 * A run's content reaches the caller through two distinct channels: the
 * driver appends every observed fact (tool calls, assistant messages,
 * usage) verbatim to the run's append-only log (`run-log.ts`), and reports
 * a single capped text line per advance through `onProgress`.  Only the log
 * carries structure; the progress channel never carries snapshots.
 *
 * @module
 */

import type { RunLog } from "./run-log.js";

/**
 * The request a subagent run is launched with.
 *
 * `agent` is the target agent name; it is resolved by identity binding
 * before the driver runs, never resolved by the driver itself.  `prompt`
 * is the prompt text handed to the subagent.  `tools` is the capability
 * whitelist the driver must pass to the host session factory.  `model` is
 * the configured `"provider/model"` string (strict mode: agents.json is the
 * sole source, so a request always carries one — the tool layer enforces
 * this before ever calling the driver).  `parentSession` is a pointer used
 * for session lineage on hosts that persist sessions.
 */
export interface SubagentRequest {
  agent: string;
  prompt: string;
  tools: string[];
  model: string;
  parentSession?: string;
}

/**
 * The one-line progress report a driver emits while a run is in flight.
 *
 * Carries the currently running tool name, a one-line summary of recent
 * output, and a completion flag — plus the host facts the run registry
 * needs and the tool layer cannot derive itself (the resolved model id, the
 * sub-session id, its on-disk file path, and the running token total).
 * Everything structural (tool calls, output lines, turn and tool counters,
 * the terminal result) no longer travels here: the driver appends it
 * verbatim to the run's fact log and views project it from there.
 *
 * Token totals are the one aggregate that DOES travel here: the driver
 * already sees each message's usage as it appends the fact, so carrying the
 * running sum costs nothing, while having the tool layer re-derive it per
 * progress tick would rescan the whole fact log every time.
 *
 * The report must stay small — the full subagent transcript never flows
 * through here.  `output` is already compacted to a single capped line.
 * The `done: true` report is the terminal one, emitted once the run has
 * settled (success, error, or abort).
 */
export interface SubagentProgress {
  /** A one-line summary of the subagent's recent output. */
  output: string;
  /** Whether the subagent run has finished. */
  done: boolean;
  /**
   * The tool name the subagent is currently running.
   *
   * Tri-state by design: a name means "this tool started", `null` means
   * "no tool is running any more" (the driver sends it when a tool call
   * ends), and an absent field means "nothing changed" — the receiver must
   * leave whatever it holds untouched.
   */
  currentTool?: string | null;
  /** The accumulated token usage reported by the sub-session so far, when
   * any message reported usage.  The driver maintains the running sum as it
   * appends message facts. */
  tokens?: number;
  /** The model id actually used by the sub-session (the id part of a
   * `"provider/id"` string), when one was resolved. */
  model?: string;
  /** The on-disk path of the sub-session file, when the host persists
   * sessions (pi).  Absent on hosts without a session-file concept
   * (OpenCode). */
  sessionPath?: string;
  /** The sub-session id this run created once the host materialises it
   * (pi reports the child session after `SessionManager.create`).  The
   * tool layer forwards it to the run registry so the fleet widget can
   * rebuild the parent/child tree. */
  childSession?: string;
}

/**
 * The outcome of a subagent run.
 *
 * A discriminated union covering the three outcomes — `ok`, `aborted`, and
 * `error`.  Every variant carries `text`: the assistant text produced before
 * the outcome, so even failures rescue whatever partial output was generated.
 */
export type SubagentResult =
  | { kind: "ok"; text: string }
  | { kind: "aborted"; text: string }
  | {
      kind: "error";
      text: string;
      errorMessage: string;
    };

/**
 * The host interface for executing a subagent.
 *
 * Implementations own every host-specific concern: creating the sub-session,
 * streaming its messages, and wiring termination.  Contract:
 *
 * - Implementations are required to honor `signal` and abort the run
 *   promptly when it fires.
 * - Implementations must not reject on abort — abort is a normal outcome
 *   and must be surfaced via the result, never as a rejected promise.
 * - Implementations must never throw for session-level failures; they
 *   collapse such failures into an `error` result.
 */
export interface SubagentDriver {
  /**
   * Run the delegation to completion.
   *
   * @param request - Agent, prompt, allowed tools, and model.
   * @param ctx.signal - The parent abort signal, honored cooperatively.
   * @param ctx.onProgress - Optional one-line progress report, called
   *   whenever the run advances (tool start, assistant message, terminal).
   *   Hosts that do not render a live progress line omit it.
   * @param ctx.log - The run's append-only fact log, when the caller owns
   *   one.  The driver appends the full, untruncated facts as it observes
   *   them; views project the log at their own render boundary.  Absent
   *   when the caller has no registry run, in which case the driver only
   *   reports text.
   * @returns The terminal result.
   */
  run(
    request: SubagentRequest,
    ctx: {
      signal: AbortSignal;
      onProgress?: (progress: SubagentProgress) => void;
      log?: RunLog;
    },
  ): Promise<SubagentResult>;
}
