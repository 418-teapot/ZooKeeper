/**
 * Session lifecycle coordinator.
 *
 * A host drives sessions through this surface only: it ensures a scope,
 * reports a real start, admits work, deletes a session and releases the
 * runtimes.  The coordinator owns the session-id normalization, the permit
 * and service projection and the release vocabulary, so no host names a
 * stop mode or holds a scope to pass one.  A release always releases
 * runtimes: it never ends a session the host still owns.
 *
 * The kernel stays the resource owner and keeps its own contract — the
 * coordinator forwards to it and adds nothing it cannot observe.  Host
 * event names stay adapter-side: a host translates its own event into a
 * start or stop reason and passes the string here unmodified.  A deletion
 * is the coordinator's: it stops that scope and then applies the session
 * records, so a session with a scope, a session without one, and a
 * deletion racing a release all follow one protocol.  The records are a
 * construction input: a coordinator always carries them, so no deletion
 * can skip them.
 *
 * @module
 */

import type {
  AnyExtensionServiceDefinition,
  AnySessionServiceDefinition,
  CleanupReport,
  LifecycleKernel,
  ServiceMap,
  SessionScope,
  WorkPermit,
} from "../lifecycle/index.js";
import type { SessionResourceCatalog } from "./resources.js";

/** A blank ID and an absent ID both mean "no session". */
function normalizeSessionID(
  sessionID: string | null | undefined,
): string | null {
  if (typeof sessionID !== "string") return null;
  return sessionID.trim() === "" ? null : sessionID;
}

/**
 * The session operations one host instance drives.
 *
 * The interface names only the session services: a host never reaches the
 * extension services through it.
 */
export interface SessionLifecycle<
  Session extends
    readonly AnySessionServiceDefinition[] = readonly AnySessionServiceDefinition[],
> {
  /**
   * Ensure the session scope of `sessionID`.
   *
   * An absent or blank id, a stopped session and a released runtime all
   * return `null` without creating anything.
   *
   * @param sessionID - The session the current host call names.
   * @returns The ready session scope, or `null`.
   */
  ensureSession(
    sessionID: string | null | undefined,
  ): Promise<SessionScope<ServiceMap<Session>> | null>;
  /**
   * Handle a real host session start.
   *
   * The session is ensured first, then each session service's start hook
   * runs with `reason` as the host reported it.
   *
   * @param sessionID - The session that really started.
   * @param reason - The host-supplied start reason, unmodified.
   * @returns Whether the start reached the session services.
   */
  startSession(
    sessionID: string | null | undefined,
    reason: string,
  ): Promise<boolean>;
  /**
   * Admit one unit of work for `sessionID`.
   *
   * The work runs under a {@link WorkPermit} whose signal follows the
   * session, the released runtimes and the caller's own cancellation.  A
   * refused call runs no work and returns `undefined`.
   *
   * The work receives the services of the session it runs for, so a
   * caller reads and writes that session's state without holding a scope.
   *
   * @param sessionID - The session the call addresses.
   * @param work - The admitted work, receiving its permit and the session
   *   services.
   * @param signal - The caller's own cancellation, if any.
   * @returns The work's value, or `undefined` when the call is refused.
   */
  runSession<T>(
    sessionID: string | null | undefined,
    work: (permit: WorkPermit, services: ServiceMap<Session>) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined>;
  /**
   * Admit one control operation for `sessionID`.
   *
   * Admission and permit revocation are those of `runSession`, but a
   * release does not wait for this call: it is the call that stops the
   * session it belongs to.  Ordinary business work uses `runSession`.
   *
   * @param sessionID - The session the call addresses.
   * @param work - The admitted work, receiving its permit and the session
   *   services.
   * @param signal - The caller's own cancellation, if any.
   * @returns The work's value, or `undefined` when the call is refused.
   */
  runControl<T>(
    sessionID: string | null | undefined,
    work: (permit: WorkPermit, services: ServiceMap<Session>) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined>;
  /**
   * Delete one session: stop its scope, then apply its session records.
   *
   * The stop runs with the `delete-session` mode, so a scope disposer sees
   * that the session is ending.  The records are applied afterwards and
   * whether or not a scope existed: a stop that was already releasing the
   * scope keeps what it owns, so the records must still be dropped.  Safe
   * to repeat, and it never rejects for cleanup failures.
   *
   * @param sessionID - The session the host deleted.
   * @param reason - The host-supplied stop reason, unmodified.
   * @returns Every cleanup failure, stop failures before record failures.
   */
  deleteSession(
    sessionID: string | null | undefined,
    reason: string,
  ): Promise<CleanupReport>;
  /**
   * Release the runtime of every session and then the extension services.
   *
   * The sessions still exist on the host side, so this keeps what they own
   * beyond their runtime.  Safe to repeat, and it never rejects for cleanup
   * failures.
   *
   * @param reason - The host-supplied stop reason, unmodified.
   * @returns Every cleanup failure, in stop order.
   */
  releaseRuntime(reason: string): Promise<CleanupReport>;
}

/**
 * Create the session lifecycle coordinator of one host instance.
 *
 * @param kernel - The kernel that owns the resource lifetime.
 * @param sessionCatalog - The session records a deletion drops.  A host
 *   that never deletes a session still passes its catalog, so the
 *   coordinator carries one deletion protocol only.
 * @returns The coordinator the host drives.
 */
export function createSessionLifecycle<
  const Extension extends readonly AnyExtensionServiceDefinition[],
  const Session extends readonly AnySessionServiceDefinition[],
>(
  kernel: LifecycleKernel<Extension, Session>,
  sessionCatalog: SessionResourceCatalog,
): SessionLifecycle<Session> {
  return {
    ensureSession: (sessionID) => kernel.ensureSession(sessionID),
    startSession: (sessionID, reason) =>
      kernel.notifySessionStart(sessionID, reason),
    runSession: (sessionID, work, signal) =>
      kernel.runSession(
        sessionID,
        (scope, permit) => work(permit, scope.services),
        signal,
      ),
    runControl: (sessionID, work, signal) =>
      kernel.runControl(
        sessionID,
        (scope, permit) => work(permit, scope.services),
        signal,
      ),
    async deleteSession(sessionID, reason) {
      const stop = await kernel.stopSession(
        sessionID,
        reason,
        "delete-session",
      );
      const id = normalizeSessionID(sessionID);
      if (id === null) return stop;
      const records = await sessionCatalog.delete(id);
      return { errors: [...stop.errors, ...records.errors] };
    },
    releaseRuntime: (reason) => kernel.stopExtension(reason),
  };
}
