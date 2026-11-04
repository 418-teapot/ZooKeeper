/**
 * pi session contexts — the extension-scope store of each session's pi
 * extension contexts, addressed by an explicit session id.
 *
 * pi hands a fresh `ExtensionContext` to every event handler.  The readers
 * of a context are session-owned: the tool host's toasts, the session's
 * fleet ui, the todo transcript scan, and the pending switch operations.
 * Each entry path therefore binds the context under the session its permit
 * admitted (`bind(permit.sessionID, ctx)`), and each reader names the
 * session it serves (`forSession(sessionID)`).  No reader resolves "the last
 * event's context", so two interleaved sessions can never serve each
 * other's context.
 *
 * A command context is a separate entry of the same session
 * (`bindCommand` / `commandForSession`): it carries the replacement API the
 * command pi admitted needs, so handoff and switch resolve it there and the
 * session's ordinary event binds never shadow it.
 *
 * Binding is a no-op without a usable session id or without a context: pi
 * never retracts a context, so an entry path that has none must not blank a
 * session.  {@link PiSessionContexts.release} is the explicit clear, run
 * when the extension scope stops, and it is terminal — a late event can
 * neither re-index a session nor revive one.
 *
 * The index holds one entry per session scope that bound.  pi fires no
 * session-deletion event, and the index must not guess when a session died,
 * so its lifetime is the extension scope's: an entry stays until
 * {@link PiSessionContexts.releaseSession} (that session scope stopped) or
 * the extension scope releases.  Retirement is terminal — the kernel never
 * hands a stopped session id out again, so a late event of that session must
 * not re-index it.
 *
 * @module
 */

import type { PiCommandCtx } from "./handoff-target.js";
import type { PiToolHostContext } from "./tool-host.js";

/**
 * The session contexts of one pi extension instance.
 *
 * A narrow read/write port: the entry paths bind, every session-owned reader
 * resolves one session's own context.  No session-scoped state is reachable
 * through it, so a service that depends on this port never captures a
 * session object.
 */
export interface PiSessionContexts {
  /**
   * Bind the context of one admitted event.
   *
   * An absent id or an absent context binds nothing.
   */
  bind(sessionID: string | undefined, ctx: unknown): void;
  /**
   * The context bound for one session.
   *
   * The reader names the session it serves, so an interleaved second
   * session's context is never returned.  An absent, blank, unbound,
   * released or released-then-rebound id yields undefined — the caller must
   * fail closed instead of reading some other session's transcript.
   */
  forSession(sessionID: string | undefined): PiToolHostContext | undefined;
  /**
   * Bind the command context of one admitted command.
   *
   * A command context is a separate entry, so an event context bound for
   * the same session never shadows it.  An absent id or an absent command
   * context binds nothing.
   */
  bindCommand(
    sessionID: string | undefined,
    ctx: PiCommandCtx | undefined,
  ): void;
  /**
   * The command context bound for one session.
   *
   * Only an admitted command binds one, so a session that ran no command
   * yields undefined — the reader fails closed instead of treating an
   * event context as the replacement API.
   */
  commandForSession(sessionID: string | undefined): PiCommandCtx | undefined;
  /**
   * Drop one session's contexts and retire the id (that session scope
   * stopped).
   *
   * Terminal for this extension scope: a later bind of the same id neither
   * indexes it again nor revives it.  Other sessions are unaffected.
   */
  releaseSession(sessionID: string | undefined): void;
  /** Drop every context (the extension scope is stopping). */
  release(): void;
}

/** Empty and absent ids both mean "no session". */
function normalizeSessionID(sessionID: string | undefined): string | null {
  if (typeof sessionID !== "string") return null;
  return sessionID.trim() === "" ? null : sessionID;
}

/**
 * The contexts one session published.
 *
 * The two entries are independent: an event context describes the session's
 * live surface, a command context carries the replacement API of the
 * command pi admitted.  Neither replaces the other.
 */
interface SessionEntries {
  /** The session's event context (read by the session-owned readers). */
  event?: PiToolHostContext;
  /** The session's command context (read by handoff and switch). */
  command?: PiCommandCtx;
}

/**
 * Create the session context port.
 *
 * @returns The port the entry paths bind into and the readers resolve.
 */
export function createPiSessionContexts(): PiSessionContexts {
  let released = false;
  const bySession = new Map<string, SessionEntries>();
  // Sessions whose scope stopped.  Kept for the extension scope's lifetime:
  // the kernel never hands a stopped id out again, so a late event of that
  // id has nothing to serve.
  const retired = new Set<string>();

  // The writable entries of one live session, or undefined when a bind must
  // not index one: a stopped extension, an unnamed session and a retired
  // session all bind nothing.
  const claim = (sessionID: string | undefined): SessionEntries | undefined => {
    if (released) return undefined;
    const id = normalizeSessionID(sessionID);
    if (id === null || retired.has(id)) return undefined;
    const existing = bySession.get(id);
    if (existing !== undefined) return existing;
    const entries: SessionEntries = {};
    bySession.set(id, entries);
    return entries;
  };

  return {
    bind(sessionID, ctx) {
      // An absent context is not a retraction: keep the session's entry.
      if (ctx === undefined || ctx === null) return;
      const entries = claim(sessionID);
      if (entries === undefined) return;
      entries.event = ctx as PiToolHostContext;
    },
    forSession(sessionID) {
      const id = normalizeSessionID(sessionID);
      if (id === null) return undefined;
      return bySession.get(id)?.event;
    },
    bindCommand(sessionID, ctx) {
      if (ctx === undefined || ctx === null) return;
      const entries = claim(sessionID);
      if (entries === undefined) return;
      entries.command = ctx;
    },
    commandForSession(sessionID) {
      const id = normalizeSessionID(sessionID);
      if (id === null) return undefined;
      return bySession.get(id)?.command;
    },
    releaseSession(sessionID) {
      const id = normalizeSessionID(sessionID);
      if (id === null) return;
      bySession.delete(id);
      retired.add(id);
    },
    release() {
      released = true;
      bySession.clear();
      retired.clear();
    },
  };
}
