/**
 * Shared runtime start protocol: one start sequence for every host entry.
 *
 * A host entry names three things: the configuration generation the runtime
 * belongs to, the {@link RuntimeOrigin} it starts, and a factory that builds
 * the runtime's owner.  The owner is created before the first fallible step
 * and carries the start publisher plus the close handle of the resources it
 * created, so a start that fails in a later phase still has something to
 * close.  A factory that throws propagates its own error: no owner exists,
 * so the start closes nothing.
 *
 * The start itself has a fixed order: create the owner, `prepare` (every
 * fallible step, no host write), `publish` (the host writes the prepared
 * value describes).  A successful start returns a {@link RuntimeHandle}: the
 * origin, the publication, and the idempotent close handle of that runtime.
 *
 * A failed start closes the runtime it created and rethrows its own error.
 * The close runs exactly once; a close that throws or reports failures stays
 * observable in the log but never replaces the start error, and the runtime
 * it closed is terminal.
 *
 * The origin is the only protocol difference between a host's instances: pi
 * starts its main instance and every subagent instance this way, OpenCode
 * starts its main instance this way, and neither host keeps a second
 * main/child test of its own.
 *
 * @module
 */

import { log } from "../utils/logger.js";
import type { CleanupReport } from "./lifecycle/index.js";
import { type Publisher, runPublisher } from "./publisher.js";

/**
 * Which instance of a host starts.
 *
 * `main` is the instance the host itself loaded; `subagent` is the inline
 * runtime a delegated session loads, fixed to the agent that delegation
 * names.
 */
export type RuntimeOrigin =
  | { readonly kind: "main" }
  | { readonly kind: "subagent"; readonly agent: string };

/** The origin of a host's main instance. */
export const MAIN_ORIGIN: RuntimeOrigin = { kind: "main" };

/**
 * The agent a runtime is fixed to, or `undefined` for the main instance.
 *
 * @param origin - The origin of the runtime.
 * @returns The delegated agent of a subagent runtime.
 */
export function originAgent(origin: RuntimeOrigin): string | undefined {
  return origin.kind === "subagent" ? origin.agent : undefined;
}

/**
 * The resources one runtime owns before its first fallible step.
 *
 * The `createRuntime` callback of {@link StartRuntimeInput} builds both
 * members synchronously, so from the moment it returns every later phase —
 * including a failure — has them.
 */
export interface RuntimeOwner<Prepared, Publication> {
  /** The start publisher of this runtime. */
  readonly publisher: Publisher<Prepared, Publication>;
  /** Stop this runtime; the host's own close operation, called at most once. */
  readonly stop: () => Promise<CleanupReport>;
}

/** A started runtime: what it is, what it published, and how it closes. */
export interface RuntimeHandle<Publication> {
  /** The origin the runtime started with. */
  readonly origin: RuntimeOrigin;
  /** The publication `publish` produced. */
  readonly publication: Publication;
  /** Stop this runtime (idempotent). */
  readonly stop: () => Promise<CleanupReport>;
}

/** The explicit inputs of one runtime start. */
export interface StartRuntimeInput<Scope, Prepared, Publication> {
  /** The configuration generation this runtime belongs to. */
  readonly scope: Scope;
  /** The origin of this runtime. */
  readonly origin: RuntimeOrigin;
  /**
   * Build the runtime's owner.
   *
   * Called before the first fallible step, so the returned owner exists for
   * every later phase — including the failure path, which closes it.  A
   * throw propagates as the start error and closes nothing.
   *
   * @param context - The scope and origin this runtime starts with.
   * @returns The owner: its start publisher and its close handle.
   */
  createRuntime: (context: {
    readonly scope: Scope;
    readonly origin: RuntimeOrigin;
  }) => RuntimeOwner<Prepared, Publication>;
}

/**
 * Close a runtime whose start failed.
 *
 * The start error stays primary: a throwing close and the failures a close
 * reports are logged, never rethrown.
 *
 * @param stop - The close handle of the failed runtime.
 */
async function closeFailedRuntime(
  stop: () => Promise<CleanupReport>,
): Promise<void> {
  try {
    const report = await stop();
    for (const failure of report.errors) {
      log.warn({
        hook: "runtime",
        event: "cleanup_failed",
        scope: failure.scope,
        service: failure.service,
        ...(failure.sessionID === undefined
          ? {}
          : { sessionId: failure.sessionID }),
        error: String(failure.error),
      });
    }
  } catch (error) {
    log.warn({
      hook: "runtime",
      event: "cleanup_failed",
      service: "runtime",
      error: String(error),
    });
  }
}

/**
 * Start one runtime: create the owner, prepare, then publish.
 *
 * @param input - The scope, the origin, and the owner factory.
 * @returns The handle of the started runtime.
 * @throws The error the failing phase raised, after closing the runtime.
 */
export async function startRuntime<Scope, Prepared, Publication>(
  input: StartRuntimeInput<Scope, Prepared, Publication>,
): Promise<RuntimeHandle<Publication>> {
  const owner = input.createRuntime({
    scope: input.scope,
    origin: input.origin,
  });
  try {
    const publication = await runPublisher(owner.publisher);
    return { origin: input.origin, publication, stop: owner.stop };
  } catch (error) {
    await closeFailedRuntime(owner.stop);
    throw error;
  }
}
