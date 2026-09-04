/**
 * Cold-start hydration for the pi subagent transcript card.
 *
 * After a pi restart the run registry (process-level state) is empty (or,
 * when the history scanner rebuilt it, holds terminal runs whose `RunLog`
 * never received the delegation's facts), so the transcript card's
 * registry lookup cannot project a restored run's transcript.  This module
 * rebuilds a `RunLog` from the delegation's persisted sub-session jsonl
 * (`result.details.sessionPath`, the only surviving pointer on terminal
 * tool results): parse with pi's official session reader, project the
 * context messages back into `RunFact`s mirroring the driver's append rules
 * (`src/adapters/pi/subagent.ts` `appendRunFact`), and cache the result by
 * pi tool-call id.
 *
 * The cache is deliberately separate from the registry: registering
 * restored runs would make the fleet widget re-list finished history on
 * every card paint, which the card is the only consumer that needs.
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
  type TextPart,
  type Usage,
  type UserMessageFact,
} from "../../core/subagent/run-log.js";

/** Load a session file's text (injectable for tests). */
export type SessionFileReader = (path: string) => Promise<string>;

/** The message-content type of a message-end fact. */
type MessageContent = Extract<RunFact, { type: "message_end" }>["content"];

/** State of a tool-call id's hydration. */
export type HydrationState =
  | { kind: "missing" }
  | { kind: "pending" }
  | { kind: "ready"; log: RunLog }
  | { kind: "failed" };

const defaultReader: SessionFileReader = (path) => readFile(path, "utf-8");

/** Settled hydrations: `null` value marks a failed load. */
const settled = new Map<string, RunLog | null>();
/** In-flight hydrations, keyed by tool-call id. */
const inflight = new Map<string, Promise<void>>();

/**
 * Coerce a raw value to a finite number (usage counters, epoch millis).
 *
 * @param value - The raw value.
 * @returns The finite number, or `undefined`.
 */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Extract the text / thinking parts of an assistant message's content.
 *
 * Mirrors the driver's `toMessageParts`: tool-call blocks are not message
 * content here — they become their own tool-start facts.
 *
 * @param content - The raw message content (array of parts).
 * @returns The projected parts (empty when there is nothing renderable).
 */
function messageParts(content: unknown): MessageContent {
  if (!Array.isArray(content)) return [];
  const parts: MessageContent = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== "object") continue;
    const part = raw as { type?: unknown; text?: unknown; thinking?: unknown };
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      parts.push({ type: "thinking", thinking: part.thinking });
    }
  }
  return parts;
}

/**
 * Project a persisted usage record onto the run-log usage shape.
 *
 * Mirrors the driver's `toUsage`: only finite numbers survive; a record
 * without any usable number yields `undefined`.
 *
 * @param raw - The raw usage object from the message.
 * @returns The usage, or `undefined`.
 */
function toUsage(raw: unknown): Usage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const input = asFiniteNumber(usage.input);
  const output = asFiniteNumber(usage.output);
  const totalTokens = asFiniteNumber(usage.totalTokens);
  if (input === undefined && output === undefined && totalTokens === undefined)
    return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/**
 * Extract the tool-call blocks of an assistant message's content.
 *
 * @param content - The raw message content.
 * @returns The tool-call blocks (name / arguments already narrowed).
 */
function toolCallBlocks(
  content: unknown,
): { id?: string; name: string; args: Record<string, unknown> }[] {
  if (!Array.isArray(content)) return [];
  const blocks: { id?: string; name: string; args: Record<string, unknown> }[] =
    [];
  for (const raw of content) {
    if (raw === null || typeof raw !== "object") continue;
    const part = raw as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (part.type !== "toolCall") continue;
    const name = typeof part.name === "string" ? part.name : "tool";
    const args =
      part.arguments !== null &&
      typeof part.arguments === "object" &&
      !Array.isArray(part.arguments)
        ? (part.arguments as Record<string, unknown>)
        : {};
    blocks.push({
      ...(typeof part.id === "string" ? { id: part.id } : {}),
      name,
      args,
    });
  }
  return blocks;
}

/**
 * Extract the text parts of a tool-result message's content.
 *
 * @param content - The raw content (string or parts array).
 * @returns The text parts.
 */
function textParts(content: unknown): TextPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const parts: TextPart[] = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== "object") continue;
    const part = raw as { type?: unknown; text?: unknown };
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    }
  }
  return parts;
}

/**
 * Extract the plain text of a user message's content.
 *
 * Mirrors pi's own user-text projection: a string content is used directly,
 * an array joins its `text` parts in order (other part kinds are ignored).
 *
 * @param content - The raw content (string or parts array).
 * @returns The joined text (empty when there is none).
 */
function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== "object") continue;
    const part = raw as { type?: unknown; text?: unknown };
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("");
}

/**
 * Convert restored context messages into run-log facts.
 *
 * Mirrors the driver's event-to-fact mapping: a user message yields one
 * user-message fact (the delegation instruction the run was started with,
 * or a later steered input) unless its text is blank; every assistant
 * message yields
 * one message-end fact (text / thinking parts plus usage) — even one with no
 * renderable part, so hydrated and live runs derive the same turn counters —
 * plus one tool-start fact per tool-call block; a tool-result message yields
 * one tool-end fact; everything else (unknown roles) is
 * dropped.  Timestamps come from the message's own epoch millis when
 * finite, else the wall clock.
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
    const at = asFiniteNumber(message.timestamp) ?? Date.now();
    if (message.role === "user") {
      // The live driver appends the prompt as a user-message fact the moment
      // it sends it (see `run()` in `src/adapters/pi/subagent.ts`), so a
      // persisted user message projects to the same fact — that is what lets
      // a hydrated overlay show the delegation instruction.  Blank text
      // renders as an empty box, so it is dropped.
      //
      // Parity assumption: hydration emits one fact per PERSISTED user
      // message, the driver one per `session.prompt()` call, and a
      // sub-session receives exactly one prompt today, so the two agree.
      // If steering into sub-sessions is ever added, both sides gain one
      // fact per prompt, so parity holds by construction.
      const text = userMessageText(message.content);
      if (text.trim().length > 0) {
        const fact: UserMessageFact = { type: "user_message", at, text };
        facts.push(fact);
      }
    } else if (message.role === "assistant") {
      // The live driver appends one message-end fact per assistant
      // `message_end` event regardless of what it carries (see
      // `appendRunFact` in `src/adapters/pi/subagent.ts`), so hydration does
      // the same: an assistant message with no renderable part still counts
      // as a turn (tool-call-only turns), keeping the derived turn counters
      // identical for live and hydrated runs.
      const content = messageParts(message.content);
      const usage = toUsage(message.usage);
      facts.push({
        type: "message_end",
        at,
        content,
        ...(usage === undefined ? {} : { usage }),
      });
      for (const block of toolCallBlocks(message.content)) {
        facts.push({
          type: "tool_start",
          at,
          ...(block.id !== undefined ? { toolCallId: block.id } : {}),
          toolName: block.name,
          args: block.args,
        });
      }
    } else if (message.role === "toolResult") {
      facts.push({
        type: "tool_end",
        at,
        ...(typeof message.toolCallId === "string"
          ? { toolCallId: message.toolCallId }
          : {}),
        toolName:
          typeof message.toolName === "string" ? message.toolName : "tool",
        content: textParts(message.content),
        isError: message.isError === true,
      });
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
      settled.set(toolCallId, log ?? null);
      onSettled?.();
    },
    () => {
      inflight.delete(toolCallId);
      settled.set(toolCallId, null);
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
