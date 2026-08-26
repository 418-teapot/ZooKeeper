/**
 * Host tool services contract shared by tool adapters.
 *
 * Declares the three host capabilities a tool adapter needs to run
 * against a session: resolving the session id from a tool context,
 * fetching the session history as host-agnostic lens messages, and
 * posting a session-scoped system notification that is persisted with
 * the session record (when the host supports it) and is never visible
 * to the model.  Framework-agnostic by design: each host implements
 * this interface against its own SDK instead of tools typing against
 * any host type.
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
  /**
   * Post a session-scoped system notification.
   *
   * Contract: the notice is persisted in the session record when the
   * host supports it, is never visible to the model, and is
   * best-effort — `notify` never rejects.  Implementations record
   * failures (e.g. a warn log) and always resolve, so callers must not
   * wrap the call in try/catch expecting a rejection.
   */
  notify(sessionId: string, text: string): Promise<void>;
}
