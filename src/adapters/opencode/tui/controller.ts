/**
 * Context data controller for the ZooKeeper TUI sidebar panel.
 *
 * Owns the shared session-message fetch, the full context recompute
 * (fetch → core state read → lens mapping → fold → metrics
 * computation → panel signal writes), and the 2-second debounced event
 * refresh.  Created once per plugin lifecycle via the
 * `createContextController` factory; all external dependencies (client
 * slice, state slice, signal setters) are injected through the options
 * object so the module stays free of host-plugin imports.
 *
 * Session state is read through the host-agnostic core's store
 * (`createStateStore().load`) — a read-only disk load that never
 * mutates or caches, matching the panel's display-only role; the
 * persisted blocks fold the transcript and the persisted effective
 * prune marks overlay the storage text, so the category breakdown
 * reflects the model-visible view.  The report and the sidebar
 * statistics all come from the core lens pipeline.
 *
 * @module
 */

import { formatPercent } from "../../../core/context/context-report.js";
import {
  computeContextReportLens,
  foldedLensTranscript,
} from "../../../core/context/context-report-lens.js";
import { fold } from "../../../core/context/fold.js";
import type { HostMessage } from "../../../core/context/lens.js";
import {
  computeCacheTrend,
  computeCumulativeCacheRate,
  computeTokenBreakdown,
  type TokenBreakdownResult,
} from "../../../core/context/lens-stats.js";
import { materializeEffectiveMarks } from "../../../core/context/release.js";
import { createStateStore } from "../../../core/context/store.js";
import { log } from "../../../utils/logger.js";
import { history } from "../history.js";
import type { ContextMessageEntry } from "../types.js";
import type { CategoryInfo } from "./subagent.js";

/** Dependencies injected by the panel — the controller's only external surface. */
export interface ContextControllerDeps {
  /** HTTP client slice — source for session message reads. */
  client: {
    session: {
      messages(options: {
        sessionID: string;
        limit?: number;
      }): Promise<unknown>;
    };
  };
  /** State slice — read for session token aggregates in the cumulative rate. */
  state: unknown;
  /** Cache hit-rate display string setter (tui() scope signal). */
  setCache: (v: string) => void;
  /** Category breakdown setter (tui() scope signal). */
  setCategories: (v: CategoryInfo | null) => void;
  /** Compute error flag setter (tui() scope signal). */
  setError: (v: boolean) => void;
  /** Trend label setter (tui() scope signal). */
  setTrendLabel: (v: string | null) => void;
  /** Trend delta setter (tui() scope signal). */
  setTrend: (v: number | null) => void;
  /** Cumulative cache hit-rate display string setter (tui() scope signal). */
  setCumulative: (v: string) => void;
  /** Token breakdown detail setter (tui() scope signal). */
  setDetail: (v: TokenBreakdownResult | null) => void;
  /** Data loaded flag setter (tui() scope signal). */
  setLoaded: (v: boolean) => void;
}

/** Interface consumed by the panel — shared fetch, compute, debounce, cleanup. */
export interface ContextController {
  /** Shared session-message fetch — one API call reused by compute + scan. */
  fetchSessionMessages: (sessionId: string) => Promise<unknown[]>;
  /** Full recompute — fetch, fold, and write all panel signals. */
  compute: (
    sessionId: string,
    preFetched?: Promise<unknown[]>,
  ) => Promise<void>;
  /** Debounced refresh (2 s — full fetch is heavier than the window). */
  scheduleRefresh: (sessionId: string) => void;
  /** Cancel any pending debounced refresh (panel cleanup). */
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the context data controller for the plugin lifecycle.
 *
 * Returns the shared fetch, the compute pipeline that writes the
 * panel signals, a debounced refresh wrapper for event-driven
 * recalculation, and a dispose hook that cancels pending refreshes.
 * The 2-second debounce timer and the stale-response sequence guard
 * live inside the returned closure.
 */
export function createContextController(
  deps: ContextControllerDeps,
): ContextController {
  const {
    client,
    state: stateSlice,
    setCache,
    setCategories,
    setError,
    setTrendLabel,
    setTrend,
    setCumulative,
    setDetail,
    setLoaded,
  } = deps;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  // Request sequence counter: prevents stale async responses from
  // overwriting newer data (issue #6 — compute race).
  let requestSeq = 0;

  // Read-only state store for display loads — never mutates and never
  // caches, so the panel always reflects the persisted state without
  // touching the shared in-memory manager.
  const store = createStateStore();

  // ── Shared fetch utility ────────────────────────────────────────
  /**
   * Fetch session messages via the client API and return the raw
   * message array.  Handles defensive unwrap ({error, data} wrapper)
   * and Array.isArray guard.  HTTP errors are thrown — callers handle
   * them individually.
   */
  async function fetchSessionMessages(sessionId: string): Promise<unknown[]> {
    const res = await client.session.messages({
      sessionID: sessionId,
    });
    // Defensive unwrap: SDK may return { error, data } without throwing.
    const resObj = res as { error?: { message?: string }; data?: unknown };
    if (resObj.error) {
      throw new Error(resObj.error.message ?? String(resObj.error));
    }
    // Some SDK versions wrap in { data: ... }
    const rawMessages = resObj.data ?? res;
    return Array.isArray(rawMessages) ? rawMessages : [];
  }

  // ── Core computation (async, full fetch via client API) ─────────
  async function compute(sessionId: string, preFetched?: Promise<unknown[]>) {
    const seq = ++requestSeq;
    try {
      const rawEntries = preFetched
        ? await preFetched
        : await fetchSessionMessages(sessionId);
      const entries: Array<unknown> = Array.isArray(rawEntries)
        ? rawEntries
        : [];
      const mapped: ContextMessageEntry[] = entries.filter(
        (m): m is ContextMessageEntry =>
          m != null &&
          typeof (m as Record<string, unknown>)?.info === "object" &&
          typeof (
            (m as Record<string, unknown>)?.info as Record<string, unknown>
          )?.role === "string",
      );
      const view = history(mapped);

      // Load the persisted session state and materialize the folded
      // (model-visible) lens transcript for the category breakdown.
      // Read-only disk load — the display never mutates or persists.
      // Defensive: a load failure falls back to the raw transcript.
      let reportMessages: HostMessage[] = view.messages;
      let folded: HostMessage[] | undefined;
      try {
        const persisted = store.load(sessionId);
        // Overlay the persisted effective prune marks first: storage
        // holds the pre-prune original text, so without this the tool
        // category would count full outputs for pruned calls.  Folding
        // still runs over the untouched view (span hashes validate the
        // stored content), and the folded transcript copies from the
        // overlaid messages so ordinals stay aligned.
        reportMessages = materializeEffectiveMarks(view.messages, persisted);
        // Apply compression-block folding so the category breakdown
        // shows the model-visible (folded) numbers.  Pure read-only —
        // fold never mutates the state or the transcript.
        const { items } = fold(view, persisted);
        folded = foldedLensTranscript(items, reportMessages, persisted);
      } catch {
        // Non-fatal: TUI must never crash from persistence I/O.
        folded = undefined;
      }

      const report = computeContextReportLens(folded ?? reportMessages);

      // ── Trend (last vs previous assistant) ──────────────────────
      const trendResult = computeCacheTrend(view.messages);

      // ── Cumulative (session aggregates preferred, fallback to
      // message-sum) ────────────────────────────────────────────
      let cumulativeRate: number | null = null;
      if (
        typeof (stateSlice as Record<string, unknown>)?.session === "object" &&
        typeof (
          (stateSlice as Record<string, unknown>).session as Record<
            string,
            unknown
          >
        )?.get === "function"
      ) {
        const fn = (stateSlice as Record<string, unknown>).session as {
          get: (id: string) =>
            | {
                tokens?: {
                  input?: number;
                  cache?: { read?: number; write?: number };
                };
              }
            | undefined;
        };
        const session = fn.get(sessionId);
        if (session?.tokens) {
          const read = session.tokens.cache?.read ?? 0;
          const write = session.tokens.cache?.write ?? 0;
          const input = session.tokens.input ?? 0;
          const denom = input + read + write;
          cumulativeRate = denom > 0 ? read / denom : null;
        } else {
          // Session exists but has no tokens — fall back to message-sum.
          cumulativeRate = computeCumulativeCacheRate(
            view.messages,
          ).cumulativeRate;
        }
      } else {
        cumulativeRate = computeCumulativeCacheRate(
          view.messages,
        ).cumulativeRate;
      }

      // ── Token breakdown (cache read / uncached input / output) ──
      const breakdown = computeTokenBreakdown(view.messages);

      // Only apply if this is still the latest request.
      if (seq !== requestSeq) return;
      setDetail(breakdown);
      setCache(
        report.cacheHitRate !== null ? formatPercent(report.cacheHitRate) : "—",
      );
      if (trendResult.hasTrendData) {
        setTrendLabel(trendResult.trendLabel);
        setTrend(trendResult.trend);
      } else {
        setTrendLabel(null);
        setTrend(null);
      }
      setCumulative(
        cumulativeRate !== null ? formatPercent(cumulativeRate) : "—",
      );
      setCategories({
        user: report.categories.user,
        assistant: report.categories.assistant,
        tool: report.categories.tool,
        system: report.categories.system,
        total: report.total,
      });
      setLoaded(true);
      setError(false);
    } catch (err) {
      // Silently degrade — plugin crash must never escape to
      // the host process.  Log for diagnosability.
      if (seq !== requestSeq) return;
      log("opencode-tui", "compute_error", sessionId, undefined, "error", {
        error: String(err),
      });
      setError(true);
    }
  }

  // ── Debounced refresh (2 s — full fetch is heavier than window) ─
  function scheduleRefresh(sessionId: string) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => compute(sessionId), 2000);
  }

  function dispose(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
  }

  return {
    fetchSessionMessages,
    compute,
    scheduleRefresh,
    dispose,
  };
}
