/**
 * OpenCode host adapter — settled-turn cause classification.
 *
 * Classifies why a session's turn ended for the loop engine's settle
 * strategies, and reports whether the settled turn made any tool call.
 * The abort this host observed on `session.error` is checked first (cheap
 * and explicit) through the session's own record, which is consumed once so
 * it cannot linger; otherwise the transcript is inspected for an aborted
 * last assistant turn or an unanswered question tool call.  The same
 * transcript fetch yields the turn's tool calls, reduced to the plain
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
 * The abort record of one session, as the classifier consumes it.
 *
 * It is owned by the session scope (see `services.ts`), so classifying one
 * session's settle can never consume another session's abort.
 */
export interface AbortRecord {
  /**
   * Claim the abort observed for this session.
   *
   * @returns Whether an abort was recorded since the last claim.
   */
  takeAborted(): boolean;
}

/**
 * Classify why a settled session's turn ended, and whether it had activity.
 *
 * @param client - The host client (may lack `session.messages`).
 * @param abortRecord - The settled session's abort record; consumed once.
 * @param sessionID - The settled session.
 * @returns The cause and activity fact, or `null` when unobservable.
 */
export async function classifyStopCause(
  client: MessagesClient | undefined,
  abortRecord: AbortRecord,
  sessionID: string,
): Promise<IdleOutcome | null> {
  if (abortRecord.takeAborted()) {
    return { cause: "aborted", hadActivity: false };
  }
  const fetchMessages = client?.session?.messages;
  if (typeof fetchMessages !== "function") {
    log.warn({
      hook: "loop",
      event: "cause_unobservable",
      sessionId: sessionID,
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
      log.warn({
        hook: "loop",
        event: "cause_unobservable",
        sessionId: sessionID,
        reason: "messages payload not an array",
      });
      return null;
    }
    messages = data as IdleMessageEntry[];
  } catch (err) {
    log.warn({
      hook: "loop",
      event: "cause_unobservable",
      sessionId: sessionID,
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
