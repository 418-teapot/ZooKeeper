/**
 * OpenCode host adapter — settled-turn cause classification.
 *
 * Classifies why a session's turn ended for the loop engine's settle
 * strategies, and reports whether the settled turn made any tool call.
 * The `session.error` flag recorded by the always-on event hook is checked
 * first (cheap and explicit); otherwise the transcript is inspected for an
 * aborted last assistant turn or an unanswered question tool call.  The
 * same transcript fetch yields the turn's tool calls, reduced to the plain
 * activity fact the engine uses for its awaiting-progress lock.  When the
 * transcript cannot be read the signal is unobservable, so the caller must
 * fail closed and skip — the classifier returns `null`.
 *
 * @module
 */

import type { StopCause } from "../../core/loop/index.js";
import { log } from "../../utils/logger.js";
import {
  countTurnToolCalls,
  hasUnansweredQuestion,
  type IdleMessageEntry,
  lastAssistantAborted,
} from "./message-shape.js";

/** The minimal client surface read while classifying a settle cause. */
interface MessagesClient {
  session?: {
    messages?: (input: { path: { id: string } }) => Promise<unknown>;
  };
}

/** The classified settle outcome plus the turn's activity fact. */
export interface IdleOutcome {
  cause: StopCause;
  hadActivity: boolean;
}

/**
 * Classify why a settled session's turn ended, and whether it had activity.
 *
 * @param client - The host client (may lack `session.messages`).
 * @param abortedSessions - Sessions with an observed abort; consumed once.
 * @param sessionID - The settled session.
 * @returns The cause and activity fact, or `null` when unobservable.
 */
export async function classifyStopCause(
  client: MessagesClient | undefined,
  abortedSessions: Set<string>,
  sessionID: string,
): Promise<IdleOutcome | null> {
  if (abortedSessions.delete(sessionID)) {
    return { cause: "aborted", hadActivity: false };
  }
  const fetchMessages = client?.session?.messages;
  if (typeof fetchMessages !== "function") {
    log("loop", "cause_unobservable", sessionID, undefined, "warn", {
      reason: "session.messages unavailable",
    });
    return null;
  }
  let messages: IdleMessageEntry[];
  try {
    const res = await fetchMessages({ path: { id: sessionID } });
    const data = Array.isArray(res)
      ? res
      : (res as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data)) {
      log("loop", "cause_unobservable", sessionID, undefined, "warn", {
        reason: "messages payload not an array",
      });
      return null;
    }
    messages = data as IdleMessageEntry[];
  } catch (err) {
    log("loop", "cause_unobservable", sessionID, undefined, "warn", {
      reason: "messages fetch failed",
      error: String(err),
    });
    return null;
  }
  const hadActivity = countTurnToolCalls(messages) > 0;
  if (lastAssistantAborted(messages)) {
    return { cause: "aborted", hadActivity };
  }
  if (hasUnansweredQuestion(messages)) {
    return { cause: "awaiting-input", hadActivity };
  }
  return { cause: "settled", hadActivity };
}
