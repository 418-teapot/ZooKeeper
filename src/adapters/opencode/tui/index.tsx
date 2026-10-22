/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { type RGBA, TextAttributes } from "@opentui/core";
import { createSignal, onCleanup, onMount } from "solid-js";
import {
  formatPercent,
  formatTokens,
  progressBar,
} from "../../../core/context/context-report.js";
import type { TokenBreakdownResult } from "../../../core/context/lens-stats.js";
import {
  type SubagentRun,
  subscribeRunChange,
  topLevelRuns,
} from "../../../core/subagent/registry.js";
import { initLogger, log } from "../../../utils/logger.js";
import { createSubagentSource } from "../subagent-source.js";
import { createContextController } from "./controller.js";
import type { CategoryInfo } from "./subagent.js";
import { formatDuration } from "./subagent.js";

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
    // One-shot process init for the TUI process (part of the OpenCode
    // host): entries carry their own session id per call, so the flush
    // timer is the only process-level requirement here.
    initLogger("opencode");

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

    // ── Context data controller ───────────────────────────────────
    // Shared fetch, compute, and the 2 s debounced refresh live in
    // the controller factory; the panel wires the returned methods
    // onto the mount lifecycle and the event bus.
    const controller = createContextController({
      client: api.client,
      state: api.state,
      setCache,
      setCategories,
      setError,
      setTrendLabel,
      setTrend,
      setCumulative,
      setDetail,
      setLoaded,
    });

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
          log.debug({
            hook: "opencode-tui",
            event: "kv_write_failed",
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
      // ── Subagent rows: a projection of the core registry ────────
      // The panel keeps no subagent state of its own — the rows are
      // re-read from the registry whenever a run changes.
      const [getSubRuns, setSubRuns] = createSignal<SubagentRun[]>([]);
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

        // Reset the projected subagent rows and expand state on every
        // mount.  Both signals live across panel remounts (e.g. session
        // switches) and would otherwise carry stale rows.
        setSubRuns([]);
        setExpandedSubIds(new Set<string>());

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
          log.debug({
            hook: "opencode-tui",
            event: "kv_read_failed",
            sessionId: props.sessionId,
            error: String(err),
          });
        }

        // Shared fetch: one API call shared between compute and scan.
        const messagesPromise = controller.fetchSessionMessages(
          props.sessionId,
        );
        controller.compute(props.sessionId, messagesPromise);

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
            controller.scheduleRefresh(props.sessionId);
          }
        }

        const unsub1 = api.event.on("message.updated", onOwnEvent);
        const unsub2 = api.event.on("message.part.updated", onOwnEvent);
        const unsub3 = api.event.on("session.updated", onOwnEvent);

        // ── Subagent facts ────────────────────────────────────────
        // The panel owns no subagent state machine: the translator writes
        // host facts into the core run registry, and the rendered rows are
        // a projection of that registry, refreshed on every run change.
        // Created and disposed with the panel.
        const source = createSubagentSource({
          client: api.client,
          state: api.state,
          parentSessionId: props.sessionId,
          fetchSessionMessages: controller.fetchSessionMessages,
        });

        const refreshSubRuns = () => setSubRuns(topLevelRuns(props.sessionId));
        refreshSubRuns();

        const unsub4 = api.event.on(
          "message.part.updated",
          source.onToolPartUpdated,
        );
        const unsub5 = api.event.on("session.idle", source.onSessionIdle);
        const unsub6 = api.event.on("session.error", source.onSessionError);
        const unsub7 = subscribeRunChange(refreshSubRuns);

        // Mount-time reconcile: recover the delegations this session
        // already performed (the shared fetch is reused).
        void source.reconcile(messagesPromise);

        onCleanup(() => {
          unsub1();
          unsub2();
          unsub3();
          unsub4();
          unsub5();
          unsub6();
          unsub7();
          controller.dispose();
          if (clockTimer) clearInterval(clockTimer);
          source.dispose();
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

      function renderSubEntry(run: SubagentRun) {
        const expanded = getExpandedSubIds().has(run.id);
        const chevron = expanded ? "▾" : "▸";
        // Status is conveyed by the dot colour alone (running=warning,
        // done=success, aborted=muted, error=error) — no redundant status
        // text, except the explicit "已取消" line for a cancellation.
        const dotColor =
          run.status === "running"
            ? props.theme.warning
            : run.status === "done"
              ? props.theme.success
              : run.status === "aborted"
                ? props.theme.textMuted
                : props.theme.error;
        // Running entries blink: alternate ● / ○ on the 1 s clock tick.
        const dotChar =
          run.status === "running" && Math.floor(getNowTick() / 1000) % 2 === 1
            ? "○"
            : "●";
        const tokenStr =
          run.tokens !== undefined ? formatTokens(run.tokens) : "";

        // Compute duration string:
        // - Running with startedAt → real-time elapsed (now - startedAt).
        // - Terminal with both times → total duration (endedAt - startedAt).
        // - Missing startedAt → "—".
        let durationStr: string;
        if (run.startedAt === undefined) {
          durationStr = "—";
        } else if (run.status === "running") {
          durationStr = formatDuration(getNowTick() - run.startedAt);
        } else if (run.endedAt !== undefined) {
          durationStr = formatDuration(run.endedAt - run.startedAt);
        } else {
          durationStr = "—";
        }

        return (
          <box flexDirection="column">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: clickable sub-agent entry row */}
            <text onMouseUp={() => toggleExpand(run.id)}>
              <span style={{ fg: props.theme.textMuted }}>{`${chevron} `}</span>
              <span style={{ fg: dotColor }}>{`${dotChar} `}</span>
              <span style={{ fg: props.theme.text }}>{run.label ?? ""}</span>
            </text>
            {expanded ? (
              <box paddingLeft={2} flexDirection="column">
                <text fg={props.theme.textMuted}>
                  {`${padLabel("agent:", 8)}${run.agent}`}
                </text>
                <text fg={props.theme.textMuted}>
                  {`${padLabel("模型:", 8)}${run.model ?? "—"}`}
                </text>
                <text fg={props.theme.textMuted}>
                  {`${padLabel("上下文:", 8)}${tokenStr || "—"}`}
                </text>
                <text fg={props.theme.textMuted}>
                  {`${padLabel("耗时:", 8)}${durationStr}`}
                </text>
                {run.status === "error" ? (
                  <text fg={props.theme.textMuted}>
                    {`${padLabel("错误:", 8)}${run.error ?? "—"}`}
                  </text>
                ) : null}
                {run.status === "aborted" ? (
                  <text fg={props.theme.textMuted}>
                    {`${padLabel("状态:", 8)}已取消`}
                  </text>
                ) : null}
                {/* Jump into the child session — same pattern as the
                    subagent-magazine plugin: route.navigate("session"). */}
                {run.childSession ? (
                  // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithMouseEvents: clickable enter-session link (TUI has no keyboard focus for this element)
                  <text
                    onMouseOver={() => setHoveredOpenId(run.id)}
                    onMouseOut={() => setHoveredOpenId(undefined)}
                    onMouseUp={() => {
                      if (run.childSession) {
                        api.route.navigate("session", {
                          sessionID: run.childSession,
                        });
                      }
                    }}
                  >
                    <span
                      style={{
                        fg:
                          getHoveredOpenId() === run.id
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
                {/* Sub-agent status section.  The rows are a projection of
                    the core run registry, re-read whenever a run changes,
                    so all rows re-render on any progress or token change —
                    acceptable for small run counts (<10).  The section
                    header (chevron + name + status counts + total context)
                    is clickable and collapses the whole section; the
                    collapsed state is persisted via api.kv.  A concrete
                    <box> container (not a fragment) wraps the section so
                    Yoga measures its height correctly — a fragment wrapper
                    caused hit-test coordinates to drift several rows above
                    the visual position. */}
                {(() => {
                  const runs = getSubRuns();
                  if (runs.length === 0) return null;
                  const subCollapsed = getSubCollapsed();
                  let done = 0;
                  let running = 0;
                  let errored = 0;
                  let aborted = 0;
                  for (const run of runs) {
                    if (run.status === "done") done++;
                    else if (run.status === "running") running++;
                    else if (run.status === "aborted") aborted++;
                    else errored++;
                  }
                  // Aggregate token snapshots per child session: a resumed
                  // task() call creates a new part entry that shares the
                  // same child session, so keep only the latest (max)
                  // snapshot per session before summing. Runs without a
                  // child session fall back to their own id and count
                  // individually.
                  const tokensBySession = new Map<string, number>();
                  for (const run of runs) {
                    const key = run.childSession ?? run.id;
                    tokensBySession.set(
                      key,
                      Math.max(tokensBySession.get(key) ?? 0, run.tokens ?? 0),
                    );
                  }
                  const totalTokens = [...tokensBySession.values()].reduce(
                    (a, b) => a + b,
                    0,
                  );
                  const tokenStr =
                    totalTokens > 0 ? formatTokens(totalTokens) : "—";
                  const segLabel = `${subCollapsed ? "▸" : "▾"} 子代理`;
                  const segDone = `● ${done} `;
                  const segRunning = `● ${running} `;
                  const segError = `● ${errored} `;
                  const segAborted = `● ${aborted} `;
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
                          {aborted > 0 ? (
                            <span style={{ fg: props.theme.textMuted }}>
                              {segAborted}
                            </span>
                          ) : null}
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
                          {runs
                            .slice()
                            .sort((a, b) => {
                              const aRun = a.status === "running" ? 0 : 1;
                              const bRun = b.status === "running" ? 0 : 1;
                              if (aRun !== bRun) return aRun - bRun;
                              if (aRun === 0) {
                                return (b.startedAt ?? 0) - (a.startedAt ?? 0);
                              }
                              return 0;
                            })
                            .map((run) => renderSubEntry(run))}
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
