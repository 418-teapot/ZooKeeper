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
 *    current event carries.  The start entry uses it to prepare a scope;
 *    business work goes through `runSession` instead.
 *  - `runSession` admits one unit of call-scoped work under a `WorkPermit`
 *    for the session the event of that call names.  The permit's signal
 *    follows the session, the extension, and the caller's own
 *    cancellation, and a stop waits for admitted work before disposing.
 *  - `runControl` admits a control operation the same way, but no stop
 *    waits for it: it is the call that replaces the session it belongs
 *    to, so waiting would deadlock the stop it performs.
 *  - `startSession` forwards a real `session_start` to the mapping, which
 *    notifies the kernel with pi's own reason string unmodified.
 *  - `stopExtension` maps `session_shutdown` through the same mapping and
 *    reports the cleanup outcome; the extension scope is terminal, so a
 *    later ensure cannot recreate anything.
 *
 * pi runs one wiring instance per extension runtime, and a sub-session loads
 * its own.  The runtime owner therefore hands that runtime's close handle to
 * the driver that created it (see `publisher.ts`), so a teardown always
 * stops the scope of the runtime it belongs to.
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
  type WorkPermit,
} from "../../core/lifecycle/index.js";
import {
  createPiLifecycleMapping,
  type PiLifecycleOutcome,
} from "./lifecycle.js";

/**
 * Stop reason used when pi's shutdown payload carries no usable reason.
 *
 * A teardown must not leak resources because a payload was malformed, so
 * the wiring stops with the event's own name instead of skipping.
 */
export const PI_SHUTDOWN_REASON = "session_shutdown";

/**
 * Stop reason the subagent driver uses when it closes a sub-session's scope.
 *
 * pi emits no `session_shutdown` for an SDK-created session, so the driver
 * stops that runtime's extension itself and records this cause.
 */
export const SDK_STOP_REASON = "sdk.session.dispose";

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
    super("pi 扩展生命周期作用域已停止");
    this.name = "PiLifecycleStoppedError";
  }
}

/**
 * One session's admission surface.
 *
 * A call is admitted only for a live session; the work runs under the
 * issued permit, and its result reaches the caller unchanged.
 */
export interface PiSessionWorkRunner {
  /**
   * Admit one unit of work for the session `ctx` names.
   *
   * The session id is read from this call's own context, never from a
   * context another event published.
   *
   * @param ctx - The event context of this call.
   * @param work - The admitted work, receiving its permit.
   * @param signal - The caller's own cancellation, if any.
   * @returns The work's value, or `undefined` when the call is refused.
   */
  runSession<T>(
    ctx: unknown,
    work: (permit: WorkPermit) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined>;
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
> extends PiSessionWorkRunner {
  /**
   * Admit one control operation for the session `ctx` names.
   *
   * A host command that replaces its own session is a control operation:
   * pi tears that session down inside the replacement, so the stop must not
   * wait for the command to return.  Admission, permit revocation and the
   * context publishing are the same as `runSession`.
   *
   * @param ctx - The event context of this call.
   * @param work - The admitted work, receiving its permit.
   * @param signal - The caller's own cancellation, if any.
   * @returns The work's value, or `undefined` when the call is refused.
   */
  runControl<T>(
    ctx: unknown,
    work: (permit: WorkPermit) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined>;
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

  /**
   * Read the session id one event carries.
   *
   * pi invalidates a captured context on session replacement / reload, and
   * reading through the stale one throws.  Such a context names no session,
   * so the call is refused instead of breaking the host.
   */
  function readSessionID(ctx?: unknown): string | undefined {
    try {
      const id = options.getSessionID?.(ctx);
      return typeof id === "string" && id.trim() !== "" ? id : undefined;
    } catch {
      return undefined;
    }
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
    return (await kernel.ensureSession(sessionID)) !== null;
  }

  async function runSession<T>(
    ctx: unknown,
    work: (permit: WorkPermit) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const sessionID = readSessionID(ctx);
    if (sessionID === undefined) return undefined;
    return kernel.runSession<T>(
      sessionID,
      (_scope, permit) => work(permit),
      signal,
    );
  }

  async function runControl<T>(
    ctx: unknown,
    work: (permit: WorkPermit) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const sessionID = readSessionID(ctx);
    if (sessionID === undefined) return undefined;
    return kernel.runControl<T>(
      sessionID,
      (_scope, permit) => work(permit),
      signal,
    );
  }

  async function startSession(
    event: unknown,
    ctx?: unknown,
  ): Promise<PiLifecycleOutcome> {
    const payload = event as { reason?: unknown } | undefined;
    if (typeof payload?.reason === "string") {
      // pi's own reason string is forwarded unmodified.  The context handed
      // to the mapping is built from the id this wiring resolved, so the
      // notification and the scope name the same session.
      const sessionID = readSessionID(ctx);
      return await mapping.sessionStart(payload as SessionStartEvent, {
        sessionManager: { getSessionId: () => sessionID },
      });
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
    return report;
  }

  return {
    activateExtension,
    ensureSession,
    runSession,
    runControl,
    startSession,
    stopExtension,
  };
}
