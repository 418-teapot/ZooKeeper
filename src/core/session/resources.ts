/**
 * Session records and the declarations that stop them.
 *
 * Some per-session records cannot live inside a session scope: every host
 * entry point of one plugin instance shares one context runtime and one
 * agent registry, so no single session scope may own them.  Each record
 * therefore declares what a stop does to it, and the catalog applies the
 * declarations once per stop:
 *
 *  - a `release` record drops its runtime part on a `release-runtime` stop
 *    and is deleted by a deletion;
 *  - a `retain` record survives a runtime release, and only a deletion
 *    drops it.
 *
 * The catalog is not a state container: the records keep their own storage
 * and access functions.  A failing record never blocks the others — every
 * declaration runs, and the failures come back in a report the way the
 * kernel reports stop failures.
 *
 * {@link contextSessionResources} lists the context records of one runtime.
 * Each host composition root builds its instance catalog from that list plus
 * the explicit session records (the agent binding) and gives it to the
 * session lifecycle coordinator.  The coordinator applies a release through
 * the session scope's stop (`defineSessionResourcesService`) and applies a
 * deletion itself, after the scope stopped: a release keeps the persisted
 * state plus the agent binding, a deletion drops every record.
 *
 * @module
 */

import type { ContextRuntime } from "../context/runtime.js";
import {
  type CleanupFailure,
  type CleanupReport,
  defineSessionService,
} from "../lifecycle/index.js";

/** What every session record declaration carries. */
interface SessionResourceBase {
  /** Record name, reported as the failure's service name. */
  readonly name: string;
  /** Delete the record; a session deletion runs it. */
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
 * Build the context session records of one runtime.
 *
 * The listed order is the application order.  The records are otherwise
 * independent.  The order does not protect a deletion: a delete evicts the
 * cached entry without writing it back, and only a release saves it.
 *
 * @param runtime - The plugin instance's context runtime.
 * @returns The runtime's session records, in application order.
 */
export function contextSessionResources(
  runtime: ContextRuntime,
): readonly SessionResource[] {
  return [
    {
      name: "modelLimit",
      runtime: "release",
      release: (sessionID) => runtime.clearModelLimit(sessionID),
      delete: (sessionID) => runtime.clearModelLimit(sessionID),
    },
    {
      name: "roundView",
      runtime: "release",
      release: (sessionID) => runtime.clearRoundView(sessionID),
      delete: (sessionID) => runtime.clearRoundView(sessionID),
    },
    {
      name: "sessionStateFile",
      runtime: "retain",
      delete: (sessionID) => runtime.delete(sessionID),
    },
    {
      name: "sessionStateCache",
      runtime: "release",
      release: (sessionID) => runtime.release(sessionID),
      delete: (sessionID) => runtime.evict(sessionID),
    },
  ];
}

/**
 * Declare the session service that releases the catalog on a stopping scope.
 *
 * The service carries no state: the records keep their own storage, so the
 * service exists only to hand the stop mode to the catalog.  Only a runtime
 * release reaches it — a deletion applies the catalog itself, after the
 * scope stopped, so a session without a scope follows the same protocol.
 * A record failure is rethrown as one aggregate error so the kernel still
 * reports it; every other record has already been applied by then.
 *
 * @param catalog - The declarations of this plugin instance.
 * @returns The session service the host declares.
 */
export function defineSessionResourcesService(catalog: SessionResourceCatalog) {
  return defineSessionService({
    name: "sessionResources",
    deps: [],
    create: ({ sessionID }) => ({ sessionID }),
    dispose: async ({ sessionID }, { mode }) => {
      if (mode !== "release-runtime") return;
      const report = await catalog.release(sessionID);
      if (report.errors.length === 0) return;
      throw new Error(
        `failed to release session records: ${report.errors
          .map((failure) => `${failure.service} (${String(failure.error)})`)
          .join(", ")}`,
      );
    },
  });
}
