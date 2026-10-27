/**
 * Live pi extension context — the extension-scope port every pi surface
 * reads the current event context from.
 *
 * pi hands a fresh `ExtensionContext` to every event handler.  The adapter
 * (session id), the tool host (toasts), the fleet widget (editor text,
 * overlay opener) and the switch host (command context, UI) all need the
 * latest one, so exactly one extension-scoped service owns it: the handlers
 * publish, everyone else reads.  Owning the pointer in a service ties its
 * lifetime to the extension scope — a stopped extension no longer serves a
 * context — instead of leaving it in an unnamed local of the entry point.
 *
 * Two views are served, and one is not a substitute for the other:
 *
 *  - {@link PiLiveContext.current} is the latest published context of the
 *    event being handled.  It answers "which surface is active right now"
 *    (the editor text, the overlay opener, the command context) and MUST
 *    NOT be used to read session-owned state, because two interleaved
 *    sessions would let one read the other's transcript.
 *  - {@link PiLiveContext.forSession} is the context published for one
 *    session id.  Session-owned readers (the todo transcript scan, the
 *    session's fleet ui) resolve their session's own context through it and
 *    fail closed when that session published none.
 *
 * Publishing an absent context is a no-op, not a clear: pi never retracts a
 * context, and an entry path without one (a session-less handler call) must
 * not blank a live surface.  {@link PiLiveContext.release} is the explicit
 * clear, run when the extension scope stops; it is terminal, so a late
 * event can neither revive the latest pointer nor index a session.
 *
 * The per-session index holds one entry per session scope that published.
 * pi fires no session-deletion event, and the index must not guess when a
 * session died, so its lifetime is the extension scope's: an entry stays
 * until {@link PiLiveContext.releaseSession} (that session scope stopped)
 * or the extension scope releases.  Retirement is terminal — the kernel
 * never hands a stopped session id out again, so a late event of that
 * session must not re-index it nor become the live surface — and it lives
 * no longer than the context that owns it.
 *
 * @module
 */

import type { PiToolHostContext } from "./tool-host.js";

/**
 * The latest pi event context, published by the handlers.
 *
 * A narrow read/write port: the handlers publish, every other surface reads
 * a value, the session id, or one session's own context.  No session-scoped
 * state is reachable through it, so a service that depends on this port
 * never captures a session object.
 */
export interface PiLiveContext {
  /** Publish the context of the event now being handled. */
  publish(ctx?: unknown): void;
  /** The latest published context, or undefined when none is live. */
  current(): PiToolHostContext | undefined;
  /** The live session id pi keeps on the latest context. */
  sessionId(): string | undefined;
  /**
   * The context published for one session.
   *
   * The reader names the session it serves, so an interleaved second
   * session's context is never returned.  An absent, blank, unpublished,
   * released or released-then-republished id yields undefined — the caller
   * must fail closed instead of reading some other session's transcript.
   */
  forSession(sessionID: string | undefined): PiToolHostContext | undefined;
  /**
   * Drop one session's context and retire the id (that session scope
   * stopped).
   *
   * Terminal for this extension scope: the session leaves the index, the
   * latest pointer no longer serves it, and a later publish of the same id
   * neither indexes it again nor makes it current.  Other sessions are
   * unaffected.
   */
  releaseSession(sessionID: string | undefined): void;
  /** Drop the published context (the extension scope is stopping). */
  release(): void;
}

/** Empty and absent ids both mean "no session". */
function normalizeSessionID(sessionID: string | undefined): string | null {
  if (typeof sessionID !== "string") return null;
  return sessionID.trim() === "" ? null : sessionID;
}

/**
 * Read the session id off a context for the per-session index.
 *
 * pi invalidates a captured context on session replacement / reload, and
 * reading through the stale one can throw.  An index read must never break
 * the publisher: such a context simply stays unindexed (readers then fail
 * closed), while the latest pointer keeps it for the surfaces that tolerate
 * it.
 */
function indexableSessionID(ctx: PiToolHostContext): string | null {
  try {
    return normalizeSessionID(ctx.sessionManager?.getSessionId?.());
  } catch {
    return null;
  }
}

/**
 * Create the live context port.
 *
 * @returns The port the handlers publish into and the services read.
 */
export function createPiLiveContext(): PiLiveContext {
  let current: PiToolHostContext | undefined;
  let released = false;
  const bySession = new Map<string, PiToolHostContext>();
  // Sessions whose scope stopped.  Kept for the extension scope's lifetime:
  // the kernel never hands a stopped id out again, so a late event of that
  // id has nothing to serve.
  const retired = new Set<string>();

  return {
    publish(ctx) {
      // A stopped extension has no live surface: a late event must not
      // revive one.
      if (released) return;
      // An absent context is not a retraction: keep the last live surface.
      if (ctx === undefined || ctx === null) return;
      const typed = ctx as PiToolHostContext;
      const sessionID = indexableSessionID(typed);
      // A retired session is terminal: its late event neither indexes a
      // context nor takes over the latest pointer.
      if (sessionID !== null && retired.has(sessionID)) return;
      current = typed;
      if (sessionID === null) return;
      bySession.set(sessionID, typed);
    },
    current() {
      return current;
    },
    sessionId() {
      return current?.sessionManager?.getSessionId();
    },
    forSession(sessionID) {
      const id = normalizeSessionID(sessionID);
      if (id === null) return undefined;
      return bySession.get(id);
    },
    releaseSession(sessionID) {
      const id = normalizeSessionID(sessionID);
      if (id === null) return;
      bySession.delete(id);
      retired.add(id);
      // A latest pointer naming the stopped session is no longer live: drop
      // it so no surface reads a session that has gone.  A pointer to any
      // other session stays untouched.
      if (current !== undefined && indexableSessionID(current) === id) {
        current = undefined;
      }
    },
    release() {
      released = true;
      current = undefined;
      bySession.clear();
      retired.clear();
    },
  };
}
