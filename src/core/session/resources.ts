/**
 * Session records and the declarations that stop them.
 *
 * Some per-session records cannot live inside a session scope: every host
 * entry point in the process shares one store, one agent registry and one
 * set of runtime caches, so no scope may own them.  Each record therefore
 * declares what a stop does to it, and the catalog applies the declarations
 * once per stop:
 *
 *  - a `release` record drops its runtime part on a `release-runtime` stop
 *    and is deleted by a `delete-session` stop;
 *  - a `retain` record survives a runtime release, and only a deletion
 *    drops it.
 *
 * The catalog is not a state container: the records keep their own storage
 * and access functions.  A failing record never blocks the others — every
 * declaration runs, and the failures come back in a report the way the
 * kernel reports stop failures.
 *
 * {@link sessionResources} lists every process-level session record of this
 * build, and {@link sessionResourcesService} puts those declarations on the
 * session scope's stop path.  A `release-runtime` stop (a plugin dispose, a
 * pi `session_shutdown`) releases the runtime records and keeps the
 * persisted state plus the agent binding; a `delete-session` stop (an
 * OpenCode `session.deleted`) deletes every record.
 *
 * @module
 */

import { modelLimitResource } from "../context/model-limits.js";
import { roundViewResource } from "../context/round-view.js";
import {
  pendingViewChangeFlagResource,
  sessionStateCacheResource,
  sessionStateFileResource,
} from "../context/runtime.js";
import {
  type CleanupFailure,
  type CleanupReport,
  defineSessionService,
} from "../lifecycle/index.js";
import { sessionAgentResource } from "./agent.js";

/** What every session record declaration carries. */
interface SessionResourceBase {
  /** Record name, reported as the failure's service name. */
  readonly name: string;
  /** Delete the record; only a `delete-session` stop runs it. */
  delete(sessionID: string): void | Promise<void>;
}

/** A record a runtime stop releases as well as a deletion drops. */
export interface ReleasedSessionResource extends SessionResourceBase {
  /** The record has a runtime part a stop releases. */
  readonly runtime: "release";
  /** Drop the runtime part; what the host still owns stays. */
  release(sessionID: string): void | Promise<void>;
}

/** A record only a session deletion drops. */
export interface RetainedSessionResource extends SessionResourceBase {
  /** The record outlives a runtime release. */
  readonly runtime: "retain";
}

/** One session record's lifecycle declaration. */
export type SessionResource = ReleasedSessionResource | RetainedSessionResource;

/** Applies the record declarations to one session. */
export interface SessionResourceCatalog {
  /** The declarations, in application order. */
  readonly resources: readonly SessionResource[];
  /** Release the runtime records; keep the retained ones. */
  release(sessionID: string): Promise<CleanupReport>;
  /** Delete every record of the session. */
  delete(sessionID: string): Promise<CleanupReport>;
}

/**
 * Apply one step to every declaration, collecting the failures.
 *
 * @param sessionID - The session the stop addresses.
 * @param resources - The declarations to apply, in order.
 * @param step - The per-declaration step of the current stop mode.
 * @returns The failures, in application order.
 */
async function applyAll(
  sessionID: string,
  resources: readonly SessionResource[],
  step: (resource: SessionResource) => void | Promise<void>,
): Promise<CleanupReport> {
  const errors: CleanupFailure[] = [];
  for (const resource of resources) {
    try {
      await step(resource);
    } catch (error) {
      errors.push({
        scope: "session",
        sessionID,
        service: resource.name,
        error,
      });
    }
  }
  return { errors };
}

/**
 * Create a catalog over a set of declarations.
 *
 * @param resources - The record declarations, in application order.
 * @returns The catalog that applies them.
 */
export function createSessionResourceCatalog(
  resources: readonly SessionResource[],
): SessionResourceCatalog {
  return {
    resources,
    release: (sessionID) =>
      applyAll(sessionID, resources, (resource) =>
        resource.runtime === "release"
          ? resource.release(sessionID)
          : undefined,
      ),
    delete: (sessionID) =>
      applyAll(sessionID, resources, (resource) => resource.delete(sessionID)),
  };
}

/**
 * Every process-level session record of this build.
 *
 * The listed order is the application order.  The records are otherwise
 * independent.  The order does not protect a deletion: a delete evicts the
 * cached entry without writing it back, and only a release saves it.
 */
export const sessionResources = createSessionResourceCatalog([
  modelLimitResource,
  roundViewResource,
  pendingViewChangeFlagResource,
  sessionStateFileResource,
  sessionStateCacheResource,
  sessionAgentResource,
]);

/**
 * Declare the session service that applies the catalog to a stopping scope.
 *
 * The service carries no state: the records are process-level, so the
 * service exists only to hand the stop mode to the catalog.  A record
 * failure is rethrown as one aggregate error so the kernel still reports
 * it; every other record has already been applied by then.
 *
 * @param catalog - The declarations to apply; this build's by default.
 * @returns The session service both hosts declare.
 */
export function defineSessionResourcesService(
  catalog: SessionResourceCatalog = sessionResources,
) {
  return defineSessionService({
    name: "sessionResources",
    deps: [],
    create: ({ sessionID }) => ({ sessionID }),
    dispose: async ({ sessionID }, { mode }) => {
      const report =
        mode === "delete-session"
          ? await catalog.delete(sessionID)
          : await catalog.release(sessionID);
      if (report.errors.length === 0) return;
      const action = mode === "delete-session" ? "delete" : "release";
      throw new Error(
        `failed to ${action} session records: ${report.errors
          .map((failure) => `${failure.service} (${String(failure.error)})`)
          .join(", ")}`,
      );
    },
  });
}

/** The session service both hosts declare. */
export const sessionResourcesService = defineSessionResourcesService();
