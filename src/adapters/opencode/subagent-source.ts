/**
 * OpenCode subagent fact source — the translator that turns host facts into
 * core registry runs.
 *
 * The panel used to own a private subagent state machine (its own status
 * enum, its own merge rules, its own entry map).  This module replaces it
 * with a translator: every host fact is written into the process-level run
 * registry (`src/core/subagent/registry.ts`) and the panel renders from the
 * registry.  The translator holds no run state of its own, so there is
 * exactly one place where run lifecycle and progress live.
 *
 * Two rules cover what the retired merge table encoded:
 *
 * 1. **Status lattice** — `running → done | error | aborted`, terminal
 *    absorbing.  The registry ignores any write that arrives after a run
 *    finished, so a late or out-of-order event can never rewrite it.
 * 2. **Monotone enrichment** — before the terminal transition the newest
 *    fact wins, after it everything is frozen.
 *
 * Host timing worth knowing: `session.idle` and `session.error` are emitted
 * before the host writes the task part's terminal state, so those events
 * carry no status and never terminate a run directly.
 *
 * Token counts only come from the HTTP API, so a poll reads each live child
 * session's last assistant message, and the final read happens while the
 * run is still active (the registry freezes a finished run).
 *
 * The lifecycle is the panel's: one source per panel mount, disposed with
 * it.
 *
 * @module
 */

import {
  finishRun,
  getRun,
  startRun,
  TERMINAL_STATUSES,
  type UpdateRunPatch,
  updateRun,
} from "../../core/subagent/registry.js";
import { log } from "../../utils/logger.js";

/**
 * The interval of the context-length poll, in milliseconds.
 *
 * The token figure is only available through the HTTP API, so the live value
 * has to be pulled; the interval is short enough to look live and long
 * enough not to hammer a local HTTP server.
 */
const TOKEN_POLL_INTERVAL_MS = 500;

/**
 * The number of trailing messages the token read asks for.
 *
 * Only the last assistant message is needed, and child sessions can grow
 * long, so the read stays bounded.
 */
const TOKEN_READ_MESSAGE_LIMIT = 20;

/**
 * The host surfaces the source reads.
 *
 * Everything host-specific is injected so the module stays free of plugin
 * imports (and testable without a TUI runtime).
 */
export interface SubagentSourceDeps {
  /** HTTP client slice — source for the token reads of child sessions. */
  client: {
    session: {
      messages(options: {
        sessionID: string;
        limit?: number;
      }): Promise<unknown>;
    };
  };
  /** State slice — read for child-session parent checks while polling. */
  state: unknown;
  /** The panel's session — the owner of the subagents being translated. */
  parentSessionId: string;
  /** Shared session-message fetch — the reconcile scan's history source. */
  fetchSessionMessages: (sessionId: string) => Promise<unknown[]>;
}

/** Interface consumed by the panel — event wiring, reconcile, dispose. */
export interface SubagentSource {
  /** Live task-tool part handler. */
  onToolPartUpdated: (event: { properties?: Record<string, unknown> }) => void;
  /**
   * Child-session idle handler.
   *
   * The host emits idle BEFORE it writes the task part's terminal state, so
   * this handler never terminates a run itself: it triggers one reconcile
   * scan, and the part state the scan reads decides.
   */
  onSessionIdle: (event: { properties?: Record<string, unknown> }) => void;
  /** Child-session error handler — same rule as `onSessionIdle`. */
  onSessionError: (event: { properties?: Record<string, unknown> }) => void;
  /**
   * Reconcile the registry against the session history.
   *
   * The panel calls this on mount (it holds a shared history fetch it can
   * pass in) and the settlement handlers call it for a child session.  Runs
   * already in the registry are never overwritten; absent ones are rebuilt
   * from their authoritative part state.
   */
  reconcile: (preFetched?: Promise<unknown[]>) => Promise<void>;
  /** Stop every timer and release the translator (panel cleanup). */
  dispose: () => void;
}

/**
 * Extract the agent name from a task tool call state.
 *
 * Reads `state.input.subagent_type` and falls back to `"task"`.
 *
 * @param input - The part's tool input.
 * @returns The delegated agent name.
 */
export function extractAgent(
  input: Record<string, unknown> | undefined,
): string {
  const raw = input?.subagent_type;
  return raw !== undefined ? String(raw) : "task";
}

/**
 * Extract the model identifier from task call metadata.
 *
 * Reads `metadata.model.modelID`; a missing or non-string id yields
 * `undefined`.
 *
 * @param metadata - The part's tool metadata.
 * @returns The resolved model id, or `undefined`.
 */
export function extractModel(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) return undefined;
  const model = metadata.model;
  if (typeof model !== "object" || model === null) return undefined;
  const modelID = (model as Record<string, unknown>).modelID;
  return typeof modelID === "string" ? modelID : undefined;
}

/**
 * Extract the child session id from task call metadata.
 *
 * The host reports it as `session_id` (snake case) with `sessionId` as the
 * camel-case variant; an empty or absent value yields `undefined`.
 *
 * @param metadata - The part's tool metadata.
 * @returns The child session id, or `undefined`.
 */
function extractChildSession(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const raw = metadata?.session_id ?? metadata?.sessionId;
  if (raw === undefined || raw === null) return undefined;
  const id = String(raw);
  return id === "" ? undefined : id;
}

/**
 * Extract timestamp fields from a task tool call state.
 *
 * Reads `state.time.start` and `state.time.end` (epoch millis).  Only finite
 * numbers are accepted — a running part carries `start` but no `end`.
 *
 * @param state - The part's tool state.
 * @returns The extractable start / end times.
 */
export function extractTimes(state: Record<string, unknown>): {
  startedAt?: number;
  endedAt?: number;
} {
  const time = state.time;
  if (typeof time !== "object" || time === null) {
    return { startedAt: undefined, endedAt: undefined };
  }
  const raw = time as Record<string, unknown>;
  const start = raw.start;
  const end = raw.end;
  return {
    startedAt:
      typeof start === "number" && Number.isFinite(start) ? start : undefined,
    endedAt: typeof end === "number" && Number.isFinite(end) ? end : undefined,
  };
}

/**
 * A title fact and the strength of the source that produced it.
 *
 * `rank` orders the five-level fallback from strongest (a host-written
 * title, rank 0) to weakest (the part id, rank 3) so a later fact can only
 * replace the label when it comes from a stronger source.
 */
interface TitleFact {
  /** The title text (empty only when nothing at all is available). */
  label: string;
  /** The source rank — lower is stronger. */
  rank: number;
}

/**
 * Derive the title fact from a task tool call state.
 *
 * Priority: state.title → input.description → input.prompt (first 40 chars)
 * → part id slice (first 8 chars) → empty string.
 *
 * @param state - The part's tool state.
 * @param partId - The part id, the last-resort title source.
 * @returns The title text and its source rank.
 */
function titleFact(state: Record<string, unknown>, partId?: string): TitleFact {
  const title = state.title;
  if (typeof title === "string" && title.length > 0) {
    return { label: title, rank: 0 };
  }

  const input = state.input as Record<string, unknown> | undefined;

  const description = input?.description;
  if (typeof description === "string" && description.length > 0) {
    return { label: description, rank: 1 };
  }

  const prompt = input?.prompt;
  if (typeof prompt === "string" && prompt.length > 0) {
    return { label: prompt.slice(0, 40), rank: 2 };
  }

  if (partId) return { label: partId.slice(0, 8), rank: 3 };

  return { label: "", rank: 4 };
}

/**
 * Extract a human-readable title from a task tool call state.
 *
 * Priority: state.title → input.description → input.prompt (first 40 chars)
 * → part id slice (first 8 chars) → empty string.
 *
 * @param state - The part's tool state.
 * @param partId - The part id, the last-resort title source.
 * @returns The chosen title.
 */
export function extractTitle(
  state: Record<string, unknown>,
  partId?: string,
): string {
  return titleFact(state, partId).label;
}

/**
 * Extract the context length from the last assistant message that reported
 * usable usage.
 *
 * Messages are expected in the `{info, parts}[]` shape of
 * `client.session.messages`.  The traversal runs in reverse and skips
 * placeholder assistant messages whose token sum is zero (written at step
 * start before any usage is recorded).  The result is `input + cache.read`
 * — the subagent's current context size, not its cumulative consumption.
 *
 * @param messages - The message list.
 * @returns The context length, or `undefined` when nothing usable is found.
 */
export function extractContextTokens(
  messages: Record<string, unknown>[],
): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info as Record<string, unknown> | undefined;
    if (info?.role !== "assistant") continue;
    const tokens = info.tokens as
      | { input?: unknown; cache?: { read?: unknown } }
      | undefined;
    if (!tokens) continue;
    // Defensive typeof checks: a non-numeric value must not poison the sum
    // (for example by string concatenation).
    const input = typeof tokens.input === "number" ? tokens.input : 0;
    const read = typeof tokens.cache?.read === "number" ? tokens.cache.read : 0;
    const sum = input + read;
    if (sum === 0) continue;
    return sum;
  }
  return undefined;
}

/**
 * Read the part's terminal outcome, if it has one.
 *
 * `completed` is `done`.  An `error` part is a cancellation (`aborted`) when
 * the host marked it interrupted or used its abort message, and a failure
 * (`error`) otherwise.
 *
 * @param state - The part's tool state.
 * @returns The terminal status, or `undefined` while the part is still live.
 */
function terminalOutcome(
  state: Record<string, unknown>,
): "done" | "error" | "aborted" | undefined {
  const status = state.status;
  if (status === "completed") return "done";
  if (status !== "error") return undefined;
  const metadata = state.metadata as Record<string, unknown> | undefined;
  if (metadata?.interrupted === true) return "aborted";
  if (state.error === "Tool execution aborted") return "aborted";
  return "error";
}

/**
 * Create the subagent fact translator for one panel mount.
 *
 * @param deps - The host surfaces (client, state, session, history fetch).
 * @returns The event handlers the panel wires onto the host bus.
 */
export function createSubagentSource(deps: SubagentSourceDeps): SubagentSource {
  const { client, state: stateSlice, parentSessionId } = deps;

  // The title source that produced each run's current label.  The registry
  // stores the label value only; remembering its provenance is what lets a
  // later fact upgrade it while a same-or-weaker source leaves it alone.
  // This is not run state — the run itself lives in the registry.
  const labelRanks = new Map<string, number>();
  // Poll timers keyed by part id; cleared on dispose.
  const pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  // In-flight guard: prevents overlapping HTTP reads for the same part when
  // a read outlasts the poll interval.
  const pendingTokenFetches = new Set<string>();
  // Set by dispose: a reconcile continuation that outlives the panel (or any
  // later call) must not register runs or install poll timers afterwards.
  let disposed = false;

  /**
   * Read a child session's current context length
   * (`tokens.input + tokens.cache.read` of its last assistant message).
   *
   * The HTTP client is used rather than the state layer because the state
   * layer syncs only sessions that were opened in the TUI, and a
   * delegation's sub-session never is.  The value is the subagent's current
   * context size, not its cumulative consumption.
   *
   * Every failure degrades to `undefined`: this sits on a polling path where
   * logging each miss would flood the log.
   */
  async function readContextTokens(
    sessionId: string,
  ): Promise<number | undefined> {
    try {
      const res = await client.session.messages({
        sessionID: sessionId,
        limit: TOKEN_READ_MESSAGE_LIMIT,
      });
      // Defensive unwrap: the SDK may report an error without throwing and
      // may wrap the payload in `{ data }`.
      const envelope = res as { error?: unknown; data?: unknown };
      if (envelope.error) return undefined;
      const raw = (envelope.data ?? res) as Record<string, unknown>[];
      if (!Array.isArray(raw)) return undefined;
      return extractContextTokens(raw);
    } catch {
      return undefined;
    }
  }

  /** Stop the poll timer of a part, if any. */
  function stopPolling(partId: string): void {
    const timer = pollTimers.get(partId);
    if (timer === undefined) return;
    clearInterval(timer);
    pollTimers.delete(partId);
  }

  /**
   * One poll round: refresh a live run's context length.
   *
   * The round is skipped (never throwing from a timer) when the run already
   * finished, the state layer cannot resolve the child session yet, or a
   * previous read for the same part is still outstanding.  A session that is
   * no longer a child of the panel's session stops the poll for good.
   */
  function pollOnce(partId: string, childSession: string): void {
    if (pendingTokenFetches.has(partId)) return;
    try {
      if (getRun(partId)?.status !== "running") {
        stopPolling(partId);
        return;
      }
      const sessionApi = (stateSlice as Record<string, unknown> | undefined)
        ?.session as Record<string, unknown> | undefined;
      if (typeof sessionApi?.get !== "function") return;
      const child = (
        sessionApi.get as (id: string) => Record<string, unknown> | undefined
      )(childSession);
      // The sub-session is not synced into the state layer yet — skip the
      // round instead of dropping the run.
      if (child === undefined) return;
      if (child.parentID !== parentSessionId) {
        stopPolling(partId);
        return;
      }

      pendingTokenFetches.add(partId);
      void readContextTokens(childSession)
        .then((tokens) => {
          if (tokens !== undefined) updateRun(partId, { tokens });
        })
        .finally(() => {
          pendingTokenFetches.delete(partId);
        });
    } catch (err) {
      // Never throw from a timer; log so persistent failures stay visible.
      log.warn({
        hook: "opencode-subagent",
        event: "sub_poll_error",
        sessionId: parentSessionId,
        error: String(err),
      });
    }
  }

  /** Start polling a live run's context length, once per part. */
  function ensurePolling(partId: string, childSession: string): void {
    if (disposed) return;
    if (pollTimers.has(partId)) return;
    if (getRun(partId)?.status !== "running") return;
    pollTimers.set(
      partId,
      setInterval(() => pollOnce(partId, childSession), TOKEN_POLL_INTERVAL_MS),
    );
  }

  /**
   * Close a run with its final context length.
   *
   * The registry freezes a run at its terminal transition, so the last read
   * has to land while the run is still active: the terminal write waits for
   * it.  A failing read still closes the run — the status is the more
   * important fact.
   */
  function finishWithFinalTokens(
    partId: string,
    childSession: string | undefined,
    outcome: "done" | "error" | "aborted",
    endedAt: number | undefined,
    error: string | undefined,
  ): void {
    stopPolling(partId);
    labelRanks.delete(partId);
    const finish = (): void => {
      finishRun(partId, {
        status: outcome,
        ...(endedAt !== undefined ? { endedAt } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(childSession !== undefined ? { childSession } : {}),
      });
    };
    if (childSession === undefined) {
      finish();
      return;
    }
    void readContextTokens(childSession)
      .then((tokens) => {
        if (tokens !== undefined) updateRun(partId, { tokens });
      })
      .finally(finish);
  }

  /**
   * Write a live part fact into the registry.
   *
   * A first sighting registers the run (a pending part has not started, so
   * it registers nothing); every later sighting enriches it and, when the
   * part reached a terminal state, closes it.
   */
  function applyLive(partId: string, state: Record<string, unknown>): void {
    const existing = getRun(partId);
    if (existing !== undefined && TERMINAL_STATUSES.has(existing.status)) {
      // Terminal absorption: a late or duplicated event changes nothing.
      return;
    }
    if (existing === undefined && state.status === "pending") return;

    const input = state.input as Record<string, unknown> | undefined;
    const metadata = state.metadata as Record<string, unknown> | undefined;
    const title = titleFact(state, partId);
    const childSession = extractChildSession(metadata);
    const { startedAt, endedAt } = extractTimes(state);

    const patch: UpdateRunPatch = {};
    const model = extractModel(metadata);
    if (model !== undefined) patch.model = model;
    if (childSession !== undefined) patch.childSession = childSession;
    if (existing !== undefined) {
      // Monotone enrichment: only a strictly stronger title source may
      // replace the label; the host reveals title, description, prompt and
      // part id as the delegation progresses.
      const rank = labelRanks.get(partId);
      if (title.label !== "" && (rank === undefined || title.rank < rank)) {
        patch.label = title.label;
        labelRanks.set(partId, title.rank);
      }
    }

    if (existing === undefined) {
      startRun({
        id: partId,
        agent: extractAgent(input),
        parentSession: parentSessionId,
        label: title.label,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(childSession !== undefined ? { childSession } : {}),
      });
      labelRanks.set(partId, title.rank);
    }
    // Progress facts land the same way whether the run was just registered
    // or already known (a just-started run is still running).
    if (Object.keys(patch).length > 0) updateRun(partId, patch);

    const outcome = terminalOutcome(state);
    if (outcome === undefined) {
      if (childSession !== undefined) ensurePolling(partId, childSession);
      return;
    }

    finishWithFinalTokens(
      partId,
      childSession ?? existing?.childSession,
      outcome,
      endedAt,
      outcome === "error" ? String(state.error ?? "") : undefined,
    );
  }

  /**
   * Write a part fact recovered from the session history.
   *
   * A part no run covers is translated exactly like a live first sighting
   * (register, enrich, close when already terminal).  A run that already
   * exists is left alone when it finished, and otherwise only receives the
   * fields the live events have not reported — the scan reads a snapshot
   * that may predate them — plus the terminal transition when the scan sees
   * it.
   */
  function applyScanned(partId: string, state: Record<string, unknown>): void {
    const existing = getRun(partId);
    if (existing === undefined) {
      applyLive(partId, state);
      return;
    }
    if (TERMINAL_STATUSES.has(existing.status)) return;
    if (state.status === "pending") return;

    const metadata = state.metadata as Record<string, unknown> | undefined;
    const childSession = extractChildSession(metadata);
    const patch: UpdateRunPatch = {};
    if (existing.childSession === undefined && childSession !== undefined) {
      patch.childSession = childSession;
    }
    const model = extractModel(metadata);
    if (existing.model === undefined && model !== undefined) {
      patch.model = model;
    }
    // Label: fill an empty one, and let a stronger scanned source replace
    // a weaker live one (e.g. a host-written title revealed while the panel
    // was unmounted); a same-or-weaker source leaves the label alone.
    const title = titleFact(state, partId);
    const knownRank = labelRanks.get(partId);
    if (
      title.label !== "" &&
      (knownRank === undefined ? !existing.label : title.rank < knownRank)
    ) {
      patch.label = title.label;
      labelRanks.set(partId, title.rank);
    }
    if (Object.keys(patch).length > 0) updateRun(partId, patch);

    const outcome = terminalOutcome(state);
    if (outcome === undefined) {
      if (childSession !== undefined) ensurePolling(partId, childSession);
      return;
    }
    const { endedAt } = extractTimes(state);
    finishWithFinalTokens(
      partId,
      childSession ?? existing.childSession,
      outcome,
      endedAt,
      outcome === "error" ? String(state.error ?? "") : undefined,
    );
  }

  /**
   * Collect the task tool parts of a message history.
   *
   * Ownership of a task part does not depend on the message role, so only
   * the message envelope is checked (parts are looked at individually).
   */
  function taskPartsFrom(
    messages: unknown[],
  ): Array<{ partId: string; state: Record<string, unknown> }> {
    const found: Array<{
      partId: string;
      state: Record<string, unknown>;
    }> = [];
    for (const raw of messages) {
      if (raw === null || typeof raw !== "object") continue;
      const entry = raw as { info?: unknown; parts?: unknown };
      if (typeof entry.info !== "object" || entry.info === null) continue;
      if (!Array.isArray(entry.parts)) continue;
      for (const partRaw of entry.parts) {
        const part = partRaw as Record<string, unknown> | null;
        if (part?.type !== "tool" || part.tool !== "task") continue;
        const state = part.state as Record<string, unknown> | undefined;
        const partId = part.id as string | undefined;
        if (state === undefined) continue;
        if (partId === undefined || partId === "") continue;
        found.push({ partId, state });
      }
    }
    return found;
  }

  /**
   * Reconcile the registry against the panel session's history.
   *
   * The scan is the recovery path (panel remount, a delegation that finished
   * while the panel was unmounted) and the settlement path (the host tells
   * us a child session went idle or failed before it writes the part).
   * Repeating it is harmless: the registry absorbs every write it already
   * has.
   */
  async function reconcile(preFetched?: Promise<unknown[]>): Promise<void> {
    try {
      const history = await (preFetched ??
        deps.fetchSessionMessages(parentSessionId));
      // The panel may have been disposed while the history read was in
      // flight; its runs and timers must not appear after that.
      if (disposed) return;
      const messages = Array.isArray(history) ? history : [];
      for (const { partId, state } of taskPartsFrom(messages)) {
        applyScanned(partId, state);
      }
    } catch (err) {
      log.warn({
        hook: "opencode-subagent",
        event: "sub_reconcile_error",
        sessionId: parentSessionId,
        error: String(err),
      });
    }
  }

  /**
   * Handle a child session settling (idle or error).
   *
   * Neither event carries a terminal status — the host writes the part's
   * terminal state afterwards — so both only trigger a reconcile scan.
   */
  function onChildSessionSettled(event: {
    properties?: Record<string, unknown>;
  }): void {
    const sessionId = event?.properties?.sessionID;
    if (typeof sessionId !== "string" || sessionId === parentSessionId) return;
    void reconcile();
  }

  function onToolPartUpdated(event: {
    properties?: Record<string, unknown>;
  }): void {
    if (event?.properties?.sessionID !== parentSessionId) return;
    const part = event?.properties?.part as Record<string, unknown> | undefined;
    if (part?.type !== "tool" || part?.tool !== "task") return;
    const state = part.state as Record<string, unknown> | undefined;
    if (state === undefined) return;
    const partId = part.id as string | undefined;
    // A part without an id would collide with every other id-less run.
    if (partId === undefined || partId === "") return;
    applyLive(partId, state);
  }

  function dispose(): void {
    disposed = true;
    for (const timer of pollTimers.values()) clearInterval(timer);
    pollTimers.clear();
    pendingTokenFetches.clear();
    labelRanks.clear();
  }

  return {
    onToolPartUpdated,
    onSessionIdle: onChildSessionSettled,
    onSessionError: onChildSessionSettled,
    reconcile,
    dispose,
  };
}
