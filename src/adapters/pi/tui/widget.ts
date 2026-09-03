/**
 * Pi `zoo` fleet widget — a component factory that tracks the active primary
 * and the current session's subagent runs above the editor.
 *
 * Replaces the legacy string-array `zoo` widget (a single `◆ <primary>`
 * line) with a live fleet widget:
 *
 *   - **Collapsed** (default): one line
 *     `◆ <primary> · <spinner> <agent> <m:ss> · ●<done> ●<failed>` — the
 *     running segment appears only while something runs, zero counts are
 *     omitted, and with no activity at all the line is just `◆ <primary>`.
 *     The primary name keeps its own `[agent.<name>].color` ANSI color; the
 *     dominant status hue colors the rest of the line (running > error >
 *     success > muted).
 *   - **Expanded** (`↓` with the editor focused and empty): a title line, an
 *     operation-hint line, and a scrolling window of run rows (top-level
 *     rows plus one nested-child level indented with `├─` / `└─`), bounded
 *     to the widget's ~10-line budget (`FLEET_MAX_LINES`).
 *
 *  Coloring is the one place the widget differs from the transcript card:
 *  every view-model line is translated through `hueToPiColor` and rendered
 *  with the real pi `theme.fg` (spinner → warning, done → success, error /
 *  aborted → error, secondary → dim).  The card stays uncolored; the widget
 *  is colored.  Lines carrying per-segment hues are wrapped segment by
 *  segment — a segment without a hue (the pre-colorized primary) is emitted
 *  verbatim, so its embedded ANSI reset never washes out the dots that
 *  follow it.
 *
 * Keyboard (`ui.onTerminalInput`): while the editor is focused AND empty, a
 * `↓` expands; once expanded `↑↓ / jk` move the selection (the run window
 * follows it), `esc` collapses anywhere, and `↑` at the very top collapses.
 * The collapsed state never steals keys (defensive guard mirroring the
 * pi-subagents `fleet-status.ts` `handleKey`).  The active primary is read
 * live from the identity core, so the primary-switch command only needs to
 * nudge a refresh.
 *
 * Hosts can force the single-line state through the returned `collapse()`
 * handle (used before opening the transcript overlay, so the base content
 * stays at a stable one-line length under pi's line-diff compositor).
 *
 * Timer: a ~`FLEET_REFRESH_MS` interval advances the spinner frame and the
 * elapsed clock while anything runs OR the widget is expanded; it is cleared
 * when collapsed with nothing running and `unref()`'d so a finished run never
 * holds the process open.  `dispose()` clears the timer.
 *
 * Pure component logic — pi's `TUI` / `Theme` are duck-typed, so this module
 * is unit-testable with a stub theme and injected timers.
 *
 * @module
 */

import {
  type EditorComponent,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  childrenOf,
  getRun,
  type SubagentRun,
  summary,
  topLevelRuns,
  windowRuns,
} from "../../../core/subagent/registry.js";
import {
  type CardLine,
  type FleetRunningSummary,
  renderFleetCollapsed,
  renderFleetRows,
} from "../../../core/subagent/view.js";
import { hueToPiColor } from "./theme.js";

/** The expanded run-list window height (of the ~10-line widget budget). */
export const FLEET_WINDOW_ROWS = 7;

/** The widget's total line budget (title + hint + window + indicators). */
export const FLEET_MAX_LINES = 10;

/** The spinner / clock refresh interval in milliseconds. */
export const FLEET_REFRESH_MS = 150;

/**
 * The host surfaces the fleet widget needs.
 *
 * `getPrimary` / `colorizeAgent` supply the active primary (read live, so a
 * switch only needs to nudge a refresh).  `getSessionId` scopes the registry
 * queries to the current session.  `getEditorText` feeds the collapsed-key
 * guard.  `enterRun` is optional: when a host can open a run inspection
 * overlay it is invoked for the selected run on enter.  The callback returns
 * whether an overlay actually opened — when the host has no `ui.custom`
 * surface or the run has no session path, it returns `false` and enter is
 * left unconsumed (the key falls through to the editor).  The timer
 * functions and `now` are injectable for deterministic tests.
 */
export interface FleetWidgetDeps {
  /** The active primary agent name, or undefined when none. */
  getPrimary(): string | undefined;
  /** Colorize an agent name per its configured `[agent.<name>].color`. */
  colorizeAgent(name: string): string;
  /** The current session id (parent session for top-level runs). */
  getSessionId(): string | undefined;
  /** The current pi editor text (guards the collapsed-key activation). */
  getEditorText(): string;
  /**
   * Optional inspection of the selected run's transcript on enter.
   *
   * Returns `true` when the inspection overlay was actually opened (the
   * enter key is then consumed); `false` when no overlay could open (no
   * `ui.custom` surface, or the run lacks a session path), leaving the key
   * to fall through to the editor.
   */
  enterRun?(run: SubagentRun): boolean | undefined;
  /** Spinner/clock refresh interval (defaults to `FLEET_REFRESH_MS`). */
  refreshMs?: number;
  /** Injectable interval factory (tests use a fake timer). */
  setInterval?: (fn: () => void, ms: number) => { unref?(): void };
  /** Injectable interval clearer (tests use a fake timer). */
  clearInterval?: (handle: unknown) => void;
  /** Injectable clock (tests use a fake timer's now). */
  now?: () => number;
}

/** Structural subset of pi's `TUI` the widget reads. */
export interface FleetTuiLike {
  /** Request a re-render (drives the spinner / elapsed clock). */
  requestRender?(force?: boolean): void;
  /** The currently focused component (inspected for the editor-focus guard). */
  focusedComponent?: unknown;
}

/** Structural subset of pi's `Theme` the widget colors lines with. */
export interface FleetThemeLike {
  fg(color: string, text: string): string;
}

/** The fleet widget surface the pi entry point wires up. */
export interface FleetWidget {
  /** Bind the live pi TUI / theme (called by the widget factory). */
  attach(tui: FleetTuiLike, theme: FleetThemeLike): void;
  /** Handle one raw terminal input (via `ui.onTerminalInput`). */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined;
  /**
   * Force the collapsed single-line state (idempotent: already-collapsed
   * calls have no further effect).  Used by hosts before opening an overlay,
   * so the base content length stays stable under pi's line-diff compositor.
   */
  collapse(): void;
  /** Re-render (registry writes / primary switches nudge this). */
  refresh(): void;
  /** Render the current lines (called by pi's widget component). */
  render(width: number): string[];
  /** Release the timer and widget state (pi calls it on replacement). */
  dispose(): void;
}

/**
 * Create the fleet widget bound to the given host surfaces.
 *
 * @param deps - The host surfaces (primary, colorizer, session id, editor
 *   text, optional enter action, and test-injectable timers / clock).
 * @returns The fleet widget handle.
 */
export function createFleetWidget(deps: FleetWidgetDeps): FleetWidget {
  const refreshMs = deps.refreshMs ?? FLEET_REFRESH_MS;
  const setIntervalFn =
    deps.setInterval ??
    ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms));
  const clearIntervalFn =
    deps.clearInterval ??
    ((handle: unknown) => globalThis.clearInterval(handle as never));
  const now = deps.now ?? Date.now;

  let tui: FleetTuiLike | undefined;
  let theme: FleetThemeLike | undefined;
  let expanded = false;
  let selectedId: string | undefined;
  let frameSeq = 0;
  let timer: { unref?(): void } | undefined;

  /** The current session id, or undefined when none is available. */
  const sessionIdOf = (): string | undefined => deps.getSessionId();

  /** The flattened run ids (top-level runs then their children, in order). */
  const rosterIds = (): string[] => {
    const sessionId = sessionIdOf();
    if (sessionId === undefined) return [];
    const ids: string[] = [];
    for (const top of topLevelRuns(sessionId)) {
      ids.push(top.id);
      for (const child of childrenOf(top.id)) ids.push(child.id);
    }
    return ids;
  };

  /**
   * The window anchor: the selected top-level id, or the parent of a
   * selected child (so the child's parent stays in view).  A stale id yields
   * `undefined` and `windowRuns` bottom-aligns.
   */
  const windowAnchor = (): string | undefined => {
    if (selectedId === undefined) return undefined;
    const sessionId = sessionIdOf();
    if (sessionId === undefined) return undefined;
    for (const top of topLevelRuns(sessionId)) {
      if (top.id === selectedId) return top.id;
      if (childrenOf(top.id).some((child) => child.id === selectedId)) {
        return top.id;
      }
    }
    return undefined;
  };

  /** Start (idempotently) or clear the spinner / clock interval. */
  const syncTimer = (): void => {
    const running = (currentRunningOf(sessionIdOf())?.length ?? 0) > 0;
    const shouldRun = expanded || running;
    if (shouldRun && tui !== undefined && timer === undefined) {
      timer = setIntervalFn(() => {
        frameSeq += 1;
        tui?.requestRender?.();
      }, refreshMs);
      timer.unref?.();
    } else if (!shouldRun && timer !== undefined) {
      clearIntervalFn(timer);
      timer = undefined;
    }
  };

  /** Nudge a re-render (the timer state is re-synced each time). */
  const refresh = (): void => {
    syncTimer();
    tui?.requestRender?.();
  };

  /** Collapse back to the single line. */
  const collapse = (): void => {
    expanded = false;
    selectedId = undefined;
    syncTimer();
    refresh();
  };

  /**
   * Color one view-model line with the pi theme.
   *
   * A line that carries `segments` is colorized per segment: each segment
   * with a hue is wrapped in `theme.fg` alone, and a segment without a hue
   * is emitted verbatim.  This is what keeps a pre-colorized segment (the
   * primary agent name, carrying its own embedded ANSI sequence that ends
   * with `\x1b[39m`) from washing out the colors of later segments — the
   * reset sequence never sits inside an outer wrap.  A segment marked with
   * its `agent` name is rendered through the host `colorizeAgent` (which
   * applies the configured `[agent.<name>].color` and returns the plain name
   * when unconfigured, so the current default is preserved).  A line without
   * segments keeps the legacy whole-line wrap.
   */
  const colorize = (line: CardLine): string => {
    if (theme === undefined) return line.text;
    const th = theme;
    if (line.segments !== undefined && line.segments.length > 0) {
      return line.segments
        .map((segment) => {
          if (segment.agent !== undefined) {
            return deps.colorizeAgent(segment.agent);
          }
          return segment.hue === undefined
            ? segment.text
            : th.fg(hueToPiColor(segment.hue), segment.text);
        })
        .join("");
    }
    return th.fg(hueToPiColor(line.hue), line.text);
  };

  /** Dim a secondary text with the pi theme. */
  const dim = (text: string): string =>
    theme !== undefined ? theme.fg("dim", text) : text;

  /**
   * The currently-running delegation summaries — top-level runs plus each
   * top-level run's nested children (one level deep, mirroring the expanded
   * view's rendering depth), so a nested run under a finished parent still
   * drives the collapsed spinner segment and its count.
   */
  const currentRunningOf = (
    sessionId: string | undefined,
  ): FleetRunningSummary[] | undefined => {
    if (sessionId === undefined) return undefined;
    const running: FleetRunningSummary[] = [];
    for (const top of topLevelRuns(sessionId)) {
      if (top.status === "running") {
        running.push({
          agent: top.agent,
          label: top.label,
          elapsedMs: now() - top.startedAt,
        });
      }
      for (const child of childrenOf(top.id)) {
        if (child.status === "running") {
          running.push({
            agent: child.agent,
            label: child.label,
            elapsedMs: now() - child.startedAt,
          });
        }
      }
    }
    return running;
  };

  /** The collapsed single-line view-model line. */
  const collapsedLine = (): CardLine => {
    const primary = deps.getPrimary() ?? "";
    const sessionId = sessionIdOf();
    const currentRunning = currentRunningOf(sessionId);
    // The running count covers top-level + one nested level (matching the
    // running list above); the done/failed counts stay top-level scoped.
    const sum =
      sessionId !== undefined
        ? {
            ...summary(sessionId),
            running: currentRunning?.length ?? 0,
          }
        : { running: 0, done: 0, failed: 0 };
    return renderFleetCollapsed(
      primary,
      primary.length > 0 ? deps.colorizeAgent(primary) : undefined,
      sum,
      currentRunning,
      frameSeq,
    );
  };

  /**
   * The expanded lines (title + hint + run window + indicators), trimmed to
   * the line budget with the ↑/↓ indicators always preserved.
   *
   * The window stays at its normal `FLEET_WINDOW_ROWS` height; the assembled
   * view (title + hint + ↑ + rows + ↓) can still exceed `FLEET_MAX_LINES`
   * when nested children inflate the rows (each child renders its own line)
   * or both indicators appear.  The trim then removes lines from the END of
   * the run-row block only — never the trailing ↓ indicator (which is what a
   * naive tail-slice would cut) nor the title/hint/↑.
   */
  const expandedLines = (): string[] => {
    const primary = deps.getPrimary();
    const title =
      primary !== undefined && primary.length > 0
        ? `◆ ${deps.colorizeAgent(primary)}`
        : "◆";
    const hint =
      deps.enterRun !== undefined
        ? "↑↓/jk select · enter inspect · esc back"
        : "↑↓/jk select · esc back";

    const sessionId = sessionIdOf();
    const tops = sessionId !== undefined ? topLevelRuns(sessionId) : [];
    const childrenByParent = new Map<string, SubagentRun[]>();
    for (const top of tops) {
      childrenByParent.set(top.id, childrenOf(top.id));
    }
    const slice = windowRuns(tops, windowAnchor(), FLEET_WINDOW_ROWS);

    const out: string[] = [`  ${title}`, `  ${dim(hint)}`];
    if (slice.hiddenAbove > 0) {
      out.push(dim(`↑ ${slice.hiddenAbove} more`));
    }
    for (const line of renderFleetRows(
      slice.rows,
      childrenByParent,
      selectedId,
      frameSeq,
      now(),
    )) {
      out.push(`  ${colorize(line)}`);
    }
    if (slice.hiddenBelow > 0) {
      out.push(dim(`↓ ${slice.hiddenBelow} more`));
    }

    // Nested children (or both indicators) can push the assembled view past
    // the budget.  Trim from the end of the run-row block only, preserving
    // the title/hint/↑ at the top and the ↓ indicator at the bottom.
    if (out.length <= FLEET_MAX_LINES) return out;
    const overflow = out.length - FLEET_MAX_LINES;
    const hasUp = slice.hiddenAbove > 0;
    const hasDown = slice.hiddenBelow > 0;
    const runStart = hasUp ? 3 : 2;
    const runEnd = hasDown ? out.length - 1 : out.length;
    const remove = Math.min(overflow, runEnd - runStart);
    out.splice(runEnd - remove, remove);
    return out;
  };

  /** Whether the editor (not the widget) currently owns focus. */
  const editorHasFocus = (): boolean => {
    const focused = (
      tui as unknown as { focusedComponent?: unknown } | undefined
    )?.focusedComponent;
    if (
      focused === undefined ||
      focused === null ||
      typeof focused !== "object"
    ) {
      return false;
    }
    const candidate = focused as Partial<EditorComponent>;
    return (
      typeof candidate.render === "function" &&
      typeof candidate.invalidate === "function" &&
      typeof candidate.handleInput === "function" &&
      typeof candidate.getText === "function" &&
      typeof candidate.setText === "function"
    );
  };

  return {
    attach(nextTui, nextTheme) {
      tui = nextTui;
      theme = nextTheme;
      syncTimer();
    },

    handleKey(data) {
      if (isKeyRelease(data)) return undefined;
      // Collapsed and expanded both defer to the editor when it is focused
      // with content: the fleet keys only take over an empty editor, so
      // typing / cursor movement is never stolen.
      if (!editorHasFocus()) {
        if (expanded) collapse();
        return undefined;
      }
      if (!expanded) {
        const activates = matchesKey(data, "down");
        if (!activates || deps.getEditorText() !== "") return undefined;
        expanded = true;
        selectedId = rosterIds()[0] ?? undefined;
        syncTimer();
        refresh();
        return { consume: true };
      }

      const roster = rosterIds();
      const index = roster.indexOf(selectedId ?? "");
      if (matchesKey(data, "down") || matchesKey(data, "j")) {
        selectedId =
          roster[Math.min(roster.length - 1, Math.max(0, index + 1))];
        refresh();
        return { consume: true };
      }
      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        if (index <= 0) {
          collapse();
        } else {
          selectedId = roster[index - 1];
          refresh();
        }
        return { consume: true };
      }
      if (matchesKey(data, "escape")) {
        collapse();
        return { consume: true };
      }
      if (matchesKey(data, "enter")) {
        const run = getRun(selectedId ?? "");
        // Enter is only consumed when an overlay was actually opened: an
        // absent `enterRun` action (no overlay surface wired), an empty
        // selection, or a callback reporting no overlay (no `ui.custom`
        // surface or no run session path) must not swallow the key from the
        // editor.
        if (run === undefined || deps.enterRun === undefined) return undefined;
        if (deps.enterRun(run) === false) return undefined;
        return { consume: true };
      }
      // An unmatched key defocuses the fleet navigation (mirroring
      // fleet-status) without stealing the key from the editor.
      collapse();
      return undefined;
    },

    collapse,

    refresh,

    render(width) {
      const lines = expanded ? expandedLines() : [colorize(collapsedLine())];
      return lines.map((l) => truncateToWidth(l, Math.max(1, width)));
    },

    dispose() {
      if (timer !== undefined) {
        clearIntervalFn(timer);
        timer = undefined;
      }
      tui = undefined;
      expanded = false;
      selectedId = undefined;
    },
  };
}
