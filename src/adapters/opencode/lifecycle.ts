/**
 * OpenCode lifecycle mapping.
 *
 * OpenCode creates sessions at `session.created` and drops them at
 * `session.deleted`, and its plugin dispose tears the whole extension
 * down.  Unlike pi, a deleted session is the only scope that stops: a
 * sibling or subagent session keeps its resources until its own event.
 *
 * Neither session event carries a start or stop reason, so the host event
 * name is what the kernel records — an attributable string rather than a
 * fabricated semantic.  The deletion reason is exported as
 * {@link SESSION_DELETED_REASON} because it is the only stop reason that
 * may end a session's persisted context.  A missing or blank session id
 * is handed to the kernel, which declines without creating anything.
 *
 * This module is the OpenCode side of the adapter/kernel boundary: cleanup
 * failures come back in the returned report, and nothing is caught and
 * dropped here.  It registers no hooks of its own.
 *
 * @module
 */

import type {
  AnyExtensionServiceDefinition,
  AnySessionServiceDefinition,
  CleanupReport,
  LifecycleKernel,
} from "../../core/lifecycle/index.js";

/**
 * The kernel handle any declaration set satisfies.
 *
 * The mapping never names the declared services, so it accepts a kernel
 * built from any declarations; the type parameters do not reach the
 * methods it calls.
 */
type Kernel = LifecycleKernel<
  readonly AnyExtensionServiceDefinition[],
  readonly AnySessionServiceDefinition[]
>;

/** The kernel operations this mapping drives. */
export type OpenCodeLifecycleKernel = Pick<
  Kernel,
  "notifySessionStart" | "stopSession" | "stopExtension"
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
 * The only reason that ends the session's persisted context: the host
 * dropped the session, so nothing will restore it.  Every other stop
 * reason (a plugin dispose or reload) keeps the state.
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
 * Build the OpenCode lifecycle mapping over a kernel.
 *
 * @param kernel - The lifecycle kernel to drive.
 * @returns `handleEvent` for the plugin's `event` hook (pass the inner
 *   `input.event`) and `dispose` for its teardown hook.
 */
export function createOpenCodeLifecycleMapping(
  kernel: OpenCodeLifecycleKernel,
) {
  /** Map one received host event onto the kernel. */
  async function handleEvent(
    event: unknown,
  ): Promise<OpenCodeLifecycleOutcome> {
    if (typeof event !== "object" || event === null) {
      return { action: "none" };
    }
    const payload = event as OpenCodeLifecycleEvent;

    if (payload.type === "session.created") {
      const started = await kernel.notifySessionStart(
        openCodeEventSessionID(payload),
        START_REASON,
      );
      return { action: "start", started };
    }
    if (payload.type === "session.deleted") {
      const sessionID = openCodeEventSessionID(payload);
      const report = await kernel.stopSession(
        sessionID,
        SESSION_DELETED_REASON,
      );
      return { action: "stop-session", sessionID, report };
    }
    return { action: "none" };
  }

  /** Stop the extension when the host disposes the plugin. */
  async function dispose(): Promise<CleanupReport> {
    return kernel.stopExtension(DISPOSE_REASON);
  }

  return { handleEvent, dispose };
}
