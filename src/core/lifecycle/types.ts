/**
 * Host-agnostic lifecycle vocabulary.
 *
 * The kernel manages resource lifetime only: an extension scope owns
 * long-lived services, every session scope nests inside that extension,
 * and a service declares the definitions it needs at construction.
 * Factories receive exactly that dependency projection plus the scope's
 * `AbortSignal`, never the kernel or a service locator.
 *
 * The two scopes are the entire resource vocabulary.  There is no process
 * dispose and no host event handling here — hosts translate their own
 * events into `ensureSession`, `notifySessionStart`, and `runSession`
 * calls, and the kernel does not inspect host types.
 *
 * Call-scoped work is admitted through `runSession`, which issues a
 * `WorkPermit` whose signal and activity reflect the session, the
 * extension, and the optional caller cancellation.
 *
 * A session service may declare a `start` hook.  Bare `ensure` never runs
 * it: only a real host start notice does, after the scope is ready, in
 * creation order.  Notices and stops are serialised per session, so a
 * notice that has begun finishes before the scope is disposed.
 *
 * @module
 */

/** Erased extension definition used by the kernel internals. */
export type AnyExtensionServiceDefinition = ExtensionServiceDefinition<
  string,
  any,
  any
>;

/** Erased session definition used by the kernel internals. */
export type AnySessionServiceDefinition = SessionServiceDefinition<
  string,
  any,
  any
>;

/** Erased definition union used by shared ordering and cleanup helpers. */
export type AnyServiceDefinition =
  | AnyExtensionServiceDefinition
  | AnySessionServiceDefinition;

/** Map declared dependencies to the resolved services they provide. */
export type DependencyServices<Deps extends readonly AnyServiceDefinition[]> = {
  [Definition in Deps[number] as Definition["name"]]: Awaited<
    ReturnType<Definition["create"]>
  >;
};

/**
 * What a session stop declares about the session's own resources.
 *
 * `release-runtime` keeps whatever outlives the scope (a session the host
 * still owns); `delete-session` tells the session disposers that the
 * session ends.  The mode is explicit: no caller infers it from the
 * reason.  It reaches the disposers only: the instance's session records
 * are deleted by the session lifecycle coordinator after the scope
 * stopped, so a stop through the kernel alone keeps them.
 */
export type SessionStopMode = "release-runtime" | "delete-session";

/**
 * Context handed to every `dispose` call.
 *
 * `reason` is the caller-supplied stop reason.  A session stopped because
 * its extension stopped receives the extension's stop reason, so cleanup
 * still records why it ran.  A session disposer receives
 * {@link SessionDisposeContext} instead.
 */
export interface DisposeContext {
  /** Host-supplied stop reason from the stop call that reached this service. */
  readonly reason: string;
}

/** Context handed to a session service's `dispose` call. */
export interface SessionDisposeContext extends DisposeContext {
  /** What this stop does with the session's resources. */
  readonly mode: SessionStopMode;
}

/** Create context for an extension-scoped service. */
export interface ExtensionCreateContext<
  Deps extends readonly AnyServiceDefinition[],
> {
  /** The services declared in `deps`, keyed by their own names. */
  readonly deps: DependencyServices<Deps>;
  /** Aborted when the extension scope stops. */
  readonly signal: AbortSignal;
}

/** Create context for a session-scoped service. */
export interface SessionCreateContext<
  Deps extends readonly AnyServiceDefinition[],
> extends ExtensionCreateContext<Deps> {
  /** The session this service instance belongs to. */
  readonly sessionID: string;
}

/**
 * Declarative extension-scoped service.
 *
 * `deps` names other extension definitions; `create` receives only the
 * services those definitions produce, so a factory cannot reach the
 * kernel or an undeclared sibling.  `dispose` is optional and runs in
 * reverse creation order.
 */
export interface ExtensionServiceDefinition<
  Name extends string = string,
  Deps extends
    readonly AnyExtensionServiceDefinition[] = readonly AnyExtensionServiceDefinition[],
  Service = unknown,
> {
  /** Unique service name inside the extension. */
  readonly name: Name;
  /** Extension definitions this factory needs at construction. */
  readonly deps: Deps;
  /** Build the service from its narrow dependency projection. */
  create(context: ExtensionCreateContext<Deps>): Service | Promise<Service>;
  /** Release the service; errors are collected by the stop report. */
  dispose?(service: Service, context: DisposeContext): void | Promise<void>;
}

/**
 * Declarative session-scoped service.
 *
 * Dependencies may be session or extension definitions; the kernel
 * creates extension services first and session dependencies in declared
 * order.  The factory additionally receives the owning session ID and a
 * signal aborted when that session stops.
 *
 * `start` is the real-start hook, not a construction step: it runs only
 * for a host start notice that arrives after the scope is ensured, runs
 * again on every real start, and never runs for a bare `ensureSession`.
 */
export interface SessionServiceDefinition<
  Name extends string = string,
  Deps extends
    readonly AnyServiceDefinition[] = readonly AnyServiceDefinition[],
  Service = unknown,
> {
  /** Unique service name inside the session scope. */
  readonly name: Name;
  /** Extension or session definitions needed at construction. */
  readonly deps: Deps;
  /** Build the service from its narrow dependency projection. */
  create(context: SessionCreateContext<Deps>): Service | Promise<Service>;
  /**
   * React to a real session start.
   *
   * Hooks run in creation order, after the scope is ensured, for every
   * host start notice.  A stop aborts the scope's signal immediately and
   * waits for a notice that has begun before it disposes the session.
   */
  start?(service: Service, context: SessionStartContext): void | Promise<void>;
  /** Release the service; errors are collected by the stop report. */
  dispose?(
    service: Service,
    context: SessionDisposeContext,
  ): void | Promise<void>;
}

/** Declarations accepted by {@link createLifecycleKernel}. */
export interface LifecycleDeclarations<
  Extension extends readonly AnyExtensionServiceDefinition[],
  Session extends readonly AnySessionServiceDefinition[],
> {
  /** Long-lived services created once per extension. */
  readonly extension: Extension;
  /** Per-session services created lazily and nested under the extension. */
  readonly session: Session;
}

/** Map a definition tuple to its resolved service instances. */
export type ServiceMap<Defs extends readonly AnyServiceDefinition[]> = {
  [Definition in Defs[number] as Definition["name"]]: Awaited<
    ReturnType<Definition["create"]>
  >;
};

/** A running extension scope. */
export interface ExtensionScope<Services> {
  /** Aborted when the extension stops. */
  readonly signal: AbortSignal;
  /** The created extension services. */
  readonly services: Services;
}

/** A running session scope nested inside one extension. */
export interface SessionScope<Services> {
  /** The owning session identifier. */
  readonly sessionID: string;
  /** Aborted when this session stops. */
  readonly signal: AbortSignal;
  /** The created session services. */
  readonly services: Services;
}

/**
 * Proof that one session accepts work for one {@link
 * LifecycleKernel.runSession} call.
 *
 * The kernel issues one permit per accepted call and releases it when the
 * work returns.  The permit never outlives the call.
 */
export interface WorkPermit {
  /** The session this permit belongs to. */
  readonly sessionID: string;
  /**
   * Aborted when the session or extension stops, or when the caller
   * cancels the call.
   */
  readonly signal: AbortSignal;
  /** Whether the work may still run under this permit. */
  isActive(): boolean;
}

/**
 * Context handed to a session service's `start` hook.
 *
 * It carries the host's real start facts and the scope's signal only —
 * never a service locator or the whole session scope.
 */
export interface SessionStartContext {
  /** The session that really started. */
  readonly sessionID: string;
  /** Host-supplied start reason. */
  readonly reason: string;
  /** Aborted when this session stops, after the notice completes. */
  readonly signal: AbortSignal;
}

/** Which scope a cleanup failure belongs to. */
export type CleanupScope = "extension" | "session";

/** One failed `dispose` call. */
export interface CleanupFailure {
  /** Scope kind of the failing service. */
  readonly scope: CleanupScope;
  /** The session ID for a session-scoped failure. */
  readonly sessionID?: string;
  /** The service name from its definition. */
  readonly service: string;
  /** The error thrown by `dispose`. */
  readonly error: unknown;
}

/**
 * Result of a stop operation.
 *
 * A stop attempts every remaining cleanup even when one fails; the
 * failures are returned here instead of rejecting so callers can report
 * a complete picture.
 */
export interface CleanupReport {
  /** Every cleanup failure, in the order the disposals ran. */
  readonly errors: readonly CleanupFailure[];
}

/** The lifecycle kernel returned by {@link createLifecycleKernel}. */
export interface LifecycleKernel<
  Extension extends readonly AnyExtensionServiceDefinition[],
  Session extends readonly AnySessionServiceDefinition[],
> {
  /**
   * Ensure the extension scope exists.  Concurrent callers share one
   * creation, and a stopped extension returns `null` instead of
   * restarting.
   */
  ensureExtension(): Promise<ExtensionScope<ServiceMap<Extension>> | null>;
  /**
   * Ensure a session scope exists.
   *
   * An absent or blank ID returns `null` without running any factory.
   * Concurrent callers share one creation; a stopped session or a
   * stopped extension returns `null` and never recreates resources.
   */
  ensureSession(
    sessionID: string | null | undefined,
  ): Promise<SessionScope<ServiceMap<Session>> | null>;
  /**
   * Run one unit of session work under a {@link WorkPermit}.
   *
   * The first call lazily creates the session.  An absent or blank ID, a
   * stopped session or extension, or an already-cancelled `signal` returns
   * `undefined` without running `work`.  A stop that begins during
   * creation is observed before the permit is issued, so the callback
   * never runs after it.  The callback's value and errors propagate
   * unchanged, and the permit is always released in `finally`.
   */
  runSession<T>(
    sessionID: string | null | undefined,
    work: (
      scope: SessionScope<ServiceMap<Session>>,
      permit: WorkPermit,
    ) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined>;
  /**
   * Run one control operation for a session under a permit no stop waits
   * for.
   *
   * Admission is the same as {@link LifecycleKernel.runSession}: an absent
   * or blank ID, a stopped session or extension, or an already-cancelled
   * `signal` runs nothing, and a stop revokes the permit at once.  The
   * difference is the stop's wait: a session and an extension stop do not
   * wait for this call to return.  It exists for the call that STOPS the
   * session it belongs to — a host command that replaces the session (an
   * agent switch, a plan handoff) — because waiting would deadlock the
   * stop it performs.  Ordinary business work must use
   * {@link LifecycleKernel.runSession} instead.
   */
  runControl<T>(
    sessionID: string | null | undefined,
    work: (
      scope: SessionScope<ServiceMap<Session>>,
      permit: WorkPermit,
    ) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined>;
  /**
   * Handle a real host session start.
   *
   * Ensures the session first, then runs each session service's
   * `start` hook in creation order with the host-supplied reason.  Every
   * real start notifies and the existing session is reused; notices are
   * serialised per session and a stop waits for the one in flight.
   * Returns `false` when the ID is invalid, the session or extension is
   * stopped, or a stop was requested before the notice could run.
   */
  notifySessionStart(
    sessionID: string | null | undefined,
    reason: string,
  ): Promise<boolean>;
  /**
   * Stop one session scope.
   *
   * `reason` and `mode` are both required and reach every session disposer
   * through {@link SessionDisposeContext}: the reason records why the stop
   * ran, the mode tells the disposers which resource step applies.  The
   * stop covers the scope only: the instance's session records are deleted
   * by the session lifecycle coordinator after this call returns, so a
   * `delete-session` stop through the kernel alone keeps them.  Safe to
   * repeat and safe to race with `ensureSession`; a stopped ID is
   * tombstoned so a late event cannot recreate it.  Never rejects for
   * cleanup failures — inspect {@link CleanupReport.errors}.
   */
  stopSession(
    sessionID: string | null | undefined,
    reason: string,
    mode: SessionStopMode,
  ): Promise<CleanupReport>;
  /**
   * Stop the extension: every remaining session first, then extension
   * services in reverse dependency order.
   *
   * `reason` reaches extension disposers, and also the disposers of the
   * nested sessions this call stops, so those cleanups stay traceable.
   * Nested sessions always stop with {@link SessionStopMode}
   * `release-runtime`: an extension stop never ends a session.
   * Safe to repeat and never rejects for cleanup failures.
   */
  stopExtension(reason: string): Promise<CleanupReport>;
}

/** Raised when declarations are ambiguous, missing a dependency, or cyclic. */
export class LifecycleDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleDefinitionError";
  }
}
