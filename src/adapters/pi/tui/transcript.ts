/**
 * Pi transcript overlay — the fleet widget's run inspection surface.
 *
 * When the user presses enter on a selected run in the `zoo` fleet widget,
 * the pi entry point opens a full-screen read-only overlay that renders the
 * run's transcript.  The overlay is a pure projection over the run's data
 * stream (`src/core/subagent/run-log.ts`) it is handed: it walks the log's
 * current facts and subscribes once to `log.subscribe` for live updates —
 * this module never replays a session file and there is no event bus.
 *
 * Where that log comes from is the opener's business, and it is not always
 * an in-memory stream: the pi history scanner rebuilds runs after a restart
 * carrying lifecycle metadata only, so their logs are empty even though the
 * full transcript survives on disk in the sub-session file.  For such a run
 * the pi entry point hydrates the facts first (shared cache in
 * `src/adapters/pi/hydrate.ts`, the same one the inline card uses) and opens
 * this overlay on the rebuilt log — see `enterRun` in `src/pi.ts`.  A run
 * whose log is still empty because that load failed opens with the
 * `emptyNotice` line (`TRANSCRIPT_UNAVAILABLE_NOTICE`) instead of the plain
 * empty-transcript line, so the surface explains itself rather than lying.
 *
 * This module is the only pi-touching layer for that surface: it maps the
 * facts directly onto pi-tui components mounted into the official
 * `ScrollView` (pi's chat-area scroll component), mirroring how `card.ts`
 * owns the pi Component / theme mapping for the subagent card.
 *
 * Projection-free rendering: there is no intermediate line projection and
 * no physical-line slicing — every fact becomes one or more pi-tui
 * components rendered in full:
 *   - a `user_message` fact renders through pi's native
 *     `UserMessageComponent` (pi's own user-message box + markdown
 *     rendering) — this is how the delegation prompt the run was started
 *     with appears at the head of the transcript;
 *   - a `message_end` fact renders through pi's native
 *     `AssistantMessageComponent` with `hideThinkingBlock = false`, so text
 *     and `thinking` parts render in full (thinking dimmed via pi's
 *     official `thinkingText` color);
 *   - a `tool_start` fact mounts pi's native `ToolExecutionComponent` (the
 *     same component pi's interactive mode uses for the main session) in
 *     its pending form — the tool's own `renderCall` produces the exact
 *     native shell — so a call without its end fact stays visible as
 *     running;
 *   - the matching `tool_end` fact feeds that component its result
 *     (`updateResult`), producing the same folded/expanded view pi's own
 *     chat shows.  Pairing uses the host tool-call id when present;
 *     id-less facts pair by tool name in FIFO order.  A `tool_start` whose
 *     native component cannot be built (unknown tool, missing pi theme)
 *     falls back to the accent `→ <name>` line plus its JSON arguments as a
 *     fenced code block; a `tool_end` with no paired native start (or a
 *     fallback-rendered start) appends its result text through a
 *     `Text` component — never markdown, so bash / tool output is not
 *     mangled, and with its terminal control sequences stripped, so foreign
 *     output cannot restyle or drive the overlay.
 *
 * Streaming: the forming head of a run — its in-flight assistant message —
 * is NOT a fact; the log delivers it as transient partial content parts (see
 * `RunLog.setPartial`), text and thinking together.  While a partial exists
 * the overlay renders it as a trailing `AssistantMessageComponent` updated in
 * place per delta (pi's own streaming idiom, `updateContent(msg, true)`),
 * handing over the parts unchanged so the native component's own thinking
 * styling applies to a reasoning stream exactly as it does to the finalized
 * message.  Retirement is mechanical and needs no bookkeeping here: the log
 * delivers the empty-partial event immediately before the fact that
 * finalizes the message, on the same stream, so the live surface is replaced
 * by the completed component and the body never shows a message twice.  A
 * restored (hydrated) or historical log has no partial, so nothing streams;
 * the surface is simply never mounted.
 *
 * Scrolling is delegated to the official pi-tui `ScrollView`: the fact
 * components are mounted into one `ScrollView`, which holds the scroll
 * offset the windowing reads (the overlay owns where the window looks — one
 * viewport anchor, see `createTranscriptOverlay`).  Because pi
 * composites overlay components by calling `render(width)` directly —
 * bypassing the layout system whose clipping would window a `ScrollView`
 * child — this overlay windows the rendered body rows by `scrollTop`
 * itself, after syncing the `ScrollView`'s layout via `updateLayout`.  The
 * keyboard forwards `↑↓/jk` (line), `PageUp/PageDown` (page, matching pi's
 * `PAGE_SCROLL_OVERLAP` convention), and `Home/End` (start / end) to the
 * `ScrollView`; the SGR mouse wheel (raw wheel bytes pi forwards to the
 * focused overlay in fullscreen mode only) steps one line per notch;
 * `esc` / `q` call the `done` callback to close.
 *
 * Live updates: the overlay keeps exactly ONE subscription — `log.subscribe`
 * on the run's ordered data stream — and projects each fact onto components
 * appended to the body (a `tool_end` updates its paired component in place),
 * while each partial delivery drives or retires the streaming surface.  Never
 * a full rebuild.  An append that retires a partial changes the body twice in
 * its one dispatch, which shows nothing in between: pi renders only after the
 * synchronous dispatch returns.  The viewport is one
 * anchor — the tail, or a body line — so a mutation needs no
 * save/restore: a tail anchor follows the newest content as facts arrive and
 * as the partial grows, a line anchor keeps pointing at its line, clamped
 * into the scrollable range when the content shrinks under it.  The
 * subscription is dropped on close (`esc` / `q`) and via `dispose`.
 *
 * Layout contract:
 *   - The overlay covers the full terminal (row 0 / col 0, width and height
 *     100%): every screen row and every column is overlay content, so the
 *     base layer (chat + widget) never shows through — its diff repaints
 *     cannot flicker under the overlay.  The viewport height is derived from
 *     the terminal row count (`tui.terminal.rows`) — it is a *viewport
 *     budget*, never a content cap: the window scrolls, so every transcript
 *     row stays reachable.
 *   - Every output line is padded to the full terminal width, so no base
 *     content bleeds through at the line ends (the compositor only
 *     overwrites the columns an overlay line declares).
 *   - The title line's agent name is pre-colorized by the pi entry point
 *     (`runTitle` applies the same `[agent.<name>].color` source as the
 *     widget's `colorizeAgent`); the overlay's width handling
 *     (`truncateToWidth` / `visibleWidth`) is ANSI-aware and never strips
 *     the sequences, so the wrapped name renders verbatim.  Unconfigured →
 *     the plain name.
 *   - `ctrl+o` (pi's `app.tools.expand` key) toggles the expanded state of
 *     every mounted tool component: collapsed = pi's default folded style
 *     (bash shows a preview + fold hint), expanded = the full output.
 *
 * Rendering strategy: facts render through pi's own
 * `AssistantMessageComponent` / `ToolExecutionComponent` imported from
 * `@earendil-works/pi-coding-agent` (added as a devDependency; pi's
 * extension loader aliases that specifier to the bundled entry at runtime,
 * so the components are the exact ones pi's interactive mode uses).  They
 * are constructed statically from the facts — `render(width)` never
 * executes a tool.  The components render through the coding-agent
 * module-level `theme` singleton (`initTheme`), which pi has already
 * initialized by the time an overlay can open; in tests the theme is
 * initialized from the package's built-in dark theme.
 *
 * An empty fact log renders a one-line "(empty transcript)" explanation
 * instead of crashing; the opener can replace that line with its own
 * `emptyNotice` (e.g. the unavailable-transcript notice after a failed
 * hydration).
 *
 * @module
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  isKeyRelease,
  Markdown,
  matchesKey,
  ScrollView,
  stripTerminalSequences,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type {
  LogEvent,
  MessageEndFact,
  MessagePart,
  RunFact,
  RunLog,
  TextPart,
  ToolEndFact,
  ToolStartFact,
  UserMessageFact,
} from "../../../core/subagent/run-log.js";
import type { MarkdownThemeSource } from "./theme.js";

/** Fallback viewport height when the terminal height is unknown. */
export const TRANSCRIPT_VIEWPORT_FALLBACK = 12;

/** Minimum viewport height so a tiny terminal still shows content. */
const MIN_VIEWPORT_ROWS = 3;

/**
 * Dim notice shown when an empty log cannot be restored from disk.
 *
 * The pi entry point hands this as `emptyNotice` when a run's transcript
 * hydration failed (its persisted sub-session is gone or unparseable), so
 * the overlay states the reason instead of the bare "(empty transcript)"
 * line, which would read as "this run produced nothing".
 */
export const TRANSCRIPT_UNAVAILABLE_NOTICE =
  "(transcript unavailable — session file unreadable)";

/**
 * Dim notice shown when a finished run has neither facts nor a session file.
 *
 * The pi entry point hands this as `emptyNotice` when the hydration gate has
 * nothing to restore from: the run recorded no fact on its log AND reports no
 * sub-session path, which is what a run that failed or was aborted before its
 * prompt ever reached the host looks like.  The bare "(empty transcript)"
 * line would blame the run's output instead of the missing record.
 */
export const TRANSCRIPT_NOT_RECORDED_NOTICE =
  "(no transcript was recorded for this run)";

/**
 * Fixed chrome rows: the title line plus the bottom hint line.
 *
 * The full-screen overlay renders exactly `terminal.rows` lines, so the
 * scrollable body window is the terminal height minus this chrome.
 */
const FIXED_OVERLAY_ROWS = 2;

/** The border / title theme color. */
const BORDER_COLOR = "border";
/** The dim hint color. */
const DIM_COLOR = "dim";
/** Scroll-overlap on a page step (mirrors pi's `PAGE_SCROLL_OVERLAP`). */
const PAGE_SCROLL_OVERLAP = 4;

/**
 * SGR mouse report introducer (`ESC [ < button ; col ; row`, `M` press /
 * `m` release), emitted under pi's `?1006h` mouse mode.  The ESC byte is
 * matched as a plain string so no control character enters a regex literal
 * (Biome disallows that); the remainder matches the control-free body.
 */
const SGR_MOUSE_BODY = /^\[<(\d+);(\d+);(\d+)[Mm]$/;

/**
 * Decode an SGR mouse-wheel report into a ScrollView line step.
 *
 * Wheel bytes only arrive in pi's fullscreen TUI mode: pi enables SGR
 * mouse tracking (`?1006h`) there and forwards the raw report to the
 * focused overlay's `handleInput`.  In pi's regular mode the terminal
 * scrolls its own native scrollback and no wheel bytes reach pi at all.
 *
 * A wheel report has bit 64 set; its low two bits carry the direction
 * (0 = up, 1 = down).  Button presses/drags (bit 64 clear) and horizontal
 * wheels (direction 2/3) decode to undefined and are ignored.  The
 * decoding mirrors pi's own wheel parser, so one notch steps exactly one
 * line, matching pi's chat-viewport granularity.
 *
 * @param data - The raw input bytes received by the overlay.
 * @returns `-1` for wheel up, `1` for wheel down, undefined otherwise.
 */
function wheelStepFromSgr(data: string): number | undefined {
  // CSI introducer first: ESC as a string escape, then the control-free body.
  const csi = `${String.fromCharCode(27)}[`;
  if (!data.startsWith(csi)) return undefined;
  const sgr = SGR_MOUSE_BODY.exec(data.slice(1));
  if (sgr === null) return undefined;
  const button = Number.parseInt(sgr[1], 10);
  if ((button & 64) === 0) return undefined;
  const direction = button & 3;
  if (direction !== 0 && direction !== 1) return undefined;
  return direction === 0 ? -1 : 1;
}

/**
 * Derive the transcript viewport height from the terminal row count.
 *
 * The overlay covers the full terminal height, so the body budget is the
 * terminal row count minus the fixed chrome rows (title line + hint line).
 * A floor keeps a tiny terminal usable; an unknown row count falls back to
 * `TRANSCRIPT_VIEWPORT_FALLBACK`.  This is a viewport budget — the window
 * scrolls, so nothing is unreachable.
 *
 * @param rows - The terminal row count, or undefined when unknown.
 * @returns The viewport height in body rows.
 */
export function computeViewportRows(rows: number | undefined): number {
  if (rows === undefined || rows <= 0) return TRANSCRIPT_VIEWPORT_FALLBACK;
  return Math.max(MIN_VIEWPORT_ROWS, rows - FIXED_OVERLAY_ROWS);
}

/**
 * The `scrollTop` that puts the last body line at the bottom of the window.
 *
 * Content shorter than the viewport cannot scroll, so the tail position is
 * then 0 (the single view shows the whole body and counts as "at the end").
 *
 * @param bodyLines - The rendered body line count.
 * @param viewportRows - The visible body rows.
 * @returns The tail scroll offset (>= 0).
 */
function tailScrollTop(bodyLines: number, viewportRows: number): number {
  return Math.max(0, bodyLines - viewportRows);
}

/**
 * Where the window is looking — the overlay's only viewport state.
 *
 * - `tail` — glued to the last body line (the chat-follow intent): the newest
 *   content stays on screen as facts append and as the stream grows.
 * - `line` — glued to body line `lineIndex`, the rendered row of the body at
 *   the width of the last measure: the view keeps showing that line while
 *   content is appended above or below it.
 *
 * The scroll offset is not state — it is derived from an anchor plus the
 * measured content height (see `resolveAnchor`) and only ever written from
 * it, so the two can never disagree.  A body line is the stable unit the view
 * holds: the window scrolls in whole rendered rows, so a within-line offset
 * would be a second encoding of the same position and is deliberately not
 * tracked.  Line identity holds within a width (transcript rows are appended
 * at the tail or rewritten in place); a re-wrap at a new width moves rows, so
 * an anchor survives a resize as the row it pointed at, re-clamped into the
 * scrollable range by the next measure.
 */
type ViewportAnchor = { kind: "tail" } | { kind: "line"; lineIndex: number };

/** The anchor that follows the end of the body (the open state). */
const TAIL_ANCHOR: ViewportAnchor = { kind: "tail" };

/**
 * The top row an anchor resolves to for a measured body.
 *
 * A tail anchor is the tail offset; a line anchor is its line, clamped into
 * the scrollable range.  The clamp is geometry only — it never re-interprets
 * a line anchor as a follow, which is what keeps a shrinking body from
 * silently starting to tail.
 *
 * @param anchor - The current viewport anchor.
 * @param bodyLines - The rendered body line count.
 * @param viewportRows - The visible body rows.
 * @returns The `scrollTop` the anchor means (>= 0, <= the tail offset).
 */
function resolveAnchor(
  anchor: ViewportAnchor,
  bodyLines: number,
  viewportRows: number,
): number {
  const tail = tailScrollTop(bodyLines, viewportRows);
  if (anchor.kind === "tail") return tail;
  return Math.min(tail, Math.max(0, anchor.lineIndex));
}

/**
 * The anchor for a desired top row, under the chat convention.
 *
 * A row at or past the end of the scrollable range is the tail anchor (that
 * is how a step back down re-engages the follow); any earlier row pins its
 * line.  Only an explicit movement goes through here — a content change
 * never re-anchors, so the tail re-engagement is always the user's doing.
 *
 * @param row - The requested top row (may be out of range; it is clamped).
 * @param bodyLines - The rendered body line count.
 * @param viewportRows - The visible body rows.
 * @returns The anchor that means that row.
 */
function anchorAtRow(
  row: number,
  bodyLines: number,
  viewportRows: number,
): ViewportAnchor {
  if (row >= tailScrollTop(bodyLines, viewportRows)) return TAIL_ANCHOR;
  return { kind: "line", lineIndex: Math.max(0, row) };
}

/** Structural subset of pi's `TUI` the overlay uses. */
export interface TranscriptTuiLike {
  /** Request a re-render (pi drives the overlay render). */
  requestRender?(): void;
  /** The live terminal (read for its row count). */
  terminal?: { rows?: number };
}

/** Structural subset of pi's `Theme` the overlay colors chrome lines with. */
export type TranscriptThemeLike = MarkdownThemeSource;

/** The deps the overlay component factory needs. */
export interface TranscriptOverlayDeps {
  /** The overlay title line (e.g. `beaver · <label>`). */
  title: string;
  /**
   * The inspected run's data stream.  Its current facts form the initial
   * projection; later deliveries — appended facts and the streaming partial
   * alike — arrive through the single subscription this overlay takes (a
   * terminal run's log simply never delivers again).
   */
  log: RunLog;
  /**
   * Replacement for the "(empty transcript)" line while the log has no facts
   * (e.g. `TRANSCRIPT_UNAVAILABLE_NOTICE` after a failed hydration).  Absent
   * → the default line.  The line is clipped to the terminal width, never
   * wrapped, so a notice has to stay short.
   */
  emptyNotice?: string;
  /**
   * Optional colorizer for the inspected run's agent.
   *
   * The pi entry point builds it from the run's `[agent.<name>].color` (the
   * same source as the widget's `colorizeAgent`), so the overlay title line
   * reads as the run's agent color.  Absent (no configured color, or a
   * test / host without the wiring) → the fixed `BORDER_COLOR` default is
   * used.
   */
  borderColorize?: (text: string) => string;
  /**
   * The working directory the sub-session ran in.  Feeds the native tool
   * renderers' render context (e.g. `read`'s compact call classification).
   * Absent → empty (the tool renderers fall back to their non-cwd formats).
   */
  cwd?: string;
  /** The live pi TUI. */
  tui: TranscriptTuiLike;
  /** The live pi theme. */
  theme: TranscriptThemeLike;
  /** Close the overlay (pi's `ui.custom` done callback). */
  done(result: undefined): void;
}

/**
 * Join the text of a tool result's content parts.
 *
 * The RunLog stores tool results as text parts only; the joined text feeds
 * the verbatim fallback rendering.
 *
 * @param parts - The result content parts.
 * @returns The joined text (empty when there is none).
 */
function resultText(parts: readonly TextPart[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part.text === "string") texts.push(part.text);
  }
  return texts.join("");
}

/** The tab and line-feed bytes, the only control bytes kept as whitespace. */
const TAB = 0x09;
/** The line-feed byte. */
const LF = 0x0a;

/**
 * Strip the terminal control bytes a foreign string may carry.
 *
 * The fallback tool-result path renders text the plugin never produced — a
 * custom tool can return anything, including ANSI / OSC escape sequences and
 * raw C0 / C1 control bytes.  Those would reach the terminal untouched
 * through `Text` and let tool output restyle the overlay, move the cursor, or
 * rewrite the line it is printed on.  The card documents a no-ANSI contract
 * for everything it renders, so this path honors the same one: escape
 * sequences go through pi's own `stripTerminalSequences`, and the remaining
 * non-printing bytes (C0 except tab / line feed, DEL, and C1) are dropped
 * here.  The scan is by code point rather than regex because Biome forbids
 * control characters in regex literals.
 *
 * @param text - The untrusted text (may contain escape / control sequences).
 * @returns The same text with its visible characters preserved and its
 *   control bytes removed; a plain string is returned unchanged.
 */
export function stripControlSequences(text: string): string {
  const stripped = stripTerminalSequences(text);
  let out = "";
  for (const char of stripped) {
    const code = char.codePointAt(0) ?? 0;
    if (code === TAB || code === LF) {
      out += char;
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // Non-printing: drop it.
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Build pi's native tool-execution component (pending form, no result).
 *
 * The component renders the tool's own `renderCall` (through the built-in
 * tool definitions) — the exact shell pi's interactive mode shows while a
 * tool executes in the main session.  Construction is static (no tool
 * execution); `render(width)` only reflects state.  The component needs
 * pi's module-level theme singleton (`initTheme`), which pi initializes at
 * startup; construction is guarded so an uninitialized theme (e.g. a host
 * without pi wiring) falls back instead of crashing the overlay.  Returns
 * `undefined` on failure.
 *
 * @param callId - The pairing id (the fact's tool-call id, or a synthetic
 *   stand-in for id-less facts).
 * @param name - The tool name.
 * @param args - The tool call arguments.
 * @param tui - The overlay's TUI surface (for the component's redraw hook).
 * @param cwd - The working directory (render context).
 * @returns The native component, or `undefined` when it cannot be built.
 */
function buildNativeToolComponent(
  callId: string,
  name: string,
  args: unknown,
  tui: TranscriptTuiLike,
  cwd: string,
): ToolExecutionComponent | undefined {
  try {
    const component = new ToolExecutionComponent(
      name,
      callId,
      args,
      // History rendering is read-only: no live images.
      { showImages: false },
      undefined,
      tui as unknown as TUI,
      cwd,
    );
    // pi keeps a private generic text display for tools WITHOUT a renderer
    // definition; the overlay's documented form for such a tool is the
    // structured fallback (arrow line + full JSON args).  Probe pi's own
    // definition check (private in the typing, present at runtime) and
    // decline the component when it reports no definition.
    const defined = (
      component as unknown as { hasRendererDefinition?(): boolean }
    ).hasRendererDefinition?.();
    if (defined === false) return undefined;
    return component;
  } catch {
    // Unknown tool / uninitialized pi theme → the caller falls back to the
    // structured rendering.
    return undefined;
  }
}

/**
 * Build the fallback components for a tool call without a native renderer.
 *
 * Renders the accent `→ <name>` line plus the complete arguments as a JSON
 * fenced code block (through `Markdown`), so every parameter stays visible.
 *
 * @param name - The tool name.
 * @param args - The tool call arguments (may be `undefined`).
 * @returns The fallback components.
 */
function fallbackToolCallComponents(name: string, args: unknown): Component[] {
  const out: Component[] = [new Text(`→ ${name}`, 0, 0)];
  if (args !== undefined) {
    const json = JSON.stringify(args, null, 2);
    if (json !== undefined && json.length > 0) {
      out.push(
        new Markdown(`\`\`\`json\n${json}\n\`\`\``, 0, 0, getMarkdownTheme()),
      );
    }
  }
  return out;
}

/**
 * Build the streaming assistant message for a log partial.
 *
 * The log holds a partial as content parts (host-neutral text + thinking),
 * so the live surface is built as an assistant message carrying exactly
 * those parts — the same shape pi itself feeds
 * `AssistantMessageComponent.updateContent` while a model streams, and the
 * same projection `assistantComponents` gives the finalized fact.  That is
 * what makes a reasoning stream read like one: the native component applies
 * its own thinking styling (dimmed, italic, via pi's `thinkingText` color)
 * to the thinking parts, so the streaming surface needs no styling logic of
 * its own.
 *
 * @param parts - The accumulated content parts of the in-flight message.
 * @returns The partial message payload for the native component.
 */
function streamingMessage(parts: readonly MessagePart[]): AssistantMessage {
  return {
    role: "assistant",
    content: [...parts],
  } as unknown as AssistantMessage;
}

/**
 * Build the native component for a completed assistant-message fact.
 *
 * The official component renders the text / thinking blocks (thinking in
 * full, dimmed via pi's `thinkingText` color) — exactly pi's native
 * assistant message.  A RunLog fact is by definition complete, so no
 * streaming flag and no stopReason notices apply.
 *
 * @param fact - The message-end fact.
 * @returns The assistant message component.
 */
function assistantComponents(fact: MessageEndFact): Component[] {
  const message = {
    role: "assistant",
    content: fact.content,
  } as unknown as AssistantMessage;
  return [new AssistantMessageComponent(message, false)];
}

/**
 * Build the native component for a user-message fact.
 *
 * The fact carries the instruction the run was given (the delegation prompt,
 * or a later steered input).  pi's official component renders it in its own
 * user-message box, so the transcript opens with what the subagent was asked
 * to do — the same surface pi's main chat shows for the same message.
 * Blank text renders nothing (an empty box would read as a bug).
 *
 * @param fact - The user-message fact.
 * @returns The component list (empty when there is nothing to show).
 */
function userComponents(fact: UserMessageFact): Component[] {
  if (fact.text.trim().length === 0) return [];
  return [new UserMessageComponent(fact.text)];
}

/**
 * Build the transcript overlay component from a run's fact log.
 *
 * The component renders the full terminal surface: a title line, the
 * scrolling transcript window, and a bottom hint line (`↑↓/jk scroll ·
 * esc/q close`).  Every row spans the full terminal width (padded to the
 * end), so the base layer never shows through.
 *
 * The body is a component tree of the projected fact components mounted
 * into the official pi-tui `ScrollView`, which holds the scroll offset the
 * windowing reads.  Because pi composites overlay components via
 * `render(width)` directly (no layout-system clipping for overlays), this
 * component windows the `ScrollView`'s full rendered body rows by
 * `scrollTop` each render, syncing the `ScrollView`'s layout through
 * `updateLayout` first.  `scrollTop` is the anchor's derived value: it is
 * written from the anchor, never read back as state.
 *
 * `↑↓` / `jk` scroll by one line, `PageUp/PageDown` by a page (viewport
 * minus `PAGE_SCROLL_OVERLAP`, mirroring pi's transcript), and `Home/End`
 * jump to the start / end — every one of them an anchor update (see
 * `stepAnchorBy` / `reanchor`), which commits the derived offset.  `esc` and
 * `q` close via the `done` callback.
 *
 * Viewport anchor: the window's position is a single state variable, an
 * anchor into the body — the tail, or a body line — and it starts at the
 * tail, so the overlay opens showing the most recent content (the same view
 * as pressing `End`), for live runs and restored ones alike.  The scroll
 * offset is derived from that anchor plus the content height, and because
 * the height is only known once the body has rendered at a width the
 * derivation runs in `render` (and on the keyboard / append paths through
 * `commitAnchor`, which measures the body and syncs the `ScrollView`
 * layout).  A scroll step moves the anchor: one that leaves the tail pins
 * the line it lands on, one that reaches the tail hands the view back to the
 * tail anchor (`End` anchors to the tail, `Home` to the first line).
 *
 * Live updates: the overlay takes ONE subscription — `deps.log.subscribe` on
 * the run's ordered data stream — and projects each appended fact onto
 * components added to the body tail (a `tool_end` updates its paired
 * component in place), while each partial delivery drives or retires the
 * streaming surface — never a full rebuild.  Scroll
 * semantics follow the familiar chat convention with no bookkeeping around a
 * mutation: a tail anchor keeps following (the new tail becomes visible), a
 * line anchor keeps pointing at its line (clamped into the scrollable range
 * when an in-place change shrinks the body under it).  The shared `ctrl+o`
 * expansion is carried across appends.  The subscription is dropped on
 * close (`esc` / `q`) and via `dispose`.
 *
 * @param deps - The overlay deps (title, run data stream, theme, done).
 * @returns The overlay component (with the mounted `ScrollView` exposed as
 *   `scrollView` for tests and host wiring).
 */
export function createTranscriptOverlay(
  deps: TranscriptOverlayDeps,
): Component & { scrollView: ScrollView; dispose(): void } {
  const { theme, tui, done } = deps;

  // The working directory feeds the native tool renderers' render context.
  // Absent → empty string (the renderers fall back to their non-cwd forms).
  const cwd = deps.cwd ?? "";
  // The shared `ctrl+o` tool expansion state (collapsed = pi's default
  // folded style, expanded = the full output).  The ToolExecutionComponent
  // keeps `expanded` private, so the overlay tracks the toggle itself and
  // applies it to every freshly built tool component (initial projection
  // and live appends alike).
  let toolsExpanded = false;
  // The last render width — the measurement paths use it so the body-line
  // counts they compare against match the ScrollView's width.
  let lastWidth = 80;
  // The viewport state — one anchor, nothing else (see `ViewportAnchor`).  It
  // starts at the tail so the overlay opens at the bottom — the recent end of
  // the run — and stays tail-anchored while live facts append, until a scroll
  // step moves the view off the tail.  `ScrollView.scrollTop` is not state
  // beside it: it is the anchor's derived value, rewritten from here.
  let anchor: ViewportAnchor = TAIL_ANCHOR;
  // The tool components mounted from `tool_start` facts and still awaiting
  // their `tool_end`, keyed by the pairing key (the fact's tool-call id
  // when present, else a synthetic id).  A start without its end renders
  // as running — the same view pi's own chat keeps for an unfinished call.
  const pendingTools = new Map<string, ToolExecutionComponent>();
  // Keys whose `tool_start` rendered through the structured fallback (no
  // native component to feed the result to); their `tool_end` appends the
  // result text verbatim below the fallback block.
  const fallbackTools = new Set<string>();
  // FIFO queues of pending synthetic keys per tool name, pairing id-less
  // facts (pi always reports call ids; the queues are the defensive path).
  const anonymousPending = new Map<string, string[]>();
  let anonymousSeq = 0;
  /**
   * Unsubscribe from the run's data stream (idempotent; called on close and
   * by `dispose`).
   */
  let unsubscribe: (() => void) | undefined;
  // The live streaming surface: the trailing assistant component showing the
  // in-flight message, kept in place per streamed delta and replaced by the
  // finalized fact component when the message closes.  Undefined while
  // nothing streams.
  let streamingComponent: AssistantMessageComponent | undefined;

  // The transcript body: every projected fact becomes one or more pi-tui
  // components, mounted into the official ScrollView (the same component
  // pi's chat area scrolls with).  The ScrollView owns the scroll state;
  // this overlay windows the rendered rows by scrollTop (overlays bypass
  // pi's layout-system clipping).
  const body = new Container();

  /** Mount components at the body tail. */
  const addAll = (components: readonly Component[]): void => {
    for (const component of components) body.addChild(component);
  };

  /**
   * Pair a `tool_end` fact with its pending `tool_start` key.
   *
   * An id-carrying end pairs by id; an id-less end pops the oldest pending
   * id-less start of the same tool name (FIFO).  Returns `undefined` when
   * nothing pairs (the end then renders its result as an orphan text).
   *
   * ASSUMPTION: call ids are always present in practice — pi reports a
   * `toolCallId` on both tool events, so the id-carrying branch is the only
   * one real transcripts take.  The FIFO fallback exists purely for
   * anomalous id-less input (foreign/legacy fact logs): without an id there
   * is no correct pairing for concurrent same-name calls, and oldest-first
   * is the best effort available (a same-name pair started out of order can
   * cross-pair, which no key derivation can fix).
   */
  const pairToolEnd = (fact: {
    toolCallId?: string;
    toolName: string;
  }): string | undefined => {
    if (fact.toolCallId !== undefined) return fact.toolCallId;
    const queue = anonymousPending.get(fact.toolName);
    if (queue === undefined || queue.length === 0) return undefined;
    const key = queue.shift() as string;
    if (queue.length === 0) anonymousPending.delete(fact.toolName);
    return key;
  };

  /** Record a pending id-less start key under its tool name. */
  const enqueueAnonymous = (toolName: string, key: string): void => {
    const queue = anonymousPending.get(toolName);
    if (queue === undefined) anonymousPending.set(toolName, [key]);
    else queue.push(key);
  };

  /** Project a `tool_start` fact onto the body (pending native or fallback). */
  const projectToolStart = (fact: ToolStartFact): void => {
    const key = fact.toolCallId ?? `tool-${anonymousSeq++}`;
    // A duplicated start for an already-mounted key is ignored (the maps
    // are the single source for the pairing).
    if (pendingTools.has(key) || fallbackTools.has(key)) return;
    if (fact.toolCallId === undefined) enqueueAnonymous(fact.toolName, key);
    const native = buildNativeToolComponent(
      key,
      fact.toolName,
      fact.args,
      tui,
      cwd,
    );
    if (native !== undefined) {
      native.setExpanded(toolsExpanded);
      pendingTools.set(key, native);
      addAll([native]);
      return;
    }
    // Unknown tool / missing pi theme → the structured fallback keeps the
    // arguments visible; the end fact appends its result text below.
    fallbackTools.add(key);
    addAll(fallbackToolCallComponents(fact.toolName, fact.args));
  };

  /** Project a `tool_end` fact: update the paired component or append text. */
  const projectToolEnd = (fact: ToolEndFact): void => {
    const key = pairToolEnd(fact);
    const native = key === undefined ? undefined : pendingTools.get(key);
    if (key !== undefined && native !== undefined) {
      pendingTools.delete(key);
      try {
        native.updateResult(
          { content: [...fact.content], isError: fact.isError },
          false,
        );
      } catch {
        // A throwing renderer must never break the projection; the
        // component keeps showing its last state.
      }
      return;
    }
    if (key !== undefined) fallbackTools.delete(key);
    // Orphan end (no start observed) or a fallback-rendered start: the
    // result text appends as plain text — never markdown, so tool output is
    // not mangled, and never raw, so a foreign string cannot drive the
    // terminal (see `stripControlSequences`).
    const text = stripControlSequences(resultText(fact.content));
    if (text.trim().length === 0) return;
    addAll([new Text(text, 0, 0)]);
  };

  /**
   * Project one fact onto the body tree (pure mutation, no bookkeeping).
   *
   * The single mapping every path uses — the initial fill over the log's
   * existing facts and every live append — so the two can never diverge.
   */
  const projectFact = (fact: RunFact): void => {
    if (fact.type === "user_message") addAll(userComponents(fact));
    else if (fact.type === "message_end") addAll(assistantComponents(fact));
    else if (fact.type === "tool_start") projectToolStart(fact);
    else projectToolEnd(fact);
  };

  // The initial projection: walk the log's facts in order.  The view opens
  // anchored to the tail (see `anchor`); the first render turns that intent
  // into a scroll offset once the body has a measurable height.
  for (const fact of deps.log.facts()) projectFact(fact);

  /**
   * Show the transient partial on the streaming surface (no bookkeeping).
   *
   * Mounts a fresh trailing assistant component the first time a partial is
   * seen (the overlay may open mid-stream, or subscribe after the run's
   * first delta) and updates the mounted one in place afterwards, so a
   * growing transcript never rebuilds the earlier messages.  The partial's
   * content parts are handed over untouched, so text and thinking stream
   * with the same rendering the finalized fact gets.
   */
  const renderPartial = (parts: readonly MessagePart[]): void => {
    if (streamingComponent === undefined) {
      const component = new AssistantMessageComponent(undefined, false);
      streamingComponent = component;
      body.addChild(component);
      component.updateContent(streamingMessage(parts), true);
      return;
    }
    streamingComponent.updateContent(streamingMessage(parts), true);
  };

  /**
   * Retire the streaming surface (body mutation only; no scroll bookkeeping).
   *
   * Driven by the empty-partial delivery that precedes the fact which
   * finalized the message, so the completed component takes the tail slot
   * the streaming one vacates.
   */
  const dropStreaming = (): void => {
    if (streamingComponent === undefined) return;
    const component = streamingComponent;
    streamingComponent = undefined;
    body.removeChild(component);
  };

  // A log opened mid-stream already carries its partial: mount it after the
  // existing facts so the tail reads as the growing message.  A restored or
  // historical log has none, and nothing mounts.
  const initialPartial = deps.log.partial();
  if (initialPartial.length > 0) renderPartial(initialPartial);

  const scrollView = new ScrollView(body, {
    overscroll: "contain",
    scrollbar: "hidden",
  });

  /** Re-render after a scroll / close / append. */
  const refresh = (): void => {
    tui.requestRender?.();
  };

  /** The rendered body line count at the given width. */
  const bodyLines = (width: number): number =>
    body.children.reduce((sum, child) => {
      return sum + child.render(width).length;
    }, 0);

  /** The body rows one frame shows (the viewport budget). */
  const viewportBudget = (): number => computeViewportRows(tui.terminal?.rows);

  /**
   * Commit the anchor: sync the `ScrollView` layout to a measured height and
   * write the offset the anchor derives.
   *
   * The only writer of the scroll offset.  The `ScrollView` learns its content
   * height from `render`, which overlays bypass, so the measured row count is
   * handed in (at the last render width) and the layout is synced to it before
   * the derived offset is written — so a movement outside of `render` takes
   * effect on the frame the host draws, and a host reading `scrollTop` sees
   * the anchor's value, never a position of its own.
   */
  const commitAnchor = (lines: number): void => {
    const rows = viewportBudget();
    scrollView.updateLayout(lines, rows, refresh);
    scrollView.scrollTo(resolveAnchor(anchor, lines, rows));
  };

  /**
   * Adopt an anchor and commit the offset it derives (the keys, the landing
   * point of a step).
   *
   * @param next - The anchor the window moves to.
   * @param lines - The body row count measured at the last render width.
   */
  const reanchor = (next: ViewportAnchor, lines: number): void => {
    anchor = next;
    commitAnchor(lines);
    refresh();
  };

  /**
   * Move the window by `delta` rows and re-anchor it where it lands.
   *
   * The step updates the anchor rather than nudging a scroll offset: the row
   * the view lands on becomes a line anchor, and a row at the end of the body
   * becomes the tail anchor again — the chat convention (a step off the tail
   * unpins, a step onto it re-pins).  The landing row is decided against the
   * measured content height, so the body is measured at the last render width.
   *
   * @param delta - The rows to move (negative scrolls toward the head).
   */
  const stepAnchorBy = (delta: number): void => {
    const rows = viewportBudget();
    const lines = bodyLines(lastWidth);
    reanchor(
      anchorAtRow(resolveAnchor(anchor, lines, rows) + delta, lines, rows),
      lines,
    );
  };

  /**
   * Move the window to an absolute row and anchor it there (the `Home` key).
   *
   * @param row - The requested top row (clamped; a row at the end re-pins).
   */
  const stepAnchorToRow = (row: number): void => {
    const lines = bodyLines(lastWidth);
    reanchor(anchorAtRow(row, lines, viewportBudget()), lines);
  };

  /** The rows a page step moves (the viewport minus pi's overlap). */
  const pageStep = (): number =>
    Math.max(1, viewportBudget() - PAGE_SCROLL_OVERLAP);

  /**
   * Apply a body change and commit the anchor.
   *
   * The anchor survives the change by itself, so there is nothing to save and
   * restore: a tail anchor re-points at the new tail (the newest content stays
   * on screen as facts append or as the stream grows), and a line anchor keeps
   * pointing at its line while content is appended above or below it.  An
   * in-place change that shrinks the body clamps the view into the scrollable
   * range, and — unlike a pin re-derived from geometry — the clamped view does
   * not start following.
   *
   * An append that retires a partial changes the body twice in its one
   * dispatch (the retirement, then the fact), and that is safe: pi renders only
   * after the synchronous dispatch returns, so the half-changed body is never
   * displayed, and each commit measures the body as it stands then.
   *
   * @param mutate - The body change (component append / in-place update).
   */
  const mutateBody = (mutate: () => void): void => {
    mutate();
    commitAnchor(bodyLines(lastWidth));
    refresh();
  };

  /**
   * Project one stream event onto the body.
   *
   * The single mapping every live update goes through, driven by the one
   * subscription the overlay keeps: facts and the forming head arrive on the
   * same ordered stream, so the overlay never reconstructs which append a
   * partial belonged to and never retires a streaming surface from a second
   * callback.
   *
   * @param event - The delivered stream event.
   */
  const applyEvent = (event: LogEvent): void => {
    if (event.kind === "fact") {
      projectFact(event.fact);
      return;
    }
    // The forming head: re-render the trailing live assistant component in
    // place (text and thinking parts alike).  Growth changes the body height,
    // so a tail-anchored view keeps following the streaming text while a line
    // anchor keeps its line.  An empty part list is the retirement — either
    // the next event on this very stream is the fact that finalizes the
    // message, or the driver sent its end-of-stream marker.  Retiring with
    // nothing mounted changes nothing, so an append with no partial (the
    // usual case for tool facts) leaves the body untouched here.
    if (event.parts.length === 0) {
      dropStreaming();
      return;
    }
    renderPartial(event.parts);
  };

  // Live updates: every delivery on the run's data stream projects onto the
  // open body (event-driven, no polling; a terminal run streams nothing more,
  // so the same wiring is inert for it).  Scroll semantics follow the
  // familiar chat convention (see `mutateBody`).
  unsubscribe = deps.log.subscribe((event) => {
    mutateBody(() => applyEvent(event));
  });

  /**
   * Clip a cell to a width and pad it back out (ANSI-width-aware).
   */
  const fit = (text: string, cellWidth: number): string => {
    const clipped = truncateToWidth(text, Math.max(0, cellWidth));
    return clipped + " ".repeat(Math.max(0, cellWidth - visibleWidth(clipped)));
  };

  return {
    invalidate(): void {
      // The ScrollView forwards invalidation to its body children, which
      // clears the Markdown / Text render caches.
      scrollView.invalidate();
    },

    // pi calls `dispose()` on an overlay component when it closes (the
    // `ui.custom` done path); the esc/q handler also drops the log
    // subscription, so the two close routes are both covered and
    // idempotent.
    dispose(): void {
      unsubscribe?.();
      unsubscribe = undefined;
    },

    handleInput(data: string): void {
      if (isKeyRelease(data)) return;
      // SGR mouse wheel (pi fullscreen mode only — the bytes never arrive
      // in regular mode): one notch steps one line, the same shape as the
      // ↑↓ handlers below.  Non-wheel mouse reports decode to undefined
      // and fall through to the unmatched-key ignore at the end.
      const wheel = wheelStepFromSgr(data);
      if (wheel !== undefined) {
        stepAnchorBy(wheel);
        return;
      }
      if (matchesKey(data, "escape") || matchesKey(data, "q")) {
        unsubscribe?.();
        unsubscribe = undefined;
        done(undefined);
        return;
      }
      // Every scroll gesture below is an anchor update: the row the step lands
      // on becomes the anchor, so no separate follow flag has to be kept in
      // sync, and the committed offset is the anchor's derived value.
      if (matchesKey(data, "down") || matchesKey(data, "j")) {
        stepAnchorBy(1);
        return;
      }
      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        stepAnchorBy(-1);
        return;
      }
      if (matchesKey(data, "pageDown")) {
        stepAnchorBy(pageStep());
        return;
      }
      if (matchesKey(data, "pageUp")) {
        stepAnchorBy(-pageStep());
        return;
      }
      if (matchesKey(data, "home")) {
        stepAnchorToRow(0);
        return;
      }
      if (matchesKey(data, "end")) {
        reanchor(TAIL_ANCHOR, bodyLines(lastWidth));
        return;
      }
      // ctrl+o (pi's `app.tools.expand` key) flips every native tool
      // component's expanded state: collapsed = pi's default folded style,
      // expanded = the full output.  The key is not consumed when no tool
      // component is mounted (unmatched keys are ignored anyway).
      if (matchesKey(data, "ctrl+o")) {
        const toolComponents: ToolExecutionComponent[] = [];
        for (const child of body.children) {
          if (child instanceof ToolExecutionComponent) {
            toolComponents.push(child);
          }
        }
        if (toolComponents.length > 0) {
          // The toggle is a body change like any other: it rewrites the
          // rendered line count in place, so it goes through `mutateBody`,
          // which re-commits the anchor — a tail anchor chases the new end, a
          // line anchor keeps its line and simply re-resolves against the new
          // height.
          mutateBody(() => {
            toolsExpanded = !toolsExpanded;
            for (const component of toolComponents) {
              component.setExpanded(toolsExpanded);
            }
          });
        }
        return;
      }
      // Unmatched keys are ignored (the overlay owns the keyboard).
    },

    render(width: number): string[] {
      const safeWidth = Math.max(1, width);
      lastWidth = safeWidth;
      // The title line defaults to the fixed BORDER_COLOR; when the pi
      // entry point supplies a `borderColorize` (from the inspected run's
      // `[agent.<name>].color`), the whole title line uses the agent color
      // instead.  The hint keeps its own color either way.
      const titleColor =
        deps.borderColorize ??
        ((text: string): string => theme.fg(BORDER_COLOR, text));
      const dim = (text: string): string => theme.fg(DIM_COLOR, text);
      const hint = dim("↑↓/jk scroll · esc/q close");
      const rows = viewportBudget();

      // Render the ScrollView's full content and derive this frame's window
      // from the anchor (overlays bypass pi's layout system, so the
      // ScrollView's viewport height is supplied here).  The body spans the
      // full terminal width (no side borders to reserve).
      const contentWidth = Math.max(1, safeWidth);
      const fullBody = scrollView.render(contentWidth);
      // The anchor is resolved here rather than at construction because the
      // content height is only known once the body has rendered at a width:
      // the first render of a restored transcript therefore opens at its last
      // line (the tail anchor), and facts appended between open and first
      // render are included.  The layout is synced before the derived offset
      // is written so it clamps against the height just measured — this path
      // runs on every frame, so no extra body measure is taken.
      const top = resolveAnchor(anchor, fullBody.length, rows);
      scrollView.updateLayout(fullBody.length, rows, refresh);
      scrollView.scrollTo(top);

      const empty =
        fullBody.length === 0
          ? dim(deps.emptyNotice ?? "(empty transcript)")
          : undefined;

      // Exactly `termHeight` rows when the terminal height is known: title
      // line + `rows` body rows + hint line.  Every row is padded to
      // the full terminal width (no base content may bleed through at the
      // line ends — the compositor only overwrites declared columns).
      const out: string[] = [fit(titleColor(deps.title), safeWidth)];
      for (let i = 0; i < rows; i++) {
        const content =
          empty !== undefined
            ? i === 0
              ? empty
              : ""
            : top + i < fullBody.length
              ? fullBody[top + i]
              : "";
        out.push(fit(content, safeWidth));
      }
      out.push(fit(hint, safeWidth));
      return out;
    },

    // The mounted official ScrollView (exposed for tests and host wiring).
    scrollView,
  };
}

/**
 * The options passed to pi's `ui.custom` for the read-only overlay.
 *
 * The overlay pins to row 0 / col 0 and spans 100% of the terminal width
 * and height (margin 0): every screen row and every column is overlay
 * content, so the base layer (chat + widget) never shows through and its
 * diff repaints cannot flicker under the overlay.
 */
const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    width: "100%",
    maxHeight: "100%",
    row: 0,
    col: 0,
    margin: 0,
  },
};

/**
 * Open the transcript overlay for a registry run's fact log.
 *
 * Maps the log's current facts directly onto pi-tui components mounted
 * into the official `ScrollView`, and opens the full-screen read-only
 * overlay via the `openOverlay` surface (the pi `ui.custom` call).  The
 * overlay stays live: while the run is still running, log appends project
 * onto the open body (see `createTranscriptOverlay`).  Returns whether the
 * overlay was actually opened: an absent `openOverlay` surface or log
 * returns `false` (the caller leaves the enter key unconsumed).
 *
 * @param opts - The open options (fact log, title, surfaces).
 * @returns True when the overlay was opened.
 */
export function openTranscriptOverlay(opts: {
  /** The inspected run's fact log (absent → no overlay possible). */
  log: RunLog | undefined;
  /**
   * Replacement for the "(empty transcript)" line while the log has no facts
   * (see `TRANSCRIPT_UNAVAILABLE_NOTICE`).  Absent → the default line.
   */
  emptyNotice?: string;
  /** The overlay title (e.g. `beaver · <label>`). */
  title: string;
  /**
   * Optional border colorizer for the inspected run's agent (built from its
   * `[agent.<name>].color`), forwarded to the overlay component.  Absent →
   * the fixed `BORDER_COLOR` default.
   */
  borderColorize?: (text: string) => string;
  /** The working directory the sub-session ran in (tool render context). */
  cwd?: string;
  /** The `ui.custom` surface (absent → no overlay possible). */
  openOverlay?: (factory: unknown, options: unknown) => unknown;
}): boolean {
  const { log, title, openOverlay } = opts;
  if (log === undefined) return false;
  if (typeof openOverlay !== "function") return false;

  openOverlay(
    (tui: unknown, theme: unknown, _keybindings: unknown, done: unknown) =>
      createTranscriptOverlay({
        title,
        log,
        ...(opts.emptyNotice !== undefined
          ? { emptyNotice: opts.emptyNotice }
          : {}),
        ...(opts.borderColorize !== undefined
          ? { borderColorize: opts.borderColorize }
          : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        tui: tui as TranscriptTuiLike,
        theme: theme as TranscriptThemeLike,
        // pi invokes the factory with its `done` callback (the 4th
        // argument); esc/q in the component call it to close the overlay.
        done: (result: undefined) => {
          if (typeof done === "function") {
            (done as (result: undefined) => void)(result);
          }
        },
      }),
    OVERLAY_OPTIONS,
  );
  return true;
}
