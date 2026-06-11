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

import { debug } from "../shared/logger.js";

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
  "Understand the request \u2192 choose the right agent \u2192 delegate via task() \u2192 verify the result.";

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

/**
 * Minimal client interface required by this hook.
 */
export interface Clientish {
  getSession?: (id: string) => Promise<{ agent?: string }>;
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
  if (!messages || messages.length === 0) return;

  // Find the last user message
  const lastUserMsg = messages.findLast(
    (m: MessageEntry) => m.info.role === "user",
  );
  if (!lastUserMsg) return;

  // Determine the agent name.
  // Only fall back to client.getSession when info.agent is null/undefined
  // (empty string is treated as a known agent name, just not "build").
  let agent = lastUserMsg.info.agent;

  if (agent == null && client?.getSession) {
    const sessionId = lastUserMsg.info.sessionID ?? lastUserMsg.info.id;
    try {
      const session = await client.getSession(sessionId);
      agent = session?.agent;
    } catch {
      // Swallow errors from the session lookup
    }
  }

  // Only inject for the build agent
  if (agent !== "build") return;

  // Ensure parts array exists
  if (!lastUserMsg.parts) {
    lastUserMsg.parts = [];
  }

  lastUserMsg.parts.push({ type: "text", text: FOCUS_REMINDER });

  debug("focus-reminder", {
    agent,
    sessionId: lastUserMsg.info.id,
  });
}
