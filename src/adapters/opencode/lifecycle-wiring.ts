/**
 * OpenCode lifecycle wiring — the kernel instance behind the plugin hooks.
 *
 * The entry point declares this host's services (see `services.ts`) and
 * drives them through the operations below:
 *
 *  - `ensureSession` creates (or reuses) the session scope of the id a hook
 *    names.  OpenCode announces creations with `session.created`, but many
 *    hooks can be the FIRST thing the host says about a session (a message
 *    update, a tool call, a command), so all of them enter through this
 *    scope; a missing id creates nothing.
 *  - `runSession` admits one unit of call-scoped work under a `WorkPermit`
 *    (a hook call, a tool call).  The permit's signal follows the session,
 *    the extension, and the caller's own cancellation, and a stop waits for
 *    admitted work before disposing the scope.
 *  - `handleEvent` maps the host's own session events (`session.created`
 *    is a real start notice, `session.deleted` stops exactly that session)
 *    through the shared mapping.  A deletion never creates a scope: the
 *    kernel tombstones the id, so a late event cannot rebuild what the
 *    host dropped.
 *  - `dispose` is the plugin's teardown hook: it stops every remaining
 *    session and then the extension, and reports the cleanup outcome.
 *    A dispose is not a deletion — the sessions still exist on the host
 *    side — so those scopes stop with the `release-runtime` mode and their
 *    persisted context survives for the next instance.
 *
 * Cleanup failures are never swallowed: the wiring logs each of them and
 * still returns the report.  A `session.deleted` naming a session this
 * instance never created a scope for still deletes that session's
 * instance records (the context runtime and the agent registry outlive a
 * scope — see `services.ts`): the catalog applies the same declarations a
 * scope's disposer applies, without creating a scope.  A session a scope
 * owned is
 * deleted by that scope's own disposer, and its failures join the returned
 * report.  Ownership therefore covers both ways a scope is created: the
 * first-use `ensureSession`, the `session.created` notice, and any admitted
 * work, so a created-then-deleted session never runs both deletions.
 *
 * `withSessionWork` is the shape the plugin entry point registers: every
 * session hook becomes call-scoped work, the `tool` registry becomes
 * permit-scoped tools, and the `event` hook sends lifetime events through
 * the lifecycle while admitting the rest of its per-session work.
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
  type WorkPermit,
} from "../../core/lifecycle/index.js";
import type { SessionResourceCatalog } from "../../core/session/resources.js";
import { log } from "../../utils/logger.js";
import {
  createOpenCodeLifecycleMapping,
  type OpenCodeLifecycleOutcome,
  openCodeEventSessionID,
} from "./lifecycle.js";

/** Options for {@link createOpenCodeLifecycleWiring}. */
export interface OpenCodeLifecycleWiringOptions<
  Extension extends readonly AnyExtensionServiceDefinition[],
  Session extends readonly AnySessionServiceDefinition[],
> {
  /** The extension-scoped service declarations of this plugin instance. */
  readonly extensionServices: Extension;
  /** The session-scoped service declarations of this plugin instance. */
  readonly sessionServices: Session;
  /**
   * The session records of this plugin instance.
   *
   * A deletion naming a session this instance never created a scope for
   * still applies these declarations, without creating a scope.
   */
  readonly sessionCatalog: SessionResourceCatalog;
}

/**
 * One session's admission surface.
 *
 * A call is admitted only for a live session; the work runs under the
 * issued permit, and its result reaches the caller unchanged.
 */
export interface SessionWorkRunner {
  /**
   * Admit one unit of work under a {@link WorkPermit}.
   *
   * @param sessionID - The session the call addresses.
   * @param work - The admitted work, receiving its permit.
   * @param signal - The caller's own cancellation, if any.
   * @returns The work's value, or `undefined` when the call is refused.
   */
  runSession<T>(
    sessionID: string | null | undefined,
    work: (permit: WorkPermit) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined>;
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
> extends SessionWorkRunner {
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

/** Hooks that address the host rather than a session. */
const SESSIONLESS_HOOKS: ReadonlySet<string> = new Set([
  "config",
  "tool.definition",
]);

/**
 * Hooks that still run when their call names no session.
 *
 * The system transform addresses the host, not one session: only its
 * session-scoped part depends on admission, and that part stays behind
 * the permit.
 */
const SESSION_OPTIONAL_HOOKS: ReadonlySet<string> = new Set([
  "experimental.chat.system.transform",
]);

/** Events whose body is one session's work. */
const SESSION_EVENTS: ReadonlySet<string> = new Set([
  "message.updated",
  "session.error",
  "session.idle",
]);

/**
 * Read the session a per-session host event addresses.
 *
 * `message.updated` names it on the message info; `session.error` and
 * `session.idle` name it on the event properties.  Anything else carries
 * no session.
 *
 * @param event - The host event the `event` hook received.
 * @returns The session id, or `null`.
 */
function eventSessionID(event: unknown): string | null {
  const properties = (event as { properties?: unknown } | null | undefined)
    ?.properties as
    | { sessionID?: unknown; info?: { sessionID?: unknown } }
    | undefined;
  const candidate = properties?.info?.sessionID ?? properties?.sessionID;
  return typeof candidate === "string" ? candidate : null;
}

/** The host-forwarded tool surface the wrapper extends. */
interface ToolHostContext {
  [field: string]: unknown;
  signal?: AbortSignal;
  permit?: WorkPermit;
}

/** One registered tool as the host calls it. */
type ToolExecute = (
  args: unknown,
  toolCtx: unknown,
  hostCtx?: ToolHostContext,
) => Promise<string>;

/** The tool-registry entry shape this module wraps. */
interface ToolEntry {
  [metadata: string]: unknown;
  execute?: ToolExecute;
}

/**
 * Wrap one tool so each call is admitted under its session's permit.
 *
 * The tool context's `abort` is the caller's cancellation.  The admitted
 * permit's signal replaces it, so the tool stops when the session or the
 * extension stops.  The third argument keeps the host's fields and adds
 * the permit for tools that need it.  A refused call returns an empty
 * string and never runs the tool.
 *
 * @param entry - The tool contribution as the registry holds it.
 * @param run - Admits the call.
 * @returns The wrapped entry, with every other field unchanged.
 */
function withSessionTool(entry: unknown, run: SessionWorkRunner): unknown {
  const tool = entry as ToolEntry | null | undefined;
  const execute = tool?.execute;
  if (typeof execute !== "function") return entry;
  return {
    ...tool,
    async execute(args: unknown, toolCtx: unknown, hostCtx?: ToolHostContext) {
      const context = (toolCtx ?? {}) as {
        sessionID?: unknown;
        sessionId?: unknown;
        abort?: unknown;
      };
      const sessionID =
        typeof context.sessionID === "string"
          ? context.sessionID
          : typeof context.sessionId === "string"
            ? context.sessionId
            : null;
      const caller =
        context.abort instanceof AbortSignal ? context.abort : undefined;
      const result = await run.runSession(
        sessionID,
        (permit) =>
          execute(
            args,
            { ...context, abort: permit.signal },
            { ...hostCtx, signal: permit.signal, permit },
          ),
        caller,
      );
      return result ?? "";
    },
  };
}

/**
 * Wrap every tool of the registry, keeping each entry's metadata.
 *
 * @param tools - The `tool` value of the assembled hooks.
 * @param run - Admits each call.
 * @returns The wrapped registry, with the same keys.
 */
function withSessionTools(tools: unknown, run: SessionWorkRunner): unknown {
  if (typeof tools !== "object" || tools === null) return tools;
  const wrapped: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(tools)) {
    wrapped[name] = withSessionTool(entry, run);
  }
  return wrapped as Record<string, unknown>;
}

/**
 * Wrap the `event` hook.
 *
 * A creation and a deletion drive the lifecycle and take no permit: the
 * deletion of a stopped session still has to run.  A per-session event is
 * admitted under the session it names and runs nothing when it names none.
 * Every other event keeps the hook's own behavior.
 *
 * @param handler - The assembled event hook.
 * @param run - Admits the per-session work.
 * @returns The wrapped event hook.
 */
function withSessionEvents(
  handler: HookHandler,
  run: SessionWorkRunner,
): HookHandler {
  return async (...args: unknown[]) => {
    const event = (args[0] as { event?: unknown } | undefined)?.event;
    const type = (event as { type?: unknown } | null | undefined)?.type;
    if (typeof type !== "string" || !SESSION_EVENTS.has(type)) {
      return handler(...args);
    }
    return run.runSession(eventSessionID(event), () => handler(...args));
  };
}

/**
 * Wrap the assembled hooks so every call enters through its session.
 *
 * A session hook becomes one unit of admitted work: it runs only for a
 * live session, receives the permit as its trailing argument, and a stop
 * waits for it before disposing the scope.  The system transform keeps
 * running when its call names no session, without a permit.  The `tool`
 * registry is wrapped entry by entry, so a tool call is admitted the same
 * way and receives the permit's signal as its abort.  `config` and
 * `tool.definition` address the host, not a session, and stay unchanged.
 *
 * @param hooks - The assembled hook fragment.
 * @param run - The lifecycle admission surface.
 * @returns The wrapped fragment, with the same keys.
 */
export function withSessionWork<T extends Record<string, unknown>>(
  hooks: T,
  run: SessionWorkRunner,
): T {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hooks)) {
    if (key === "tool") {
      wrapped.tool = withSessionTools(value, run);
      continue;
    }
    if (typeof value !== "function" || SESSIONLESS_HOOKS.has(key)) {
      wrapped[key] = value;
      continue;
    }
    const handler = value as HookHandler;
    if (key === "event") {
      wrapped.event = withSessionEvents(handler, run);
      continue;
    }
    wrapped[key] = async (...args: unknown[]) => {
      const sessionID = sessionIDOfArgs(args);
      if (
        SESSION_OPTIONAL_HOOKS.has(key) &&
        normalizeSessionID(sessionID) === null
      ) {
        return handler(...args, undefined);
      }
      return run.runSession(sessionID, (permit) => handler(...args, permit));
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

  async function runSession<T>(
    rawSessionID: string | null | undefined,
    work: (permit: WorkPermit) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const sessionID = normalizeSessionID(rawSessionID);
    if (sessionID === null) return undefined;
    return kernel.runSession<T>(
      sessionID,
      (_scope, permit) => {
        // Admission itself registers ownership, so a later deletion uses
        // the scope's disposer instead of the unknown-session fallback.
        owned.add(sessionID);
        return work(permit);
      },
      signal,
    );
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
    let report = outcome.report;
    // A session whose scope this instance owned was deleted by that scope's
    // disposer; one it never created still gets the deletion, so nothing is
    // left behind and its failures reach the caller as well.
    if (sessionID !== null && !owned.delete(sessionID)) {
      const fallback = await options.sessionCatalog.delete(sessionID);
      report = { errors: [...fallback.errors, ...report.errors] };
    }
    logCleanupFailures(report);
    return report === outcome.report ? outcome : { ...outcome, report };
  }

  async function dispose(): Promise<CleanupReport> {
    const report = await mapping.dispose();
    owned.clear();
    logCleanupFailures(report);
    return report;
  }

  return { ensureSession, runSession, handleEvent, dispose };
}
