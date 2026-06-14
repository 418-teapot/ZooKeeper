/**
 * Focus Reminder hook for ZooKeeper OpenCode plugin.
 *
 * On every LLM turn (via `experimental.chat.messages.transform`), injects a
 * delegation-flow reminder text part into the last user message for the
 * `build` agent.  This nudges the orchestrator LLM to stay focused on
 * orchestrating rather than implementing.
 *
 * @module
 */

import { log } from "../../utils/logger.js";
import { type Clientish, getAgentName } from "../utils/agent.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Reminder text appended to the last user message on every LLM turn.
 *
 * Reinforces that the build agent must orchestrate — not implement — and
 * specifies the expected delegation flow: understand → choose agent →
 * delegate via `task()` → verify the result.
 */
export const FOCUS_REMINDER =
  "!IMPORTANT! Remember your role: orchestrate, don't implement.\n" +
  "Understand the request \u2192 choose the right agent \u2192 delegate via task() \u2192 verify the result.\n" +
  "Split large tasks — one task() = one focused outcome.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a message within `output.messages`.
 */
export interface MessageInfo {
  role: string;
  id: string;
  sessionID?: string;
  agent?: string;
}

/**
 * A text part within a message's `parts` array.
 */
export interface TextPart {
  type: "text";
  text: string;
}

/**
 * A single message entry in the transform output.
 */
export interface MessageEntry {
  info: MessageInfo;
  parts: TextPart[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Inject the focus reminder into the last user message for the `build` agent.
 *
 * Finds the last message with `role === "user"` and, if the agent is
 * `"build"` (determined via `info.agent` or fallback to
 * `client.getSession()`), pushes a text part containing `FOCUS_REMINDER`
 * onto its `parts` array.
 *
 * This is stateless — no session tracking.  Every LLM turn starts with a
 * fresh messages array, so the reminder is naturally injected exactly once
 * per turn with no duplication risk.
 *
 * @param client - The OpenCode client (captured via closure), or null/undefined.
 * @param output - The hook output object whose `messages` array is mutated in place.
 */
export async function injectFocusReminder(
  client: Clientish | null | undefined,
  output: { messages?: MessageEntry[] },
): Promise<void> {
  const messages = output.messages;
  if (!messages || messages.length === 0) {
    log("focus-reminder", "reminder_skipped", "", undefined, "debug", {
      reason: "no_messages",
    });
    return;
  }

  // Find the last user message
  const lastUserMsg = messages.findLast(
    (m: MessageEntry) => m.info.role === "user",
  );
  if (!lastUserMsg) {
    log("focus-reminder", "reminder_skipped", "", undefined, "debug", {
      reason: "no_user_msg",
    });
    return;
  }

  // Only fall back to client.getSession when info.agent is null/undefined
  // (empty string is treated as a known agent name, just not "build").
  // Use the shared getAgentName helper for the fallback.
  if (lastUserMsg.info.agent == null) {
    const sessionId = lastUserMsg.info.sessionID ?? lastUserMsg.info.id;
    const resolved = await getAgentName(client, sessionId);
    if (resolved != null) {
      lastUserMsg.info.agent = resolved;
    }
  }

  const agent = lastUserMsg.info.agent;

  // Only inject for the build agent
  if (agent !== "build") {
    log(
      "focus-reminder",
      "reminder_skipped",
      lastUserMsg.info.sessionID ?? "",
      undefined,
      "debug",
      {
        reason:
          agent === undefined || agent === null ? "agent_unknown" : "not_build",
      },
    );
    return;
  }

  // Ensure parts array exists
  if (!lastUserMsg.parts) {
    lastUserMsg.parts = [];
  }

  lastUserMsg.parts.push({ type: "text", text: FOCUS_REMINDER });

  log(
    "focus-reminder",
    "reminder_injected",
    lastUserMsg.info.sessionID ?? lastUserMsg.info.id,
    undefined,
    "info",
    {
      agent,
      message_id: lastUserMsg.info.id,
    },
  );
}
