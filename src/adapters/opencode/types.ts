/**
 * OpenCode v1 message shapes, the session client slice, and the pure
 * helpers that read messages.
 *
 * This is the OpenCode adapter's home for the v1 message shapes
 * (`ContextMessageEntry { info, parts }` and friends) plus the small
 * pure helpers (`getCallId`, `isMessageIgnored`) that classify them.
 * The shapes describe the host messages as they arrive at the
 * `messages.transform` hook, so they belong here — not in the
 * framework-agnostic core.  `SessionClient` likewise types the v1
 * client slice the tools, the `/dcp` handler, and the tool host consume.
 *
 * Context measurement and reporting live in `src/core/context/` (the
 * lens pipeline, consumed by the sidebar and `/dcp`); this module holds
 * no estimation, report, or cache logic.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Token information on a completed assistant message.
 */
export interface ContextTokenInfo {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: {
    read?: number;
    write?: number;
  };
}

/**
 * Minimal shape of `info` within a message entry.
 */
export interface ContextMessageInfo {
  role: string;
  id: string;
  sessionID?: string;
  tokens?: ContextTokenInfo;
  agent?: string;
  /** Whether this message is a compaction summary placeholder. */
  summary?: boolean;
  /** Whether this message is a synthetic compression block summary. */
  synthetic?: boolean;
}

/**
 * A text part within a message's `parts` array.
 */
export interface ContextTextPart {
  type: string;
  text?: string;
}

/**
 * A single message entry in the hook output.
 */
export interface ContextMessageEntry {
  info: ContextMessageInfo;
  parts?: ContextTextPart[];
}

// ---------------------------------------------------------------------------
// Session client — v1 session slice
// ---------------------------------------------------------------------------

/**
 * Minimal OpenCode v1 session client slice consumed by the
 * context-management units.
 *
 * Consumed by the `/dcp` command handler, the compress/decompress tool
 * adapters, and the v1 tool host; declares only the session APIs
 * (`session.messages`, `session.prompt`, `session.get`) those units
 * use, since the full v1 client is much larger.  `session.prompt`
 * carries the optional `agent` field so a notification can address the
 * session agent explicitly (without it OpenCode switches the session to
 * the default agent); `session.get` is the per-call fallback used to
 * resolve an unknown session agent.
 */
export interface SessionClient {
  session?: {
    messages?: (input: {
      path: { id: string };
    }) => Promise<{ data?: unknown } | unknown[]>;
    prompt?: (input: {
      path: { id: string };
      body: {
        noReply?: boolean;
        parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
        agent?: string;
      };
    }) => Promise<unknown>;
    get?: (input: {
      path: { id: string };
    }) => Promise<{ agent?: string } | undefined>;
  };
}

// ---------------------------------------------------------------------------
// Helpers — v1 message classification
// ---------------------------------------------------------------------------

/**
 * Extract the callID from a part, checking multiple possible field names.
 *
 * OpenCode SDK may expose the call identifier as `callID` or `callId`.
 *
 * @param part - A message part.
 * @returns The call identifier string, or undefined.
 */
export function getCallId(part: unknown): string | undefined {
  const p = part as Record<string, unknown>;
  return (p.callID as string) ?? (p.callId as string) ?? undefined;
}

/**
 * Determine whether a message is an "ignored" user message.
 *
 * A user message is considered ignored when:
 * - Its `info.ignored` field is truthy, OR
 * - All of its parts have `ignored: true`
 *
 * Empty-parts messages are NOT considered ignored.
 *
 * @param msg - The message entry to check.
 * @returns `true` if the message should be skipped.
 */
export function isMessageIgnored(msg: ContextMessageEntry): boolean {
  if (!msg) return false;
  if (msg.info) {
    const info = msg.info as unknown as Record<string, unknown>;
    if (info.ignored) return true;
  }

  const parts = msg.parts;
  if (!parts || parts.length === 0) return false;
  return parts.every((p) => {
    const textPart = p as { ignored?: boolean };
    return textPart.ignored === true;
  });
}
