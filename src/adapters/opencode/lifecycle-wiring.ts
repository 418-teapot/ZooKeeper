/**
 * OpenCode lifecycle wiring — the kernel instance behind the plugin hooks.
 *
 * The entry point declares this host's services (see `services.ts`) and
 * drives them through the operations below:
 *
 *  - `ensureSession` creates (or reuses) the session scope of the id a hook
 *    names.  OpenCode announces creations with `session.created`, but many
 *    hooks can be the FIRST thing the host says about a session (a message
 *    update, a tool call, a command), so they all ensure the scope before
 *    touching session state; a missing id creates nothing.
 *  - `handleEvent` maps the host's own session events (`session.created`
 *    is a real start notice, `session.deleted` stops exactly that session)
 *    through the shared mapping.  A deletion never creates a scope: the
 *    kernel tombstones the id, so a late event cannot rebuild what the
 *    host dropped.
 *  - `dispose` is the plugin's teardown hook: it stops every remaining
 *    session and then the extension, and reports the cleanup outcome.
 *    A dispose is not a deletion — the sessions still exist on the host
 *    side — so their persisted context survives for the next instance.
 *
 * Cleanup failures are never swallowed: the wiring logs each of them and
 * still returns the report.  A `session.deleted` naming a session this
 * instance never created a scope for still releases that session's
 * process-level records (the context pipeline keeps one store per process —
 * see `services.ts`), while a session a scope owned is released by that
 * scope's own disposer.  Ownership therefore covers both ways a scope is
 * created: the first-use `ensureSession` and the `session.created`
 * notice, so a created-then-deleted session never runs both releases.
 *
 * @module
 */

import {
  type AnyExtensionServiceDefinition,
  type AnySessionServiceDefinition,
  type CleanupReport,
  createLifecycleKernel,
  type LifecycleKernel,
  type ServiceMap,
  type SessionScope,
} from "../../core/lifecycle/index.js";
import { log } from "../../utils/logger.js";
import {
  createOpenCodeLifecycleMapping,
  type OpenCodeLifecycleOutcome,
  openCodeEventSessionID,
} from "./lifecycle.js";
import { releaseUnscopedSession } from "./services.js";

/** Options for {@link createOpenCodeLifecycleWiring}. */
export interface OpenCodeLifecycleWiringOptions<
  Extension extends readonly AnyExtensionServiceDefinition[],
  Session extends readonly AnySessionServiceDefinition[],
> {
  /** The extension-scoped service declarations of this plugin instance. */
  readonly extensionServices: Extension;
  /** The session-scoped service declarations of this plugin instance. */
  readonly sessionServices: Session;
}

/**
 * The lifecycle operations one OpenCode plugin instance drives.
 *
 * Session services stay reachable only through their own session scope and
 * an explicit session id, so a caller can never hold another session's
 * state.
 */
export interface OpenCodeLifecycleWiring<
  Session extends
    readonly AnySessionServiceDefinition[] = readonly AnySessionServiceDefinition[],
> {
  /**
   * Ensure the session scope of `sessionID`.
   *
   * An absent or blank id, a session the host already deleted, and a
   * disposed plugin all return `null` without creating anything.
   *
   * @param sessionID - The session the current hook names.
   * @returns The ready session scope, or `null`.
   */
  ensureSession(
    sessionID: string | null | undefined,
  ): Promise<SessionScope<ServiceMap<Session>> | null>;
  /**
   * Map one received host event onto the kernel.
   *
   * @param event - The host event as the `event` hook received it.
   * @returns What the event did; `none` for anything unmapped.
   */
  handleEvent(event: unknown): Promise<OpenCodeLifecycleOutcome>;
  /**
   * Stop every session and then the extension (the plugin's `dispose`).
   *
   * @returns The cleanup report; failures are also logged.
   */
  dispose(): Promise<CleanupReport>;
}

/** A blank id and an absent id both mean "no session". */
function normalizeSessionID(
  sessionID: string | null | undefined,
): string | null {
  if (typeof sessionID !== "string") return null;
  return sessionID.trim() === "" ? null : sessionID;
}

/** A hook as it is handed to the host. */
type HookHandler = (...args: unknown[]) => unknown;

/**
 * Read the session a hook call addresses.
 *
 * Most hooks name it on their input; the message transform receives no
 * session context, so it is read off the conversation's first message
 * instead.  Anything else means "no session" — the wrapper never guesses.
 *
 * @param args - The arguments the host passed to the hook.
 * @returns The session id, or `null`.
 */
function sessionIDOfArgs(args: readonly unknown[]): string | null {
  const input = args[0] as { sessionID?: unknown } | undefined;
  if (typeof input?.sessionID === "string") return input.sessionID;

  const output = args[1] as { messages?: unknown } | undefined;
  const first = Array.isArray(output?.messages)
    ? output.messages[0]
    : undefined;
  const id = (first as { info?: { sessionID?: unknown } } | undefined)?.info
    ?.sessionID;
  return typeof id === "string" ? id : null;
}

/** Hooks that receive host configuration rather than a session. */
const SESSIONLESS_HOOKS: ReadonlySet<string> = new Set(["event", "config"]);

/**
 * Wrap the assembled hooks so each call ensures the session scope first.
 *
 * Every hook that names a session may be the host's first observation of
 * it, so the session's state must exist before the handler reads it.  The
 * hooks that name no session are left untouched: `event` ensures exactly
 * the paths it drives, and some of them (a deletion) must not create
 * anything, while `config` runs against the host configuration before any
 * session exists.  Non-function entries (the `tool` registry) pass through
 * as they are.
 *
 * @param hooks - The assembled hook fragment.
 * @param ensure - Ensures the scope of the session a call addresses.
 * @returns The wrapped fragment, with the same keys.
 */
export function withEnsuredSessions<T extends Record<string, unknown>>(
  hooks: T,
  ensure: (sessionID: string | null | undefined) => Promise<unknown>,
): T {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hooks)) {
    if (typeof value !== "function" || SESSIONLESS_HOOKS.has(key)) {
      wrapped[key] = value;
      continue;
    }
    const handler = value as HookHandler;
    wrapped[key] = async (...args: unknown[]) => {
      await ensure(sessionIDOfArgs(args));
      return handler(...args);
    };
  }
  return wrapped as T;
}

/**
 * Log every cleanup failure of a stop report.
 *
 * A failed disposer must stay visible: without an entry here the resource
 * it was supposed to release would be lost silently.
 *
 * @param report - The stop report to report.
 */
function logCleanupFailures(report: CleanupReport): void {
  for (const failure of report.errors) {
    log.warn({
      hook: "plugin",
      event: "cleanup_failed",
      scope: failure.scope,
      service: failure.service,
      ...(failure.sessionID === undefined
        ? {}
        : { sessionId: failure.sessionID }),
      error: String(failure.error),
    });
  }
}

/**
 * Create the lifecycle wiring of one OpenCode plugin instance.
 *
 * @param options - The extension and session declarations of this host.
 * @returns The lifecycle operations the plugin hooks drive.
 */
export function createOpenCodeLifecycleWiring<
  const Extension extends readonly AnyExtensionServiceDefinition[],
  const Session extends readonly AnySessionServiceDefinition[],
>(
  options: OpenCodeLifecycleWiringOptions<Extension, Session>,
): OpenCodeLifecycleWiring<Session> {
  const kernel: LifecycleKernel<Extension, Session> = createLifecycleKernel({
    extension: options.extensionServices,
    session: options.sessionServices,
  });
  const mapping = createOpenCodeLifecycleMapping(kernel);
  // Sessions this instance created a scope for and has not stopped.  The
  // kernel tombstones a stopped id without exposing that fact, and a
  // deletion of an unknown session still needs the process-level release.
  const owned = new Set<string>();

  async function ensureSession(
    rawSessionID: string | null | undefined,
  ): Promise<SessionScope<ServiceMap<Session>> | null> {
    const sessionID = normalizeSessionID(rawSessionID);
    if (sessionID === null) return null;
    const scope = await kernel.ensureSession(sessionID);
    if (scope === null) return null;
    owned.add(sessionID);
    return scope as SessionScope<ServiceMap<Session>>;
  }

  async function handleEvent(
    event: unknown,
  ): Promise<OpenCodeLifecycleOutcome> {
    const outcome = await mapping.handleEvent(event);
    if (outcome.action === "start") {
      // A real start notice creates the scope itself (the mapping goes
      // through the kernel's notify path, not this wiring's ensure), so the
      // session is registered as owned here.  `started === false` means no
      // scope exists — a deletion of that id still needs the fallback.
      if (outcome.started) {
        const started = normalizeSessionID(openCodeEventSessionID(event));
        if (started !== null) owned.add(started);
      }
      return outcome;
    }
    if (outcome.action !== "stop-session") return outcome;

    const sessionID = normalizeSessionID(outcome.sessionID);
    if (sessionID !== null) {
      const wasOwned = owned.delete(sessionID);
      // A session whose scope this instance owned was released by that
      // scope's disposer; one it never created keeps the deletion's own
      // process-level release so nothing is left behind.
      if (!wasOwned) releaseUnscopedSession(sessionID);
    }
    logCleanupFailures(outcome.report);
    return outcome;
  }

  async function dispose(): Promise<CleanupReport> {
    const report = await mapping.dispose();
    owned.clear();
    logCleanupFailures(report);
    return report;
  }

  return { ensureSession, handleEvent, dispose };
}
