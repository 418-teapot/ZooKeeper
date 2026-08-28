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
 * @module
 */

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
 * A compact progress snapshot streamed to the caller during a run.
 *
 * Carries the currently running tool name, a one-line summary of recent
 * output, and a completion flag.  Beyond the base snapshot, a structured
 * view is accumulated for live transcript rendering: the recent tool calls
 * (name plus a one-line summary), the recent output lines, the turn and
 * tool-call counters, and the start timestamp.  The snapshot must stay
 * small — the full subagent transcript never flows through here.
 */
export interface SubagentProgress {
  /** The subagent name (target agent). */
  agent?: string;
  /** The tool name the subagent is currently running, or undefined when idle. */
  currentTool?: string;
  /** A one-line summary of the subagent's recent output. */
  output: string;
  /** Whether the subagent run has finished. */
  done: boolean;
  /** Recent tool calls: name plus a one-line summary each. */
  toolCalls?: Array<{ name: string; summary: string }>;
  /** Recent output lines (most recent last). */
  outputLines?: string[];
  /** Number of completed turns. */
  turnCount?: number;
  /** Number of completed tool calls. */
  toolCallCount?: number;
  /** Epoch-millis start time of the run. */
  startedAt?: number;
  /** The model id actually used by the sub-session (the id part of a
   * `"provider/id"` string), when one was resolved. */
  model?: string;
  /** The total token usage accumulated across the sub-session's assistant
   * messages, when the provider reports usage.  Absent when no usage data
   * was observed. */
  tokens?: number;
  /** The on-disk path of the sub-session file, when the host persists
   * sessions (pi).  Absent on hosts without a session file concept
   * (OpenCode). */
  sessionPath?: string;
  /** The final result when the run has finished. */
  result?:
    | { kind: "ok"; text: string }
    | { kind: "aborted"; text: string }
    | {
        kind: "error";
        text: string;
        errorMessage: string;
      };
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
  | { kind: "error"; text: string; errorMessage: string };

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
  run(
    request: SubagentRequest,
    ctx: {
      signal: AbortSignal;
      onProgress?: (progress: SubagentProgress) => void;
    },
  ): Promise<SubagentResult>;
}
