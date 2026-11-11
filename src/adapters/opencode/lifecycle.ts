/**
 * OpenCode lifecycle mapping.
 *
 * OpenCode creates sessions at `session.created` and drops them at
 * `session.deleted`, and its plugin dispose tears the whole extension
 * down.  Unlike pi, a deleted session is the only scope that stops: a
 * sibling or subagent session keeps its resources until its own event.
 *
 * Neither session event carries a start or stop reason, so the host event
 * name is what the coordinator records — an attributable string rather than
 * a fabricated semantic.  The reason stays diagnostic; the deletion itself
 * is a separate operation.  A `session.deleted` event deletes the session,
 * while the plugin's own dispose releases the runtime of every remaining
 * session and keeps their persisted context.  A missing or blank session id
 * is handed over unchanged, so a call that names no session does nothing.
 *
 * This module is the OpenCode side of the adapter boundary: cleanup
 * failures come back in the returned report, and nothing is caught and
 * dropped here.  It registers no hooks of its own.
 *
 * @module
 */

import type { CleanupReport } from "../../core/lifecycle/index.js";
import type { SessionLifecycle } from "../../core/session/lifecycle.js";

/** The session lifecycle operations this mapping drives. */
export type OpenCodeLifecycleOperations = Pick<
  SessionLifecycle,
  "startSession" | "deleteSession" | "releaseRuntime"
>;

/**
 * The slice of an OpenCode event this mapping reads.
 *
 * A session event carries its session under `properties.info`; other
 * events carry no `info` and read as "no session".
 */
export interface OpenCodeLifecycleEvent {
  readonly type?: string;
  readonly properties?: {
    readonly info?: { readonly id?: unknown };
  };
}

/**
 * What one mapped OpenCode event did.
 *
 * `none` is the explicit no-op for an unmapped or malformed event, so the
 * caller never has to guess whether something happened.
 */
export type OpenCodeLifecycleOutcome =
  | { readonly action: "none" }
  | { readonly action: "start"; readonly started: boolean }
  | {
      readonly action: "stop-session";
      readonly sessionID: string | null;
      readonly report: CleanupReport;
    }
  | { readonly action: "stop-extension"; readonly report: CleanupReport };

/** OpenCode session events carry no reason; the event name is the reason. */
const START_REASON = "session.created";

/**
 * Stop reason recorded for a deleted session.
 *
 * Diagnostic only: whether the session's resources are deleted is decided
 * by the deletion operation the mapping calls, never by this string.
 */
export const SESSION_DELETED_REASON = "session.deleted";

/** Stop reason recorded when the plugin itself is disposed. */
const DISPOSE_REASON = "dispose";

/**
 * Read the session id a host event carries.
 *
 * The `event` hook receives every host event, and a session event carries
 * its session under `properties.info`; other events carry no `info` and
 * read as "no session".
 *
 * @param event - The host event as the `event` hook received it.
 * @returns The session id, or `null` when the event carries none.
 */
export function openCodeEventSessionID(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const id = (event as OpenCodeLifecycleEvent).properties?.info?.id;
  return typeof id === "string" ? id : null;
}

/**
 * Build the OpenCode lifecycle mapping over a coordinator.
 *
 * @param lifecycle - The session lifecycle operations to drive.
 * @returns `handleEvent` for the plugin's `event` hook (pass the inner
 *   `input.event`) and `dispose` for its teardown hook.
 */
export function createOpenCodeLifecycleMapping(
  lifecycle: OpenCodeLifecycleOperations,
) {
  /** Map one received host event onto the coordinator. */
  async function handleEvent(
    event: unknown,
  ): Promise<OpenCodeLifecycleOutcome> {
    if (typeof event !== "object" || event === null) {
      return { action: "none" };
    }
    const payload = event as OpenCodeLifecycleEvent;

    if (payload.type === "session.created") {
      const started = await lifecycle.startSession(
        openCodeEventSessionID(payload),
        START_REASON,
      );
      return { action: "start", started };
    }
    if (payload.type === "session.deleted") {
      const sessionID = openCodeEventSessionID(payload);
      const report = await lifecycle.deleteSession(
        sessionID,
        SESSION_DELETED_REASON,
      );
      return { action: "stop-session", sessionID, report };
    }
    return { action: "none" };
  }

  /** Release every runtime when the host disposes the plugin. */
  async function dispose(): Promise<CleanupReport> {
    return lifecycle.releaseRuntime(DISPOSE_REASON);
  }

  return { handleEvent, dispose };
}
