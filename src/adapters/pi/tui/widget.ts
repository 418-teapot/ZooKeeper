/**
 * Pi `zoo` fleet widget — a component factory that tracks the active primary
 * and the current session's subagent runs above the editor.
 *
 * Two display states:
 *
 *   - **Collapsed** (default): one line
 *     `◆ <primary> · <spinner> <agent> <m:ss> · ●<done> ■<failed> ■<aborted>`
 *     — the
 *     running segment appears only while something runs, zero counts are
 *     omitted, and with no activity at all the line is just `◆ <primary>`.
 *     The primary name keeps its own `[agent.<name>].color` ANSI color; the
 *     dominant status hue colors the rest of the line (running > error >
 *     success > muted).
 *   - **Expanded** (`↓` with the editor focused and empty): a full-width
 *     title line, an operation-hint line, and a scrolling window of run rows
 *     (top-level rows plus every nested generation indented with `├─` / `└─`),
 *     bounded to the widget's ~10-line budget (`FLEET_MAX_LINES`).
 *
 * When the host supplies todo phases the widget becomes dual-column: the
 * title + hint form a shared full-width header above both columns, the
 * fleet occupies the left column and the todo list the right one, joined by
 * `joinColumns` on a wide terminal and stacked vertically on a narrow one.
 * The collapsed state then renders both summaries on one line, separated by
 * `│`; with no projected todo rows the widget is byte-for-byte the
 * single-column fleet line it always was.  `tab` toggles which column owns
 * the expanded navigation keys.
 *
 * The widget owns the height budget.  `FLEET_MAX_LINES` is the total line
 * budget; each layout mode divides it into explicit row allotments handed to
 * the pure column renderers (`fleet-column.ts`, `todo-column.ts`), neither of
 * which holds an opinion about height.  Wide mode gives both columns the body
 * budget (`FLEET_MAX_LINES` minus the shared header); narrow mode attempts
 * full windows and tightens both when the stack would overflow; the
 * todo-only state hands the column the whole budget.
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
 * `↓` expands; once expanded `tab` switches the focused column and
 * `↑↓ / jk` move that column's selection (the window follows it), `esc`
 * collapses anywhere, and `↑` at the very top collapses.  On the todo
 * column `enter` toggles the fold of any phase header — open phases
 * enumerate by default, settled phases collapse — and the override is
 * explicit, so a later status change never flips what the user sees.  Task
 * rows consume enter as a no-op.  The collapsed state never steals keys
 * (defensive guard mirroring the
 * pi-subagents `fleet-status.ts` `handleKey`).  The active primary is read
 * live from the identity core, so the primary-switch command only needs to
 * nudge a refresh.
 *
 * Hosts can force the single-line state through the returned `collapse()`
 * handle (used before opening the transcript overlay, so the base content
 * stays at a stable one-line length under pi's line-diff compositor).
 *
 * Timer: a ~`FLEET_REFRESH_MS` interval advances the spinner frame and the
 * elapsed clock while anything runs or the widget is expanded (the expanded
 * todo spinner shares this clock); it is cleared when collapsed with nothing
 * running and `unref()`'d so a finished run never holds the process open.
 * `dispose()` clears the timer.
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
} from "../../../core/subagent/registry.js";
import {
  type CardLine,
  type FleetRunningSummary,
  renderFleetCollapsed,
} from "../../../core/subagent/view.js";
import type { TodoPhase } from "../../../core/todo/types.js";
import { type TodoViewLine, todoLines } from "../../../core/todo/view.js";
import {
  columnWidths,
  isNarrowLayout,
  joinColumns,
  padToWidth,
} from "./columns.js";
import {
  type FleetColumnOptions,
  type FleetColumnThemeLike,
  renderFleetColumn,
} from "./fleet-column.js";
import { hueToPiColor } from "./theme.js";
import {
  renderTodoCollapsed,
  renderTodoColumn,
  type TodoColumnOptions,
  type TodoColumnThemeLike,
} from "./todo-column.js";

/**
 * The expanded run-list window budget in rendered rows (of the ~10-line
 * widget budget).  A top-level run with nested children costs more than one
 * row, so this is a row budget, not a run count.
 */
export const FLEET_WINDOW_ROWS = 7;

/** The widget's total line budget (title + hint + window + indicators). */
export const FLEET_MAX_LINES = 10;

/** The spinner / clock refresh interval in milliseconds. */
export const FLEET_REFRESH_MS = 150;

/**
 * The narrow stacked layout's full-size window before tightening.
 *
 * The layout first attempts a full window for both columns; when the
 * combined stack exceeds {@link FLEET_MAX_LINES} it shrinks both to
 * {@link NARROW_WINDOW_ROWS}.
 */
const NARROW_FULL_ROWS = 7;

/**
 * The run / todo window shrunk to when the narrow stacked layout would
 * otherwise exceed the widget line budget.
 */
const NARROW_WINDOW_ROWS = 3;

/** Which column owns the expanded key routing. */
type FocusColumn = "fleet" | "todo";

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
  /**
   * The current todo phases for the right-hand column.
   *
   * Optional: absent (or returning an empty list) renders the fleet column
   * alone, preserving the widget's single-column behaviour.
   */
  getTodoPhases?(): readonly TodoPhase[];
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
  /**
   * Paint a background color for the selected fleet row (pi's `Theme.bg`).
   *
   * Optional: when absent the widget falls back to a raw ANSI background
   * pair (see `highlight`), so a minimal theme stub keeps working.
   */
  bg?(color: string, text: string): string;
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
  let focusColumn: FocusColumn = "fleet";
  let selectedId: string | undefined;
  let todoSelected = 0;
  const todoFoldOverrides = new Map<string, boolean>();
  // Bumped whenever `todoFoldOverrides` changes, so the memoized projection
  // below recomputes without inspecting the map itself.
  let todoFoldVersion = 0;
  let todoProjectionPhases: readonly TodoPhase[] | undefined;
  let todoProjectionVersion = -1;
  let todoProjectionRows: TodoViewLine[] = [];
  let frameSeq = 0;
  let timer: { unref?(): void } | undefined;

  /** The current session id, or undefined when none is available. */
  const sessionIdOf = (): string | undefined => deps.getSessionId();

  /**
   * The flattened run ids (top-level runs, then their descendants depth-first
   * in the expanded view's row order).
   */
  const rosterIds = (): string[] => {
    const sessionId = sessionIdOf();
    if (sessionId === undefined) return [];
    const ids: string[] = [];
    const walk = (runId: string): void => {
      ids.push(runId);
      for (const child of childrenOf(runId)) walk(child.id);
    };
    for (const top of topLevelRuns(sessionId)) walk(top.id);
    return ids;
  };

  /** The current todo phases (empty when the host wires no source). */
  const todoPhases = (): readonly TodoPhase[] => deps.getTodoPhases?.() ?? [];

  /**
   * The projected todo rows, memoized on the phases array reference and the
   * expansion version.
   *
   * The host hands back a reference-stable phases array between refreshes,
   * so the same projection is reused across every render and key handler
   * until the data or the phase fold overrides actually change.  Keying on
   * those two facts keeps the render path from re-projecting the plan for
   * each `projectedTodoRowCount` call site.
   */
  const todoRows = (): TodoViewLine[] => {
    const phases = todoPhases();
    if (
      todoProjectionPhases === phases &&
      todoProjectionVersion === todoFoldVersion
    ) {
      return todoProjectionRows;
    }
    todoProjectionPhases = phases;
    todoProjectionVersion = todoFoldVersion;
    todoProjectionRows = todoLines(phases, {
      foldOverrides: todoFoldOverrides,
    });
    return todoProjectionRows;
  };

  /**
   * Whether the projection produces at least one row.
   *
   * Visibility is gated on the projection rather than the phase count: a plan
   * whose phases are all task-less projects no rows, so the widget treats it
   * as having no todo column at all (the renderer's own empty placeholder
   * stays a defensive case).  This keeps the collapsed line, the hint, and
   * the `tab` routing consistent with what actually renders.
   */
  const hasTodoRows = (): boolean => todoRows().length > 0;

  /** Whether the fleet column has content (a primary or at least one run). */
  const hasFleetContent = (): boolean => {
    const primary = deps.getPrimary();
    return (
      (primary !== undefined && primary.length > 0) || rosterIds().length > 0
    );
  };

  /** The number of projected todo rows. */
  const projectedTodoRowCount = (): number => todoRows().length;

  /** The theme handed to the todo column (a passthrough when unattached). */
  const todoTheme = (): TodoColumnThemeLike =>
    theme ?? { fg: (_color: string, text: string) => text };

  /** The theme handed to the fleet column (a passthrough when unattached). */
  const fleetTheme = (): FleetColumnThemeLike =>
    theme ?? { fg: (_color: string, text: string) => text };

  /** The session's top-level runs (empty when no session is available). */
  const currentTops = (): SubagentRun[] => {
    const sessionId = sessionIdOf();
    return sessionId !== undefined ? topLevelRuns(sessionId) : [];
  };

  /** Build the fleet column options for one render pass. */
  const fleetColumnOpts = (
    windowRows: number,
    maxLines: number,
  ): FleetColumnOptions => ({
    windowRows,
    maxLines,
    selectedId,
    focused: focusColumn === "fleet",
    frame: frameSeq,
    now: now(),
    theme: fleetTheme(),
    colorizeAgent: deps.colorizeAgent,
  });

  /** Build the todo column options for one render pass. */
  const todoColumnOpts = (
    columnWidth: number,
    maxRows: number,
  ): TodoColumnOptions => ({
    width: columnWidth,
    maxRows,
    frame: frameSeq,
    focused: focusColumn === "todo",
    theme: todoTheme(),
    foldOverrides: todoFoldOverrides,
    ...(focusColumn === "todo"
      ? {
          selectedIndex: Math.max(
            0,
            Math.min(todoSelected, projectedTodoRowCount() - 1),
          ),
        }
      : {}),
  });

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

  /** Collapse back to the single line and reset the focus to the fleet. */
  const collapse = (): void => {
    expanded = false;
    focusColumn = "fleet";
    selectedId = undefined;
    todoSelected = 0;
    todoFoldOverrides.clear();
    todoFoldVersion += 1;
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
   * segments falls back to the whole-line wrap.
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
   * The currently-running delegation summaries — every running run in the
   * tree, at any depth, in roster order, so a deeply nested run under a
   * finished parent still drives the collapsed spinner segment and its
   * count.
   */
  const currentRunningOf = (
    sessionId: string | undefined,
  ): FleetRunningSummary[] | undefined => {
    if (sessionId === undefined) return undefined;
    const running: FleetRunningSummary[] = [];
    const collect = (run: SubagentRun): void => {
      if (run.status === "running") {
        running.push({
          agent: run.agent,
          label: run.label,
          elapsedMs: now() - run.startedAt,
        });
      }
      for (const child of childrenOf(run.id)) collect(child);
    };
    for (const top of topLevelRuns(sessionId)) collect(top);
    return running;
  };

  /** The collapsed single-line view-model line. */
  const collapsedLine = (): CardLine => {
    const primary = deps.getPrimary() ?? "";
    const sessionId = sessionIdOf();
    const currentRunning = currentRunningOf(sessionId);
    // Both counts cover the whole run tree: the running list walks every
    // generation and `summary` tallies top-level plus nested runs, so the
    // collapsed line reports every delegation the session performed.
    const sum =
      sessionId !== undefined
        ? {
            ...summary(sessionId),
            running: currentRunning?.length ?? 0,
          }
        : { running: 0, done: 0, failed: 0, aborted: 0 };
    return renderFleetCollapsed(
      primary,
      primary.length > 0 ? deps.colorizeAgent(primary) : undefined,
      sum,
      currentRunning,
      frameSeq,
    );
  };

  /**
   * The expanded header rows (title + operation hint).
   *
   * Rendered as full-width rows above the columns so the title and hint
   * span the whole widget instead of being squeezed into the fleet column.
   * Both rows start at column 0, matching every column body row (the
   * wide-mode separator is the only left edge offset, and it belongs to the
   * columns).  The hint mentions the `tab` toggle only when a todo column is
   * present, and the inspect segment only when the host wired `enterRun`.
   * On a narrow terminal the hint shortens to a compact key list so it fits
   * the stacked layout.
   */
  const expandedHeaderLines = (width: number): string[] => {
    const primary = deps.getPrimary();
    const title =
      primary !== undefined && primary.length > 0
        ? `◆ ${deps.colorizeAgent(primary)}`
        : "◆";
    const hasTab = hasTodoRows();
    const hasEnter = deps.enterRun !== undefined;
    const hint = isNarrowLayout(width)
      ? [
          "↑↓/jk",
          ...(hasTab ? ["tab"] : []),
          ...(hasEnter ? ["enter"] : []),
          "esc",
        ].join(" · ")
      : [
          "↑↓/jk select",
          ...(hasTab ? ["tab switch"] : []),
          ...(hasEnter ? ["enter inspect"] : []),
          "esc back",
        ].join(" · ");
    return [title, dim(hint)];
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
        // Never park the focus on a column that renders nothing: a todo-only
        // state hands the keys straight to the todo column.
        focusColumn = hasFleetContent() ? "fleet" : "todo";
        todoSelected = 0;
        selectedId = rosterIds()[0] ?? undefined;
        syncTimer();
        refresh();
        return { consume: true };
      }

      // `tab` switches which expanded column owns the navigation keys, but
      // only to a column that actually renders: focusing a hidden column
      // would move the band onto nothing.
      if (matchesKey(data, "tab")) {
        const target = focusColumn === "fleet" ? "todo" : "fleet";
        const focusable = target === "todo" ? hasTodoRows() : hasFleetContent();
        if (focusable) {
          focusColumn = target;
          refresh();
        }
        return { consume: true };
      }

      if (focusColumn === "todo") {
        const last = Math.max(0, projectedTodoRowCount() - 1);
        if (matchesKey(data, "down") || matchesKey(data, "j")) {
          // Clamp a stale index before moving so a list that shrank under
          // the cursor never swallows the keypress on an invisible row.
          todoSelected = Math.min(todoSelected, last);
          todoSelected = Math.min(last, todoSelected + 1);
          refresh();
          return { consume: true };
        }
        if (matchesKey(data, "up") || matchesKey(data, "k")) {
          todoSelected = Math.min(todoSelected, last);
          if (todoSelected <= 0) {
            collapse();
          } else {
            todoSelected -= 1;
            refresh();
          }
          return { consume: true };
        }
        if (matchesKey(data, "escape")) {
          collapse();
          return { consume: true };
        }
        if (matchesKey(data, "enter")) {
          // Any phase header toggles its fold; the override is explicit, so
          // a later settled↔open status change never flips what the user
          // sees.  Task rows have no enter action.  Either way the key is
          // consumed so it never reaches the editor while the todo column
          // owns focus.
          const rows = todoRows();
          const index = Math.max(0, Math.min(todoSelected, rows.length - 1));
          const row = rows[index];
          if (row !== undefined && row.kind === "header") {
            const effective = todoFoldOverrides.get(row.name) ?? !row.settled;
            todoFoldOverrides.set(row.name, !effective);
            todoFoldVersion += 1;
            refresh();
          }
          return { consume: true };
        }
        collapse();
        return undefined;
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
      const safeWidth = Math.max(1, width);
      const phases = todoPhases();
      const hasTodo = hasTodoRows();
      const hasFleet = hasFleetContent();
      // Nothing on either side: hide the widget entirely.
      if (!hasFleet && !hasTodo) return [];

      if (!expanded) {
        if (!hasFleet) {
          return [
            truncateToWidth(
              renderTodoCollapsed(phases, { theme: todoTheme() }),
              safeWidth,
            ),
          ];
        }
        const fleetLine = colorize(collapsedLine());
        if (!hasTodo) return [truncateToWidth(fleetLine, safeWidth)];
        const todoSegment = renderTodoCollapsed(phases, { theme: todoTheme() });
        const joined =
          joinColumns([fleetLine], [todoSegment], safeWidth)[0] ?? "";
        return [truncateToWidth(joined, safeWidth)];
      }

      if (!hasFleet) {
        return renderTodoColumn(
          phases,
          todoColumnOpts(safeWidth, FLEET_MAX_LINES),
        ).map((l) => truncateToWidth(l, safeWidth));
      }

      const header = expandedHeaderLines(safeWidth);
      // The header occupies the first two budget rows; the column bodies
      // share whatever remains.
      const bodyBudget = FLEET_MAX_LINES - header.length;
      const tops = currentTops();

      // With no projected todo rows the expanded widget is the fleet column
      // alone at every width: no join, no separator, no todo placeholder.
      if (!hasTodo) {
        const fleet = renderFleetColumn(
          tops,
          fleetColumnOpts(FLEET_WINDOW_ROWS, bodyBudget),
        );
        return [...header, ...fleet].map((l) => truncateToWidth(l, safeWidth));
      }

      if (!isNarrowLayout(safeWidth)) {
        // The header spans the full width above the two columns.
        const left = renderFleetColumn(
          tops,
          fleetColumnOpts(FLEET_WINDOW_ROWS, bodyBudget),
        );
        const { right: todoWidth } = columnWidths(safeWidth);
        const right = renderTodoColumn(
          phases,
          todoColumnOpts(todoWidth, bodyBudget),
        );
        const body = joinColumns(left, right, safeWidth);
        return [
          ...header.map((l) =>
            padToWidth(truncateToWidth(l, safeWidth), safeWidth),
          ),
          ...body.map((l) => truncateToWidth(l, safeWidth)),
        ];
      }

      // Narrow: stack the fleet body above the todo list, below the shared
      // header.  When the combined stack would exceed the budget, tighten
      // both windows (3 rows) and give the fleet a budget of whatever the
      // header and todo stack leave, so the whole widget still fits with its
      // ↑/↓ indicators intact.
      let todo = renderTodoColumn(
        phases,
        todoColumnOpts(safeWidth, NARROW_FULL_ROWS),
      );
      let fleet = renderFleetColumn(
        tops,
        fleetColumnOpts(FLEET_WINDOW_ROWS, bodyBudget),
      );
      if (header.length + fleet.length + todo.length > FLEET_MAX_LINES) {
        todo = renderTodoColumn(
          phases,
          todoColumnOpts(safeWidth, NARROW_WINDOW_ROWS),
        );
        fleet = renderFleetColumn(
          tops,
          fleetColumnOpts(
            NARROW_WINDOW_ROWS,
            Math.max(1, FLEET_MAX_LINES - header.length - todo.length),
          ),
        );
      }
      return [...header, ...fleet, ...todo].map((l) =>
        truncateToWidth(l, safeWidth),
      );
    },

    dispose() {
      if (timer !== undefined) {
        clearIntervalFn(timer);
        timer = undefined;
      }
      tui = undefined;
      expanded = false;
      focusColumn = "fleet";
      selectedId = undefined;
      todoSelected = 0;
      todoFoldOverrides.clear();
      todoFoldVersion += 1;
    },
  };
}
