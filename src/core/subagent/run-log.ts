/**
 * Ordered data stream of one subagent run.
 *
 * A run is, at bottom, a stream of two kinds of observation: finalized
 * facts — a user message arrived, a tool call started, a tool call finished,
 * an assistant message completed — and the forming head of the message that
 * is being written right now.  This module stores the facts verbatim (no
 * count caps, no width caps, no display formatting at collection time) and
 * delivers both kinds over ONE totally-ordered stream, so a consumer never
 * has to reason about how independent feeds interleave.  Every consumer (the
 * transcript card, the fleet widget, the session-facade overlay) projects the
 * same stream at its own render boundary, so information is never destroyed
 * before it can be seen.
 *
 * The fact shapes deliberately mirror the raw session events a host driver
 * observes first-hand (pi's `tool_execution_start` / `tool_execution_end`
 * and the assistant `message_end` with its content parts and usage), so a
 * driver can append them with minimal adaptation.  The user-message fact is
 * the one exception: a driver appends it at the moment it sends the run's
 * prompt (see `UserMessageFact`), so the instruction is present and ordered
 * first regardless of how — or when — a host echoes it back as an event.  The types are defined
 * purely here — apart from the plugin's own file logger (used to report a
 * throwing listener), nothing in this module imports a host or SDK API.
 *
 * @module
 */

import { log } from "../../utils/logger.js";

/** A text content part of an assistant message or tool result. */
export interface TextPart {
  type: "text";
  text: string;
}

/** A thinking (reasoning) content part of an assistant message. */
export interface ThinkingPart {
  type: "thinking";
  thinking: string;
}

/** One content part of a completed assistant message. */
export type MessagePart = TextPart | ThinkingPart;

/**
 * Token usage reported with one assistant message.
 *
 * Mirrors the provider usage envelope: `totalTokens` is the convenience
 * total when the host computes one; otherwise `input` + `output` are the
 * parts.  All fields are optional because providers may omit usage.
 */
export interface Usage {
  input?: number;
  output?: number;
  totalTokens?: number;
}

/**
 * The token count one usage report contributes to a run's total.
 *
 * Prefers the provider's `totalTokens`, falling back to `input` + `output`.
 * A missing report, or one whose sum is not a positive finite number,
 * contributes nothing (`undefined`) so a run that never reported usage keeps
 * an absent total rather than a misleading zero.  This is the single
 * definition of "tokens of one message", shared by the render-time counters
 * (`view.ts`) and by any driver that accumulates the total incrementally.
 *
 * @param usage - The per-message usage report, when the provider gave one.
 * @returns The contributed token count, or `undefined` when the report is
 *   absent or non-positive.
 */
export function usageTokens(usage: Usage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  const total = usage.totalTokens ?? 0;
  const reported = total > 0 ? total : (usage.input ?? 0) + (usage.output ?? 0);
  if (!Number.isFinite(reported) || reported <= 0) return undefined;
  return reported;
}

/** Fields shared by every fact: when it happened. */
interface FactBase {
  /** Epoch-millis timestamp of the observed event. */
  at: number;
}

/** A tool execution started. */
export interface ToolStartFact extends FactBase {
  type: "tool_start";
  /** The host tool-call id, when the host reports one. */
  toolCallId?: string;
  /** The tool name. */
  toolName: string;
  /** The full, untruncated call arguments. */
  args: Record<string, unknown>;
}

/** A tool execution finished (with or without an error). */
export interface ToolEndFact extends FactBase {
  type: "tool_end";
  /** The host tool-call id, when the host reports one. */
  toolCallId?: string;
  /** The tool name. */
  toolName: string;
  /** The result content parts (text; other part kinds are dropped by the
   * driver at collection because no projection renders them yet). */
  content: TextPart[];
  /** Whether the tool call ended in an error. */
  isError: boolean;
}

/**
 * A user message observed by the run.
 *
 * In this plugin's usage it is the delegation instruction the run was
 * started with (and any later input the user steered into the sub-session).
 * The driver appends it at the moment it sends the prompt rather than from a
 * message event, so the transcript always opens with what the subagent was
 * asked to do.
 *
 * IMPORTANT for projections: this is not an assistant message.  Anything
 * counting turns or folding token usage over the fact stream must skip it
 * (see `deriveCounters` in `view.ts`); only surfaces that show what the user
 * asked for project it.
 */
export interface UserMessageFact extends FactBase {
  type: "user_message";
  /** The full, untruncated message text. */
  text: string;
}

/** An assistant message completed. */
export interface MessageEndFact extends FactBase {
  type: "message_end";
  /** The full content parts of the finalized message. */
  content: MessagePart[];
  /** The usage report, when the provider reported one. */
  usage?: Usage;
}

/** One observed fact of a run — the union of the four fact kinds. */
export type RunFact =
  | UserMessageFact
  | ToolStartFact
  | ToolEndFact
  | MessageEndFact;

/**
 * One delivery on a run's data stream.
 *
 * `fact` reports a fact that was just appended (and is already readable
 * through `facts()`); `partial` reports the forming head of the run — the
 * accumulated content parts of the assistant message being written, or an
 * empty list when nothing is forming.  The two kinds share one ordered
 * stream, so retirement is mechanical: an `append` that finds a partial
 * delivers `{ kind: "partial", parts: [] }` immediately before its `fact`
 * delivery, in the same dispatch.
 */
export type LogEvent =
  | { kind: "fact"; fact: RunFact }
  | { kind: "partial"; parts: readonly MessagePart[] };

/**
 * A listener of the run's ordered event stream (see `RunLog.subscribe`).
 */
export type RunLogListener = (event: LogEvent, log: RunLog) => void;

/**
 * A listener notified for appended facts only (see `RunLog.onFact`).
 *
 * The filtered convenience over the single stream: partial deliveries are
 * never passed to it.
 */
export type RunFactListener = (fact: RunFact, log: RunLog) => void;

/** The streamable body of one content part (text or thinking). */
function partBody(part: MessagePart): string {
  return part.type === "text" ? part.text : part.thinking;
}

/**
 * Whether two partial part lists carry the same content.
 *
 * A partial arrives as a freshly built array on every streamed delta, so
 * reference equality says nothing; the comparison is by part kind and body.
 *
 * @param a - The incoming partial.
 * @param b - The currently stored partial.
 * @returns True when the two render identically (no notification needed).
 */
function samePartial(
  a: readonly MessagePart[],
  b: readonly MessagePart[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (part, i) => part.type === b[i].type && partBody(part) === partBody(b[i]),
  );
}

/** The stored value of "no partial" (a stable empty-list identity). */
const NO_PARTIAL: readonly MessagePart[] = [];

/**
 * The run's data stream: finalized facts plus the forming head.
 *
 * Facts are never mutated, reordered, or dropped after append, and they are
 * the only part of the stream that persists in `facts()`.  Notifications
 * travel over a single ordered delivery point (`subscribe`), so a projected
 * surface reads the run's state changes in the exact order they happened:
 * a streaming delta, then the fact that finalizes it.  Appends notify the
 * subscribed listeners so the run-change machinery refreshes its consumers
 * (card, fleet widget, overlay).
 *
 * Listener isolation: every listener runs inside a `try`/`catch`.  pi
 * dispatches its own events without protecting subscriber code, and the
 * driver appends facts synchronously from inside that dispatch, so a
 * throwing projection (a UI surface building components from the fact)
 * must never unwind into the host and cost the run a persisted message.
 * The isolation lives here, at the dispatch point, rather than in each
 * consumer: every surface (and any future one) gets the guarantee without
 * having to remember to guard.  The first throw of a log is reported as a
 * warn; later ones are swallowed quietly so a permanently broken listener
 * cannot flood the log.
 *
 * Delivery is never reentrant: a listener that appends (or calls
 * `setPartial`) while events are in flight has its own events queued and
 * delivered after the in-flight ones, so the stream a listener observes is
 * the same total order for every listener (see `dispatch`).
 *
 * The forming head: a run's in-flight assistant message is NOT a fact — the
 * fact record stays an immutable, append-only log of what actually happened.
 * The streamed content instead rides on the tail as projection state
 * (`setPartial` / `partial`), delivered as `{ kind: "partial" }` events on
 * the same stream.  A partial is a list of content parts (text and
 * thinking), so a reasoning stream projects live exactly like a text one
 * instead of appearing only when the message finalizes.  Contract: a partial
 * never appears in `facts()`, is never persisted, and is retired mechanically
 * by the next `append` — which delivers the empty-partial event before its
 * fact event in the same dispatch — so a driver cannot leak a half-message
 * into the record and a streaming surface never has to guess which delivery
 * finalized a message.
 */
export class RunLog {
  /** The facts in append order.  Never mutated after append. */
  private readonly entries: RunFact[] = [];

  /** Listeners of the ordered event stream (see `subscribe`). */
  private readonly listeners = new Set<RunLogListener>();

  /** The transient streaming content riding on the log's tail. */
  private partialParts: readonly MessagePart[] = NO_PARTIAL;

  /** Whether a listener throw has already been reported for this log. */
  private reportedListenerError = false;

  /** Whether this log is inside a delivery (see `dispatch`). */
  private dispatching = false;

  /**
   * Events raised while a delivery was in flight, in the order they were
   * raised (the reentrancy queue drained by the running dispatch).
   */
  private readonly queuedEvents: LogEvent[] = [];

  /**
   * Append one fact to the end of the log and deliver it on the stream.
   *
   * The fact is stored before any listener runs, and a throwing listener is
   * caught (see the class doc): `append` itself never throws.
   *
   * Retirement of the forming head is mechanical here: when a partial is
   * present, its emptying is delivered as a `{ kind: "partial",
   * parts: [] }` event immediately before the `{ kind: "fact" }` event, in
   * one dispatch, so a streaming surface drops the in-flight message at the
   * moment — and only the moment — the fact that replaces it exists.
   *
   * @param fact - The fact to append (stored by reference; the caller must
   *   not mutate it afterwards).
   * @returns The appended fact.
   */
  append(fact: RunFact): RunFact {
    this.entries.push(fact);
    const events: LogEvent[] = [];
    if (this.partialParts !== NO_PARTIAL) {
      this.partialParts = NO_PARTIAL;
      events.push({ kind: "partial", parts: NO_PARTIAL });
    }
    events.push({ kind: "fact", fact });
    this.dispatch(events);
    return fact;
  }

  /**
   * Deliver events to the subscribers in order (throw-isolated, never
   * reentrant).
   *
   * Every event of one dispatch reaches every listener before the next
   * event is delivered, so no surface ever sees the fact that finalizes a
   * message before it sees that message retire.
   *
   * A listener may itself write to the log (append a fact, retire or extend
   * the partial).  Those writes are queued instead of being delivered inside
   * the running delivery, and the queue is drained FIFO once the in-flight
   * events are out — so the stream stays totally ordered and every listener
   * sees the same order, never an interleaving in which a late subscriber is
   * handed a nested event before the outer one it is still mid-delivery of.
   * The queue drains in one loop, so writes made by the flushed events are
   * ordered the same way (no recursion depth in the host's stack).
   *
   * @param events - The events to deliver, in stream order.
   */
  private dispatch(events: readonly LogEvent[]): void {
    for (const event of events) this.queuedEvents.push(event);
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.queuedEvents.length > 0) {
        const event = this.queuedEvents.shift();
        if (event === undefined) break;
        for (const listener of this.listeners) {
          try {
            listener(event, this);
          } catch (error) {
            this.reportListenerError(error);
          }
        }
      }
    } finally {
      // A throw escaping the isolation (a failing report) must not leave the
      // log permanently marked as dispatching, and a half-delivered queue
      // must not leak into the next dispatch as stale events.
      this.dispatching = false;
      this.queuedEvents.length = 0;
    }
  }

  /**
   * Report a listener throw once per log (the isolation's error channel).
   *
   * @param error - The value thrown by the listener.
   */
  private reportListenerError(error: unknown): void {
    if (this.reportedListenerError) return;
    this.reportedListenerError = true;
    const message = error instanceof Error ? error.message : String(error);
    log("run-log", "listener_threw", "", undefined, "warn", { message });
  }

  /**
   * Append a user-message fact.
   *
   * @param text - The full message text (stored untruncated).
   * @param at - Epoch-millis timestamp (defaults to the current time).
   * @returns The appended fact.
   */
  appendUserMessage(text: string, at: number = Date.now()): UserMessageFact {
    const fact: UserMessageFact = { type: "user_message", at, text };
    return this.append(fact) as UserMessageFact;
  }

  /**
   * Append a tool-start fact.
   *
   * @param toolName - The tool that started.
   * @param args - The full call arguments (stored untruncated).
   * @param at - Epoch-millis timestamp (defaults to the current time).
   * @param toolCallId - The host tool-call id, when reported.
   * @returns The appended fact.
   */
  appendToolStart(
    toolName: string,
    args: Record<string, unknown>,
    at: number = Date.now(),
    toolCallId?: string,
  ): ToolStartFact {
    const fact: ToolStartFact = {
      type: "tool_start",
      at,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      toolName,
      args,
    };
    return this.append(fact) as ToolStartFact;
  }

  /**
   * Append a tool-end fact.
   *
   * @param toolName - The tool that finished.
   * @param content - The result content parts (stored untruncated).
   * @param isError - Whether the call ended in an error.
   * @param at - Epoch-millis timestamp (defaults to the current time).
   * @param toolCallId - The host tool-call id, when reported.
   * @returns The appended fact.
   */
  appendToolEnd(
    toolName: string,
    content: TextPart[],
    isError: boolean,
    at: number = Date.now(),
    toolCallId?: string,
  ): ToolEndFact {
    const fact: ToolEndFact = {
      type: "tool_end",
      at,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      toolName,
      content,
      isError,
    };
    return this.append(fact) as ToolEndFact;
  }

  /**
   * Append an assistant-message-completed fact.
   *
   * @param content - The full content parts of the finalized message.
   * @param usage - The provider usage report, when any.
   * @param at - Epoch-millis timestamp (defaults to the current time).
   * @returns The appended fact.
   */
  appendMessage(
    content: MessagePart[],
    usage?: Usage,
    at: number = Date.now(),
  ): MessageEndFact {
    const fact: MessageEndFact = {
      type: "message_end",
      at,
      content,
      ...(usage !== undefined ? { usage } : {}),
    };
    return this.append(fact) as MessageEndFact;
  }

  /**
   * The facts in append order.
   *
   * @returns A read-only view over the stored facts (live: later appends
   *   are visible through the same array reference).
   */
  facts(): readonly RunFact[] {
    return this.entries;
  }

  /** Number of facts appended so far. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Subscribe to the run's ordered event stream.
   *
   * Listeners run synchronously, in subscription order, and see every
   * delivery in stream order.  A listener that writes to the log while a
   * delivery is in flight has its events queued and flushed after the
   * in-flight ones (see `dispatch`), so no listener sees an interleaving.
   * A throwing listener is caught by the dispatcher: the throw never
   * reaches the driver, and the remaining listeners keep being notified.
   *
   * @param listener - Called with each event (fact append or partial change).
   * @returns A function that removes the subscription.
   */
  subscribe(listener: RunLogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe to fact appends only (the filtered convenience over the
   * stream).
   *
   * For consumers whose state depends on the persisted record — the fleet
   * widget's run-change notification, the card — and must therefore stay
   * asleep while a message streams token by token.  Partial deliveries are
   * never passed to the listener.
   *
   * @param listener - Called with each newly appended fact.
   * @returns A function that removes the subscription.
   */
  onFact(listener: RunFactListener): () => void {
    const filtered: RunLogListener = (event, source) => {
      if (event.kind === "fact") listener(event.fact, source);
    };
    return this.subscribe(filtered);
  }

  /**
   * The transient streaming content riding on the log's tail.
   *
   * @returns The accumulated partial parts in order, or an empty list when
   *   nothing streams (never streamed, ended by the driver, or already
   *   finalized by an append).  The list is the log's own; callers must not
   *   mutate it.
   */
  partial(): readonly MessagePart[] {
    return this.partialParts;
  }

  /**
   * Replace the transient streaming content with the accumulated partial.
   *
   * A driver calls this per streamed delta with the whole content accumulated
   * so far for the message now being written (last-write-wins, so a
   * projection never has to sum deltas itself).  Text and thinking parts both
   * belong: the list carries the in-flight message's shape, so a surface can
   * give a reasoning stream the same rendering it gives the finalized fact.
   * The parts are copied into a log-owned list (the part objects themselves
   * are stored by reference and must not be mutated afterwards).  The
   * content never joins the facts, and the next append retires it (see
   * `append`).  A part with
   * no visible body (empty or whitespace-only) is dropped, so a partial with
   * nothing streamable left reads as none.  A value unchanged from the
   * current partial does not notify, so a surface never re-renders for a
   * delta that added nothing.  An empty (or fully blank) list is the explicit
   * end-of-stream marker: it retires the forming head without a fact, which
   * is what a driver sends when a run ends without finalizing its message.
   *
   * @param parts - The accumulated content parts of the in-flight message.
   */
  setPartial(parts: readonly MessagePart[]): void {
    const next = parts.filter((part) => partBody(part).trim().length > 0);
    if (samePartial(next, this.partialParts)) return;
    this.partialParts = next.length > 0 ? next : NO_PARTIAL;
    this.dispatch([{ kind: "partial", parts: this.partialParts }]);
  }
}

/**
 * Create an empty run log.
 *
 * @returns The fresh append-only log.
 */
export function createRunLog(): RunLog {
  return new RunLog();
}
