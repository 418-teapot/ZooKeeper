/**
 * Host-agnostic context lens types.
 *
 * A message is an opaque handle to the core: its content is reachable
 * only through `TextRegion` read/write lenses, never by unpacking host
 * message structures.  Identity is positional (ordinal) only — no host
 * ids and no structural access.  This module is the lowest layer of the
 * new core: pure types plus pure helpers, zero imports.
 *
 * @module
 */

/**
 * Message role.
 *
 * `"user"` and `"assistant"` are canonical; the `(string & {})` tail lets
 * hosts extend the union with their own roles while keeping editor
 * autocomplete for the canonical two.
 */
export type Role = "user" | "assistant" | (string & {});

/**
 * Kind of a text region within a message.
 *
 * - `content` — ordinary message text.
 * - `thinking` — reasoning trace; counted by estimation, never rewritten.
 * - `tool-input` — a tool call's arguments.
 * - `tool-output` — a tool call's result.
 */
export type RegionKind = "content" | "thinking" | "tool-input" | "tool-output";

/**
 * Tool-call metadata attached to a region.
 *
 * Region-level text metadata, not structural access: the lens still
 * offers no message structure, no ids, and no host fields.  `status` is
 * the host's verbatim status string (e.g. "pending", "running",
 * "completed", "error"); the core does not enumerate the value space —
 * producers interpret the semantics themselves.
 */
export interface ToolMeta {
  /** Tool name (e.g. "bash", "read"). */
  name: string;
  /** Host-verbatim call status string. */
  status?: string;
}

/**
 * A read/write lens over one region's text.
 *
 * The lens exposes text only — no structure, no ids, no host fields.
 * `set()` mutates the underlying storage in place; a subsequent `get()`
 * on the same region observes the new text.  `tool` is present on
 * tool-input/tool-output regions only.
 */
export interface TextRegion {
  kind: RegionKind;
  get(): string;
  set(text: string): void;
  /** Tool-call metadata; undefined on non tool regions. */
  tool?: ToolMeta;
}

/**
 * API-reported exact token usage for a message.
 *
 * Field names are flat and mirror the legacy token report consumed by
 * `measure` (input + output + reasoning + cache read/write) so exact
 * accounting parity is preserved; `reasoning` is included because the
 * legacy exact-token sum counts it alongside the other four components.
 * `cacheRead`/`cacheWrite` correspond to the legacy nested
 * `cache.read`/`cache.write`.
 */
export interface TokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * An opaque message handle in the host-agnostic core.
 *
 * `hidden` carries the v1 "ignored" semantics: the message still
 * occupies an ordinal in the transcript but is skipped by estimation
 * and numbering.  `usage` is the API exact token report when available.
 */
export interface HostMessage {
  role: Role;
  hidden: boolean;
  regions: TextRegion[];
  usage?: TokenUsage;
}

/**
 * Minimal forward shape of a fold block as referenced by a summary view
 * item.
 *
 * The persisted `Block` lands in a later phase; `BlockSpan` is the
 * subset of fields the view layer reads, so the formal `Block` can
 * satisfy this interface without reshaping `ViewItem`.
 */
export interface BlockSpan {
  /** First covered ordinal (inclusive). */
  start: number;
  /** Last covered ordinal (exclusive). */
  end: number;
  /** Optional human-readable block title. */
  title?: string;
  /** LLM-written summary text shown in the view. */
  summary: string;
}

/**
 * One item of a folded view.
 *
 * `original` references a single transcript message by ordinal;
 * `summary` references a block's span (the right endpoint of a range
 * that lands on a summary item covers the whole block).
 */
export type ViewItem =
  | { type: "original"; ordinal: number }
  | { type: "summary"; block: BlockSpan };

/**
 * Host-adapter contract: the three methods every host must provide.
 *
 * The core talks to a host only through this interface — the host
 * reports its transcript (`history`), renders a block's summary into a
 * synthetic message (`materializeSummary`), and materializes a folded
 * view into its own messages (`applyView`).  `View = fold(history,
 * blocks)` stays a pure function recomputed every round; the adapter
 * never caches a view.
 *
 * The signatures describe the contract, not the implementation: the
 * current OpenCode v1 adapter provides the building blocks with
 * signatures specialized to v1 in-place semantics — its
 * `applyView(messages, history, items, state)` additionally carries
 * the v1 message array and session state because v1 mutation is in
 * place, and its `materializeSummary(block, lineNumber)` renders from a
 * block span rather than a bare text.  A future pi adapter would return
 * a replacement messages array instead (`context` event `{messages}`
 * contract).
 */
export interface HostAdapter {
  /** Report the host's transcript as lens messages (ordinals align 1:1). */
  history(): HostMessage[];
  /** Render a block's summary text into a synthetic host message. */
  materializeSummary(text: string): HostMessage;
  /** Materialize a folded view into the host's messages. */
  applyView(items: ViewItem[]): void;
}

/**
 * Collect the regions of a message with the given kind, in order.
 *
 * @param msg - The message to filter.
 * @param kind - The region kind to select.
 * @returns The matching regions, preserving their order.
 */
export function regionsOfKind(
  msg: HostMessage,
  kind: RegionKind,
): TextRegion[] {
  return msg.regions.filter((region) => region.kind === kind);
}

/**
 * Find the ordinal of the first non-hidden user message.
 *
 * Hidden messages are skipped; the result is the transcript position of
 * the first user message that is not hidden.
 *
 * @param messages - The transcript.
 * @returns The ordinal, or -1 when no non-hidden user message exists.
 */
export function findFirstUserOrdinal(messages: HostMessage[]): number {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && !messages[i].hidden) return i;
  }
  return -1;
}

/**
 * Find the ordinal of the last non-hidden user message.
 *
 * Hidden messages are skipped; the result is the transcript position of
 * the last user message that is not hidden.
 *
 * @param messages - The transcript.
 * @returns The ordinal, or -1 when no non-hidden user message exists.
 */
export function findLastUserOrdinal(messages: HostMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !messages[i].hidden) return i;
  }
  return -1;
}
