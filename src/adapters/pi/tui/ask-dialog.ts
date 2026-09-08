/**
 * Ask-form dialog — the pi TUI surface of the `ask` tool.
 *
 * ONE panel drives the whole form: a chip strip selects the question pages
 * plus a trailing Submit summary page (multi-question forms only), the body
 * renders the active page, and the footer carries the key hints.  The
 * component resolves through pi's `ui.custom` `done` callback with ONE
 * `AskResult` per question, so the caller never has to interpret keys.
 *
 * Result semantics (the three core slots, assembled per question):
 *   - a committed answer is always preserved, whatever closes the form;
 *   - Enter on an option commits the answer and advances (a single-question
 *     form closes); on the Submit page Enter closes with the answers;
 *   - Esc closes the form: an unanswered question the user had been shown
 *     (the active page, or one paged onto and back) is `declined`; an
 *     unanswered question the user never reached is
 *     `unavailable("aborted")`;
 *   - a final submit (Enter on the Submit page) declines every question the
 *     user left unanswered — skipping is a user decision, not a
 *     system-side termination;
 *   - the timeout closes the form: every unanswered question is
 *     `unavailable("timeout")`;
 *   - an external abort (the host's AbortSignal) closes the form: every
 *     unanswered question is `unavailable("aborted")`.
 *
 * Geometry: the panel height is measured ONCE, at the first render, from
 * the tallest page's natural content and clamped to 70% of the terminal
 * rows; it never changes afterwards (tab switches, cursor moves, and later
 * answers all keep the box rigid), and content that no longer fits scrolls.
 *
 * Headless-testable by construction: pi's `Theme` / `TUI` are duck-typed to
 * the members used here, the timers are injectable, and the component comes
 * from a plain factory taking `(tui, theme, done)`.
 *
 * @module
 */

import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  AskOption,
  AskResult,
  NormalizedQuestion,
} from "../../../core/ask.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A question as the ask adapter hands it to the dialog.
 *
 * Extends the core's normalized question with `recommended` — an
 * adapter-only UI hint (badge + initial cursor position) that never enters
 * the core protocol or the answer payload.
 */
export interface AskDialogQuestion extends NormalizedQuestion {
  /** Index into `options` of the recommended candidate (ignored when
   * absent or out of range). */
  recommended?: number;
}

/** How the form closed; drives the unanswered questions' slots. */
export type AskDialogClosure = "submit" | "cancel" | "timeout" | "abort";

/** The value the dialog resolves `done` with. */
export interface AskDialogOutcome {
  /** One result per question, in question order. */
  results: AskResult[];
  /** How the form closed (logging only — `results` is already complete). */
  closure: AskDialogClosure;
}

/** Structural subset of pi's `TUI` the dialog needs. */
export interface AskDialogTuiLike {
  /** Request a re-render after any state change. */
  requestRender(force?: boolean): void;
  /** Terminal geometry — the height clamp and the Editor's own viewport. */
  terminal: { rows: number; columns: number };
}

/** Structural subset of pi's `Theme` the dialog colors lines with. */
export interface AskDialogThemeLike {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

/** Injectable timer surface (tests drive expiry deterministically). */
export interface AskDialogTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Clock in ms (defaults to `Date.now`). */
  now?(): number;
}

/** The component object handed back to pi's `ui.custom` factory. */
export interface AskDialogComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  /** Stop timers and ignore further input (pi calls it on teardown). */
  dispose(): void;
  /** Mirrored onto the embedded Editor so it can emit the hardware cursor. */
  focused: boolean;
}

/** The dialog handle the ask adapter keeps for external aborts. */
export interface AskDialog {
  /** The pi component (returned from the `ui.custom` factory). */
  component: AskDialogComponent;
  /** Close the form as aborted (idempotent; ignored once closed). */
  abort(): void;
}

/** Construction dependencies of {@link createAskDialog}. */
export interface AskDialogDeps {
  questions: AskDialogQuestion[];
  tui: AskDialogTuiLike;
  theme: AskDialogThemeLike;
  done: (outcome: AskDialogOutcome) => void;
  /** Timeout in seconds; absent → the form waits indefinitely. */
  timeoutSeconds?: number;
  /** Timer surface (defaults to the wall clock). */
  timers?: AskDialogTimers;
}

/** One body line span belonging to a question row (inclusive bounds). */
export interface AskRowSpan {
  from: number;
  to: number;
}

/** A rendered page: its content lines and each row's line span. */
export interface AskPageBody {
  lines: string[];
  spans: AskRowSpan[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum panel height in rows (never smaller, even on tiny terminals). */
const MIN_PANEL_ROWS = 10;
/** Minimum body rows left after the box chrome is subtracted. */
const MIN_BODY_ROWS = 3;
/** Panel height clamp as a fraction of the terminal height. */
const MAX_HEIGHT_FRACTION = 0.7;
/** Assumed terminal height when the host reports none. */
const DEFAULT_TERM_ROWS = 24;
/** Suffix marking the recommended candidate (UI only, never in answers). */
const RECOMMENDED_SUFFIX = " (Recommended)";
/** The freeform row's label. */
const FREEFORM_LABEL = "Type something.";
/** Narrowest width the box renders at (below it borders would collapse). */
const MIN_BOX_WIDTH = 20;
/** Marker glyphs — pi-tui ships no radio/checkbox symbol table. */
const RADIO_ON = "◉";
const RADIO_OFF = "○";
const CHECK_ON = "☑";
const CHECK_OFF = "☐";

/** The wall-clock timer default. */
export const REAL_TIMERS: AskDialogTimers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Width / layout helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Pad or truncate `text` to exactly `width` display columns. */
export function fitColumns(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), "", true);
}

/** Collapse embedded newlines / runs of blanks onto a single line. */
export function toOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Append `text` to `lines`, word-wrapped at `width`. */
function addWrapped(lines: string[], text: string, width: number): void {
  for (const line of wrapTextWithAnsi(text, Math.max(1, width))) {
    lines.push(line);
  }
}

/**
 * Append `text` to `lines` with a hanging indent, so every wrapped
 * continuation line aligns under the start of the text.
 */
function addPrefixed(
  lines: string[],
  prefix: string,
  text: string,
  width: number,
): void {
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= width) {
    addWrapped(lines, prefix + text, width);
    return;
  }
  const filler = " ".repeat(prefixWidth);
  const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
  for (let i = 0; i < wrapped.length; i++) {
    lines.push(`${i === 0 ? prefix : filler}${wrapped[i]}`);
  }
}

// ---------------------------------------------------------------------------
// Pure state helpers (exported for tests)
// ---------------------------------------------------------------------------

/** A body row of a question page. */
export type AskRow = { kind: "option"; option: AskOption } | { kind: "other" };

/** The question's rows: its options plus the freeform row when allowed. */
export function rowsOf(q: AskDialogQuestion): AskRow[] {
  const rows: AskRow[] = q.options.map((option) => ({
    kind: "option",
    option,
  }));
  if (q.allowFreeform) rows.push({ kind: "other" });
  return rows;
}

/** Initial cursor position: the recommended option when one is declared. */
export function initialCursor(q: AskDialogQuestion): number {
  const max = Math.max(0, q.options.length - 1);
  const rec = q.recommended;
  if (typeof rec === "number" && Number.isFinite(rec) && rec >= 0) {
    return Math.min(Math.floor(rec), max);
  }
  return 0;
}

/**
 * The pending answer of a question, derived from its toggles.
 *
 * Option picks win over a freeform answer — each commit clears the other,
 * so the two are never both set.  `undefined` while nothing is selected.
 */
export function pendingAnswer(
  q: AskDialogQuestion,
  state: { selected: Set<string>; custom?: string },
): AskResult | undefined {
  const picked = q.options
    .filter((o) => state.selected.has(o.label))
    .map((o) => o.label);
  if (picked.length > 0) {
    return { status: "answered", answer: picked, wasCustom: false };
  }
  if (state.custom !== undefined && state.custom.length > 0) {
    return { status: "answered", answer: [state.custom], wasCustom: true };
  }
  return undefined;
}

/**
 * Build the per-question results for a closing kind.
 *
 * Committed answers always survive.  A `cancel` declines every unanswered
 * question the user had been shown (`reached`) and aborts the unanswered
 * questions the form never surfaced; a `timeout` marks every unanswered
 * question as timed out; an `abort` reports them aborted; and a `submit`
 * declines the gaps — finishing the form without answering is the user's own
 * decision, which is the `declined` slot, not a system-side `unavailable`.
 *
 * @param committed - The committed slot per question (undefined = open).
 * @param reached - Indices of the question pages the user was shown.
 * @param closure - How the form closed.
 * @returns One `AskResult` per question.
 */
export function buildResults(
  committed: (AskResult | undefined)[],
  reached: ReadonlySet<number>,
  closure: AskDialogClosure,
): AskResult[] {
  return committed.map((result, i) => {
    if (result !== undefined) return result;
    if (closure === "submit" || (closure === "cancel" && reached.has(i))) {
      return { status: "declined" };
    }
    return {
      status: "unavailable",
      reason: closure === "timeout" ? "timeout" : "aborted",
    };
  });
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

/** Per-question dialog state. */
interface QuestionState {
  /** Committed slot (undefined until Enter confirms an answer). */
  committed?: AskResult;
  /** Pending multi-select labels (Space toggles, Enter commits). */
  selected: Set<string>;
  /** Pending freeform text (set by the Editor's submit). */
  custom?: string;
  /** Cursor index into the question's row list. */
  cursor: number;
  /** First visible body line (overflow scrolling). */
  scroll: number;
  /** True after PgUp/PgDn — stops the cursor from dragging the window. */
  manual: boolean;
  /** True while the embedded Editor owns the keyboard. */
  editing: boolean;
}

/**
 * Build the ask dialog.
 *
 * @param deps - Questions, the duck-typed TUI / theme, the `done` resolver,
 *   and the optional timeout (with its injectable timer surface).
 * @returns The pi component plus the external `abort()` handle.
 */
export function createAskDialog(deps: AskDialogDeps): AskDialog {
  const { questions, tui, theme, done } = deps;
  const timers = deps.timers ?? REAL_TIMERS;
  /** Multi-question forms get the chip strip and the Submit page. */
  const multi = questions.length > 1;
  /** Tab index of the Submit page (meaningful only when `multi`). */
  const submitTab = questions.length;
  const tabCount = multi ? questions.length + 1 : questions.length;

  const states: QuestionState[] = questions.map((q) => ({
    selected: new Set<string>(),
    cursor: initialCursor(q),
    scroll: 0,
    manual: false,
    editing: false,
  }));

  let active = 0;
  /**
   * The question pages the user has been shown.
   *
   * Free paging (Tab / arrows) means the active tab is not the only question
   * the user has seen, and Esc must record a refusal (`declined`) for every
   * unanswered one they had the chance to answer.  The first question is
   * shown at mount; the Submit page is not a question, so landing on it
   * marks nothing.
   */
  const reached = new Set<number>([0]);
  let closed = false;
  /** Panel height, measured once at the first render (see `ensureHeight`). */
  let panelRows: number | undefined;
  let cachedLines: string[] | undefined;

  /** The active question's state (the Submit page borrows the last one for
   * its freeform/editor state, which is always idle there). */
  function activeState(): QuestionState {
    return states[Math.min(active, questions.length - 1)];
  }

  function refresh(): void {
    cachedLines = undefined;
    tui.requestRender();
  }

  function isSubmitPage(): boolean {
    return multi && active === submitTab;
  }

  /** Move to a tab, recording a question page as seen. */
  function goTab(index: number): void {
    active = index;
    if (index < questions.length) reached.add(index);
  }

  /** The effective answer of a question (committed, else pending). */
  function answerOf(index: number): AskResult | undefined {
    const state = states[index];
    return state.committed ?? pendingAnswer(questions[index], state);
  }

  /** Questions with no answer yet (pending toggles count as answered). */
  function unansweredCount(): number {
    let missing = 0;
    for (let i = 0; i < questions.length; i++) {
      if (answerOf(i) === undefined) missing++;
    }
    return missing;
  }

  // --- freeform editor ----------------------------------------------------

  const editorTheme: EditorTheme = {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
  const editor = new Editor(tui as unknown as TUI, editorTheme);
  editor.onSubmit = (value) => {
    if (closed) return;
    const trimmed = value.trim();
    // An empty submit keeps the user in the editor — there is nothing to
    // commit, and dropping back to the list would silently lose the answer.
    if (trimmed.length === 0) return;
    const state = activeState();
    state.custom = trimmed;
    state.selected.clear();
    state.editing = false;
    editor.setText("");
    commitAndAdvance();
  };

  /** Leave freeform mode, discarding an unsubmitted draft. */
  function exitEditor(): void {
    const state = activeState();
    if (state.editing) {
      state.editing = false;
      editor.setText("");
    }
  }

  // --- countdown ----------------------------------------------------------

  const timeoutSeconds = deps.timeoutSeconds;
  let expireHandle: unknown;
  let tickHandle: unknown;
  let deadline = 0;
  let remaining = 0;

  function clock(): number {
    return (timers.now ?? Date.now)();
  }

  function startTimer(): void {
    if (timeoutSeconds === undefined || closed) return;
    remaining = Math.max(1, Math.floor(timeoutSeconds));
    deadline = clock() + remaining * 1000;
    expireHandle = timers.setTimeout(() => {
      finish("timeout");
    }, remaining * 1000);
    tickHandle = timers.setInterval(() => {
      // Deadline-based display: a slow render cannot drift the countdown.
      const left = Math.max(0, Math.ceil((deadline - clock()) / 1000));
      if (left !== remaining) {
        remaining = left;
        cachedLines = undefined;
      }
      tui.requestRender();
    }, 1000);
  }

  function stopTimer(): void {
    if (expireHandle !== undefined) timers.clearTimeout(expireHandle);
    if (tickHandle !== undefined) timers.clearInterval(tickHandle);
    expireHandle = undefined;
    tickHandle = undefined;
  }

  /** Any accepted keypress restarts the countdown from its full length. */
  function resetTimer(): void {
    if (timeoutSeconds === undefined || closed) return;
    stopTimer();
    startTimer();
  }

  /** The panel title: plain `Ask`, or `Ask (Ns)` while a countdown runs. */
  function titleText(): string {
    return timeoutSeconds === undefined ? "Ask" : `Ask (${remaining}s)`;
  }

  // --- closing ------------------------------------------------------------

  function finish(closure: AskDialogClosure): void {
    if (closed) return;
    // A final submit adopts every pending toggle, so editing a question and
    // submitting without re-pressing Enter still lands.
    if (closure === "submit") {
      for (let i = 0; i < questions.length; i++) {
        const pending = pendingAnswer(questions[i], states[i]);
        if (pending !== undefined) states[i].committed = pending;
      }
    }
    closed = true;
    stopTimer();
    cachedLines = undefined;
    done({
      results: buildResults(
        states.map((s) => s.committed),
        reached,
        closure,
      ),
      closure,
    });
  }

  /**
   * Commit the active question's pending answer and move on.
   *
   * A no-op while nothing is selected (on a multi-select question the
   * footer explains that Space toggles first).  A single-question form
   * closes; a multi-question form advances to the next question, then to
   * the Submit page.
   */
  function commitAndAdvance(): void {
    const index = Math.min(active, questions.length - 1);
    const pending = pendingAnswer(questions[index], states[index]);
    if (pending === undefined) return;
    states[index].committed = pending;
    states[index].editing = false;
    if (!multi) {
      finish("submit");
      return;
    }
    goTab(index + 1 < questions.length ? index + 1 : submitTab);
    refresh();
  }

  // --- input --------------------------------------------------------------

  function moveCursor(delta: number): void {
    const state = activeState();
    const rows = rowsOf(questions[Math.min(active, questions.length - 1)]);
    if (rows.length === 0) return;
    state.cursor = Math.max(0, Math.min(rows.length - 1, state.cursor + delta));
    state.manual = false;
    refresh();
  }

  function scrollPage(delta: number): void {
    const state = activeState();
    state.scroll += delta * bodyRows();
    state.manual = true;
    refresh();
  }

  /** Switch tabs (wrap-around); only multi-question forms bind Tab keys. */
  function handleTabKey(data: string): boolean {
    if (!multi) return false;
    const forward = matchesKey(data, Key.tab) || matchesKey(data, Key.right);
    const backward =
      matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left);
    if (!forward && !backward) return false;
    exitEditor();
    goTab((active + (forward ? 1 : -1) + tabCount) % tabCount);
    refresh();
    return true;
  }

  function handleInput(data: string): void {
    if (closed) return;
    resetTimer();
    const state = activeState();

    // While freeform input is open the Editor owns every key; Esc hands the
    // keyboard back to the option list (it does NOT cancel the question).
    if (state.editing) {
      if (matchesKey(data, Key.escape)) {
        exitEditor();
        refresh();
        return;
      }
      editor.handleInput(data);
      refresh();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      finish("cancel");
      return;
    }

    if (handleTabKey(data)) return;

    if (isSubmitPage()) {
      if (matchesKey(data, Key.enter)) finish("submit");
      else if (matchesKey(data, Key.up)) scrollPage(-1);
      else if (matchesKey(data, Key.down)) scrollPage(1);
      return;
    }

    if (matchesKey(data, Key.up)) {
      moveCursor(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      moveCursor(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      scrollPage(-1);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      scrollPage(1);
      return;
    }

    const question = questions[active];
    const rows = rowsOf(question);
    const row = rows[Math.min(state.cursor, rows.length - 1)];

    // Space toggles a candidate on multi-select questions only.
    if (question.multiple && matchesKey(data, Key.space)) {
      if (row && row.kind === "option") {
        if (state.selected.has(row.option.label)) {
          state.selected.delete(row.option.label);
        } else {
          state.selected.add(row.option.label);
          state.custom = undefined;
        }
        refresh();
      }
      return;
    }

    if (!matchesKey(data, Key.enter)) return;
    if (!row) return;
    if (row.kind === "other") {
      state.editing = true;
      editor.setText("");
      refresh();
      return;
    }
    if (question.multiple) {
      // Enter confirms the pending selection; it never toggles, so a
      // confirm cannot silently deselect the row under the cursor.
      commitAndAdvance();
      return;
    }
    state.selected.clear();
    state.custom = undefined;
    state.selected.add(row.option.label);
    commitAndAdvance();
  }

  // --- page content -------------------------------------------------------

  /** Render one question page: content lines plus each row's line span.
   *
   * `editing` is passed explicitly so the height measurement can reserve the
   * freeform block (blank + prompt + editor) even while the page is in list
   * mode — otherwise entering freeform would push the option list off a
   * small fixed-height panel. */
  function questionPage(
    index: number,
    inner: number,
    editing: boolean = states[index].editing,
  ): AskPageBody {
    const q = questions[index];
    const state = states[index];
    const rows = rowsOf(q);
    const lines: string[] = [];
    const spans: AskRowSpan[] = [];
    addWrapped(lines, theme.fg("text", q.question), inner);
    lines.push("");
    for (let i = 0; i < rows.length; i++) {
      const from = lines.length;
      const row = rows[i];
      const focused = i === state.cursor;
      const checked =
        row.kind === "option" && state.selected.has(row.option.label);
      const marker = q.multiple
        ? checked
          ? CHECK_ON
          : CHECK_OFF
        : checked
          ? RADIO_ON
          : RADIO_OFF;
      const caret = focused ? theme.fg("accent", ">") : " ";
      const label =
        row.kind === "option"
          ? row.option.label + (q.recommended === i ? RECOMMENDED_SUFFIX : "")
          : FREEFORM_LABEL + (editing ? " [edit]" : "");
      addPrefixed(
        lines,
        `${caret} ${marker} `,
        theme.fg(focused ? "accent" : checked ? "success" : "text", label),
        inner,
      );
      if (row.kind === "option" && row.option.description !== undefined) {
        addPrefixed(
          lines,
          "      ",
          theme.fg("muted", row.option.description),
          inner,
        );
      }
      spans.push({ from, to: lines.length - 1 });
    }
    if (editing) {
      lines.push("");
      addPrefixed(lines, " ", theme.fg("muted", "Your answer:"), inner);
      for (const line of editor.render(Math.max(1, inner - 2))) {
        lines.push(` ${line}`);
      }
    }
    return { lines, spans };
  }

  /** Render the Submit summary page (answers + the unanswered warning). */
  function submitPage(inner: number): AskPageBody {
    const lines: string[] = [];
    const heading = theme.bold
      ? theme.fg("toolTitle", theme.bold("Review"))
      : theme.fg("toolTitle", "Review");
    addWrapped(lines, heading, inner);
    lines.push("");
    for (let i = 0; i < questions.length; i++) {
      const answer = answerOf(i);
      const head = theme.fg("muted", `Q${i + 1}: `);
      let body: string;
      if (answer === undefined) {
        // Skipping is a refusal to answer, which is what a final submit
        // records for this row (see `buildResults`).
        body = theme.fg("warning", "declined");
      } else if (answer.status === "answered") {
        body = theme.fg(
          "text",
          `${answer.wasCustom ? "(wrote) " : ""}${toOneLine(answer.answer.join(", "))}`,
        );
      } else {
        body = theme.fg("dim", answer.status);
      }
      addPrefixed(lines, " ", `${head}${body}`, inner);
    }
    lines.push("");
    const missing = unansweredCount();
    addWrapped(
      lines,
      missing > 0
        ? theme.fg(
            "warning",
            `${missing} question(s) unanswered — Enter still submits.`,
          )
        : theme.fg("success", "All answered — press Enter to submit."),
      inner,
    );
    return { lines, spans: [] };
  }

  /** The chip strip: one chip per question plus the Submit chip. */
  function chipsLine(inner: number): string {
    const parts: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const answered = answerOf(i) !== undefined;
      const raw = ` Q${i + 1} ${answered ? "●" : "○"} `;
      const text = i === active ? `[${raw}]` : raw;
      if (i === active) parts.push(theme.fg("accent", text));
      else if (answered) parts.push(theme.fg("success", text));
      else parts.push(theme.fg("muted", text));
    }
    const missing = unansweredCount();
    const raw = ` Submit ${missing === 0 ? "✓" : "?"} `;
    const text = isSubmitPage() ? `[${raw}]` : raw;
    if (isSubmitPage()) parts.push(theme.fg("accent", text));
    else if (missing === 0) parts.push(theme.fg("success", text));
    else parts.push(theme.fg("warning", text));
    return fitColumns(parts.join(""), inner);
  }

  /** The footer hint line, switched by the active mode. */
  function footerLine(inner: number, clipped: string): string {
    const state = activeState();
    let hint: string;
    if (state.editing) {
      hint = "Enter submit · Esc back to the list";
    } else if (isSubmitPage()) {
      hint = "Tab/←→ switch question · Enter submit · Esc cancel";
    } else if (questions[active].multiple) {
      hint = "Space toggle · Enter confirm · Tab/←→ switch · Esc decline";
    } else {
      hint = "↑↓ move · Enter select · Tab switch · Esc decline";
    }
    return fitColumns(`${theme.fg("dim", hint)}${clipped}`, inner);
  }

  // --- box geometry -------------------------------------------------------

  /** Box rows that are never body: top border, chips, footer, bottom. */
  function chromeRows(): number {
    return multi ? 4 : 3;
  }

  /** The body height — fixed once the panel height was measured. */
  function bodyRows(): number {
    return Math.max(
      MIN_BODY_ROWS,
      (panelRows ?? MIN_PANEL_ROWS) - chromeRows(),
    );
  }

  function topBorder(width: number): string {
    const head = `╭─ ${titleText()} `;
    const rest = Math.max(0, width - visibleWidth(head) - 1);
    return theme.fg("border", `${head}${"─".repeat(rest)}╮`);
  }

  function bottomBorder(width: number): string {
    return theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  }

  function borderRow(content: string, width: number): string {
    const bar = theme.fg("border", "│");
    return `${bar} ${fitColumns(content, Math.max(0, width - 4))} ${bar}`;
  }

  /**
   * Measure the panel height ONCE (at the first render, the panel's spawn)
   * from the tallest page and clamp it to the terminal-height fraction.
   */
  function ensureHeight(width: number): void {
    if (panelRows !== undefined) return;
    const inner = Math.max(1, width - 4);
    let natural = 1;
    for (let i = 0; i < questions.length; i++) {
      // Reserve the freeform block for any question that can open it.
      const page = questionPage(i, inner, questions[i].allowFreeform);
      natural = Math.max(natural, page.lines.length);
    }
    if (multi) natural = Math.max(natural, submitPage(inner).lines.length);
    const termRows = tui.terminal?.rows ?? DEFAULT_TERM_ROWS;
    const cap = Math.max(
      MIN_PANEL_ROWS,
      Math.floor(termRows * MAX_HEIGHT_FRACTION),
    );
    panelRows = Math.max(
      chromeRows() + MIN_BODY_ROWS,
      Math.min(natural + chromeRows(), cap),
    );
  }

  /** Window the page body to the fixed panel, following the cursor. */
  function windowBody(body: AskPageBody): string[] {
    const rows = bodyRows();
    const state = activeState();
    if (body.lines.length <= rows) {
      state.scroll = 0;
      return [...body.lines];
    }
    // While freeform input is open its block sits at the END of the page, so
    // the fixed-height window is pinned to the bottom — otherwise typing
    // would happen off-screen.
    if (state.editing) {
      state.scroll = body.lines.length - rows;
      return body.lines.slice(state.scroll, state.scroll + rows);
    }
    const span = body.spans[state.cursor];
    if (!state.manual && span !== undefined) {
      if (span.from < state.scroll) state.scroll = span.from;
      else if (span.to > state.scroll + rows - 1) {
        state.scroll = span.to - rows + 1;
      }
    }
    state.scroll = Math.max(
      0,
      Math.min(state.scroll, body.lines.length - rows),
    );
    return body.lines.slice(state.scroll, state.scroll + rows);
  }

  /** The footer clip indicator (`↑` / `↓` / `↕`), empty when nothing hides. */
  function clipIndicator(body: AskPageBody): string {
    const rows = bodyRows();
    if (body.lines.length <= rows) return "";
    const state = activeState();
    const top = state.scroll > 0;
    const bottom = state.scroll + rows < body.lines.length;
    if (top && bottom) return " ↕";
    if (top) return " ↑";
    return " ↓";
  }

  function render(width: number): string[] {
    if (cachedLines !== undefined) return cachedLines;
    const w = Math.max(MIN_BOX_WIDTH, Math.floor(width));
    ensureHeight(w);
    const inner = Math.max(1, w - 4);
    const body: AskPageBody = isSubmitPage()
      ? submitPage(inner)
      : questionPage(active, inner);
    // The window is resolved first — the indicator reports where THIS
    // frame's window sits, not the previous frame's.
    const windowed = windowBody(body);
    const clipped = clipIndicator(body);
    const out: string[] = [topBorder(w)];
    if (multi) out.push(borderRow(chipsLine(inner), w));
    for (const line of windowed) out.push(borderRow(line, w));
    for (let i = windowed.length; i < bodyRows(); i++) {
      out.push(borderRow("", w));
    }
    out.push(borderRow(footerLine(inner, clipped), w));
    out.push(bottomBorder(w));
    cachedLines = out;
    return out;
  }

  startTimer();

  const component: AskDialogComponent = {
    render,
    handleInput,
    invalidate: () => {
      cachedLines = undefined;
      editor.invalidate();
    },
    dispose: () => {
      closed = true;
      stopTimer();
    },
    get focused() {
      return editor.focused;
    },
    set focused(value: boolean) {
      editor.focused = value;
    },
  };

  return {
    component,
    abort: () => finish("abort"),
  };
}
