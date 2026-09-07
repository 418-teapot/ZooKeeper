/**
 * Host-agnostic context lens types.
 *
 * A message is an opaque handle to the core: its content is reachable
 * only through `TextRegion` read lenses, never by unpacking host
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
 * Positional address of a region within the transcript.
 *
 * The same vocabulary the `RegionEdit` and prune-mark addresses use —
 * a message ordinal plus a region index inside it — so an invocation
 * reference and a mark can address the same region without any host
 * id.
 */
export interface InvocationRef {
  /** Ordinal of the message holding the region. */
  ordinal: number;
  /** Index of the region within that message. */
  regionIndex: number;
}

/**
 * One paired tool invocation of the transcript.
 *
 * The host adapter pairs a call's input with its output at projection
 * time using the host's own call identity (a call id, or the same-part
 * adjacency of the v1 layout) and emits the pairing result as this
 * positional table entry.  `status` follows a shared convention:
 * hosts map their terminal states onto `"completed"` / `"error"`
 * (pi synthesises them from its error flag; v1 supplies the same
 * literals natively), and producers compare against exactly those
 * two strings — any other value is treated as non-terminal and the
 * call is left alone.  `input` is always present (a projected tool
 * call carries its arguments); `output` is absent while the call is
 * still in flight and no result has been linked to it.
 */
export interface Invocation {
  /** Tool name (e.g. "bash", "read"). */
  name: string;
  /** Host-verbatim call status string. */
  status?: string;
  /** Positional address of the call's tool-input region. */
  input: InvocationRef;
  /** Positional address of the call's tool-output region, once linked. */
  output?: InvocationRef;
}

/**
 * The snapshot one projection pass produces.
 *
 * Bundles the region view with the invocation table paired in the same
 * pass, so every positional reference of the table is guaranteed
 * consistent with `messages`.  `byRegion` is the reverse index — a map
 * from a region address (see `regionKey`) to the invocation whose
 * input or output the region addresses — for per-region consumers
 * (sweep, canon).  A tool region with no reverse-index entry carries
 * no pairing information: producers abstain from it (fail-closed).
 */
export interface Projection {
  /** The lens transcript; ordinals are array indices. */
  messages: HostMessage[];
  /** The invocation table, in the order the adapter paired the calls. */
  invocations: Invocation[];
  /** Reverse index keyed by `regionKey` over every invocation address. */
  byRegion: Map<string, Invocation>;
}

/**
 * A read-only lens over one region's text.
 *
 * The lens exposes text only — no structure, no ids, no host fields.
 * Text replacement is expressed as `RegionEdit` data; writing edits
 * into a conversation is the host adapter's job (`HostAdapter.render`),
 * never a core capability.  Tool-call pairing does not travel on
 * regions — it is first-class table data (see `Projection`).
 */
export interface TextRegion {
  kind: RegionKind;
  get(): string;
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
 * `compaction` marks a host-native compaction summary message: the
 * transcript interval before the last such message is historical, so
 * the report's category breakdown starts at (and includes) the last
 * compaction-marked message.
 */
export interface HostMessage {
  role: Role;
  hidden: boolean;
  regions: TextRegion[];
  usage?: TokenUsage;
  /** True on host-native compaction summary messages (optional). */
  compaction?: boolean;
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
 * One region text replacement in a host conversation.
 *
 * Addresses a region by message ordinal and, when the message carries
 * more than one region, the region index within the message.  `text` is
 * the full replacement, not a delta.  Edits are pure data: applying
 * them — writing the text into the addressed region — is the host
 * adapter's job (`HostAdapter.render`).
 */
export interface RegionEdit {
  /** Ordinal of the message whose region text is replaced. */
  messageOrdinal: number;
  /** Index of the region within the message, for multi-region messages. */
  regionIndex?: number;
  /** The full replacement text. */
  text: string;
}

/**
 * Host-adapter contract over a host conversation type.
 *
 * The core talks to a host only through this interface: the host
 * projects its conversation into lens messages (`history`) and renders a
 * folded view plus the round's region edits back into the conversation
 * (`render`).  Summary materialization is an internal detail of a host's
 * render implementation, not a cross-host seam.  The view stays a pure
 * function recomputed every round — the adapter never caches one.
 *
 * All mutating methods return the conversation after the operation.  The
 * input may be mutated in place or replaced by a new value; callers must
 * always use the returned object and must not rely on in-place mutation.
 * Measurement of a conversation is a host-side concern and is not covered
 * by this contract.
 *
 * `state` is typed as `unknown` because `SessionState` lives in
 * `state.ts`, which imports `BlockSpan` from this module; importing
 * `SessionState` here would create an import cycle.
 */
export interface HostAdapter<THostConversation> {
  /**
   * Project the host conversation into a lens snapshot (ordinals align
   * 1:1).  The invocation table is paired with the region view in the
   * same pass, so the two always agree on addresses.
   */
  history(conversation: THostConversation): Projection;
  /**
   * Apply region edits to the host conversation.
   *
   * Runs before the producers and eligibility scan so placeholder text
   * is observable through the lens.  The input may be mutated in place or
   * replaced; callers must use the returned conversation.
   *
   * @param conversation - The host conversation before edits.
   * @param edits - Region text replacements to apply.
   * @returns The conversation after edits.
   */
  applyEdits(
    conversation: THostConversation,
    edits: RegionEdit[],
  ): THostConversation;
  /**
   * Materialize the folded view into the host conversation.
   *
   * Runs after producers/fold so the final view replaces or restructures
   * messages.  The input may be mutated in place or replaced; callers must
   * use the returned conversation.
   *
   * @param conversation - The host conversation before rendering.
   * @param items - The folded view items, in view order.
   * @param state - The session state used for summary materialization.
   * @returns The conversation after rendering.
   */
  renderView(
    conversation: THostConversation,
    items: ViewItem[],
    state: unknown,
  ): THostConversation;
  /**
   * Render the folded view and region edits into the host conversation.
   *
   * Equivalent to `applyEdits(conversation, edits)` followed by
   * `renderView(conversation, items, state)`.  The input may be mutated in
   * place or replaced; callers must use the returned conversation.
   *
   * @param conversation - The host conversation before rendering.
   * @param items - The folded view items, in view order.
   * @param edits - Region text replacements to apply.
   * @param state - The session state used for summary materialization.
   * @returns The conversation after rendering.
   */
  render(
    conversation: THostConversation,
    items: ViewItem[],
    edits: RegionEdit[],
    state: unknown,
  ): THostConversation;
  /** Extract the session identifier from the first message, if any. */
  sessionId(conversation: THostConversation): string | undefined;
  /**
   * Append a synthetic user text message to the conversation.
   *
   * Used for context-pressure nudges and manual compress triggers.  The
   * message is appended at the end and is not persisted by the host.  The
   * input may be mutated in place or replaced; callers must use the
   * returned conversation.
   *
   * @param conversation - The host conversation before appending.
   * @param id - The synthetic message id.
   * @param sessionId - The session identifier.
   * @param text - The message text.
   * @returns The conversation after appending.
   */
  appendUserMessage(
    conversation: THostConversation,
    id: string,
    sessionId: string,
    text: string,
  ): THostConversation;
}

/**
 * Reverse-index key of a region address.
 *
 * The `byRegion` map of a `Projection` is keyed by this string; the
 * `ordinal:regionIndex` shape is unique per region address.
 *
 * @param ref - The region address to key.
 * @returns The reverse-index key.
 */
export function regionKey(ref: InvocationRef): string {
  return `${ref.ordinal}:${ref.regionIndex}`;
}

/**
 * Assemble a projection snapshot from the views of one projection pass.
 *
 * Builds the region-address reverse index over every input and output
 * reference of the invocation table in the same call, so adapters only
 * have to supply the two paired views.  When several invocations
 * address the same region (a malformed host projection), the last one
 * wins.
 *
 * @param messages - The lens transcript.
 * @param invocations - The invocation table paired with the transcript.
 * @returns The projection snapshot bundling both views.
 */
export function project(
  messages: HostMessage[],
  invocations: Invocation[],
): Projection {
  const byRegion = new Map<string, Invocation>();
  for (const invocation of invocations) {
    byRegion.set(regionKey(invocation.input), invocation);
    if (invocation.output !== undefined) {
      byRegion.set(regionKey(invocation.output), invocation);
    }
  }
  return { messages, invocations, byRegion };
}

/**
 * Look up the invocation owning a region.
 *
 * @param projection - The projection snapshot holding the reverse index.
 * @param ordinal - Ordinal of the message holding the region.
 * @param regionIndex - Index of the region within the message.
 * @returns The owning invocation, or undefined when the region carries
 *   no pairing information.
 */
export function invocationForRegion(
  projection: Projection,
  ordinal: number,
  regionIndex: number,
): Invocation | undefined {
  return projection.byRegion.get(regionKey({ ordinal, regionIndex }));
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
