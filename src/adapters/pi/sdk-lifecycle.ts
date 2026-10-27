/**
 * Process-level pi SDK session lifecycle bridge.
 *
 * pi's extension runtime owns the lifecycle kernel that holds a session's
 * resources, but a subagent runs as a separate `AgentSession` created
 * through the SDK.  That session is disposed explicitly by the driver
 * (`session.dispose()`), while pi never emits `session_shutdown` for it —
 * so without a bridge the sub-session's scope would leak.
 *
 * This module is that bridge: the extension instance that first ensures a
 * session associates the id with itself (an explicit owner token) and a
 * stopper, and the driver calls {@link stopPiSdkSession} before disposing
 * the SDK session.  A session no extension ever associated is a no-op, so
 * a driver whose session loaded no extension stays harmless.
 *
 * A process can run several extension runtimes at once — each SDK
 * sub-session loads its own — and a replacement runtime can take a session
 * id over.  Associations are therefore keyed by session id AND by the
 * owning extension instance: a stop detaches only the entry it read, so a
 * newer owner's registration for the same id survives, and a release is
 * refused unless the association still belongs to the caller.  The map is
 * process-level because the SDK driver runs in the same process as the
 * runtimes it stops; tests clear it with
 * {@link resetPiSdkLifecycleBridge}.
 *
 * @module
 */

import type { CleanupReport } from "../../core/lifecycle/index.js";
import { log } from "../../utils/logger.js";

/** Stop reason recorded for a session stopped by the SDK teardown. */
export const SDK_STOP_REASON = "sdk.session.dispose";

/** Pseudo service name reported when a stopper itself throws. */
const BRIDGE_SERVICE = "pi-sdk-lifecycle-bridge";

/**
 * Stops the owning extension's scope and reports its cleanup outcome.
 *
 * The reason is supplied by the bridge (the SDK teardown) so every scope
 * stopped through it records the same attributable cause.
 */
export type PiSdkSessionStopper = (reason: string) => Promise<CleanupReport>;

/** One session id → owning extension registration. */
interface SessionAssociation {
  /** The extension instance that owns this session. */
  readonly owner: object;
  /** Stops the owner's session scope. */
  readonly stop: PiSdkSessionStopper;
}

// Process-level: every extension runtime and the SDK driver that disposes
// its sessions run in the same process, so one map keyed by session id can
// route a teardown to the runtime that owns it.
const associations = new Map<string, SessionAssociation>();

/** A blank id and an absent id both mean "no session". */
function normalizeSessionID(
  sessionID: string | null | undefined,
): string | null {
  if (typeof sessionID !== "string") return null;
  const trimmed = sessionID.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Associate a session with the extension that owns its scope.
 *
 * Re-associating the same id replaces the previous owner, which is how a
 * replacement extension instance takes the session over.
 *
 * @param sessionID - The session to associate (blank is ignored).
 * @param owner - The owning extension instance (an identity token).
 * @param stop - Stops the owner's scope for this session.
 * @returns Whether an association was recorded.
 */
export function associatePiSdkSession(
  sessionID: string | null | undefined,
  owner: object,
  stop: PiSdkSessionStopper,
): boolean {
  const id = normalizeSessionID(sessionID);
  if (id === null) return false;
  associations.set(id, { owner, stop });
  return true;
}

/**
 * Drop one association, but only while it still belongs to `owner`.
 *
 * @param sessionID - The session to detach (blank is ignored).
 * @param owner - The owner the association must still have.
 * @returns Whether an association was removed.
 */
export function releasePiSdkSession(
  sessionID: string | null | undefined,
  owner: object,
): boolean {
  const id = normalizeSessionID(sessionID);
  if (id === null) return false;
  const entry = associations.get(id);
  if (entry === undefined || entry.owner !== owner) return false;
  associations.delete(id);
  return true;
}

/**
 * Drop every association owned by one extension instance.
 *
 * Called when the extension itself stops, so a session scope torn down
 * with it leaves no stale association behind.
 *
 * @param owner - The owning extension instance.
 * @returns The number of associations removed.
 */
export function releasePiSdkSessions(owner: object): number {
  let released = 0;
  for (const [sessionID, entry] of associations) {
    if (entry.owner !== owner) continue;
    associations.delete(sessionID);
    released += 1;
  }
  return released;
}

/**
 * Whether an extension associated this session.
 *
 * Diagnostics / test seam: the bridge is otherwise write-only from the
 * extension's side.
 *
 * @param sessionID - The session to inspect.
 * @returns Whether an association exists.
 */
export function hasPiSdkSession(sessionID: string | null | undefined): boolean {
  const id = normalizeSessionID(sessionID);
  return id !== null && associations.has(id);
}

/**
 * Stop the extension that associated a session.  The carrying session is
 * gone (the SDK disposed it), so the owner's whole scope stops: its nested
 * sessions first, then its extension services.
 *
 * The association is detached first, so a concurrent stop cannot run the
 * same stopper twice, and a newer association for the same id is left
 * untouched.  A session no extension associated (the session loaded no
 * extension, or its creation failed) is an explicit no-op: the empty
 * report says nothing was found, not that nothing needed cleaning.
 *
 * Cleanup failures come back in the report; a stopper that throws is
 * reported as a bridge failure instead of escaping into the driver's
 * teardown.
 *
 * @param sessionID - The session being torn down.
 * @returns The cleanup report of the stopped scope.
 */
export async function stopPiSdkSession(
  sessionID: string | null | undefined,
): Promise<CleanupReport> {
  const id = normalizeSessionID(sessionID);
  if (id === null) return { errors: [] };

  const entry = associations.get(id);
  if (entry === undefined) return { errors: [] };

  // Detach only this association: a stop must never drop a newer
  // extension's registration for the same id.
  if (associations.get(id) === entry) associations.delete(id);

  try {
    const report = await entry.stop(SDK_STOP_REASON);
    for (const failure of report.errors) {
      log.warn({
        hook: "lifecycle",
        event: "cleanup_failed",
        sessionId: id,
        reason: SDK_STOP_REASON,
        scope: failure.scope,
        service: failure.service,
        error: String(failure.error),
      });
    }
    return report;
  } catch (error) {
    log.warn({
      hook: "lifecycle",
      event: "cleanup_failed",
      sessionId: id,
      reason: SDK_STOP_REASON,
      service: BRIDGE_SERVICE,
      error: String(error),
    });
    return {
      errors: [
        {
          scope: "session",
          sessionID: id,
          service: BRIDGE_SERVICE,
          error,
        },
      ],
    };
  }
}

/**
 * Clear every association (test reset).
 *
 * Production never needs this: an association ends through an explicit
 * release — {@link releasePiSdkSessions} when the owning extension stops,
 * or {@link stopPiSdkSession} when the driver disposes the session — so a
 * finished extension leaves nothing behind to accumulate for the
 * lifetime of the process.
 */
export function resetPiSdkLifecycleBridge(): void {
  associations.clear();
}
