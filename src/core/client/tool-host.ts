/**
 * Host tool services contract shared by tool adapters.
 *
 * Declares the host capabilities a tool adapter needs to run against a
 * session: resolving the session id from a tool context, posting a
 * session-scoped system notification that is persisted with the session
 * record (when the host supports it) and is never visible to the model,
 * and — optionally — showing a transient session-scoped toast to the
 * human observer.  Framework-agnostic by design: each host implements
 * this interface against its own SDK instead of tools typing against
 * any host type.
 *
 * The one optional capability is `fetchHistory`.  Its two consumers rank
 * the sources differently: the compression tools address the round view
 * published by the context transform (see `core/context/round-view.ts`)
 * and consult this read only when no round view exists, while `/dcp`
 * prefers the live host read — fresher for a usage report — and falls
 * back to the published round view.  Either way a host may implement it
 * only when its read path is provably the same source the transform
 * projects; a host whose read lands in a different ordinal space must
 * not implement it at all.
 *
 * @module
 */

import type { Projection } from "../context/lens.js";

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
  /**
   * Fetch the session's full history as a host-agnostic projection
   * snapshot (lens transcript + invocation table).
   *
   * Optional.  The two consumers rank it differently:
   *
   * - The compression tools treat it as a FALLBACK: they address the
   *   folded view the context transform published for the current round
   *   and consult this method only when no round view exists yet (e.g.
   *   the very first turn, before any transform ran).
   * - The `/dcp` command treats it as its PREFERRED read — a live host
   *   read is fresher than a cached view for a usage report — and falls
   *   back to the published round view when the host wires no history.
   *
   * A host may implement it only when its read path is provably the
   * same source the transform projects — same storage, same projection
   * — so the ordinal space agrees.  A host that cannot make that claim
   * must leave the method absent rather than hand back a snapshot in a
   * different address space.
   */
  fetchHistory?(sessionId: string): Promise<Projection>;
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
