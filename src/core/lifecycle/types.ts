/**
 * Host-agnostic lifecycle vocabulary.
 *
 * The kernel manages resource lifetime only: an extension scope owns
 * long-lived services, every session scope nests inside that extension,
 * and a service declares the definitions it needs at construction.
 * Factories receive exactly that dependency projection plus the scope's
 * `AbortSignal`, never the kernel or a service locator.
 *
 * The two scopes are the entire vocabulary.  There is no process dispose
 * and no turn/call boundary here — hosts translate their own events into
 * `ensureSession` / `notifySessionStart` calls and the kernel does not
 * inspect host types.
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
 * Context handed to every `dispose` call.
 *
 * `reason` is the caller-supplied stop reason.  A session stopped because
 * its extension stopped receives the extension's stop reason, so cleanup
 * still records why it ran.
 */
export interface DisposeContext {
  /** Host-supplied stop reason from the stop call that reached this service. */
  readonly reason: string;
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
   * host start notice.  The scope's signal is not yet aborted and the
   * session cannot be disposed until the notice completes.
   */
  start?(service: Service, context: SessionStartContext): void | Promise<void>;
  /** Release the service; errors are collected by the stop report. */
  dispose?(service: Service, context: DisposeContext): void | Promise<void>;
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
   * `reason` is required and reaches every session disposer through
   * {@link DisposeContext}.  Safe to repeat and safe to race with
   * `ensureSession`; a stopped ID is tombstoned so a late event cannot
   * recreate it.  Never rejects for cleanup failures — inspect
   * {@link CleanupReport.errors}.
   */
  stopSession(
    sessionID: string | null | undefined,
    reason: string,
  ): Promise<CleanupReport>;
  /**
   * Stop the extension: every remaining session first, then extension
   * services in reverse dependency order.
   *
   * `reason` reaches extension disposers, and also the disposers of the
   * nested sessions this call stops, so those cleanups stay traceable.
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
