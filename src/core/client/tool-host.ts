/**
 * Host tool services contract shared by tool adapters.
 *
 * Declares the host capabilities a tool adapter needs to run against a
 * session: resolving the session id from a tool context, fetching the
 * session history as host-agnostic lens messages, posting a
 * session-scoped system notification that is persisted with the session
 * record (when the host supports it) and is never visible to the model,
 * and — optionally — showing a transient session-scoped toast to the
 * human observer.  Framework-agnostic by design: each host implements
 * this interface against its own SDK instead of tools typing against
 * any host type.
 *
 * @module
 */

import type { HostMessage } from "../context/lens.js";

/**
 * Payload of a transient toast shown to the human observer.
 *
 * `source` names the producing unit (e.g. `"context-pruning"`) and
 * `level` the urgency band; the host port owns the rendering of both
 * (prefix / variant), so producers pass plain parameters and never
 * pre-format.  `text` is a short human-facing sentence — never a model
 * prompt payload.
 */
export interface ToastPayload {
  /** Producing unit name, rendered by the port as the toast origin. */
  source: string;
  /** Urgency band mapped onto the host's own toast severity vocabulary. */
  level: "info" | "warning";
  /** Short human-readable message. */
  text: string;
}

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
  /**
   * Show a transient session-scoped toast to the human observer
   * (optional — only hosts with a UI surface implement it).
   *
   * Contract: fire-and-forget and purely observational — the call is
   * synchronous, never throws (implementations record failures, e.g. a
   * warn log, and swallow them), and never reaches the model.  When the
   * host has no UI surface the call silently drops; the availability
   * guard lives solely in the implementation, so producers never
   * pre-check.  Callers must invoke through an optional call
   * (`toolHost.toast?.(...)`) since a host may not wire the port at
   * all.
   */
  toast?(sessionId: string, toast: ToastPayload): void;
}
