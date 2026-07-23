/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { type RGBA, TextAttributes } from "@opentui/core";
import { createSignal, onCleanup, onMount } from "solid-js";
import {
  formatPercent,
  formatTokens,
  progressBar,
} from "./core/context-report.js";
import type {
  ContextMessageEntry,
  TokenBreakdownResult,
} from "./core/metrics.js";
import {
  computeCacheTrend,
  computeContextReport,
  computeCumulativeCacheRate,
  computeTokenBreakdown,
} from "./core/metrics.js";
import { loadSessionState } from "./core/pruning/state.js";
import { log, setSessionId } from "./utils/logger.js";

/** Category values for sidebar breakdown display. */
interface CategoryInfo {
  user: number;
  assistant: number;
  tool: number;
  system: number;
  total: number;
}

// ── Sub-agent types ─────────────────────────────────────────

/** Status for a sub-agent entry tracked in the sidebar panel. */
export type SubStatus = "running" | "done" | "error";

/** A single sub-agent entry shown in the sub-agent section. */
export interface SubEntry {
  id: string;
  title: string;
  agent: string;
  status: SubStatus;
  sessionId?: string;
  tokens?: number;
  error?: string;
  model?: string;
  /** Epoch ms when the sub-agent started (from state.time.start). */
  startedAt?: number;
  /** Epoch ms when the sub-agent ended (from state.time.end). */
  endedAt?: number;
}

/**
 * Map a tool-part state status to the SubStatus enum.
 *
 * - "completed" → "done"
 * - "error" → "error"
 * - everything else (running, pending, unknown) → "running"
 */
export function subStatusFromState(stateStatus: string): SubStatus {
  if (stateStatus === "completed") return "done";
  if (stateStatus === "error") return "error";
  return "running";
}

/**
 * Extract the agent name from a task tool call state.
 *
 * Reads `state.input.subagent_type` and falls back to `"task"`.
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
 * Reads `metadata.model.modelID` and returns it as a string.
 * Returns `undefined` when the metadata is absent, the model field
 * is not an object, or the modelID is missing / not a string.
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
 * Extract timestamp fields from a task tool call state.
 *
 * Reads `state.time.start` and `state.time.end` (epoch ms).
 * Only finite numbers are accepted — all other values yield
 * undefined.  This mirrors the DB schema where running entries
 * have `start` but no `end`.
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
 * Extract the total context tokens (input + cache.read) from the last
 * valid assistant message in a message list.
 *
 * Messages are expected in the {info, parts}[] shape returned by
 * api.client.session.messages.  Traverses in reverse order and skips
 * placeholder assistant messages where the token sum is zero (created
 * at step start before actual tokens are recorded).
 *
 * Returns the token sum for the first valid assistant message found,
 * or undefined when no assistant message has non-zero tokens.
 *
 * @param messages - Array of {info, parts} message objects.
 * @returns Sum of input + cache.read tokens, or undefined.
 */
export function extractContextTokens(
  messages: Record<string, unknown>[],
): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const info = m?.info as Record<string, unknown> | undefined;
    if (info?.role !== "assistant") continue;
    const t = info.tokens as
      | { input?: unknown; cache?: { read?: unknown } }
      | undefined;
    // Skip messages with missing tokens field (no token data yet).
    if (!t) continue;
    // Defensive typeof checks (matches extractTimes): a non-numeric
    // value must not poison the sum (e.g. string concatenation).
    const input = typeof t.input === "number" ? t.input : 0;
    const cacheRead = typeof t.cache?.read === "number" ? t.cache.read : 0;
    const sum = input + cacheRead;
    // Skip zero-sum placeholder messages created at step start.
    if (sum === 0) continue;
    return sum;
  }
  return undefined;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * - < 60 s  →  "12s"
 * - ≥ 60 s  →  "2m05s" (seconds zero-padded)
 * - negative, NaN, Infinity  →  "—"
 */
export function formatDuration(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${String(sec).padStart(2, "0")}s`;
}

/**
 * Extract a human-readable title from a task tool call state.
 *
 * Priority: state.title → input.description → input.prompt (first 40 chars)
 * → partId slice (first 8 chars) → empty string.
 */
export function extractTitle(
  state: Record<string, unknown>,
  partId?: string,
): string {
  const st = state.title;
  if (typeof st === "string" && st.length > 0) return st;

  const input = state.input as Record<string, unknown> | undefined;

  const desc = input?.description;
  if (typeof desc === "string" && desc.length > 0) return desc;

  const prompt = input?.prompt;
  if (typeof prompt === "string" && prompt.length > 0) {
    return prompt.slice(0, 40);
  }

  if (partId) return partId.slice(0, 8);

  return "";
}

/**
 * Scan an array of message entries for completed/in-flight task tool
 * calls and return the corresponding sub-agent entries.
 *
 * Only parts where `type === "tool"` and `tool === "task"` are
 * considered.  Parts with `state.status === "pending"` are skipped
 * (not yet started).  Entries are built using the same helper
 * functions as the live event handler: `subStatusFromState`,
 * `extractAgent`, and `extractTitle`.
 */
export function collectSubEntries(messages: ContextMessageEntry[]): SubEntry[] {
  const entries: SubEntry[] = [];

  for (const msg of messages) {
    if (!msg.parts || !Array.isArray(msg.parts)) continue;

    for (const partRaw of msg.parts) {
      const part = partRaw as unknown as Record<string, unknown>;
      if (part.type !== "tool" || part.tool !== "task") continue;

      const state = part.state as Record<string, unknown> | undefined;
      if (!state) continue;

      const stateStatus = state.status as string;
      // pending → not yet started, skip like the magazine does.
      if (stateStatus === "pending") continue;

      const partId = part.id as string | undefined;
      if (!partId) continue;

      const status = subStatusFromState(stateStatus);
      const input = state.input as Record<string, unknown> | undefined;
      const agent = extractAgent(input);
      const title = extractTitle(state, partId);
      const meta = state.metadata as Record<string, unknown> | undefined;
      const sessionId = String(meta?.session_id ?? meta?.sessionId ?? "");
      const model = extractModel(meta);
      const error = status === "error" ? String(state.error ?? "") : undefined;
      const { startedAt, endedAt } = extractTimes(state);

      entries.push({
        id: partId,
        title,
        agent,
        status,
        sessionId: sessionId || undefined,
        model,
        tokens: undefined,
        error,
        startedAt,
        endedAt,
      });
    }
  }

  return entries;
}

// ── Scan-merge pure function ──────────────────────────────────

/**
 * Merge scanned sub-entries into the existing map.
 *
 * Rules (in priority order):
 * 1. New entries (not in prev) are inserted as-is.
 * 2. Existing entries in a terminal state (done/error) are never
 *    overwritten — terminal is irreversible from a real-time event.
 * 3. Existing "running" entries are overwritten when the scanned
 *    entry is in a terminal state (done/error).  This fixes the
 *    case where a sub-agent completed while the panel was unmounted
 *    and the live event was missed.
 * 4. In all other cases only the missing sessionId is patched;
 *    status / tokens / error from the existing entry are preserved
 *    (live events are fresher).
 * 5. Tokens from scanned entries are never applied — token values
 *    come from polling or one-shot reads, not from the scanned
 *    message state (which always has `tokens: undefined`).
 *
 * Pure function — no side effects (no timer management).
 */
export function mergeScannedEntries(
  prev: Map<string, SubEntry>,
  scanned: SubEntry[],
): Map<string, SubEntry> {
  const next = new Map(prev);

  for (const entry of scanned) {
    const existing = next.get(entry.id);

    if (!existing) {
      // Rule 1: brand new entry → insert as-is.
      next.set(entry.id, entry);
      continue;
    }

    // Rule 2: existing terminal entry → never overwrite.
    if (existing.status === "done" || existing.status === "error") {
      // Still patch missing sessionId / model / startedAt / endedAt.
      if (
        (!existing.sessionId && entry.sessionId) ||
        (!existing.model && entry.model) ||
        (!existing.startedAt && entry.startedAt) ||
        (!existing.endedAt && entry.endedAt)
      ) {
        next.set(entry.id, {
          ...existing,
          sessionId: entry.sessionId || existing.sessionId,
          model: entry.model || existing.model,
          startedAt: entry.startedAt ?? existing.startedAt,
          endedAt: entry.endedAt ?? existing.endedAt,
        });
      }
      continue;
    }

    // Rule 3: existing running + scanned terminal → overwrite status.
    if (
      existing.status === "running" &&
      (entry.status === "done" || entry.status === "error")
    ) {
      next.set(entry.id, {
        ...existing,
        status: entry.status,
        // Preserve existing tokens (they come from polling, not scan).
        error: entry.status === "error" ? entry.error : existing.error,
        // Patch model from scanned if existing doesn't have one yet.
        model: existing.model || entry.model,
        // Use scanned times — DB has authoritative start/end for
        // terminal states (fixes missing endedAt from live events).
        startedAt: entry.startedAt ?? existing.startedAt,
        endedAt: entry.endedAt ?? existing.endedAt,
      });
      continue;
    }

    // Rule 4: fallback — only patch missing sessionId / model /
    // startedAt / endedAt; never overwrite status / tokens / error.
    if (
      (!existing.sessionId && entry.sessionId) ||
      (!existing.model && entry.model) ||
      (!existing.startedAt && entry.startedAt) ||
      (!existing.endedAt && entry.endedAt)
    ) {
      next.set(entry.id, {
        ...existing,
        sessionId: entry.sessionId || existing.sessionId,
        model: entry.model || existing.model,
        startedAt: entry.startedAt ?? existing.startedAt,
        endedAt: entry.endedAt ?? existing.endedAt,
      });
    }
  }

  return next;
}

/**
 * ZooKeeper TUI — sidebar_content live data panel.
 *
 * Displays the current session's context token usage, cache hit rate,
 * and category breakdown (user/asst/tool/sys).  The panel is
 * collapsible — click the "ZooKeeper" title to toggle — and collapsed
 * state is persisted via `api.kv`.
 *
 * Data flow:
 * 1. `onMount` — shared fetch via
 *    `fetchSessionMessages()` (no limit, one API call),
 *    compute report, subscribe to three events with a
 *    2-second debounce.
 * 2. Each event triggers a debounced recalculation.
 *
 * @module
 */

const plugin: TuiPluginModule = {
  id: "zookeeper-tui",
  tui: async (api) => {
    // ── Shared panel signals (tui() scope) ──────────────────────────
    const [getCache, setCache] = createSignal<string>("—");
    const [getLoaded, setLoaded] = createSignal(false);
    const [getCategories, setCategories] = createSignal<CategoryInfo | null>(
      null,
    );
    const [getCollapsed, setCollapsed] = createSignal(false);
    const [getError, setError] = createSignal(false);
    const [getTrendLabel, setTrendLabel] = createSignal<string | null>(null);
    const [getTrend, setTrend] = createSignal<number | null>(null);
    const [getCumulative, setCumulative] = createSignal<string>("—");
    const [getSubEntries, setSubEntries] = createSignal<Map<string, SubEntry>>(
      new Map(),
    );
    const [getExpandedSubIds, setExpandedSubIds] = createSignal<Set<string>>(
      new Set(),
    );
    const [getSubCollapsed, setSubCollapsed] = createSignal(false);
    const [getCacheCollapsed, setCacheCollapsed] = createSignal(false);
    const [getDistCollapsed, setDistCollapsed] = createSignal(false);
    const [getDetailCollapsed, setDetailCollapsed] = createSignal(false);
    const [getDetail, setDetail] = createSignal<TokenBreakdownResult | null>(
      null,
    );

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    // Request sequence counter: prevents stale async responses from
    // overwriting newer data (issue #6 — compute race).
    let requestSeq = 0;

    // ── Shared fetch utility ────────────────────────────────────────
    /**
     * Fetch session messages via the client API and return the raw
     * message array.  Handles defensive unwrap ({error, data} wrapper)
     * and Array.isArray guard.  HTTP errors are thrown — callers handle
     * them individually.
     */
    async function fetchSessionMessages(sessionId: string): Promise<unknown[]> {
      const res = await api.client.session.messages({
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

        // Load pruned callIDs for DCP visibility in category breakdown.
        // Defensive: load failure results in empty set (tools fully counted).
        let prunedCallIDs: Set<string> | undefined;
        try {
          const persisted = loadSessionState(sessionId);
          if (persisted) {
            prunedCallIDs = new Set(persisted.prune.tools.keys());
          }
        } catch {
          // Non-fatal: TUI must never crash from persistence I/O.
          prunedCallIDs = undefined;
        }

        const report = computeContextReport(mapped, prunedCallIDs);

        // ── Trend (last vs previous assistant) ──────────────────────
        const trendResult = computeCacheTrend(mapped);

        // ── Cumulative (session aggregates preferred, fallback to
        // message-sum) ────────────────────────────────────────────
        let cumulativeRate: number | null = null;
        if (
          typeof (api.state as Record<string, unknown>)?.session === "object" &&
          typeof (
            (api.state as Record<string, unknown>).session as Record<
              string,
              unknown
            >
          )?.get === "function"
        ) {
          const fn = (api.state as Record<string, unknown>).session as {
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
            cumulativeRate = computeCumulativeCacheRate(mapped).cumulativeRate;
          }
        } else {
          cumulativeRate = computeCumulativeCacheRate(mapped).cumulativeRate;
        }

        // ── Token breakdown (cache read / uncached input / output) ──
        const breakdown = computeTokenBreakdown(mapped);

        // Only apply if this is still the latest request.
        if (seq !== requestSeq) return;
        setDetail(breakdown);
        setCache(
          report.cacheHitRate !== null
            ? formatPercent(report.cacheHitRate)
            : "—",
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

    // ── Collapse toggles with KV persistence ─────────────────────
    const KV_PANEL = "zookeeper.context_panel.collapsed";
    const KV_SUB = "zookeeper.subagent_panel.collapsed";
    const KV_CACHE = "zookeeper.cache_section.collapsed";
    const KV_DETAIL = "zookeeper.detail_section.collapsed";
    const KV_DIST = "zookeeper.distribution_section.collapsed";

    // Returns a toggle function that flips the given signal and
    // persists the new state under the given KV key.  KV write
    // failures are silently ignored (must never crash the host).
    function makeCollapseToggle(
      get: () => boolean,
      set: (v: boolean) => void,
      kvKey: string,
    ): () => void {
      return () => {
        const next = !get();
        set(next);
        try {
          if (api.kv.ready) {
            api.kv.set(kvKey, next);
          }
        } catch (err) {
          log("opencode-tui", "kv_write_failed", "", undefined, "debug", {
            error: String(err),
          });
        }
      };
    }

    const toggleCollapsed = makeCollapseToggle(
      getCollapsed,
      setCollapsed,
      KV_PANEL,
    );
    const toggleSubCollapsed = makeCollapseToggle(
      getSubCollapsed,
      setSubCollapsed,
      KV_SUB,
    );
    const toggleCacheCollapsed = makeCollapseToggle(
      getCacheCollapsed,
      setCacheCollapsed,
      KV_CACHE,
    );
    const toggleDetailCollapsed = makeCollapseToggle(
      getDetailCollapsed,
      setDetailCollapsed,
      KV_DETAIL,
    );
    const toggleDistCollapsed = makeCollapseToggle(
      getDistCollapsed,
      setDistCollapsed,
      KV_DIST,
    );

    // ── ZookeeperPanel component ───────────────────────────────────
    function ZookeeperPanel(props: {
      sessionId: string;
      // Theme colours forwarded from the slot context.
      theme: {
        primary: RGBA;
        text: RGBA;
        textMuted: RGBA;
        backgroundElement: RGBA;
        borderSubtle: RGBA;
        success: RGBA;
        warning: RGBA;
        error: RGBA;
      };
    }) {
      // ── Real-time clock for running sub-agent durations ─────────
      // A 1 s interval tick used to compute live "time elapsed" for
      // running entries in renderSubEntry.  Kept always-active for
      // simplicity — the overhead is negligible (< 1 μs per tick)
      // and avoids the complexity of observing whether any running
      // entry exists.
      const [getNowTick, setNowTick] = createSignal(Date.now());
      // Hover state for the "enter session" button in expanded entries.
      const [getHoveredOpenId, setHoveredOpenId] = createSignal<
        string | undefined
      >(undefined);
      // Panel content width in terminal cells, tracked via the root
      // box's onSizeChange.  Used to right-align header stats and to
      // size separator lines.
      const [getPanelWidth, setPanelWidth] = createSignal(28);
      // opentui box element ref — untyped, matches magazine pattern.
      let boxEl: any;
      let clockTimer: ReturnType<typeof setInterval> | undefined;

      // ── Lifecycle ──────────────────────────────────────────────
      onMount(() => {
        // Start the 1 s real-time clock.
        clockTimer = setInterval(() => setNowTick(Date.now()), 1000);

        // Reset sub-agent map and expand state on every mount.  The
        // signal lives in the plugin scope (tui()) and would otherwise
        // carry stale entries across panel remounts (e.g. session
        // switches or mount/unmount cycles).  Clearing here provides
        // per-session isolation and eliminates residual "running"
        // entries left from a previous lifecycle.  Live events and the
        // historical scan (scanSubEntries) re-populate the map.
        setSubEntries(new Map());
        setExpandedSubIds(new Set<string>());

        // Ensure TUI-process logs are flushed to disk (logger requires
        // _sessionId to be set; issue #1).
        setSessionId(props.sessionId);

        // Restore collapsed state from persisted KV storage.
        try {
          if (api.kv.ready) {
            const restore = (kvKey: string, set: (v: boolean) => void) => {
              const saved = api.kv.get<boolean>(kvKey);
              if (saved !== undefined) set(saved);
            };
            restore(KV_PANEL, setCollapsed);
            restore(KV_SUB, setSubCollapsed);
            restore(KV_CACHE, setCacheCollapsed);
            restore(KV_DIST, setDistCollapsed);
            restore(KV_DETAIL, setDetailCollapsed);
          }
        } catch (err) {
          // Silently ignore — default to expanded.
          log(
            "opencode-tui",
            "kv_read_failed",
            props.sessionId,
            undefined,
            "debug",
            {
              error: String(err),
            },
          );
        }

        // Shared fetch: one API call shared between compute and scan.
        const messagesPromise = fetchSessionMessages(props.sessionId);
        compute(props.sessionId, messagesPromise);

        // Helper: only refresh when the event belongs to the current
        // session, so child-subagent events don't trigger spurious
        // refetches (issue #4).
        function onOwnEvent(event: { properties?: Record<string, unknown> }) {
          const eid: unknown =
            event?.properties?.sessionID ??
            (event?.properties?.info as Record<string, unknown> | undefined)
              ?.sessionID ??
            (event?.properties?.info as Record<string, unknown> | undefined)
              ?.id;
          if (eid === undefined || String(eid) === props.sessionId) {
            scheduleRefresh(props.sessionId);
          }
        }

        const unsub1 = api.event.on("message.updated", onOwnEvent);
        const unsub2 = api.event.on("message.part.updated", onOwnEvent);
        const unsub3 = api.event.on("session.updated", onOwnEvent);

        // ── Sub-agent tracking ────────────────────────────────────
        // Poll timers keyed by part.id; cleared in onCleanup.
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
         * Uses api.client.session.messages (HTTP interface) with limit 20
         * because the state-layer api.state.session.messages(sid) only
         * syncs messages for sessions that have been opened in the TUI.
         * Sessions created by sub-agents (task tool calls) are never
         * opened in the TUI, so state.session.messages returns an empty
         * array for them.  The HTTP client API works for any session.
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
            const res = await api.client.session.messages({
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
              const stateApi = api.state as Record<string, unknown>;
              const sessionApi = stateApi.session as Record<string, unknown>;
              if (typeof sessionApi?.get !== "function") return;
              const getFn = sessionApi.get as (
                id: string,
              ) => Record<string, unknown> | undefined;
              const childSession = getFn(sessionId);
              if (!childSession) return; // skip round, don't delete entry
              if (childSession.parentID !== props.sessionId) {
                // Not a child of current session anymore — stop polling.
                stopPolling(partId);
                return;
              }

              // Fire-and-forget async token read.  readContextTokens
              // now uses api.client.session.messages (HTTP) instead of
              // the state layer — the state layer does not sync messages
              // for sessions that were never opened in the TUI.
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
                    props.sessionId,
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
                props.sessionId,
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
                if (
                  !entry ||
                  (entry.status !== "done" && entry.status !== "error")
                ) {
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
        function onToolPartUpdated(event: {
          properties?: Record<string, unknown>;
        }) {
          const eid = event?.properties?.sessionID as string | undefined;
          if (eid !== props.sessionId) return;

          const part = event?.properties?.part as
            | Record<string, unknown>
            | undefined;
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
          const error =
            status === "error" ? String(state.error ?? "") : undefined;

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
        function onSessionIdle(event: {
          properties?: Record<string, unknown>;
        }) {
          const sid = event?.properties?.sessionID as string | undefined;
          if (!sid || sid === props.sessionId) return;

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
        function onSessionError(event: {
          properties?: Record<string, unknown>;
        }) {
          const sid = event?.properties?.sessionID as string | undefined;
          if (!sid || sid === props.sessionId) return;

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

        const unsub4 = api.event.on("message.part.updated", onToolPartUpdated);
        const unsub5 = api.event.on("session.idle", onSessionIdle);
        const unsub6 = api.event.on("session.error", onSessionError);

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
                m != null &&
                typeof (m as Record<string, unknown>)?.info === "object",
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
              if (
                oldEntry?.status === "running" &&
                entry.status !== "running"
              ) {
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
            log(
              "opencode-tui",
              "sub_scan_error",
              sessionId,
              undefined,
              "warn",
              {
                error: String(err),
              },
            );
          }
        }

        scanSubEntries(props.sessionId, messagesPromise).catch(() => {});

        onCleanup(() => {
          unsub1();
          unsub2();
          unsub3();
          unsub4();
          unsub5();
          unsub6();
          if (debounceTimer) clearTimeout(debounceTimer);
          if (clockTimer) clearInterval(clockTimer);
          for (const timer of pollTimers.values()) {
            clearInterval(timer);
          }
          pollTimers.clear();
        });
      });

      // ── Expand / collapse toggle ──────────────────────────────
      function toggleExpand(id: string) {
        setExpandedSubIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }

      // ── Render helpers ─────────────────────────────────────────
      function renderCategoryRow(label: string, value: number, total: number) {
        const ratio = total > 0 ? value / total : 0;
        const bar = progressBar(ratio, 10);
        // Two-child space-between (the only layout proven reliable in
        // this opentui version — a three-child row glues the middle
        // child to its neighbours).  The bar is merged into the right
        // element ahead of the numbers; bar width is constant, so
        // bars stay aligned across rows.  Token and percent columns
        // use fixed-width padding for cross-row alignment.
        const tokenStr = formatTokens(value).padStart(6);
        const pctStr = formatPercent(ratio).padStart(5);
        return (
          <box flexDirection="row" justifyContent="space-between">
            <text fg={props.theme.textMuted}>{label}</text>
            <text>
              <span style={{ fg: props.theme.text }}>{bar}</span>
              <span style={{ fg: props.theme.textMuted }}>
                {` ${tokenStr} ${pctStr}`}
              </span>
            </text>
          </box>
        );
      }

      // Render a plain breakdown row (no bar) for the 明细 sub-section:
      // muted label on the left, muted token + percent on the right.
      function renderDetailRow(label: string, value: number, total: number) {
        const ratio = total > 0 ? value / total : 0;
        const tokenStr = formatTokens(value).padStart(6);
        const pctStr = formatPercent(ratio).padStart(5);
        return (
          <box flexDirection="row" justifyContent="space-between">
            <text fg={props.theme.textMuted}>{label}</text>
            <text fg={props.theme.textMuted}>{`${tokenStr} ${pctStr}`}</text>
          </box>
        );
      }

      // Compute terminal-cell width.  Wide characters (Hangul jamo,
      // CJK, full-width forms) occupy 2 cells; everything else —
      // including box-drawing chars like ─ and chevrons ▾/▸ — is 1.
      function cellWidth(s: string): number {
        let cells = 0;
        for (const ch of s) {
          const cp = ch.codePointAt(0) ?? 0;
          const wide =
            (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
            cp >= 0x2e80; // CJK radicals .. full-width forms
          cells += wide ? 2 : 1;
        }
        return cells;
      }

      // Pad a detail label to a fixed terminal-cell width so values align.
      function padLabel(label: string, width: number): string {
        return label + " ".repeat(Math.max(0, width - cellWidth(label)));
      }

      function renderSubEntry(entry: SubEntry) {
        const expanded = getExpandedSubIds().has(entry.id);
        const chevron = expanded ? "▾" : "▸";
        // Status is conveyed by the dot colour alone (running=warning,
        // done=success, error=error) — no redundant status text.
        const dotColor =
          entry.status === "running"
            ? props.theme.warning
            : entry.status === "done"
              ? props.theme.success
              : props.theme.error;
        // Running entries blink: alternate ● / ○ on the 1 s clock tick.
        const dotChar =
          entry.status === "running" &&
          Math.floor(getNowTick() / 1000) % 2 === 1
            ? "○"
            : "●";
        const tokenStr =
          entry.tokens !== undefined ? formatTokens(entry.tokens) : "";

        // Compute duration string:
        // - Running with startedAt → real-time elapsed (now - startedAt).
        // - Terminal with both times → total duration (endedAt - startedAt).
        // - Missing startedAt → "—".
        let durationStr: string;
        if (entry.startedAt === undefined) {
          durationStr = "—";
        } else if (entry.status === "running") {
          durationStr = formatDuration(getNowTick() - entry.startedAt);
        } else if (entry.endedAt !== undefined) {
          durationStr = formatDuration(entry.endedAt - entry.startedAt);
        } else {
          durationStr = "—";
        }

        return (
          <box flexDirection="column">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: clickable sub-agent entry row */}
            <text onMouseUp={() => toggleExpand(entry.id)}>
              <span style={{ fg: props.theme.textMuted }}>{`${chevron} `}</span>
              <span style={{ fg: dotColor }}>{`${dotChar} `}</span>
              <span style={{ fg: props.theme.text }}>{entry.title}</span>
            </text>
            {expanded ? (
              <box paddingLeft={2} flexDirection="column">
                <text fg={props.theme.textMuted}>
                  {`${padLabel("agent:", 8)}${entry.agent}`}
                </text>
                <text fg={props.theme.textMuted}>
                  {`${padLabel("模型:", 8)}${entry.model ?? "—"}`}
                </text>
                <text fg={props.theme.textMuted}>
                  {`${padLabel("上下文:", 8)}${tokenStr || "—"}`}
                </text>
                <text fg={props.theme.textMuted}>
                  {`${padLabel("耗时:", 8)}${durationStr}`}
                </text>
                {entry.status === "error" ? (
                  <text fg={props.theme.textMuted}>
                    {`${padLabel("错误:", 8)}${entry.error ?? "—"}`}
                  </text>
                ) : null}
                {/* Jump into the child session — same pattern as the
                    subagent-magazine plugin: route.navigate("session"). */}
                {entry.sessionId ? (
                  // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithMouseEvents: clickable enter-session link (TUI has no keyboard focus for this element)
                  <text
                    onMouseOver={() => setHoveredOpenId(entry.id)}
                    onMouseOut={() => setHoveredOpenId(undefined)}
                    onMouseUp={() => {
                      if (entry.sessionId) {
                        api.route.navigate("session", {
                          sessionID: entry.sessionId,
                        });
                      }
                    }}
                  >
                    <span
                      style={{
                        fg:
                          getHoveredOpenId() === entry.id
                            ? props.theme.primary
                            : props.theme.textMuted,
                      }}
                    >
                      {"→ 进入会话"}
                    </span>
                  </text>
                ) : null}
              </box>
            ) : null}
          </box>
        );
      }

      // ── Render ─────────────────────────────────────────────────
      return (
        <box flexDirection="column" paddingRight={1} gap={1}>
          <box
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={props.theme.backgroundElement}
            border={["left"]}
            borderColor={props.theme.primary}
            // The opentui universal renderer calls props.ref(node) as
            // a function — ref must be a callback, a plain variable
            // binding would be evaluated as undefined at JSX creation.
            ref={(el: any) => {
              boxEl = el;
            }}
            onSizeChange={() => {
              const raw = boxEl?.width as number | undefined;
              // Guard against NaN/non-finite widths from the ref.
              const w =
                typeof raw === "number" && Number.isFinite(raw)
                  ? Math.max(20, raw)
                  : 28;
              setPanelWidth((prev) => (prev === w ? prev : w));
            }}
          >
            {/* biome-ignore lint/a11y/noStaticElementInteractions: clickable title for collapsible panel */}
            <text
              fg={props.theme.primary}
              attributes={TextAttributes.BOLD}
              onMouseUp={toggleCollapsed}
            >
              {getCollapsed() ? "▸" : "▾"} ZooKeeper
            </text>
            {getCollapsed() ? null : getError() ? (
              <text fg={props.theme.textMuted}>数据异常</text>
            ) : getLoaded() ? (
              <>
                {/* Cache statistics section — header is clickable and
                    collapses the whole section; the collapsed state is
                    persisted via api.kv (same pattern as the sub-agent
                    section).  Wrapped in a concrete <box> (not a
                    fragment) so Yoga measures its height correctly and
                    mouse hit-test coordinates stay accurate. */}
                <box
                  flexDirection="column"
                  border={["top", "bottom", "right"]}
                  borderColor={props.theme.borderSubtle}
                >
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: clickable section header */}
                  <text onMouseUp={() => toggleCacheCollapsed()}>
                    <span style={{ fg: props.theme.text }}>
                      {`${getCacheCollapsed() ? "▸" : "▾"} 缓存统计`}
                    </span>
                  </text>
                  {getCacheCollapsed() ? null : (
                    <>
                      {/* Separator under the section header.  Width
                          subtracts the outer panel's border + padding
                          (3) and this section's right border (1). */}
                      <text fg={props.theme.textMuted}>
                        {"─".repeat(Math.max(1, getPanelWidth() - 4))}
                      </text>
                      {/* Cache hit rate + trend arrow (right-aligned) */}
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={props.theme.text}>{"命中率"}</text>
                        <text>
                          <span style={{ fg: props.theme.text }}>
                            {getCache()}
                          </span>
                          {(() => {
                            const label = getTrendLabel();
                            if (!label) return null;
                            const trend = getTrend();
                            let color: RGBA;
                            if (trend !== null && trend > 0) {
                              color = props.theme.success;
                            } else if (trend !== null && trend < 0) {
                              color = props.theme.error;
                            } else {
                              color = props.theme.textMuted;
                            }
                            return (
                              <span style={{ fg: color }}>{` ${label}`}</span>
                            );
                          })()}
                        </text>
                      </box>
                      {/* Cumulative cache hit rate (right-aligned) */}
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={props.theme.textMuted}>{"总命中"}</text>
                        <text fg={props.theme.textMuted}>
                          {getCumulative()}
                        </text>
                      </box>
                      {/* Detail sub-section — clickable header with an
                          inline separator fill on the same row; collapsed
                          state persisted via api.kv.  Concrete <box>
                          wrapper for correct Yoga height measurement
                          (same reason as the distribution section). */}
                      <box flexDirection="column">
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: clickable section header */}
                        <text onMouseUp={() => toggleDetailCollapsed()}>
                          <span style={{ fg: props.theme.text }}>
                            {`${getDetailCollapsed() ? "▸" : "▾"} 明细 `}
                          </span>
                          <span style={{ fg: props.theme.textMuted }}>
                            {"─".repeat(
                              Math.max(
                                1,
                                getPanelWidth() -
                                  4 -
                                  cellWidth(
                                    `${getDetailCollapsed() ? "▸" : "▾"} 明细 `,
                                  ),
                              ),
                            )}
                          </span>
                        </text>
                        {getDetailCollapsed()
                          ? null
                          : (() => {
                              const detail = getDetail();
                              if (!detail || detail.total === 0) return null;
                              return (
                                <>
                                  {renderDetailRow(
                                    "缓存读",
                                    detail.cacheRead,
                                    detail.total,
                                  )}
                                  {renderDetailRow(
                                    "未命中",
                                    detail.input,
                                    detail.total,
                                  )}
                                  {renderDetailRow(
                                    "输出",
                                    detail.output,
                                    detail.total,
                                  )}
                                </>
                              );
                            })()}
                      </box>
                      {/* Context distribution sub-section — clickable
                          header with an inline separator fill on the
                          same row; collapsed state persisted via api.kv.
                          Concrete <box> wrapper for correct Yoga height
                          measurement (same reason as the sub-agent
                          section). */}
                      <box flexDirection="column">
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: clickable section header */}
                        <text onMouseUp={() => toggleDistCollapsed()}>
                          <span style={{ fg: props.theme.text }}>
                            {`${getDistCollapsed() ? "▸" : "▾"} 上下文分布 `}
                          </span>
                          <span style={{ fg: props.theme.textMuted }}>
                            {"─".repeat(
                              Math.max(
                                1,
                                getPanelWidth() -
                                  4 -
                                  cellWidth(
                                    `${getDistCollapsed() ? "▸" : "▾"} 上下文分布 `,
                                  ),
                              ),
                            )}
                          </span>
                        </text>
                        {getDistCollapsed()
                          ? null
                          : (() => {
                              const cats = getCategories();
                              if (!cats) return null;
                              return (
                                <>
                                  {renderCategoryRow(
                                    "用户",
                                    cats.user,
                                    cats.total,
                                  )}
                                  {renderCategoryRow(
                                    "agent",
                                    cats.assistant,
                                    cats.total,
                                  )}
                                  {renderCategoryRow(
                                    "工具",
                                    cats.tool,
                                    cats.total,
                                  )}
                                  {renderCategoryRow(
                                    "系统",
                                    cats.system,
                                    cats.total,
                                  )}
                                </>
                              );
                            })()}
                      </box>
                    </>
                  )}
                </box>
                {/* Sub-agent status section.  The Map is replaced on
                    every update, so all rows re-render on any token
                    change — acceptable for small entry counts (<10).
                    The section header (chevron + name + status counts +
                    total context) is clickable and collapses the whole
                    section; the collapsed state is persisted via api.kv.
                    A concrete <box> container (not a fragment) wraps the
                    section so Yoga measures its height correctly — a
                    fragment wrapper caused hit-test coordinates to drift
                    several rows above the visual position. */}
                {(() => {
                  const entries = getSubEntries();
                  if (entries.size === 0) return null;
                  const subCollapsed = getSubCollapsed();
                  let done = 0;
                  let running = 0;
                  let errored = 0;
                  let totalTokens = 0;
                  for (const entry of entries.values()) {
                    if (entry.status === "done") done++;
                    else if (entry.status === "running") running++;
                    else errored++;
                    totalTokens += entry.tokens ?? 0;
                  }
                  const tokenStr =
                    totalTokens > 0 ? formatTokens(totalTokens) : "—";
                  const segLabel = `${subCollapsed ? "▸" : "▾"} 子代理`;
                  const segDone = `● ${done} `;
                  const segRunning = `● ${running} `;
                  const segError = `● ${errored} `;
                  return (
                    <box
                      flexDirection="column"
                      border={["top", "bottom", "right"]}
                      borderColor={props.theme.borderSubtle}
                    >
                      {/* Header row: label on the left, status counts
                          and token total right-aligned via flexbox
                          space-between (no manual spacer math). */}
                      <box flexDirection="row" justifyContent="space-between">
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: clickable section header */}
                        <text onMouseUp={() => toggleSubCollapsed()}>
                          <span style={{ fg: props.theme.text }}>
                            {segLabel}
                          </span>
                        </text>
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: clickable section header */}
                        <text onMouseUp={() => toggleSubCollapsed()}>
                          <span style={{ fg: props.theme.success }}>
                            {segDone}
                          </span>
                          <span style={{ fg: props.theme.warning }}>
                            {segRunning}
                          </span>
                          <span style={{ fg: props.theme.error }}>
                            {segError}
                          </span>
                          <span style={{ fg: props.theme.text }}>
                            {tokenStr}
                          </span>
                        </text>
                      </box>
                      {subCollapsed ? null : (
                        <>
                          <text fg={props.theme.textMuted}>
                            {"─".repeat(Math.max(1, getPanelWidth() - 4))}
                          </text>
                          {/* Running entries first (newest started
                              first); terminal entries keep insertion
                              order (sort is stable). */}
                          {[...entries.values()]
                            .sort((a, b) => {
                              const aRun = a.status === "running" ? 0 : 1;
                              const bRun = b.status === "running" ? 0 : 1;
                              if (aRun !== bRun) return aRun - bRun;
                              if (aRun === 0) {
                                return (b.startedAt ?? 0) - (a.startedAt ?? 0);
                              }
                              return 0;
                            })
                            .map((entry) => renderSubEntry(entry))}
                        </>
                      )}
                    </box>
                  );
                })()}
              </>
            ) : (
              <text fg={props.theme.textMuted}>加载中…</text>
            )}
          </box>
        </box>
      );
    }

    // ── Register slot ──────────────────────────────────────────────
    api.slots.register({
      order: 55,
      slots: {
        sidebar_content(ctx, input) {
          return (
            <ZookeeperPanel
              sessionId={input.session_id}
              theme={{
                primary: ctx.theme.current.primary,
                text: ctx.theme.current.text,
                textMuted: ctx.theme.current.textMuted,
                backgroundElement: ctx.theme.current.backgroundElement,
                borderSubtle: ctx.theme.current.borderSubtle,
                success: ctx.theme.current.success,
                warning: ctx.theme.current.warning,
                error: ctx.theme.current.error,
              }}
            />
          );
        },
      },
    });
  },
};

export default plugin;
