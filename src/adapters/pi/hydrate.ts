/**
 * Cold-start hydration for the pi subagent transcript card.
 *
 * After a pi restart the run registry (process-level state) is empty (or,
 * when the history scanner rebuilt it, holds terminal runs whose `RunLog`
 * never received the delegation's facts), and runs finished live lose their
 * in-memory log the moment they finish (the registry keeps metadata only),
 * so the transcript card's registry lookup cannot project a finished run's
 * transcript.  This module
 * rebuilds a `RunLog` from the delegation's persisted sub-session jsonl
 * (`result.details.sessionPath`, the only surviving pointer on terminal
 * tool results): parse with pi's official session reader and project the
 * context messages into `RunFact`s through the shared projection layer
 * (`run-facts.ts`, the same rules the live driver applies to the events of
 * the same activity), then cache the result by pi tool-call id.
 *
 * The cache is deliberately separate from the registry: registering
 * restored runs would make the fleet widget re-list finished history on
 * every card paint, which the card is the only consumer that needs.  It is
 * also bounded — a small fixed capacity (see `SETTLED_CAPACITY`) with FIFO
 * eviction — because finished-run transcripts live on the session files,
 * not in resident memory: the cache only avoids reloading the handful of
 * runs a view revisits around a finish.
 *
 * @module
 */
import { readFile } from "node:fs/promises";
import {
  parseSessionEntries,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  createRunLog,
  type RunFact,
  type RunLog,
} from "../../core/subagent/run-log.js";
import {
  messageEndFact,
  projectToolCalls,
  toolEndFact,
  toolStartFact,
  userMessageFact,
} from "./run-facts.js";

/** Load a session file's text (injectable for tests). */
export type SessionFileReader = (path: string) => Promise<string>;

/** State of a tool-call id's hydration. */
export type HydrationState =
  | { kind: "missing" }
  | { kind: "pending" }
  | { kind: "ready"; log: RunLog }
  | { kind: "failed" };

const defaultReader: SessionFileReader = (path) => readFile(path, "utf-8");

/**
 * The settled-cache capacity.
 *
 * Finished-run views rebuild their transcripts from disk through this cache;
 * a small fixed capacity keeps resident memory bounded (finished runs live
 * on the session files, not here) while comfortably serving the handful of
 * runs a user inspects around a finish.
 */
const SETTLED_CAPACITY = 8;

/** Settled hydrations: `null` value marks a failed load.  Bounded — the
 * oldest entry is evicted beyond `SETTLED_CAPACITY` (FIFO). */
const settled = new Map<string, RunLog | null>();
/** In-flight hydrations, keyed by tool-call id. */
const inflight = new Map<string, Promise<void>>();

/**
 * Store one settled hydration, evicting the oldest entry beyond capacity.
 *
 * `beginHydration` guards re-entry, so each id is stored exactly once and
 * the first key is the oldest — the FIFO eviction target.
 *
 * @param toolCallId - The tool-call id to store under.
 * @param log - The rebuilt log, or `null` for a failed load.
 */
function cacheSettled(toolCallId: string, log: RunLog | null): void {
  settled.set(toolCallId, log);
  if (settled.size > SETTLED_CAPACITY) {
    const oldest = settled.keys().next().value;
    if (oldest !== undefined) settled.delete(oldest);
  }
}

/**
 * Convert restored context messages into run-log facts.
 *
 * The projection rules are the shared ones (`run-facts.ts`), so a replayed
 * run and a live run derive the same facts from the same activity: a user
 * message yields one user-message fact unless its text is blank; every
 * assistant message yields one message-end fact (text / thinking parts plus
 * usage) — even one with no renderable part, so hydrated and live runs derive
 * the same turn counters — plus one tool-start fact per tool-call block; a
 * tool-result message yields one tool-end fact; everything else (unknown
 * roles) is dropped.  Timestamps come from the message's own epoch millis
 * when finite, else the wall clock.
 *
 * @param messages - The context messages (duck-typed; untrusted shapes).
 * @returns The facts, in message order.
 */
export function factsFromContextMessages(
  messages: readonly unknown[],
): RunFact[] {
  const facts: RunFact[] = [];
  for (const raw of messages) {
    if (raw === null || typeof raw !== "object") continue;
    const message = raw as {
      role?: unknown;
      content?: unknown;
      timestamp?: unknown;
      usage?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      isError?: unknown;
    };
    const stamp = message.timestamp;
    const at =
      typeof stamp === "number" && Number.isFinite(stamp) ? stamp : Date.now();
    if (message.role === "user") {
      const fact = userMessageFact(message.content, at);
      if (fact !== undefined) facts.push(fact);
    } else if (message.role === "assistant") {
      // One message-end fact per assistant message regardless of what it
      // carries: an assistant message with no renderable part still counts
      // as a turn (tool-call-only turns), so the derived turn counters stay
      // identical for live and replayed runs.
      facts.push(messageEndFact(message.content, message.usage, at));
      for (const block of projectToolCalls(message.content)) {
        facts.push(toolStartFact(block, at));
      }
    } else if (message.role === "toolResult") {
      facts.push(
        toolEndFact(
          {
            toolCallId:
              typeof message.toolCallId === "string"
                ? message.toolCallId
                : undefined,
            toolName:
              typeof message.toolName === "string" ? message.toolName : "tool",
            content: message.content,
            isError: message.isError === true,
          },
          at,
        ),
      );
    }
  }
  return facts;
}

/**
 * Project the messages of one parsed session entry onto LLM messages.
 *
 * `sessionEntryToContextMessages` returns the message(s) an entry
 * contributes to the model context (a plain message entry returns its
 * message; a compaction returns its summary); entries that contribute
 * nothing yield an empty list.
 *
 * @param messages - The context messages from the session file.
 * @returns The projected LLM messages.
 */
function contextMessagesFromText(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const entry of parseSessionEntries(text)) {
    if (entry.type === "session") continue;
    messages.push(...sessionEntryToContextMessages(entry));
  }
  return messages;
}

/**
 * Load a delegation's sub-session file as a run log.
 *
 * A missing / unreadable / unparseable file yields `undefined` (the caller
 * falls back to the delivered result text); the load never throws.
 *
 * @param sessionPath - The sub-session jsonl path.
 * @param read - Optional file reader (test seam).
 * @returns The rebuilt run log, or `undefined` on any failure.
 */
export async function loadRunLog(
  sessionPath: string,
  read: SessionFileReader = defaultReader,
): Promise<RunLog | undefined> {
  try {
    const text = await read(sessionPath);
    const messages = contextMessagesFromText(text);
    const log = createRunLog();
    for (const fact of factsFromContextMessages(messages)) {
      log.append(fact);
    }
    return log;
  } catch {
    return undefined;
  }
}

/**
 * Current hydration state for a tool-call id.
 *
 * @param toolCallId - The pi tool-call id (the card's registry key).
 * @returns The state (see `HydrationState`).
 */
export function hydrationState(toolCallId: string): HydrationState {
  if (inflight.has(toolCallId)) return { kind: "pending" };
  const hit = settled.get(toolCallId);
  if (hit === undefined && !settled.has(toolCallId)) return { kind: "missing" };
  return hit === null || hit === undefined
    ? { kind: "failed" }
    : { kind: "ready", log: hit };
}

/**
 * Start a hydration if none exists for this id (idempotent).
 *
 * A pending or settled hydration is never restarted; the load runs
 * asynchronously and `onSettled` fires exactly once when it completes
 * (success or failure) so the caller can repaint.
 *
 * @param toolCallId - The pi tool-call id to cache under.
 * @param sessionPath - The sub-session jsonl to parse.
 * @param onSettled - Callback fired once the load settles.
 * @param load - Optional loader (test seam).
 */
export function beginHydration(
  toolCallId: string,
  sessionPath: string,
  onSettled?: () => void,
  load: (path: string) => Promise<RunLog | undefined> = loadRunLog,
): void {
  if (settled.has(toolCallId) || inflight.has(toolCallId)) return;
  const task = load(sessionPath).then(
    (log) => {
      inflight.delete(toolCallId);
      cacheSettled(toolCallId, log ?? null);
      onSettled?.();
    },
    () => {
      inflight.delete(toolCallId);
      cacheSettled(toolCallId, null);
      onSettled?.();
    },
  );
  inflight.set(toolCallId, task);
}

/**
 * Await the in-flight hydration for an id (resolves immediately when the
 * id is not pending).  The await handle for callers that must act once a
 * load settles — including one that joined a hydration started elsewhere
 * (whose `onSettled` belongs to that first caller).  Tests use it for
 * deterministic repaint assertions.
 *
 * @param toolCallId - The pi tool-call id.
 * @returns A promise resolving once the hydration settles.
 */
export async function waitForHydration(toolCallId: string): Promise<void> {
  const task = inflight.get(toolCallId);
  if (task !== undefined) await task;
}

/**
 * Clear all hydration state (test isolation helper).
 */
export function resetHydration(): void {
  settled.clear();
  inflight.clear();
}
