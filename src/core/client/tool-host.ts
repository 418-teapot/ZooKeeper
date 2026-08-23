/**
 * Host tool services contract shared by tool adapters.
 *
 * Declares the three host capabilities a tool adapter needs to run
 * against a session: resolving the session id from a tool context,
 * fetching the session history as host-agnostic lens messages, and
 * posting a best-effort ignored chat notification.  Framework-agnostic
 * by design: each host implements this interface against its own SDK
 * instead of tools typing against any host type.
 *
 * @module
 */

import type { HostMessage } from "../context/lens.js";

/**
 * Host services a tool adapter needs to run against a session.
 */
export interface ToolHost {
  /** Resolve the session id from a tool execution context. */
  resolveSessionId(toolCtx: unknown): string | undefined;
  /** Fetch the session's full history as host-agnostic lens messages. */
  fetchHistory(sessionId: string): Promise<HostMessage[]>;
  /** Post an ignored chat notification, swallowing failures. */
  notify(sessionId: string, text: string): Promise<void>;
}
