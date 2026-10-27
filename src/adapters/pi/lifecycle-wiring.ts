/**
 * pi lifecycle wiring — the kernel instance behind pi's entry point.
 *
 * The entry point declares its extension- and session-scoped services here
 * and drives them through the same operations this module exposes:
 *
 *  - `activateExtension` resolves the extension scope, creating its services
 *    through the kernel on first call.  The entry point calls it BEFORE
 *    composing the product, so the composition receives services the kernel
 *    owns instead of objects the entry point built itself.  The returned
 *    service map is typed by the declarations, and nothing session-scoped is
 *    reachable through it.
 *  - `ensureSession` creates (or reuses) a session scope for the id the
 *    current event carries.  Every pi handler and tool/command bridge calls
 *    it before touching session resources, so a session whose first
 *    observation is a tool call still gets its scope — without a start
 *    notice, which only pi's own `session_start` may produce.
 *  - `startSession` forwards a real `session_start` to the mapping, which
 *    notifies the kernel with pi's own reason string unmodified.
 *  - `stopExtension` maps `session_shutdown` through the same mapping and
 *    reports the cleanup outcome; the extension scope is terminal, so a
 *    later ensure cannot recreate anything.
 *
 * Every ensured session is also associated with this wiring instance in the
 * SDK bridge.  pi can run more than one extension runtime in a process (a
 * sub-session loads its own), so the association is what keeps a driver's
 * explicit teardown attached to the right owner: stopping the session the
 * driver disposes stops that owner's extension — every nested session and
 * extension service included — and leaves a replacement owner untouched
 * (see `sdk-lifecycle.ts`).
 *
 * @module
 */

import type {
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  type AnyExtensionServiceDefinition,
  type AnySessionServiceDefinition,
  type CleanupReport,
  createLifecycleKernel,
  type ExtensionScope,
  type LifecycleKernel,
  type ServiceMap,
} from "../../core/lifecycle/index.js";
import {
  createPiLifecycleMapping,
  type PiLifecycleOutcome,
} from "./lifecycle.js";
import {
  associatePiSdkSession,
  releasePiSdkSessions,
} from "./sdk-lifecycle.js";

/**
 * Stop reason used when pi's shutdown payload carries no usable reason.
 *
 * A teardown must not leak resources because a payload was malformed, so
 * the wiring stops with the event's own name instead of skipping.
 */
export const PI_SHUTDOWN_REASON = "session_shutdown";

/** Options for {@link createPiLifecycleWiring}. */
export interface PiLifecycleWiringOptions<
  Extension extends readonly AnyExtensionServiceDefinition[],
  Session extends readonly AnySessionServiceDefinition[],
> {
  /**
   * The extension-scoped service declarations of this host.  They are
   * created by the kernel when the entry point activates the extension —
   * before it composes the profile — and stopped by every path that stops
   * the extension, including the SDK driver's teardown.
   */
  readonly extensionServices: Extension;
  /** The session-scoped service declarations of this host. */
  readonly sessionServices: Session;
  /**
   * Resolve the session id from an event context.  Undefined (or a blank
   * id) means "no session": nothing is created.
   */
  getSessionID?(ctx?: unknown): string | undefined;
}

/**
 * Raised when activation is attempted after the extension scope stopped.
 *
 * The kernel treats a stopped extension as terminal (a late session event
 * must not resurrect it), so an activation that arrives afterwards cannot
 * be satisfied.  The wiring reports that instead of handing out a scope
 * whose services were never created.
 */
export class PiLifecycleStoppedError extends Error {
  constructor() {
    super("pi extension lifecycle scope already stopped");
    this.name = "PiLifecycleStoppedError";
  }
}

/**
 * The host-facing lifecycle operations of one pi extension instance.
 *
 * The extension parameter makes {@link PiLifecycleWiring.activateExtension}
 * return the declared services by name.  Session services stay reachable
 * only through their own session scope and explicit session id: the wiring
 * offers no session accessor, so a caller can never hold another session's
 * store.
 */
export interface PiLifecycleWiring<
  Extension extends
    readonly AnyExtensionServiceDefinition[] = readonly AnyExtensionServiceDefinition[],
> {
  /**
   * Activate the extension scope.
   *
   * Resolves the extension's services, creating them through the kernel on
   * first call (concurrent callers share one creation and later calls reuse
   * it), so the entry point composes the profile from services the kernel
   * owns rather than from objects it built itself.  The session scopes stay
   * uncreated: they appear when an event first names one.
   *
   * @returns The extension scope, whose `services` map is typed by the
   *   declared extensions.
   * @throws {PiLifecycleStoppedError} When the extension already stopped.
   */
  activateExtension(): Promise<ExtensionScope<ServiceMap<Extension>>>;
  /**
   * Ensure the session scope of the id `ctx` resolves.  Returns whether a
   * usable scope exists; no id, a stopped session, or a stopped extension
   * all return `false` without creating anything.
   */
  ensureSession(ctx?: unknown): Promise<boolean>;
  /**
   * Handle one real `session_start` notice.  A payload that carries no
   * reason only ensures the scope — a start reason is never fabricated.
   */
  startSession(event: unknown, ctx?: unknown): Promise<PiLifecycleOutcome>;
  /**
   * Handle `session_shutdown`: stop the extension (nested sessions first)
   * and report every cleanup failure.
   */
  stopExtension(event: unknown): Promise<CleanupReport>;
}

/**
 * Create the lifecycle wiring of one pi extension instance.
 *
 * @param options - The extension and session declarations plus the session
 *   id resolver.
 * @returns The lifecycle operations the entry point drives.
 */
export function createPiLifecycleWiring<
  const Extension extends readonly AnyExtensionServiceDefinition[],
  const Session extends readonly AnySessionServiceDefinition[],
>(
  options: PiLifecycleWiringOptions<Extension, Session>,
): PiLifecycleWiring<Extension> {
  // The resident wiring (loop engine, handoff store) keeps its current
  // lifetime; the caller declares which services belong to the extension
  // scope and which nest per session.
  const kernel: LifecycleKernel<Extension, Session> = createLifecycleKernel({
    extension: options.extensionServices,
    session: options.sessionServices,
  });
  const mapping = createPiLifecycleMapping(kernel);
  // This extension instance's identity in the SDK bridge.  A replacement
  // instance registers its own token, so an old scope can never release or
  // stop the new one.
  const owner = {};

  /** Read the session id the current event carries. */
  function readSessionID(ctx?: unknown): string | undefined {
    const id = options.getSessionID?.(ctx);
    return typeof id === "string" && id.trim() !== "" ? id : undefined;
  }

  async function activateExtension(): Promise<
    ExtensionScope<ServiceMap<Extension>>
  > {
    const scope = await kernel.ensureExtension();
    if (scope === null) throw new PiLifecycleStoppedError();
    return scope as ExtensionScope<ServiceMap<Extension>>;
  }

  async function ensureSession(ctx?: unknown): Promise<boolean> {
    const sessionID = readSessionID(ctx);
    if (sessionID === undefined) return false;
    const scope = await kernel.ensureSession(sessionID);
    if (scope === null) return false;
    // Associate the ensured session with this extension so the SDK driver's
    // explicit teardown stops exactly this owner's scope.
    associatePiSdkSession(scope.sessionID, owner, async (reason) => {
      const report = await kernel.stopExtension(reason);
      // The owner is terminal from here on: drop its remaining
      // associations so a later SDK dispose cannot reach a stopped scope.
      releasePiSdkSessions(owner);
      return report;
    });
    return true;
  }

  async function startSession(
    event: unknown,
    ctx?: unknown,
  ): Promise<PiLifecycleOutcome> {
    const payload = event as { reason?: unknown } | undefined;
    if (typeof payload?.reason === "string") {
      // pi's own reason string is forwarded unmodified.  The context handed
      // to the mapping is built from the id this wiring resolved (the event
      // context or the shared holder), so both paths name the same session.
      const sessionID = readSessionID(ctx);
      const outcome = await mapping.sessionStart(payload as SessionStartEvent, {
        sessionManager: { getSessionId: () => sessionID },
      });
      // The mapping creates the scope directly, bypassing `ensureSession`, so
      // the association is made here: the SDK driver may dispose the session
      // before any other event ensures it.
      await ensureSession(ctx);
      return outcome;
    }
    // No usable reason: this is not a start notice, so only the scope is
    // ensured (the caller's widget / todo wiring needs it) and no start is
    // fabricated.
    await ensureSession(ctx);
    return { action: "none" };
  }

  async function stopExtension(event: unknown): Promise<CleanupReport> {
    const payload = event as { type?: unknown; reason?: unknown } | undefined;
    const report =
      payload?.type === "session_shutdown" && typeof payload.reason === "string"
        ? (await mapping.sessionShutdown(payload as SessionShutdownEvent))
            .report
        : // A payload pi cannot attribute still must not leak resources, so
          // the stop runs with the host-level reason instead of skipping.
          await kernel.stopExtension(PI_SHUTDOWN_REASON);
    // The extension and its nested sessions are gone; drop this instance's
    // associations so a later SDK stop cannot reach a stopped scope.
    releasePiSdkSessions(owner);
    return report;
  }

  return { activateExtension, ensureSession, startSession, stopExtension };
}
