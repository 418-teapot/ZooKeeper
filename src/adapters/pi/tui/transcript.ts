/**
 * Pi transcript overlay — the fleet widget's run inspection surface.
 *
 * When the user presses enter on a selected run in the `zoo` fleet widget,
 * the pi entry point opens a full-screen read-only overlay that renders the
 * run sub-session's transcript — the initial history replayed from its
 * persisted JSONL file once, then a live view driven by event-driven
 * appends while the inspected run is still running.  This
 * module is the only pi-touching layer for that surface: it maps the parsed
 * pi session records directly onto pi-tui components mounted into the
 * official `ScrollView` (pi's chat-area scroll component), mirroring how
 * `card.ts` owns the pi Component / theme mapping for the subagent card.
 *
 * Projection-free rendering: there is no intermediate line projection and no
 * physical-line slicing — every pi record becomes one or more pi-tui
 * components rendered in full:
 *   - user text renders through pi's native `UserMessageComponent` (text
 *     extracted from the message content, mirroring pi's own projection);
 *   - assistant text and `thinking` blocks render through pi's native
 *     `AssistantMessageComponent` with `hideThinkingBlock = false`, so
 *     thinking renders in full (dimmed via pi's official `thinkingText`
 *     color), together with pi's stopReason error / abort notices;
 *   - a `toolCall` paired with its `toolResult` renders through pi's native
 *     `ToolExecutionComponent` (the same component pi's interactive mode uses
 *     for the main session) — the tool's own `renderCall` / `renderResult`
 *     produce the exact native shell (bash preview + fold hint, read /
 *     grep / ls call formats, edit diff preview).  The component owns the
 *     collapsed/expanded view: collapsed is pi's default folded style,
 *     `ctrl+o` flips every tool component to expanded (full output).  A
 *     `toolCall` whose construction fails (unknown tool, missing pi theme)
 *     falls back to the accent `→ <name>` line plus its JSON arguments as a
 *     fenced code block; an orphan `toolResult` (no matching call in the
 *     transcript) falls back to its full text verbatim through a `Text`
 *     component — never markdown, so bash / tool output is not mangled.
 *
 * Scrolling is delegated to the official pi-tui `ScrollView`: the record
 * components are mounted into one `ScrollView` that owns the scroll state
 * (scroll offset, page / line stepping, clamping, start / end).  Because pi
 * composites overlay components by calling `render(width)` directly —
 * bypassing the layout system whose clipping would window a `ScrollView`
 * child — this overlay windows the rendered body rows by `scrollView.scrollTop`
 * itself, after syncing the `ScrollView`'s layout via `updateLayout`.  The
 * keyboard forwards `↑↓/jk` (line), `PageUp/PageDown` (page, matching pi's
 * `PAGE_SCROLL_OVERLAP` convention), and `Home/End` (start / end) to the
 * `ScrollView`; the SGR mouse wheel (raw wheel bytes pi forwards to the
 * focused overlay in fullscreen mode only) steps one line per notch;
 * `esc` / `q` call the `done` callback to close.
 *
 * Live updates: while the inspected run is still running (the host wires a
 * `childSession` — the sub-session id the run created), the overlay
 * subscribes to the live-transcript bus (`src/adapters/pi/live-transcript.ts`),
 * which the subagent driver feeds with the child session's stream events.
 * Assistant text and thinking render incrementally as the accumulated
 * partial messages stream in (`message_start` / `message_update` mount and
 * re-render one in-place streaming surface at the body tail); `message_end`
 * discards that surface and appends the finalized record, so the final
 * rendering is identical to the historical/replay rendering.  Tool activity
 * is visible while it runs: `tool_execution_start` mounts a native
 * `ToolExecutionComponent` (pi's pending shell) at the body tail,
 * `tool_execution_end` feeds it the result, and once the paired
 * `toolResult` record enters the transcript the record walk renders the
 * call at its replay position and the live component is retired — nothing
 * renders twice, and the converged layout is replay-identical.  `agent_end`
 * closes the stream: a streaming surface left by a run that aborted before
 * its final `message_end` is dropped so no frozen partial lingers (live
 * tool components keep their last state).  The scroll
 * state follows the familiar chat semantics: a view glued to the end before
 * an append or a streaming update stays glued (the new tail becomes
 * visible), any other offset is preserved (clamped to the new content).
 * The subscription is dropped on close (`esc` / `q`).  A historical run (no
 * `childSession` wired) renders the final file once — the file-only path.
 *
 * The initial render is always a one-time file replay through the official
 * parser; live events then append on top.  A run opened mid-flight replays
 * the file first and subscribes afterwards — the open path is synchronous
 * (pi invokes the overlay factory synchronously), so replayed history and
 * live events cannot structurally overlap; a per-message fingerprint dedup
 * additionally skips any live event whose message is already in the
 * replayed history.
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
 * Rendering strategy: message records render through pi's own
 * `UserMessageComponent` / `AssistantMessageComponent` / `ToolExecutionComponent`
 * imported from `@earendil-works/pi-coding-agent` (added as a devDependency;
 * pi's extension loader aliases that specifier to the bundled entry at
 * runtime, so the components are the exact ones pi's interactive mode uses).
 * They are constructed statically from the parsed records — `render(width)`
 * never executes a tool.  The components render through the coding-agent
 * module-level `theme` singleton (`initTheme`), which pi has already
 * initialized by the time an overlay can open; in tests the theme is
 * initialized from the package's built-in dark theme.
 *
 * Parsing strategy: the session file goes through pi's official
 * `parseSessionEntries` / `sessionEntryToContextMessages` (the same parser
 * pi's session manager uses), so the persisted JSONL — including session
 * headers and non-message records — is projected exactly as pi would.
 *
 * An unreadable session file or an empty transcript renders a one-line
 * explanation instead of crashing.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  parseSessionEntries,
  sessionEntryToContextMessages,
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
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { subscribeTranscript } from "../live-transcript.js";
import { type PiHistoryEntry, readSessionCwd } from "../subagent-scan.js";
import type { MarkdownThemeSource } from "./theme.js";

/** Fallback viewport height when the terminal height is unknown. */
export const TRANSCRIPT_VIEWPORT_FALLBACK = 12;

/** Minimum viewport height so a tiny terminal still shows content. */
const MIN_VIEWPORT_ROWS = 3;

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
  if (!data.startsWith("\u001b[")) return undefined;
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
  /** The pi session records (from the official parser), in source order. */
  entries: PiHistoryEntry[];
  /** An optional notice line replacing the transcript body. */
  notice?: string;
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
   * The working directory the sub-session ran in (the session header's
   * `cwd`).  Feeds the native tool renderers' render context (e.g. `read`'s
   * compact call classification).  Absent → empty (the tool renderers fall
   * back to their non-cwd formats).
   */
  cwd?: string;
  /** The live pi TUI. */
  tui: TranscriptTuiLike;
  /** The live pi theme. */
  theme: TranscriptThemeLike;
  /** Close the overlay (pi's `ui.custom` done callback). */
  done(result: undefined): void;
  /**
   * Optional child-session id for live event-driven updates.
   *
   * When provided, the overlay subscribes to the live-transcript bus
   * (`src/adapters/pi/live-transcript.ts`) for this session's streaming
   * lifecycle, finalized messages, tool-execution bookends, and run-end
   * marker: assistant partials render incrementally, tool calls mount live
   * native components as they execute, and each finalized message appends
   * its record as it arrives — no polling.  Absent → the overlay renders a
   * static snapshot (the historical-run path).
   */
  childSession?: string;
}

/**
 * Join the text content of a pi user content value (string or text parts).
 *
 * Mirrors pi's own user-text projection (interactive-mode's
 * `getUserMessageText`): a string content is used directly, an array joins
 * the `text` parts in order.
 *
 * @param content - The pi user content (raw string or content-part array).
 * @returns The joined text (empty when there is none).
 */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text"
    ) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

/**
 * Extract the joined text of the text content parts of a tool result.
 *
 * Only `text` parts count — image / other parts are ignored — mirroring the
 * projection used across the pi adapter.
 *
 * @param content - The pi content parts (array or raw string).
 * @returns The joined text (empty when there is none).
 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text"
    ) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

/**
 * The paired facts of a tool invocation extracted from the transcript.
 *
 * A `toolCall` content block is the call half, matched by call id with a
 * `toolResult` message (the result half).  Both halves are fed into pi's
 * native `ToolExecutionComponent`.
 */
interface ToolResultFacts {
  /** The tool's display name. */
  toolName: string;
  /** The result content parts (text / image), as pi's tool result shape. */
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  /** Whether the tool failed. */
  isError: boolean;
  /** The structured result details (e.g. the edit diff), when present. */
  details?: unknown;
}

/** A tool result content part as pi's native component takes it. */
type ToolResultPart = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

/**
 * Normalize a raw pi tool-result content value into content parts.
 *
 * A string content becomes a single text part; an array passes through as
 * the parts it already is (pi persists `text` / `image` parts); anything
 * else yields an empty list.  Mirrors pi's own projection so the live and
 * replay paths feed `ToolExecutionComponent.updateResult` the same shape.
 *
 * @param rawContent - The raw `content` value of a tool result.
 * @returns The content parts (possibly empty).
 */
function toolResultParts(rawContent: unknown): ToolResultPart[] {
  if (Array.isArray(rawContent)) return rawContent as ToolResultPart[];
  if (typeof rawContent === "string" && rawContent.length > 0) {
    return [{ type: "text", text: rawContent }];
  }
  return [];
}

/**
 * Index every `toolResult` message in the transcript by call id.
 *
 * Runs before the record walk so a `toolCall` block can resolve its result
 * regardless of message order (pi persists call then result, but the walk
 * renders assistant messages first).
 *
 * @param entries - The pi session records.
 * @returns The call-id → result-facts index.
 */
function indexToolResults(
  entries: PiHistoryEntry[],
): Map<string, ToolResultFacts> {
  const results = new Map<string, ToolResultFacts>();
  for (const entry of entries) {
    const message = entry.message;
    if (message === null || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    if (msg.role !== "toolResult") continue;
    const callId = msg.toolCallId;
    if (typeof callId !== "string" || callId.length === 0) continue;
    const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
    results.set(callId, {
      toolName,
      content: toolResultParts(msg.content),
      isError: msg.isError === true,
      ...(msg.details !== undefined ? { details: msg.details } : {}),
    });
  }
  return results;
}

/**
 * Build pi's native tool-execution component (pending form, no result).
 *
 * The component renders the tool's own `renderCall` (through the built-in
 * tool definitions) — the exact shell pi's interactive mode shows while a
 * tool executes in the main session.  Construction and `updateResult` are
 * static (no tool execution); `render(width)` only reflects state.  The
 * component needs pi's module-level theme singleton (`initTheme`), which pi
 * initializes at startup; construction is guarded so an uninitialized theme
 * (e.g. a host without pi wiring) falls back instead of crashing the
 * overlay.  Returns `undefined` on failure.
 *
 * @param callId - The tool call id.
 * @param name - The tool name.
 * @param args - The tool call arguments.
 * @param tui - The overlay's TUI surface (for the component's redraw hook).
 * @param cwd - The session's working directory (render context).
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
    return new ToolExecutionComponent(
      name,
      callId,
      args,
      // History rendering is read-only: no live images.
      { showImages: false },
      undefined,
      tui as unknown as TUI,
      cwd,
    );
  } catch {
    // Unknown tool / uninitialized pi theme → the caller falls back to the
    // structured rendering.
    return undefined;
  }
}

/**
 * Construct pi's native tool-execution component for a completed tool call.
 *
 * Builds the pending shell (shared with the live-mount path) and immediately
 * folds in the paired result — both guarded, so any construction or renderer
 * failure yields `undefined` and the caller falls back.
 *
 * @param callId - The tool call id.
 * @param name - The tool name.
 * @param args - The tool call arguments.
 * @param result - The paired result facts.
 * @param tui - The overlay's TUI surface (for the component's redraw hook).
 * @param cwd - The session's working directory (render context).
 * @returns The native component, or `undefined` when it cannot be built.
 */
function createNativeToolComponent(
  callId: string,
  name: string,
  args: unknown,
  result: ToolResultFacts,
  tui: TranscriptTuiLike,
  cwd: string,
): ToolExecutionComponent | undefined {
  const component = buildNativeToolComponent(callId, name, args, tui, cwd);
  if (component === undefined) return undefined;
  try {
    component.updateResult(
      {
        content: result.content,
        details: result.details,
        isError: result.isError,
      },
      false,
    );
    return component;
  } catch {
    // A throwing result renderer → the caller falls back to the structured
    // rendering.
    return undefined;
  }
}

/**
 * Build the fallback components for a `toolCall` without a native renderer.
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
 * Build the pi-tui components for one pi session record.
 *
 * Projection-free mapping — every record becomes one or more components
 * rendered in full:
 *   - a `user` message → pi's native `UserMessageComponent` (its own
 *     userMessageBg box + markdown rendering);
 *   - an `assistant` message → pi's native `AssistantMessageComponent` with
 *     `hideThinkingBlock = false` (thinking renders in full, dimmed via
 *     pi's official `thinkingText` color, together with stopReason error /
 *     abort notices), and every `toolCall` block rendered separately: a
 *     call paired with its `toolResult` → pi's native
 *     `ToolExecutionComponent` (when it can be built); a call whose result
 *     is not recorded yet but whose live component is mounted → rendered by
 *     that live component at the body tail (nothing added here, so it never
 *     appears twice); a failed / unknown tool or a call with neither →
 *     fallback to the accent `→ <name>` line plus the complete JSON
 *     arguments;
 *   - an orphan `toolResult` (no matching `toolCall` in the transcript) →
 *     a `Text` with the full verbatim text (never markdown);
 *   - everything else (non-message records, empty content, unrecognized
 *     roles) → no components.
 *
 * @param entry - The pi session record.
 * @param results - The call-id → result-facts index (for pairing).
 * @param renderedToolCalls - The call ids already rendered natively (an
 *   orphan result must skip its text form when its call rendered).
 * @param liveToolIds - Call ids with a mounted live tool component (a call
 *   whose result is not recorded yet renders at the body tail from its live
 *   component — the rebuild must not also draw the fallback for it).
 * @param tui - The overlay's TUI surface (for native tool components).
 * @param cwd - The session's working directory (render context).
 * @returns The component list for the record (empty when nothing renders).
 */
function recordComponents(
  entry: PiHistoryEntry,
  results: Map<string, ToolResultFacts>,
  renderedToolCalls: Set<string>,
  liveToolIds: ReadonlySet<string>,
  tui: TranscriptTuiLike,
  cwd: string,
): Component[] {
  const message = entry.message;
  if (message === null || typeof message !== "object") return [];
  const msg = message as Record<string, unknown>;
  const role = msg.role;

  if (role === "user") {
    const text = userText(msg.content);
    if (text.trim().length === 0) return [];
    return [new UserMessageComponent(text)];
  }

  if (role === "assistant") {
    const content = msg.content;
    if (!Array.isArray(content)) return [];
    const out: Component[] = [];
    // The official component renders the text / thinking blocks (thinking in
    // full, dimmed via pi's `thinkingText` color) plus the stopReason error
    // / abort notices — exactly pi's native assistant message.  It does not
    // render toolCall blocks, so those are rendered separately below.
    out.push(
      new AssistantMessageComponent(msg as unknown as AssistantMessage, false),
    );
    for (const blockRaw of content) {
      if (blockRaw === null || typeof blockRaw !== "object") continue;
      const block = blockRaw as Record<string, unknown>;
      if (block.type !== "toolCall") continue;
      const name = typeof block.name === "string" ? block.name : "tool";
      const callId = block.id;
      const args = block.arguments;
      const result =
        typeof callId === "string" ? results.get(callId) : undefined;
      if (result !== undefined) {
        const native = createNativeToolComponent(
          callId as string,
          name,
          args,
          result,
          tui,
          cwd,
        );
        if (native !== undefined) {
          out.push(native);
          renderedToolCalls.add(callId as string);
          continue;
        }
      }
      // A live tool component already renders this still-unrecorded call at
      // the body tail — drawing the fallback on top would render it twice.
      if (typeof callId === "string" && liveToolIds.has(callId)) continue;
      // No paired result (interrupted call) or no native renderer → the
      // structured fallback keeps the arguments visible.
      out.push(...fallbackToolCallComponents(name, args));
    }
    return out;
  }

  if (role === "toolResult") {
    const callId = msg.toolCallId;
    // The call half already rendered this result through the native
    // component — skip the orphan text form.
    if (typeof callId === "string" && renderedToolCalls.has(callId)) {
      return [];
    }
    const text = resultText(msg.content);
    if (text.trim().length === 0) return [];
    return [new Text(text, 0, 0)];
  }

  return [];
}

/**
 * Build the transcript overlay component.
 *
 * The component renders the full terminal surface: a title line, the
 * scrolling transcript window, and a bottom hint line (`↑↓/jk scroll ·
 * esc/q close`).  Every row spans the full terminal width (padded to the
 * end), so the base layer never shows through.
 *
 * The body is a component tree of the pi records mounted into the official
 * pi-tui `ScrollView`, which owns the scroll state.  Because pi composites
 * overlay components via `render(width)` directly (no layout-system clipping
 * for overlays), this component windows the `ScrollView`'s full rendered body
 * rows by `scrollTop` each render, syncing the `ScrollView`'s layout through
 * `updateLayout` first so `scrollTop` stays clamped to the content.
 *
 * `↑↓` / `jk` scroll by one line, `PageUp/PageDown` by a page (viewport minus
 * `PAGE_SCROLL_OVERLAP`, mirroring pi's transcript), and `Home/End` jump to
 * the start / end — all through `ScrollView.scrollBy` / `scrollTo` / `scrollToStart`
 * / `scrollToEnd`.  `esc` / `q` close via the `done` callback.
 *
 * Live updates: when `deps.childSession` is provided (a running run), the
 * overlay subscribes to the live-transcript bus (`src/adapters/pi/live-transcript.ts`)
 * for that session's stream events: assistant `message_start` /
 * `message_update` render the accumulating partial in place on a single
 * streaming surface at the body tail, `message_end` discards that surface
 * and appends the finalized record (fingerprint-deduped against the
 * replayed history), `tool_execution_start` / `tool_execution_end` mount
 * and finalize live native tool components, and `agent_end` drops a
 * streaming surface the run left dangling — event-driven, no polling, no
 * full file re-parse.  The
 * scroll state follows the familiar chat semantics: a view glued to the end
 * stays glued (the new tail becomes visible), any other offset is preserved
 * (clamped to the new content length).  The `ctrl+o` expanded state is
 * carried across the append rebuild.  The subscription is dropped on close
 * (`esc` / `q`) and via `dispose`.  A run without a `childSession` renders
 * the final file once (the historical-run path).
 *
 * @param deps - The overlay deps (title, entries, theme, done, optional
 *   live-update surfaces).
 * @returns The overlay component (with the mounted `ScrollView` exposed as
 *   `scrollView` for tests and host wiring).
 */
export function createTranscriptOverlay(
  deps: TranscriptOverlayDeps,
): Component & { scrollView: ScrollView; dispose(): void } {
  const { theme, tui, done } = deps;

  // The session's working directory (from the session header) feeds the
  // native tool renderers' render context.  Absent → empty string.
  let cwd = deps.cwd ?? "";
  // The shared `ctrl+o` tool expansion state (collapsed = pi's default
  // folded style, expanded = the full output).  The ToolExecutionComponent
  // keeps `expanded` private, so the overlay tracks the toggle itself and
  // re-applies it to every freshly built tool component on a live append.
  let toolsExpanded = false;
  // The notice line (e.g. "(transcript unavailable)" / "(empty transcript)").
  // Mutable: a live append that renders real content clears an earlier
  // "unavailable" notice (a run opened mid-flight before pi created the
  // session file still shows the live stream).
  let notice: string | undefined = deps.notice;
  // The last render width — the append path uses it to size the body-line
  // counts for the end-follow decision (it must match the ScrollView's
  // width).
  let lastWidth = 80;
  // The rendered body line count at the last render / rebuild at `lastWidth`,
  // cached so a live append makes its end-follow decision without re-rendering
  // the pre-append body (one full render pass saved per append).  `undefined`
  // until the first render / rebuild — an append before any render (defensive)
  // falls back to measuring the body once.
  let cachedBodyLines: number | undefined;
  // The live tool components mounted from the `tool_execution_start`
  // bookends, keyed by tool-call id.  A component enters the body tail on
  // the call's start (pi's native pending shell — the tool's activity is
  // visible the moment it runs, before any record is finalized), receives
  // its result on `tool_execution_end`, and leaves the map when the paired
  // `toolResult` record enters the transcript (the record walk then renders
  // the call at its replay position — the live twin is dropped so nothing
  // renders twice).  A call whose run aborted before its result was
  // recorded keeps its live component: it shows the tool's last state
  // (running, or the delivered result), mirroring how pi's own chat leaves
  // finished tool components on screen after a run ends.
  const liveToolComponents = new Map<string, ToolExecutionComponent>();

  /**
   * (Re)fill the transcript body container with the record components.
   *
   * Recomputes the tool-result index and walks every record, collecting the
   * native tool components (which own the collapsed/expanded view).  The
   * container instance is stable — the ScrollView holds it as its single
   * child — so a refresh clears and refills it in place, keeping the
   * ScrollView's scroll state alive.  The shared `ctrl+o` expansion is
   * applied to the fresh tool components (a refresh must not reset it).
   *
   * The live tool components (mounted from the tool-execution bookends) are
   * not records: a call whose result is now recorded was just rendered by
   * the walk (paired native), so its live component is dropped for good;
   * a still-unrecorded call's component survives and is re-appended at the
   * body tail (in mount order) — `body.clear()` took it out of the tree.
   *
   * @param entries - The pi session records (in source order).
   * @param nextCwd - The session's working directory for the tool renderers.
   */
  const rebuildBody = (entries: PiHistoryEntry[], nextCwd: string): void => {
    cwd = nextCwd;
    const results = indexToolResults(entries);
    const renderedToolCalls = new Set<string>();
    const liveToolIds = new Set(liveToolComponents.keys());
    // The streaming surface is not a record: a rebuild refills the body
    // solely from the record list, which discards it — drop the reference
    // along with it so the streaming state never points at an orphaned
    // component (the `message_end` handler removes it before finalizing;
    // this reset covers any other rebuild path).
    streamingComponent = undefined;
    body.clear();
    for (const entry of entries) {
      const components = recordComponents(
        entry,
        results,
        renderedToolCalls,
        liveToolIds,
        tui,
        cwd,
      );
      for (const component of components) {
        if (component instanceof ToolExecutionComponent) {
          component.setExpanded(toolsExpanded);
        }
        body.addChild(component);
      }
    }
    for (const callId of [...liveToolComponents.keys()]) {
      const component = liveToolComponents.get(callId);
      if (component === undefined) continue;
      if (results.has(callId)) {
        // The record walk rendered the call paired with its recorded result
        // — the live twin is redundant (nothing renders twice).
        liveToolComponents.delete(callId);
      } else {
        body.addChild(component);
      }
    }
  };

  // The transcript body: every pi record becomes one or more pi-tui
  // components, mounted into the official ScrollView (the same component pi's
  // chat area scrolls with).  The ScrollView owns the scroll state; this
  // overlay windows the rendered rows by scrollTop (overlays bypass pi's
  // layout-system clipping).
  const body = new Container();
  // The live streaming surface: one `AssistantMessageComponent` mounted at
  // the tail of the body while an assistant message streams (its content is
  // replaced in place on every accumulated partial).  It is NOT part of the
  // record list — `message_end` removes it and the record rebuild renders
  // the finalized message through the normal (replay-identical) path.
  let streamingComponent: AssistantMessageComponent | undefined;
  rebuildBody(deps.entries, cwd);
  const scrollView = new ScrollView(body, {
    overscroll: "contain",
    scrollbar: "hidden",
  });

  /** Re-render after a scroll / close. */
  const refresh = (): void => {
    tui.requestRender?.();
  };

  /** The rendered body line count at the given width. */
  const bodyLines = (width: number): number =>
    body.children.reduce((sum, child) => {
      return sum + child.render(width).length;
    }, 0);

  /**
   * The stable message fingerprint used to dedup live events against the
   * replayed history.
   *
   * The live `message_end` event carries the exact message object pi
   * persisted to the session file (`appendMessage(event.message)` runs after
   * listener dispatch), so the JSON serialization of the live message equals
   * the serialization of the replayed message parsed from the file — key
   * order is preserved through both paths.  A live event whose fingerprint
   * is already known was already in the replayed history and is skipped.
   */
  const fingerprintOf = (message: unknown): string => {
    try {
      return JSON.stringify(message);
    } catch {
      return "";
    }
  };
  // The fingerprints of the replayed history (the initial records), plus
  // every live message appended afterwards — a live event that duplicates an
  // already-rendered message is skipped.
  const seenFingerprints = new Set<string>(
    deps.entries.map((entry) => fingerprintOf(entry.message)),
  );
  /** The overlay's record list in the same shape as the file-parsed records. */
  const recordEntries: PiHistoryEntry[] = [...deps.entries];

  /** Unsubscribe from the live-transcript bus (idempotent; called on close
   * and dispose). */
  let unsubscribeLive: (() => void) | undefined;

  /**
   * Apply a body mutation preserving the chat-follow scroll state.
   *
   * The pre-change content height comes from the cached line count (the last
   * render / rebuild at `lastWidth`) — no fresh body render for the
   * end-follow decision; a defensive fallback measures once when no render /
   * rebuild happened yet.  After the mutation the body is measured once (and
   * the cache repopulated), the `ScrollView` layout is synced to the new
   * height so end-scrolling clamps to the new tail, and a view that was
   * glued to the end stays glued; any other offset is preserved (clamped to
   * the new content).
   *
   * @param mutate - The body change (record append / streaming mount /
   *   in-place update / removal).
   */
  const applyBodyChange = (mutate: () => void): void => {
    const width = lastWidth;
    const viewportRows = computeViewportRows(tui.terminal?.rows);
    const oldLines = cachedBodyLines ?? bodyLines(width);
    const atEnd = scrollView.scrollTop >= Math.max(0, oldLines - viewportRows);
    mutate();
    // The ScrollView only learns the content height in render; sync it now
    // so scrollToEnd clamps to the NEW content length.  The post-mutation
    // line count is computed once and cached — the next change reuses it.
    cachedBodyLines = bodyLines(width);
    scrollView.updateLayout(cachedBodyLines, viewportRows, refresh);
    if (atEnd) {
      scrollView.scrollToEnd();
    }
    refresh();
  };

  /**
   * Mount the live streaming surface for a new assistant stream.
   *
   * The surface is one `AssistantMessageComponent` appended to the body and
   * filled in place on every accumulated partial — never a body rebuild.
   * A new stream supersedes any dangling surface defensively; in practice
   * the `agent_end` handler already dropped a surface left by a run that
   * aborted before its `message_end`.
   *
   * @param message - The partial assistant message to render.
   */
  const beginStreaming = (message: unknown): void => {
    const component = new AssistantMessageComponent(undefined, false);
    applyBodyChange(() => {
      if (streamingComponent !== undefined) {
        body.removeChild(streamingComponent);
      }
      streamingComponent = component;
      body.addChild(component);
      component.updateContent(message as AssistantMessage, true);
    });
  };

  /**
   * Re-render the streaming surface with the accumulated partial message.
   *
   * The overlay may subscribe after pi emitted `message_start` (a run
   * opened mid-stream): the first seen partial then mounts the surface.
   *
   * @param message - The accumulated partial assistant message.
   */
  const updateStreaming = (message: unknown): void => {
    if (streamingComponent === undefined) {
      beginStreaming(message);
      return;
    }
    const component = streamingComponent;
    applyBodyChange(() => {
      component.updateContent(message as AssistantMessage, true);
    });
  };

  /**
   * Remove the streaming surface ahead of the `message_end` finalization.
   *
   * No-op when nothing streams.  The scroll state is maintained through the
   * removal the same way as any body change (glued stays glued).
   */
  const endStreaming = (): void => {
    if (streamingComponent === undefined) return;
    const component = streamingComponent;
    streamingComponent = undefined;
    applyBodyChange(() => {
      body.removeChild(component);
    });
  };

  /**
   * Append a live message to the record list and rebuild the body.
   *
   * Rebuilds from the full record list so the tool-result pairing logic
   * (which indexes every result before walking) resolves the new message
   * against the previously-rendered history — an assistant message carrying
   * a `toolCall` block renders as an unpaired call until its `toolResult`
   * message arrives, then the rebuild pairs them through the native
   * component.  A paired record also retires the call's live tool
   * component (see `rebuildBody`).  Scroll semantics follow the familiar
   * chat convention (a view glued to the end stays glued, any other offset
   * is preserved); see `applyBodyChange`.  The shared `ctrl+o` expansion is
   * carried across the rebuild.
   *
   * @param message - The finalized message from the live event.
   */
  const appendLiveMessage = (message: unknown): void => {
    const fingerprint = fingerprintOf(message);
    // An empty fingerprint means the message was not JSON-serializable
    // (stringify failed); two such messages would share the "" key and the
    // second would be dropped, so they skip dedup and always append.
    if (fingerprint !== "" && seenFingerprints.has(fingerprint)) return;
    if (fingerprint !== "") seenFingerprints.add(fingerprint);
    recordEntries.push({ type: "message", message });
    // A live append proves the run's stream is flowing — clear the
    // "unavailable" notice (the session file may not have existed at open
    // time for a mid-flight run).
    if (notice !== undefined) notice = undefined;
    applyBodyChange(() => {
      rebuildBody(recordEntries, cwd);
    });
  };

  /**
   * Mount the live native tool component for a call that started executing.
   *
   * Same construction the record walk uses (minus the result — the tool is
   * still running, so pi's native pending shell shows).  The component
   * enters at the body tail; a rebuild triggered here also retires any
   * `→ <name>` fallback the record walk had drawn for the same call, so the
   * call never renders twice.  A construction failure (unknown tool under
   * an unmapped renderer) simply leaves the record-path rendering in place —
   * the overlay must never go blind on a live tool.  A duplicated start for
   * an already-mounted id is ignored (the map is the single source).
   *
   * @param callId - The tool call id (the live component's key).
   * @param toolName - The tool's name.
   * @param args - The tool call arguments.
   */
  const mountLiveTool = (
    callId: string,
    toolName: string,
    args: unknown,
  ): void => {
    if (liveToolComponents.has(callId)) return;
    const component = buildNativeToolComponent(
      callId,
      toolName,
      args,
      tui,
      cwd,
    );
    if (component === undefined) return;
    component.setExpanded(toolsExpanded);
    liveToolComponents.set(callId, component);
    applyBodyChange(() => {
      rebuildBody(recordEntries, cwd);
    });
  };

  /**
   * Deliver a finished result to the call's live tool component.
   *
   * pi emits `tool_execution_end` before the `toolResult`-role
   * `message_end`, so this is the first moment the result is visible.  An
   * end for an id without a mounted component (start missed, or a rebuild
   * already retired the twin because the result entered the records) is
   * inert — the record path owns the rendering from there.
   *
   * @param callId - The tool call id.
   * @param result - The raw tool result (duck shape: `content` parts,
   *   optional `details`).
   * @param isError - Whether the tool failed.
   */
  const finishLiveTool = (
    callId: string,
    result: unknown,
    isError: boolean,
  ): void => {
    const component = liveToolComponents.get(callId);
    if (component === undefined) return;
    const raw =
      result !== null && typeof result === "object"
        ? (result as Record<string, unknown>)
        : {};
    applyBodyChange(() => {
      try {
        component.updateResult(
          {
            content: toolResultParts(raw.content),
            ...(raw.details !== undefined ? { details: raw.details } : {}),
            isError,
          },
          false,
        );
      } catch {
        // A throwing renderer must never break the live path; the finalized
        // record rebuild re-renders the pair through the guarded path.
      }
    });
  };

  // Live updates: subscribe to the live-transcript bus for this run's child
  // session.  The driver forwards the session's stream: `message_start` /
  // `message_update` (assistant) render the accumulating partial in place on
  // a single streaming surface, `message_end` discards that surface and
  // appends the finalized record, `tool_execution_start` /
  // `tool_execution_end` mount and finalize the live tool components (tool
  // activity is visible the moment it runs, not only once records finalize),
  // and `agent_end` closes the stream — event-driven, no full file
  // re-parse.  A finalized message whose fingerprint already sits in the
  // replayed history appends nothing (the streaming surface is still
  // removed, so nothing duplicates or lingers).  The subscription is dropped
  // on close (and via dispose); a run without a `childSession` wired
  // renders the final file once (the historical-run path).
  if (deps.childSession !== undefined) {
    unsubscribeLive = subscribeTranscript(deps.childSession, (event) => {
      // Any live event — even a bare streaming delta — proves the run's
      // stream is flowing, so the "unavailable" notice must clear while the
      // partial renders (the record path alone cannot recover a stream that
      // has not finalized yet).
      if (notice !== undefined) notice = undefined;
      if (event.type === "message_start") {
        beginStreaming(event.message);
      } else if (event.type === "message_update") {
        updateStreaming(event.message);
      } else if (event.type === "tool_execution_start") {
        mountLiveTool(event.toolCallId, event.toolName, event.args);
      } else if (event.type === "tool_execution_end") {
        finishLiveTool(event.toolCallId, event.result, event.isError);
      } else if (event.type === "agent_end") {
        // The run ended.  A final `message_end` normally already closed the
        // streaming surface; when the run aborted before it, drop the
        // dangling partial here so no frozen half-message outlives the run.
        // Live tool components intentionally stay: each shows its last
        // state (running, or the result that arrived before the abort) —
        // the same post-run behavior pi's own chat has.
        endStreaming();
      } else {
        endStreaming();
        appendLiveMessage(event.message);
      }
    });
  }

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
    // `ui.custom` done path); the esc/q handler also drops the live
    // subscription, so the two close routes are both covered and idempotent.
    dispose(): void {
      unsubscribeLive?.();
      unsubscribeLive = undefined;
    },

    handleInput(data: string): void {
      if (isKeyRelease(data)) return;
      // SGR mouse wheel (pi fullscreen mode only — the bytes never arrive
      // in regular mode): one notch steps one line, the same shape as the
      // ↑↓ handlers below.  Non-wheel mouse reports decode to undefined
      // and fall through to the unmatched-key ignore at the end.
      const wheel = wheelStepFromSgr(data);
      if (wheel !== undefined) {
        scrollView.scrollBy(wheel);
        refresh();
        return;
      }
      if (matchesKey(data, "escape") || matchesKey(data, "q")) {
        unsubscribeLive?.();
        unsubscribeLive = undefined;
        done(undefined);
        return;
      }
      if (matchesKey(data, "down") || matchesKey(data, "j")) {
        scrollView.scrollBy(1);
        refresh();
        return;
      }
      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        scrollView.scrollBy(-1);
        refresh();
        return;
      }
      if (matchesKey(data, "pageDown")) {
        scrollView.scrollBy(
          Math.max(1, scrollView.viewportHeight - PAGE_SCROLL_OVERLAP),
        );
        refresh();
        return;
      }
      if (matchesKey(data, "pageUp")) {
        scrollView.scrollBy(
          -Math.max(1, scrollView.viewportHeight - PAGE_SCROLL_OVERLAP),
        );
        refresh();
        return;
      }
      if (matchesKey(data, "home")) {
        scrollView.scrollToStart();
        refresh();
        return;
      }
      if (matchesKey(data, "end")) {
        scrollView.scrollToEnd();
        refresh();
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
          toolsExpanded = !toolsExpanded;
          for (const component of toolComponents) {
            component.setExpanded(toolsExpanded);
          }
          // Expansion changes the rendered line count; the cached count is
          // stale until the next render repopulates it.
          cachedBodyLines = undefined;
          refresh();
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
      // instead.  The hint / notices keep their own colors either way.
      const titleColor =
        deps.borderColorize ??
        ((text: string): string => theme.fg(BORDER_COLOR, text));
      const dim = (text: string): string => theme.fg(DIM_COLOR, text);
      const hint = dim("↑↓/jk scroll · esc/q close");
      const viewportRows = computeViewportRows(tui.terminal?.rows);

      // Render the ScrollView's full content and sync its layout so
      // scrollTop is clamped to the content (overlays bypass pi's layout
      // system, so the ScrollView's viewport height is supplied here).  The
      // body spans the full terminal width (no side borders to reserve).
      const contentWidth = Math.max(1, safeWidth);
      const fullBody = scrollView.render(contentWidth);
      cachedBodyLines = fullBody.length;
      scrollView.updateLayout(fullBody.length, viewportRows, refresh);
      const top = scrollView.scrollTop;

      const currentNotice =
        notice !== undefined
          ? dim(notice)
          : fullBody.length === 0
            ? dim("(empty transcript)")
            : undefined;

      // Exactly `termHeight` rows when the terminal height is known: title
      // line + viewportRows body rows + hint line.  Every row is padded to
      // the full terminal width (no base content may bleed through at the
      // line ends — the compositor only overwrites declared columns).
      const out: string[] = [fit(titleColor(deps.title), safeWidth)];
      for (let i = 0; i < viewportRows; i++) {
        const content =
          currentNotice !== undefined
            ? i === 0
              ? currentNotice
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
 * Read a session file's raw text (the default `readSessionFile`).
 *
 * Returns `undefined` when the file is missing or unreadable — the caller
 * renders the "(transcript unavailable)" notice.
 *
 * @param path - The session file path.
 * @returns The raw file text, or `undefined` on read failure.
 */
function readSessionFileDefault(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Open the transcript overlay for a run sub-session.
 *
 * Reads the persisted session file (the initial read-at-open snapshot)
 * through pi's official `parseSessionEntries` / `sessionEntryToContextMessages`
 * (the same parser pi's session manager uses), maps each message record
 * directly onto pi-tui components mounted into the official `ScrollView`,
 * and opens the full-screen read-only overlay via the `openOverlay` surface
 * (the pi `ui.custom` call).  Returns whether the overlay was actually
 * opened: an absent `openOverlay` surface or an empty `sessionPath` returns
 * `false` (the caller leaves the enter key unconsumed).
 *
 * While the overlay is open and the inspected run is live, new transcript
 * content arrives event-driven: the overlay subscribes to the live-transcript
 * bus for the run's child session (`childSession`, the sub-session id the
 * run created), renders assistant partials incrementally as they stream,
 * and finalizes each `message_end` record as it arrives — no polling.  An
 * unreadable session file still opens the overlay (the run exists, so the
 * enter key is consumed) but renders a one-line "(transcript unavailable)"
 * notice instead of crashing.
 *
 * `readSessionFile` is injectable for tests (it supplies the raw jsonl
 * text); `readEntries` injects the parsed records directly, bypassing the
 * official parser.  `childSession` — when provided — wires the live
 * event-driven updates for the running run.
 *
 * @param opts - The open options (session path, title, surfaces).
 * @returns True when the overlay was opened.
 */
export function openTranscriptOverlay(opts: {
  /** The run's on-disk sub-session file path. */
  sessionPath: string | undefined;
  /** The overlay title (e.g. `beaver · <label>`). */
  title: string;
  /**
   * Optional border colorizer for the inspected run's agent (built from its
   * `[agent.<name>].color`), forwarded to the overlay component.  Absent →
   * the fixed `BORDER_COLOR` default.
   */
  borderColorize?: (text: string) => string;
  /** The `ui.custom` surface (absent → no overlay possible). */
  openOverlay?: (factory: unknown, options: unknown) => unknown;
  /**
   * Injectable raw session-file reader (defaults to reading the file and
   * parsing it through pi's official `parseSessionEntries`).  Returns the
   * file text, or `undefined` when the file cannot be read.
   */
  readSessionFile?: (path: string) => string | undefined;
  /**
   * Injectable parsed-record reader (defaults to the official parser
   * projection over `readSessionFile`'s text).  When provided, the raw file
   * is not read.
   */
  readEntries?: (path: string) => PiHistoryEntry[] | undefined;
  /** Injectable session-cwd reader (defaults to the pi header parser). */
  readCwd?: (path: string) => ReturnType<typeof readSessionCwd>;
  /**
   * Optional child-session id for live event-driven updates.
   *
   * When provided (a running run), the overlay subscribes to the
   * live-transcript bus for this session and appends each new message
   * record as it arrives — no polling.  Absent → the overlay renders the
   * final file once (the historical-run path).
   */
  childSession?: string;
}): boolean {
  const { sessionPath, title, openOverlay } = opts;
  if (sessionPath === undefined || sessionPath.length === 0) return false;
  if (typeof openOverlay !== "function") return false;

  // The entry projection shared by the initial read (the one-time history
  // replay).
  const readEntriesFn = (): PiHistoryEntry[] | undefined => {
    if (opts.readEntries !== undefined) return opts.readEntries(sessionPath);
    // The official projection: parse the jsonl into file entries, then map
    // each entry to its context message(s) — the exact parser pi's session
    // manager uses (headers / non-message records are dropped here).
    const readSessionFile = opts.readSessionFile ?? readSessionFileDefault;
    const text = readSessionFile(sessionPath);
    if (text === undefined) return undefined;
    // Only the session header is filtered: compaction / branch_summary /
    // custom_message entries project to context messages, which the record
    // walk then skips (the overlay renders user / assistant / toolResult
    // records only).
    return parseSessionEntries(text)
      .filter((entry) => entry.type !== "session")
      .flatMap((entry) => sessionEntryToContextMessages(entry))
      .map((message) => ({ type: "message", message }));
  };
  // The session header's cwd feeds the native tool renderers' render
  // context; absent (unreadable file / malformed header) the tool renderers
  // fall back to their non-cwd formats.
  const readCwd = opts.readCwd ?? readSessionCwd;
  const cwd = readCwd(sessionPath);

  const entries = readEntriesFn();
  let notice: string | undefined;
  let recordEntries: PiHistoryEntry[];
  if (entries === undefined) {
    notice = "(transcript unavailable)";
    recordEntries = [];
  } else {
    recordEntries = entries;
    if (recordEntries.length === 0) notice = "(empty transcript)";
  }

  openOverlay(
    (tui: unknown, theme: unknown, _keybindings: unknown, done: unknown) =>
      createTranscriptOverlay({
        title,
        entries: recordEntries,
        ...(notice !== undefined ? { notice } : {}),
        ...(opts.borderColorize !== undefined
          ? { borderColorize: opts.borderColorize }
          : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        tui: tui as TranscriptTuiLike,
        theme: theme as TranscriptThemeLike,
        // pi invokes the factory with its `done` callback (the 4th
        // argument); esc/q in the component call it to close the overlay.
        done: (result: undefined) => {
          if (typeof done === "function") {
            (done as (result: undefined) => void)(result);
          }
        },
        // Live updates: subscribe to the live-transcript bus for the run's
        // child session when the run is live (event-driven appends, no
        // polling).  A historical run (no childSession) renders the file
        // once.
        ...(opts.childSession !== undefined
          ? { childSession: opts.childSession }
          : {}),
      }),
    OVERLAY_OPTIONS,
  );
  return true;
}
