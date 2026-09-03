/**
 * Pi live-transcript event bus — forwards the child session's stream events
 * from the subagent driver to the transcript overlay.
 *
 * The subagent driver (`src/adapters/pi/subagent.ts`) receives the child
 * session's full `AgentSessionEvent` stream on its subscription and forwards
 * each event (keyed by the child session id) onto this bus; the transcript
 * overlay (`src/adapters/pi/tui/transcript.ts`) subscribes for the run's
 * child session and renders from what survives the narrowing: assistant
 * text incrementally from the streamed partials, finalized records as they
 * close, live tool components mounted from the tool-execution bookends, and
 * a run-end marker that closes a stream whose final `message_end` never
 * arrived — all event-driven, no polling, no repeated full re-parse.
 *
 * The bus lives in the pi adapter layer deliberately: core
 * (`src/core/*`) never imports pi event types, and both the producer (the
 * driver) and the consumer (the overlay) sit in `src/adapters/pi/`.
 *
 * Lifecycle: the driver emits for a session id while its run is active;
 * an overlay subscribes for the run's child session (read off the registry
 * run) and unsubscribes on close.  Both sides are optional — a run with no
 * open overlay emits into the void (a no-op), and a historical run's overlay
 * never subscribes (it renders the file, which is final).
 *
 * The forwarded payload is host-neutral: events are narrowed to a duck
 * shape (the message object, or the call facts of a tool bookend), so
 * consumers never need pi types.  The bus narrows the raw stream to what
 * the overlay renders from: finalized messages (`message_end`, user /
 * assistant / toolResult), the streaming lifecycle of assistant messages
 * (`message_start` opens the live partial, `message_update` carries the
 * accumulated partial message), the `tool_execution_start` /
 * `tool_execution_end` bookends (tool execution start/end keyed by call id,
 * so a running tool and its result render before the `toolResult` record
 * closes), and the bare `agent_end` run-end marker (no payload — the
 * overlay only needs to know the run ended).  Only assistant messages
 * stream — user and toolResult messages are injected whole (pi emits their
 * `message_start` / `message_end` back to back), so their lifecycle events
 * are dropped and their records render from the `message_end` alone.  The
 * partial-output `tool_execution_update` and everything else the overlay
 * does not render from (`turn_end`, roles outside user / assistant /
 * toolResult) are dropped at the bus boundary, so the driver can forward
 * the full stream without pre-filtering.
 *
 * Module-level state plus `resetTranscriptBus()` for tests.
 *
 * @module
 */

/**
 * A live transcript event forwarded to overlay subscribers.
 *
 * The union mirrors the pi `AgentSessionEvent` shapes the overlay renders
 * from: the streaming lifecycle of an assistant message (`message_start` /
 * `message_update`, carrying the accumulated partial message) closed by the
 * finalized record (`message_end`, user / assistant / toolResult); the
 * tool-execution bookends (`tool_execution_start` mounts the live tool
 * component, `tool_execution_end` delivers its result) narrowed to their
 * host-neutral call facts; and the bare `agent_end` run-end marker, which
 * tells the overlay the stream is over even when the final `message_end`
 * never arrived.
 */
export type LiveTranscriptEvent =
  | { type: "message_start"; message: unknown }
  | { type: "message_update"; message: unknown }
  | { type: "message_end"; message: unknown }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "agent_end" };

/** A subscriber callback receiving forwarded transcript events. */
export type LiveTranscriptListener = (event: LiveTranscriptEvent) => void;

/** The module-level subscriber table, keyed by child session id. */
const subscribers = new Map<string, Set<LiveTranscriptListener>>();

/**
 * Reset the module-level subscriber table.
 *
 * Process-global state means tests share one isolate; call this between
 * tests (and on overlay close) so listeners never leak.
 */
export function resetTranscriptBus(): void {
  subscribers.clear();
}

/**
 * Subscribe to a child session's live transcript events.
 *
 * @param sessionId - The child session id whose events to receive.
 * @param listener - The callback invoked per forwarded event.
 * @returns An unsubscribe function (idempotent).
 */
export function subscribeTranscript(
  sessionId: string,
  listener: LiveTranscriptListener,
): () => void {
  let listeners = subscribers.get(sessionId);
  if (listeners === undefined) {
    listeners = new Set();
    subscribers.set(sessionId, listeners);
  }
  listeners.add(listener);
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    const set = subscribers.get(sessionId);
    if (set === undefined) return;
    set.delete(listener);
    if (set.size === 0) subscribers.delete(sessionId);
  };
}

/**
 * Narrow an unknown event to its forwarded form, or `undefined` when the
 * event type carries nothing the overlay renders.
 *
 * The bus carries the finalized messages (`message_end`) of the roles the
 * overlay renders (user / assistant / toolResult), the streaming lifecycle
 * of assistant messages (`message_start` / `message_update`, each carrying
 * the message object — for updates that is the accumulated partial message,
 * so the raw `assistantMessageEvent` delta envelope is dropped), the
 * tool-execution bookends narrowed to their host-neutral call facts (the
 * call id keys the overlay's live tool component; a bookend without a
 * usable id carries nothing to render from and is dropped), and the bare
 * `agent_end` run-end marker (its message list is stripped — the overlay
 * only needs the fact that the run ended).  Only assistant messages stream:
 * user and toolResult messages arrive whole (`message_start` /
 * `message_end` back to back), so their lifecycle events are dropped and
 * the record renders from the `message_end` alone.  Other roles (custom,
 * compaction summaries, branch summaries), the partial-output
 * `tool_execution_update`, and everything else (`turn_end`) are dropped at
 * the bus boundary, so the driver can forward the full stream without
 * pre-filtering.
 *
 * @param event - The raw event to narrow.
 * @returns The forwarded event, or `undefined` to drop.
 */
function narrowEvent(event: unknown): LiveTranscriptEvent | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const raw = event as Record<string, unknown>;
  const type = raw.type;
  if (type === "agent_end") return { type: "agent_end" };
  if (type === "tool_execution_start" || type === "tool_execution_end") {
    const toolCallId = raw.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) {
      return undefined;
    }
    const toolName =
      typeof raw.toolName === "string" && raw.toolName.length > 0
        ? raw.toolName
        : "tool";
    if (type === "tool_execution_start") {
      return {
        type: "tool_execution_start",
        toolCallId,
        toolName,
        args: raw.args,
      };
    }
    return {
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: raw.result,
      isError: raw.isError === true,
    };
  }
  if (
    type !== "message_start" &&
    type !== "message_update" &&
    type !== "message_end"
  ) {
    return undefined;
  }
  const message = raw.message;
  if (message === null || typeof message !== "object") return undefined;
  const role = (message as Record<string, unknown>).role;
  if (type === "message_end") {
    if (role !== "user" && role !== "assistant" && role !== "toolResult") {
      return undefined;
    }
    return { type: "message_end", message };
  }
  // Streaming lifecycle: only assistant messages produce live partials.
  if (role !== "assistant") return undefined;
  return { type, message };
}

/**
 * Forward an event to a session's subscribers.
 *
 * The event is narrowed to its forwarded form at the bus boundary —
 * events the overlay does not render from are dropped.  Emitting with no
 * subscribers is a no-op (an overlay is optional for any given run).
 *
 * @param sessionId - The child session id the event belongs to.
 * @param event - The raw event to forward.
 */
export function emitTranscriptEvent(sessionId: string, event: unknown): void {
  const narrowed = narrowEvent(event);
  if (narrowed === undefined) return;
  const listeners = subscribers.get(sessionId);
  if (listeners === undefined) return;
  // Copy so a subscriber unsubscribing mid-dispatch does not disturb the
  // iteration.
  for (const listener of [...listeners]) {
    try {
      listener(narrowed);
    } catch {
      // A throwing overlay listener must never break the subagent run.
    }
  }
}
