/**
 * Host-agnostic lifecycle kernel.
 *
 * A kernel instance owns exactly two kinds of scope: one extension scope
 * created once on first use, and lazily created session scopes nested
 * inside it.  Services are declarative — each declaration names the
 * services it needs at construction, and its factory receives only that
 * slice plus the scope's `AbortSignal`.  There is no service locator, no
 * process dispose, and no host event handling here.
 *
 * Creation and stopping are serialised per scope.  Concurrent `ensure`
 * calls share one creation, a session stopped while its factory is still
 * running is never handed out, and a stopped ID is tombstoned so a late
 * event cannot recreate it.  Extension stop drains sessions first, then
 * disposes extension services in reverse dependency order; every
 * disposal is attempted and failures are returned in the cleanup report.
 *
 * Real session starts are a separate entry point
 * ({@link LifecycleKernel.notifySessionStart}) so a first-use ensure can
 * never fabricate a start reason.  A session stop carries its reason for
 * diagnostics and an explicit mode that decides whether it also deletes
 * what belongs to the session.
 *
 * `runSession` admits one unit of call-scoped work.  It lazily creates
 * the session, issues one `WorkPermit`, and releases it when the work
 * returns.  A stop revokes every permit synchronously, so admitted work
 * learns at once that it may no longer run, and the stop waits for those
 * calls to return before disposing the scope.  `runControl` admits the
 * same way but is never waited on: it is the call that stops the session
 * it belongs to, so waiting would deadlock the stop it performs.  Only a
 * replacement control operation (an agent switch, a plan handoff) may use
 * it; ordinary business work goes through `runSession`.
 *
 * @module
 */

import {
  type AnyExtensionServiceDefinition,
  type AnySessionServiceDefinition,
  type CleanupFailure,
  type CleanupReport,
  type DisposeContext,
  type ExtensionScope,
  type LifecycleDeclarations,
  LifecycleDefinitionError,
  type LifecycleKernel,
  type ServiceMap,
  type SessionDisposeContext,
  type SessionScope,
  type SessionStartContext,
  type SessionStopMode,
  type WorkPermit,
} from "./types.js";

/** Context a disposer receives: session stops add the explicit mode. */
type DisposableContext = DisposeContext | SessionDisposeContext;

/** Structural definition view used by ordering, creation, and cleanup. */
interface ErasedDefinition {
  readonly name: string;
  readonly deps: readonly ErasedDefinition[];
  create(context: {
    deps: ErasedServices;
    signal: AbortSignal;
    sessionID?: string;
  }): unknown;
  dispose?(service: unknown, context: DisposableContext): void | Promise<void>;
  start?(service: unknown, context: SessionStartContext): void | Promise<void>;
}

/** One created service plus the definition that owns its disposer. */
interface CreatedService {
  readonly definition: ErasedDefinition;
  readonly service: unknown;
}

/** One admitted unit of session work. */
interface WorkSlot {
  active: boolean;
}

/** Per-session internal state. */
interface SessionRecord {
  readonly sessionID: string;
  readonly controller: AbortController;
  readonly created: CreatedService[];
  readonly byName: Map<string, unknown>;
  state: "creating" | "ready" | "stopped" | "failed";
  stopRequested: boolean;
  stopPromise: Promise<CleanupReport> | null;
  pending: Promise<void>;
  startTail: Promise<void>;
  readonly work: Set<WorkSlot>;
  workIdle: Promise<void> | null;
  releaseWorkIdle: (() => void) | null;
  handle: ErasedSessionScope | null;
  error: unknown;
}

/** Extension lifecycle state. */
type ExtensionState = "idle" | "creating" | "ready" | "stopping" | "stopped";

/** Erased scope shapes used by the implementation. */
type ErasedServices = Record<string, unknown>;
type ErasedSessionScope = SessionScope<ErasedServices>;

/** A blank ID and an absent ID both mean "no session". */
function normalizeSessionID(
  sessionID: string | null | undefined,
): string | null {
  if (typeof sessionID !== "string") return null;
  return sessionID.trim() === "" ? null : sessionID;
}

/** An already cancelled call never reaches the callback. */
function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Order definitions so every dependency is created first.
 *
 * `external` names (the extension services, when ordering session
 * services) are assumed to exist already; any other dependency must be
 * in `definitions`.  Duplicate names are checked by the caller.
 */
function orderDefinitions<
  Definition extends {
    readonly name: string;
    readonly deps: readonly { readonly name: string }[];
  },
>(
  definitions: readonly Definition[],
  external: ReadonlySet<string>,
  scope: "extension" | "session",
): Definition[] {
  const byName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  const visiting = new Set<string>();
  const done = new Set<string>();
  const ordered: Definition[] = [];

  const visit = (definition: Definition, trail: readonly string[]): void => {
    if (done.has(definition.name)) return;

    if (visiting.has(definition.name)) {
      throw new LifecycleDefinitionError(
        `lifecycle ${scope} service dependency cycle: ${[
          ...trail,
          definition.name,
        ].join(" -> ")}`,
      );
    }

    visiting.add(definition.name);
    for (const dependency of definition.deps) {
      if (external.has(dependency.name)) continue;
      const target = byName.get(dependency.name);
      if (target === undefined) {
        throw new LifecycleDefinitionError(
          `lifecycle ${scope} service "${definition.name}" depends on unknown service "${dependency.name}"`,
        );
      }
      visit(target, [...trail, definition.name]);
    }
    visiting.delete(definition.name);
    done.add(definition.name);
    ordered.push(definition);
  };

  for (const definition of definitions) visit(definition, []);
  return ordered;
}

/** Build the narrow dependency slice a factory declared. */
function pickDeps(
  names: readonly string[],
  ...sources: ReadonlyMap<string, unknown>[]
): ErasedServices {
  const deps: ErasedServices = {};
  for (const name of names) {
    let found = false;
    for (const source of sources) {
      if (source.has(name)) {
        deps[name] = source.get(name);
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(`lifecycle dependency "${name}" is not ready`);
    }
  }
  return deps;
}

/**
 * Dispose created services in reverse creation order, collecting every
 * failure and continuing with the remaining services.
 */
async function disposeCreated(
  created: readonly CreatedService[],
  scope: "extension" | "session",
  sessionID: string | undefined,
  context: DisposableContext,
  errors: CleanupFailure[],
): Promise<void> {
  for (let index = created.length - 1; index >= 0; index -= 1) {
    const entry = created[index];
    if (entry === undefined || entry.definition.dispose === undefined) {
      continue;
    }
    try {
      await entry.definition.dispose(entry.service, context);
    } catch (error) {
      errors.push({
        scope,
        ...(sessionID === undefined ? {} : { sessionID }),
        service: entry.definition.name,
        error,
      });
    }
  }
}

/** Keep an unexpected create failure primary while surfacing cleanup errors. */
function combineCreateError(
  error: unknown,
  errors: readonly CleanupFailure[],
): unknown {
  if (errors.length === 0) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AggregateError(
    [error, ...errors.map((failure) => failure.error)],
    `lifecycle create failed: ${message} (${errors.length} cleanup failure(s))`,
  );
}

/**
 * Create a lifecycle kernel from declarative service definitions.
 *
 * Declarations are validated synchronously: duplicate names (including a
 * session service shadowing an extension service), missing dependencies,
 * and dependency cycles raise {@link LifecycleDefinitionError}.
 *
 * @param declarations - Extension and session service declarations.
 * @returns The kernel handle.
 */
export function createLifecycleKernel<
  const Extension extends readonly AnyExtensionServiceDefinition[],
  const Session extends readonly AnySessionServiceDefinition[],
>(
  declarations: LifecycleDeclarations<Extension, Session>,
): LifecycleKernel<Extension, Session> {
  const extensionDeclarations =
    declarations.extension as unknown as readonly ErasedDefinition[];
  const sessionDeclarations =
    declarations.session as unknown as readonly ErasedDefinition[];

  const extensionNames = new Set<string>();
  for (const definition of extensionDeclarations) {
    if (extensionNames.has(definition.name)) {
      throw new LifecycleDefinitionError(
        `duplicate extension service name "${definition.name}"`,
      );
    }
    extensionNames.add(definition.name);
  }

  const sessionNames = new Set<string>();
  for (const definition of sessionDeclarations) {
    if (sessionNames.has(definition.name)) {
      throw new LifecycleDefinitionError(
        `duplicate session service name "${definition.name}"`,
      );
    }
    if (extensionNames.has(definition.name)) {
      throw new LifecycleDefinitionError(
        `service name "${definition.name}" is declared in both scopes`,
      );
    }
    sessionNames.add(definition.name);
  }

  const extensionOrder = orderDefinitions(
    extensionDeclarations,
    new Set(),
    "extension",
  );
  const sessionOrder = orderDefinitions(
    sessionDeclarations,
    extensionNames,
    "session",
  );

  let extensionState: ExtensionState = "idle";
  let extensionStopRequested = false;
  let extensionStopPromise: Promise<CleanupReport> | null = null;
  let extensionFinalReport: CleanupReport | null = null;
  let extensionPromise: Promise<ExtensionScope<ErasedServices> | null> | null =
    null;
  let extensionController: AbortController | null = null;
  let extensionHandle: ExtensionScope<ErasedServices> | null = null;
  let extensionCreated: CreatedService[] = [];
  let extensionByName = new Map<string, unknown>();

  const sessions = new Map<string, SessionRecord>();
  const stoppedSessions = new Set<string>();

  /** A new scope can start only while the extension is alive. */
  function extensionAcceptsNewWork(): boolean {
    return (
      !extensionStopRequested &&
      extensionState !== "stopping" &&
      extensionState !== "stopped"
    );
  }

  /** Empty report helper. */
  function emptyReport(): CleanupReport {
    return { errors: [] };
  }

  /** Create extension services in dependency order. */
  async function startExtension(): Promise<ExtensionScope<ErasedServices> | null> {
    const controller = new AbortController();
    extensionController = controller;
    extensionCreated = [];
    extensionByName = new Map();

    try {
      for (const definition of extensionOrder) {
        const deps = pickDeps(
          definition.deps.map((dependency) => dependency.name),
          extensionByName,
        );
        const service = await definition.create({
          deps,
          signal: controller.signal,
        });
        extensionCreated.push({ definition, service });
        extensionByName.set(definition.name, service);
      }

      extensionHandle = {
        signal: controller.signal,
        services: Object.fromEntries(extensionByName),
      };
      if (extensionState === "creating") {
        extensionState = "ready";
      }
      return extensionState === "ready" ? extensionHandle : null;
    } catch (error) {
      const errors: CleanupFailure[] = [];
      // Abort before the first await: every service the failed scope built
      // observes the stop at once, so no reader holds a live signal of a
      // scope that never became ready.
      controller.abort();
      await disposeCreated(
        extensionCreated,
        "extension",
        undefined,
        { reason: "create.failed" },
        errors,
      );
      extensionCreated = [];
      extensionByName = new Map();
      extensionHandle = null;
      extensionPromise = null;
      extensionState = extensionStopRequested ? "stopped" : "idle";
      throw combineCreateError(error, errors);
    }
  }

  /** Ensure the extension scope, sharing one creation among callers. */
  function ensureExtension(): Promise<ExtensionScope<ErasedServices> | null> {
    if (extensionState === "ready") {
      return Promise.resolve(extensionHandle);
    }
    if (extensionState === "stopped" || extensionState === "stopping") {
      return Promise.resolve(null);
    }
    if (extensionState === "creating" && extensionPromise !== null) {
      return extensionPromise;
    }

    extensionState = "creating";
    extensionPromise = startExtension();
    return extensionPromise;
  }

  /** Create one session's services; resolves with the failure stored. */
  async function startSession(record: SessionRecord): Promise<void> {
    try {
      const extension = await ensureExtension();
      if (
        extension === null ||
        record.stopRequested ||
        !extensionAcceptsNewWork()
      ) {
        record.state = "stopped";
        return;
      }

      for (const definition of sessionOrder) {
        if (record.stopRequested || !extensionAcceptsNewWork()) break;

        // Session services shadow nothing (names are globally unique), so
        // the extension map is a valid second source for extension deps.
        const deps = pickDeps(
          definition.deps.map((dependency) => dependency.name),
          record.byName,
          extensionByName,
        );
        const service = await definition.create({
          deps,
          signal: record.controller.signal,
          sessionID: record.sessionID,
        });
        record.created.push({ definition, service });
        record.byName.set(definition.name, service);
      }

      record.handle = {
        sessionID: record.sessionID,
        signal: record.controller.signal,
        services: Object.fromEntries(record.byName),
      };
      record.state = "ready";
    } catch (error) {
      const errors: CleanupFailure[] = [];
      await disposeCreated(
        record.created,
        "session",
        record.sessionID,
        { reason: "create.failed", mode: "release-runtime" },
        errors,
      );
      record.created.length = 0;
      record.byName.clear();
      record.handle = null;
      record.state = "failed";
      record.error = combineCreateError(error, errors);
      sessions.delete(record.sessionID);
    }
  }

  /** Wait for creation and report the session only when it is usable. */
  async function settleSession(
    record: SessionRecord,
  ): Promise<ErasedSessionScope | null> {
    if (record.state === "creating") {
      await record.pending;
    }
    if (record.state === "failed") throw record.error;
    if (
      record.stopRequested ||
      stoppedSessions.has(record.sessionID) ||
      !extensionAcceptsNewWork()
    ) {
      return null;
    }
    return record.state === "ready" ? record.handle : null;
  }

  /** Ensure one session scope, sharing creation among concurrent callers. */
  async function ensureSession(
    rawSessionID: string | null | undefined,
  ): Promise<ErasedSessionScope | null> {
    const sessionID = normalizeSessionID(rawSessionID);
    if (
      sessionID === null ||
      stoppedSessions.has(sessionID) ||
      !extensionAcceptsNewWork()
    ) {
      return null;
    }

    const existing = sessions.get(sessionID);
    if (existing !== undefined) return settleSession(existing);

    const record: SessionRecord = {
      sessionID,
      controller: new AbortController(),
      created: [],
      byName: new Map(),
      state: "creating",
      stopRequested: false,
      stopPromise: null,
      pending: Promise.resolve(),
      startTail: Promise.resolve(),
      work: new Set(),
      workIdle: null,
      releaseWorkIdle: null,
      handle: null,
      error: null,
    };
    sessions.set(sessionID, record);
    record.pending = startSession(record);
    return settleSession(record);
  }

  /**
   * Admit one call, issuing a permit only while the session still accepts
   * work.
   *
   * `waitsForStop` decides whether a session or extension stop waits for
   * the call to return: session work is waited on, a control operation
   * (the call that stops the session it belongs to) is not.
   */
  async function admitCall<T>(
    rawSessionID: string | null | undefined,
    work: (
      scope: SessionScope<ServiceMap<Session>>,
      permit: WorkPermit,
    ) => T | Promise<T>,
    callerSignal: AbortSignal | undefined,
    waitsForStop: boolean,
  ): Promise<T | undefined> {
    const sessionID = normalizeSessionID(rawSessionID);
    if (sessionID === null || isCancelled(callerSignal)) return undefined;

    const scope = await ensureSession(sessionID);
    if (scope === null) return undefined;

    const record = sessions.get(sessionID);
    if (record === undefined) return undefined;
    // Issue the permit in the same synchronous segment as the final
    // checks: a stop cannot slip between the check and the registration.
    if (
      record.stopRequested ||
      record.state !== "ready" ||
      stoppedSessions.has(sessionID) ||
      !extensionAcceptsNewWork() ||
      isCancelled(callerSignal)
    ) {
      return undefined;
    }

    const slot: WorkSlot = { active: true };
    if (waitsForStop) record.work.add(slot);
    // The permit follows the session, the extension and the caller: its
    // signal aborts when any of them stops.
    const sources: AbortSignal[] = [record.controller.signal];
    if (extensionController !== null) sources.push(extensionController.signal);
    if (callerSignal !== undefined) sources.push(callerSignal);
    const signal = sources.length === 1 ? sources[0] : AbortSignal.any(sources);
    const permit: WorkPermit = {
      sessionID,
      signal,
      isActive: () => slot.active && !signal.aborted,
    };

    try {
      return await work(
        scope as unknown as SessionScope<ServiceMap<Session>>,
        permit,
      );
    } finally {
      slot.active = false;
      record.work.delete(slot);
      notifyWorkIdle(record);
    }
  }

  /**
   * Run one unit of session work, issuing a permit only while the session
   * still accepts work.
   */
  function runSession<T>(
    rawSessionID: string | null | undefined,
    work: (
      scope: SessionScope<ServiceMap<Session>>,
      permit: WorkPermit,
    ) => T | Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T | undefined> {
    return admitCall(rawSessionID, work, callerSignal, true);
  }

  /**
   * Run one control operation for a session, issuing the same permit as
   * session work without letting a stop wait for it.
   */
  function runControl<T>(
    rawSessionID: string | null | undefined,
    work: (
      scope: SessionScope<ServiceMap<Session>>,
      permit: WorkPermit,
    ) => T | Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T | undefined> {
    return admitCall(rawSessionID, work, callerSignal, false);
  }

  /** Resolve a stop that is waiting for admitted work to finish. */
  function notifyWorkIdle(record: SessionRecord): void {
    if (record.work.size > 0) return;
    const release = record.releaseWorkIdle;
    record.workIdle = null;
    record.releaseWorkIdle = null;
    release?.();
  }

  /** Wait for the work admitted before a stop to release its permits. */
  function waitForWork(record: SessionRecord): Promise<void> {
    if (record.work.size === 0) return Promise.resolve();
    if (record.workIdle === null) {
      record.workIdle = new Promise<void>((resolve) => {
        record.releaseWorkIdle = resolve;
      });
    }
    return record.workIdle;
  }

  /**
   * Run one real-start notice: every hook in creation order, unless the
   * session stopped or never became ready.
   */
  async function runStartHooks(
    record: SessionRecord,
    reason: string,
  ): Promise<boolean> {
    if (
      record.stopRequested ||
      stoppedSessions.has(record.sessionID) ||
      record.state !== "ready"
    ) {
      return false;
    }

    for (const entry of record.created) {
      if (entry.definition.start === undefined) continue;
      // A notice that has begun runs to completion; a stop waits for the
      // tail below, so no hook can outlive the disposal.
      await entry.definition.start(entry.service, {
        sessionID: record.sessionID,
        reason,
        signal: record.controller.signal,
      });
    }
    return true;
  }

  /** Serialise notices per session so hooks never interleave. */
  function enqueueStartNotice(
    record: SessionRecord,
    reason: string,
  ): Promise<boolean> {
    const run = record.startTail.then(
      () => runStartHooks(record, reason),
      () => runStartHooks(record, reason),
    );
    // The tail never rejects: a failing hook rejects its own notice only.
    record.startTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Handle a real host start: ensure, then queue the notice. */
  async function notifySessionStart(
    rawSessionID: string | null | undefined,
    reason: string,
  ): Promise<boolean> {
    const sessionID = normalizeSessionID(rawSessionID);
    if (
      sessionID === null ||
      stoppedSessions.has(sessionID) ||
      !extensionAcceptsNewWork()
    ) {
      return false;
    }

    const scope = await ensureSession(sessionID);
    if (
      scope === null ||
      stoppedSessions.has(sessionID) ||
      !extensionAcceptsNewWork()
    ) {
      return false;
    }

    const record = sessions.get(sessionID);
    if (record === undefined) return false;
    return enqueueStartNotice(record, reason);
  }

  /** Stop one session, tombstoning the ID first. */
  function stopSession(
    rawSessionID: string | null | undefined,
    reason: string,
    mode: SessionStopMode,
  ): Promise<CleanupReport> {
    const sessionID = normalizeSessionID(rawSessionID);
    if (sessionID === null) return Promise.resolve(emptyReport());

    stoppedSessions.add(sessionID);
    const record = sessions.get(sessionID);
    if (record === undefined) return Promise.resolve(emptyReport());
    if (record.stopPromise !== null) return record.stopPromise;

    record.stopRequested = true;
    // Abort before the first await: every permit derived from the scope
    // signal turns inactive at once and no new work can be admitted.
    record.controller.abort();
    record.stopPromise = (async () => {
      await record.pending;
      // Wait for a notice that had already begun before disposing.
      await record.startTail;
      await waitForWork(record);
      const errors: CleanupFailure[] = [];
      if (record.state === "ready") {
        await disposeCreated(
          record.created,
          "session",
          sessionID,
          { reason, mode },
          errors,
        );
        record.created.length = 0;
        record.byName.clear();
        record.handle = null;
      }
      record.state = "stopped";
      sessions.delete(sessionID);
      return { errors };
    })();

    return record.stopPromise;
  }

  /** Stop the extension: sessions first, then services in reverse order. */
  function stopExtension(reason: string): Promise<CleanupReport> {
    if (extensionFinalReport !== null) {
      return Promise.resolve(extensionFinalReport);
    }
    if (extensionStopPromise !== null) return extensionStopPromise;

    extensionStopRequested = true;
    if (extensionState === "idle" || extensionState === "stopped") {
      extensionState = "stopped";
      extensionFinalReport = emptyReport();
      return Promise.resolve(extensionFinalReport);
    }

    extensionState = "stopping";
    // Start every session stop before the first await so each permit is
    // revoked at once, then collect the reports in stop order.
    const sessionStops = [...sessions.keys()].map((sessionID) =>
      // An extension stop never ends a session: its resources are
      // released, not deleted.
      stopSession(sessionID, reason, "release-runtime"),
    );
    extensionStopPromise = (async () => {
      const errors: CleanupFailure[] = [];

      for (const stop of sessionStops) {
        const report = await stop;
        errors.push(...report.errors);
      }

      if (extensionPromise !== null) {
        try {
          await extensionPromise;
        } catch {
          // Already surfaced to the ensure callers; stop stays report-based.
        }
      }

      extensionController?.abort();
      await disposeCreated(
        extensionCreated,
        "extension",
        undefined,
        { reason },
        errors,
      );
      extensionCreated = [];
      extensionByName = new Map();
      extensionHandle = null;
      extensionState = "stopped";

      const report: CleanupReport = { errors };
      extensionFinalReport = report;
      return report;
    })();

    return extensionStopPromise;
  }

  return {
    ensureExtension,
    ensureSession,
    runSession,
    runControl,
    notifySessionStart,
    stopSession,
    stopExtension,
  } as LifecycleKernel<Extension, Session>;
}
