/**
 * Sub-agent real-time tracking for the ZooKeeper TUI sidebar panel.
 *
 * Owns the live task-tool event handlers, the 500ms context-token
 * polling loop, one-shot final token reads for terminated entries,
 * and the historical scan that recovers entries from earlier
 * messages.  Created per panel mount via the `createSubAgentTracker`
 * factory; all external dependencies are injected through the
 * options object so the module stays free of host-plugin imports.
 *
 * @module
 */

import type { ContextMessageEntry } from "../core/context/metrics.js";
import { log } from "../utils/logger.js";
import type { SubEntry } from "./subagent.js";
import {
  collectSubEntries,
  extractAgent,
  extractContextTokens,
  extractModel,
  extractTimes,
  extractTitle,
  mergeScannedEntries,
  subStatusFromState,
} from "./subagent.js";

/** Dependencies injected by the panel — the tracker's only external surface. */
export interface SubAgentTrackerDeps {
  /** HTTP client slice — source for session message reads. */
  client: {
    session: {
      messages(options: {
        sessionID: string;
        limit?: number;
      }): Promise<unknown>;
    };
  };
  /** State slice — read for child-session parent checks in polling. */
  state: unknown;
  /** Current panel session — owner of the sub-agents being tracked. */
  parentSessionId: string;
  /** Read the live sub-entries map (tui() scope signal). */
  getSubEntries: () => Map<string, SubEntry>;
  /** Update the live sub-entries map (tui() scope signal). */
  setSubEntries: (
    next:
      | Map<string, SubEntry>
      | ((prev: Map<string, SubEntry>) => Map<string, SubEntry>),
  ) => void;
  /** Shared session-message fetch — one API call reused by compute + scan. */
  fetchSessionMessages: (sessionId: string) => Promise<unknown[]>;
}

/** Interface consumed by the panel — event wiring, scan trigger, dispose. */
export interface SubAgentTracker {
  /** Live task-tool part handler — upserts entries, starts/stops polling. */
  onToolPartUpdated: (event: { properties?: Record<string, unknown> }) => void;
  /** Child-session idle handler — marks matching running entries done. */
  onSessionIdle: (event: { properties?: Record<string, unknown> }) => void;
  /** Child-session error handler — marks matching running entries error. */
  onSessionError: (event: { properties?: Record<string, unknown> }) => void;
  /** Historical scan on mount — merges scanned entries + resumes polling. */
  scanSubEntries: (
    sessionId: string,
    preFetched?: Promise<unknown[]>,
  ) => Promise<void>;
  /** Stop all polling timers (panel cleanup). */
  dispose: () => void;
}

/**
 * Create the sub-agent tracking subsystem for one panel mount.
 *
 * Returns handler methods to wire onto the host event bus, an
 * initial-scan trigger, and a dispose hook that stops all polling
 * timers.  The 500ms polling loop, the in-flight fetch guard, and
 * the token reads all live inside the returned closure.
 */
export function createSubAgentTracker(
  deps: SubAgentTrackerDeps,
): SubAgentTracker {
  const {
    client,
    state: stateSlice,
    parentSessionId,
    getSubEntries,
    setSubEntries,
    fetchSessionMessages,
  } = deps;

  // Poll timers keyed by part.id; cleared in dispose.
  const pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  // In-flight guard: prevents overlapping HTTP fetches for the same
  // partId in the polling loop (ensurePolling).
  const pendingTokenFetches = new Set<string>();

  /**
   * Read the current context size (tokens.input + tokens.cache.read)
   * of a child session from its last assistant message.
   *
   * We intentionally use the last assistant message here rather than
   * session-level aggregation (which sums all LLM calls including
   * cache re-reads).  The displayed value represents the sub-agent's
   * current context size, not cumulative consumption — a deliberate
   * semantic choice that differs from the cumulative cache rate formula.
   *
   * Uses the injected client's session.messages (HTTP interface) with
   * limit 20 because the state layer's session.messages(sid) only
   * syncs messages for sessions that have been opened in the TUI.
   * Sessions created by sub-agents (task tool calls) are never opened
   * in the TUI, so state.session.messages returns an empty array for
   * them.  The HTTP client interface works for any session.
   *
   * Returns undefined when the message list is unavailable or no
   * assistant message is found; the caller treats this as "no data
   * yet" and skips the round.  Silently returns undefined on any
   * error — no log output — because this sits on a 500ms polling
   * hot path and logging every failure would flood the log.
   */
  async function readContextTokens(
    sessionId: string,
  ): Promise<number | undefined> {
    try {
      const res = await client.session.messages({
        sessionID: sessionId,
        limit: 20,
      });
      // Defensive unwrap: SDK may return { error, data } without
      // throwing — same pattern as fetchSessionMessages.
      const resObj = res as {
        error?: { message?: string };
        data?: unknown;
      };
      if (resObj.error) return undefined;
      // Some SDK versions wrap in { data: ... }
      const rawMessages = (resObj.data ?? res) as Array<
        Record<string, unknown>
      >;
      if (!Array.isArray(rawMessages)) return undefined;
      // Delegate to the pure extractor — handles placeholder
      // assistant messages with zero-sum tokens.
      return extractContextTokens(rawMessages);
    } catch {
      return undefined;
    }
  }

  function ensurePolling(partId: string, sessionId: string) {
    if (pollTimers.has(partId)) return;
    const timer = setInterval(() => {
      // In-flight guard: skip if previous HTTP fetch for this
      // partId is still outstanding — prevents slow requests
      // from stacking (the 500ms interval could otherwise
      // overlap with a pending HTTP call).
      if (pendingTokenFetches.has(partId)) return;

      try {
        const stateApi = stateSlice as Record<string, unknown>;
        const sessionApi = stateApi.session as Record<string, unknown>;
        if (typeof sessionApi?.get !== "function") return;
        const getFn = sessionApi.get as (
          id: string,
        ) => Record<string, unknown> | undefined;
        const childSession = getFn(sessionId);
        if (!childSession) return; // skip round, don't delete entry
        if (childSession.parentID !== parentSessionId) {
          // Not a child of current session anymore — stop polling.
          stopPolling(partId);
          return;
        }

        // Fire-and-forget async token read.  readContextTokens uses
        // the injected client (HTTP) instead of the state layer —
        // the state layer does not sync messages for sessions that
        // were never opened in the TUI.
        pendingTokenFetches.add(partId);
        readContextTokens(sessionId)
          .then((tokens) => {
            if (tokens !== undefined) {
              setSubEntries((prev) => {
                const next = new Map(prev);
                const entry = next.get(partId);
                if (entry && entry.status === "running") {
                  next.set(partId, { ...entry, tokens });
                }
                return next;
              });
            }
          })
          .catch((err) => {
            // Silently degrade — never throw from a timer.
            // Log so persistent API failures stay diagnosable.
            log(
              "opencode-tui",
              "sub_poll_error",
              parentSessionId,
              undefined,
              "warn",
              { error: String(err) },
            );
          })
          .finally(() => {
            pendingTokenFetches.delete(partId);
          });
      } catch (err) {
        // Silently degrade — never throw from a timer.
        // Log so persistent API failures stay diagnosable.
        log(
          "opencode-tui",
          "sub_poll_error",
          parentSessionId,
          undefined,
          "warn",
          { error: String(err) },
        );
      }
    }, 500);
    pollTimers.set(partId, timer);
  }

  function stopPolling(partId: string) {
    const timer = pollTimers.get(partId);
    if (timer) {
      clearInterval(timer);
      pollTimers.delete(partId);
    }
  }

  /**
   * Fire-and-forget final token read for a terminated sub-agent
   * entry.  Reads context tokens via readContextTokens and updates
   * the entry's token value only if it still exists and its status
   * is "done" or "error".  Overwrite semantics — the final read is
   * authoritative and replaces any polling-residual value.
   */
  function finalizeTokens(partId: string, sessionId: string) {
    readContextTokens(sessionId)
      .then((tokens) => {
        if (tokens === undefined) return;
        setSubEntries((prev) => {
          const entry = prev.get(partId);
          if (!entry || (entry.status !== "done" && entry.status !== "error")) {
            return prev;
          }
          const next = new Map(prev);
          next.set(partId, { ...entry, tokens });
          return next;
        });
      })
      .catch(() => {
        // Silently degrade — never throw from fire-and-forget.
      });
  }

  // Detect task() tool calls from the current session.
  function onToolPartUpdated(event: { properties?: Record<string, unknown> }) {
    const eid = event?.properties?.sessionID as string | undefined;
    if (eid !== parentSessionId) return;

    const part = event?.properties?.part as Record<string, unknown> | undefined;
    if (part?.type !== "tool" || part?.tool !== "task") return;

    const state = part.state as Record<string, unknown> | undefined;
    if (!state) return;

    const partId = part.id as string | undefined;
    // Guard: a part without id would collide with other entries
    // in the Map under the "undefined" key.
    if (!partId) return;
    const stateStatus = state.status as string;
    const status = subStatusFromState(stateStatus);
    const input = state.input as Record<string, unknown> | undefined;
    const agent = extractAgent(input);
    const title = extractTitle(state, partId);
    const meta = state.metadata as Record<string, unknown> | undefined;
    const sessionId = String(meta?.session_id ?? meta?.sessionId ?? "");
    const model = extractModel(meta);
    const error = status === "error" ? String(state.error ?? "") : undefined;

    const { startedAt, endedAt } = extractTimes(state);

    setSubEntries((prev) => {
      const next = new Map(prev);
      const existing = next.get(partId);
      next.set(partId, {
        id: partId,
        title,
        agent,
        status,
        sessionId: sessionId || existing?.sessionId,
        model: model || existing?.model,
        tokens: existing?.tokens,
        error: error ?? existing?.error,
        // Prefer fresh extraction, fallback to existing on
        // partial updates (e.g. event fires with start only).
        startedAt: startedAt ?? existing?.startedAt,
        endedAt: endedAt ?? existing?.endedAt,
      });
      return next;
    });

    if (status === "running" && sessionId) {
      ensurePolling(partId, sessionId);
    } else if (status !== "running") {
      stopPolling(partId);
      if (sessionId) {
        finalizeTokens(partId, sessionId);
      }
    }
  }

  // Mark child sessions as done when they go idle.
  function onSessionIdle(event: { properties?: Record<string, unknown> }) {
    const sid = event?.properties?.sessionID as string | undefined;
    if (!sid || sid === parentSessionId) return;

    const toFinalize: string[] = [];

    setSubEntries((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [id, entry] of next) {
        if (entry.sessionId === sid && entry.status === "running") {
          next.set(id, {
            ...entry,
            status: "done",
            endedAt: entry.endedAt ?? Date.now(),
          });
          changed = true;
          stopPolling(id);
          toFinalize.push(id);
        }
      }
      return changed ? next : prev;
    });

    for (const id of toFinalize) {
      finalizeTokens(id, sid);
    }
  }

  // Mark child sessions as error when they error out.
  function onSessionError(event: { properties?: Record<string, unknown> }) {
    const sid = event?.properties?.sessionID as string | undefined;
    if (!sid || sid === parentSessionId) return;

    // Error payload may be a string or a structured object with
    // a message field — String(obj) would print "[object Object]".
    const rawErr = event?.properties?.error as
      | string
      | { message?: unknown }
      | undefined;
    const errMsg =
      typeof rawErr === "string"
        ? rawErr
        : typeof rawErr?.message === "string"
          ? rawErr.message
          : undefined;

    const toFinalize: string[] = [];

    setSubEntries((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [id, entry] of next) {
        if (entry.sessionId === sid && entry.status === "running") {
          next.set(id, {
            ...entry,
            status: "error",
            error: errMsg,
            endedAt: entry.endedAt ?? Date.now(),
          });
          changed = true;
          stopPolling(id);
          toFinalize.push(id);
        }
      }
      return changed ? next : prev;
    });

    for (const id of toFinalize) {
      finalizeTokens(id, sid);
    }
  }

  // ── Historical scan ───────────────────────────────────────
  // Scan existing messages on mount to recover sub-agent entries
  // from earlier in the session (e.g. reopening a running session).
  // Merges into the existing getSubEntries map, giving priority
  // to entries already placed by live events (they are fresher).

  async function scanSubEntries(
    sessionId: string,
    preFetched?: Promise<unknown[]>,
  ) {
    try {
      const rawEntries = preFetched
        ? await preFetched
        : await fetchSessionMessages(sessionId);
      const entries: Array<unknown> = Array.isArray(rawEntries)
        ? rawEntries
        : [];
      // Lenient filter: only checks info is object, not role.
      // Task tool part ownership does not depend on role.
      const mapped: ContextMessageEntry[] = entries.filter(
        (m): m is ContextMessageEntry =>
          m != null && typeof (m as Record<string, unknown>)?.info === "object",
      );
      const scanned = collectSubEntries(mapped);

      // Merge scanned entries into the live map using the pure
      // mergeScannedEntries function.  Capture the previous map
      // before the merge so we can detect running→terminal
      // transitions and stop their polling timers.
      const prevSubMap = getSubEntries();
      const merged = mergeScannedEntries(prevSubMap, scanned);
      setSubEntries(merged);

      // Stop polling for entries that transitioned from running
      // to a terminal state (done/error) during the merge.
      // This prevents phantom timers when the panel missed
      // live events due to unmount.
      for (const [id, entry] of merged) {
        const oldEntry = prevSubMap.get(id);
        if (oldEntry?.status === "running" && entry.status !== "running") {
          stopPolling(id);
        }
      }

      // Start polling for running entries; one-shot token read
      // for done/error entries.
      for (const entry of scanned) {
        if (!entry.sessionId) continue;

        if (entry.status === "running") {
          // Phantom timer guard: re-check status after async
          // fetch — a concurrent session.idle/error event may
          // have terminated this entry while we were scanning.
          if (getSubEntries().get(entry.id)?.status === "running") {
            ensurePolling(entry.id, entry.sessionId);
          }
        } else {
          // One-shot token read: context size from the last
          // assistant message (tokens.input + tokens.cache.read).
          // Matches the ensurePolling behaviour — current context
          // size, not cumulative consumption.
          const tokens = await readContextTokens(entry.sessionId);
          if (tokens !== undefined) {
            setSubEntries((prev) => {
              const existing = prev.get(entry.id);
              // Skip if entry no longer exists or tokens already
              // set by live event.
              if (!existing || existing.tokens !== undefined) {
                return prev;
              }
              const next = new Map(prev);
              next.set(entry.id, { ...existing, tokens });
              return next;
            });
          }
        }
      }
    } catch (err) {
      log("opencode-tui", "sub_scan_error", sessionId, undefined, "warn", {
        error: String(err),
      });
    }
  }

  function dispose(): void {
    for (const timer of pollTimers.values()) {
      clearInterval(timer);
    }
    pollTimers.clear();
  }

  return {
    onToolPartUpdated,
    onSessionIdle,
    onSessionError,
    scanSubEntries,
    dispose,
  };
}
