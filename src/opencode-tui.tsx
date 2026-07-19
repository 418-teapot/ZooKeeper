/** @jsxImportSource @opentui/solid */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { type RGBA, TextAttributes } from "@opentui/core";
import { createSignal, onCleanup, onMount } from "solid-js";
import {
  formatPercent,
  formatTokens,
  progressBar,
} from "./core/context-report.js";
import type { ContextMessageEntry } from "./core/metrics.js";
import { computeContextReport } from "./core/metrics.js";
import { log, setSessionId } from "./utils/logger.js";

/** Category values for sidebar breakdown display. */
interface CategoryInfo {
  user: number;
  assistant: number;
  tool: number;
  system: number;
  misc: number;
  total: number;
}

/**
 * ZooKeeper TUI — sidebar_content live data panel.
 *
 * Displays the current session's context token usage, cache hit rate,
 * and category breakdown (user/asst/tool/sys/misc).  The panel is
 * collapsible — click the "ZooKeeper" title to toggle — and collapsed
 * state is persisted via `api.kv`.
 *
 * Data flow:
 * 1. `onMount` — fire-and-forget full fetch via
 *    `api.client.session.messages()` (no limit), compute report,
 *    subscribe to three events with a 2-second debounce.
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

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    // Request sequence counter: prevents stale async responses from
    // overwriting newer data (issue #6 — compute race).
    let requestSeq = 0;

    // ── Core computation (async, full fetch via client API) ─────────
    async function compute(sessionId: string) {
      const seq = ++requestSeq;
      try {
        // Full message fetch — no limit, unlike api.state.session.messages
        // which truncates at 100.  Returns { info, parts } shape
        // compatible with ContextMessageEntry.
        const res = await api.client.session.messages({
          sessionID: sessionId,
        });
        // HTTP error check: SDK may return { error, data } without throwing.
        const resObj = res as { error?: { message?: string }; data?: unknown };
        if (resObj.error) {
          const msg = resObj.error.message ?? String(resObj.error);
          log("opencode-tui", "compute_error", sessionId, undefined, "error", {
            error: msg,
          });
          setError(true);
          return;
        }
        // Defensive: some SDK versions wrap in { data: ... }
        const rawMessages = resObj.data ?? res;
        const entries: Array<unknown> = Array.isArray(rawMessages)
          ? rawMessages
          : [];
        const mapped: ContextMessageEntry[] = entries.filter(
          (m): m is ContextMessageEntry =>
            m != null &&
            typeof (m as Record<string, unknown>)?.info === "object" &&
            typeof (
              (m as Record<string, unknown>)?.info as Record<string, unknown>
            )?.role === "string",
        );
        const report = computeContextReport(mapped);
        // Only apply if this is still the latest request.
        if (seq !== requestSeq) return;
        setCache(
          report.cacheHitRate !== null
            ? formatPercent(report.cacheHitRate)
            : "—",
        );
        setCategories({
          user: report.categories.user,
          assistant: report.categories.assistant,
          tool: report.categories.tool,
          system: report.categories.system,
          misc: report.categories.misc,
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

    // ── Collapse toggle with KV persistence ────────────────────────
    function toggleCollapsed() {
      const next = !getCollapsed();
      setCollapsed(next);
      try {
        if (api.kv.ready) {
          api.kv.set("zookeeper.context_panel.collapsed", next);
        }
      } catch (err) {
        // Silently ignore — KV write failure must not crash.
        log("opencode-tui", "kv_write_failed", "", undefined, "debug", {
          error: String(err),
        });
      }
    }

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
      };
    }) {
      // ── Lifecycle ──────────────────────────────────────────────
      onMount(() => {
        // Ensure TUI-process logs are flushed to disk (logger requires
        // _sessionId to be set; issue #1).
        setSessionId(props.sessionId);

        // Restore collapsed state from persisted KV storage.
        try {
          if (api.kv.ready) {
            const saved = api.kv.get<boolean>(
              "zookeeper.context_panel.collapsed",
            );
            if (saved !== undefined) setCollapsed(saved);
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

        // Fire-and-forget initial fetch (errors handled inside compute).
        compute(props.sessionId);

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

        onCleanup(() => {
          unsub1();
          unsub2();
          unsub3();
          if (debounceTimer) clearTimeout(debounceTimer);
        });
      });

      // ── Render helpers ─────────────────────────────────────────
      function renderCategoryRow(label: string, value: number, total: number) {
        const ratio = total > 0 ? value / total : 0;
        const bar = progressBar(ratio, 6);
        const tokenStr = formatTokens(value);
        const pctStr = formatPercent(ratio);
        return (
          <text fg={props.theme.text}>
            {`${label.padEnd(4)} ${bar} ${tokenStr.padStart(6)} ${pctStr.padStart(5)}`}
          </text>
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
          >
            {/* biome-ignore lint/a11y/noStaticElementInteractions: clickable title for collapsible panel */}
            <text
              fg={props.theme.primary}
              attributes={TextAttributes.BOLD}
              onMouseDown={toggleCollapsed}
            >
              {getCollapsed() ? "▸" : "▾"} ZooKeeper
            </text>
            {getCollapsed() ? null : getError() ? (
              <text fg={props.theme.textMuted}>数据异常</text>
            ) : getLoaded() ? (
              <>
                <text fg={props.theme.text}>
                  {"缓存  "}
                  {getCache()}
                </text>
                {/* Text separator (avoids Yoga border crash with empty box) */}
                <text fg={props.theme.textMuted}>{"─".repeat(24)}</text>
                {/* Category breakdown rows */}
                {(() => {
                  const cats = getCategories();
                  if (!cats) return null;
                  return (
                    <>
                      {renderCategoryRow("user", cats.user, cats.total)}
                      {renderCategoryRow("asst", cats.assistant, cats.total)}
                      {renderCategoryRow("tool", cats.tool, cats.total)}
                      {renderCategoryRow("sys", cats.system, cats.total)}
                      {renderCategoryRow("misc", cats.misc, cats.total)}
                    </>
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
              }}
            />
          );
        },
      },
    });
  },
};

export default plugin;
