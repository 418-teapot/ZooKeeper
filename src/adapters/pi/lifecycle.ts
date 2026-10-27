/**
 * pi lifecycle mapping.
 *
 * This mapping consumes exactly two event types: `session_start`
 * (startup / reload / new / resume / fork) is a real start notice, and
 * `session_shutdown` (quit / reload / new / resume / fork) means pi is
 * tearing the extension runtime down — including the sessions nested in
 * it.  Any other event the caller forwards is reported as `none`.
 * `session_start` carries no session identifier, so the mapping reads
 * it off the event context's session manager; an absent or blank id is
 * handed to the kernel unchanged, which declines without creating
 * anything rather than having this layer guess.
 *
 * This module is the pi side of the adapter/kernel boundary: pi's reason
 * strings cross to the kernel unmodified, cleanup failures come back in
 * the stop report, and nothing is caught and dropped here.  It registers
 * no handlers of its own — the entry point decides when to call it.
 *
 * @module
 */

import type {
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
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
export type PiLifecycleKernel = Pick<
  Kernel,
  "notifySessionStart" | "stopExtension"
>;

/**
 * The slice of pi's event context this mapping reads.
 *
 * pi's `session_start` event carries no session identifier; the live one
 * is on the context's session manager, so that is the only context member
 * the mapping needs.
 */
export interface PiLifecycleContext {
  readonly sessionManager?: {
    getSessionId?: () => string | undefined;
  };
}

/**
 * What one mapped pi event did.
 *
 * `none` is the explicit no-op for an unmapped or malformed event, so the
 * caller never has to guess whether something happened.
 */
export type PiLifecycleOutcome =
  | { readonly action: "none" }
  | { readonly action: "start"; readonly started: boolean }
  | { readonly action: "stop-extension"; readonly report: CleanupReport };

/**
 * Build the pi lifecycle mapping over a kernel.
 *
 * `sessionStart` / `sessionShutdown` are the per-event entry points (pi
 * registers handlers per event key); `handleEvent` dispatches an already
 * received event and reports every other event as `none`.
 *
 * @param kernel - The lifecycle kernel to drive.
 * @returns The mapping functions.
 */
export function createPiLifecycleMapping(kernel: PiLifecycleKernel) {
  /** Read the session id pi keeps on the event context. */
  function readSessionID(ctx: PiLifecycleContext | undefined): string | null {
    return ctx?.sessionManager?.getSessionId?.() ?? null;
  }

  /** `session_start`: a real start notice for the context's session. */
  async function sessionStart(
    event: SessionStartEvent,
    ctx?: PiLifecycleContext,
  ): Promise<PiLifecycleOutcome> {
    const started = await kernel.notifySessionStart(
      readSessionID(ctx),
      event.reason,
    );
    return { action: "start", started };
  }

  /** `session_shutdown`: pi replaces its runtime, so the extension stops. */
  async function sessionShutdown(
    event: SessionShutdownEvent,
  ): Promise<Extract<PiLifecycleOutcome, { action: "stop-extension" }>> {
    const report = await kernel.stopExtension(event.reason);
    return { action: "stop-extension", report };
  }

  /**
   * Map one received pi event.
   *
   * A start without pi's reason string cannot be reported to the services,
   * so it is treated as a malformed payload and skipped instead of
   * inventing a reason.
   */
  async function handleEvent(
    event: unknown,
    ctx?: unknown,
  ): Promise<PiLifecycleOutcome> {
    if (typeof event !== "object" || event === null) {
      return { action: "none" };
    }
    const payload = event as { type?: unknown; reason?: unknown };
    if (typeof payload.reason !== "string") return { action: "none" };

    if (payload.type === "session_start") {
      return sessionStart(
        event as SessionStartEvent,
        ctx as PiLifecycleContext | undefined,
      );
    }
    if (payload.type === "session_shutdown") {
      return sessionShutdown(event as SessionShutdownEvent);
    }
    return { action: "none" };
  }

  return { sessionStart, sessionShutdown, handleEvent };
}
