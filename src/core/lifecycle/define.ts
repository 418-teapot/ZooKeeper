/**
 * Typed declaration helpers for the lifecycle kernel.
 *
 * Dependencies are declared as the definition objects themselves, so the
 * factory's dependency projection and the service map both derive from
 * the same declarations.  Names stay literal, which keeps the scope's
 * service map precise without hand-written generic arguments.
 *
 * @module
 */

import type {
  AnyExtensionServiceDefinition,
  AnyServiceDefinition,
  DisposeContext,
  ExtensionCreateContext,
  ExtensionServiceDefinition,
  SessionCreateContext,
  SessionServiceDefinition,
  SessionStartContext,
} from "./types.js";

/** The raw declaration shape accepted by {@link defineExtensionService}. */
export interface ExtensionServiceSpec<
  Name extends string,
  Deps extends readonly AnyExtensionServiceDefinition[],
  Service,
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

/** The raw declaration shape accepted by {@link defineSessionService}. */
export interface SessionServiceSpec<
  Name extends string,
  Deps extends readonly AnyServiceDefinition[],
  Service,
> {
  /** Unique service name inside the session scope. */
  readonly name: Name;
  /** Extension or session definitions needed at construction. */
  readonly deps: Deps;
  /** Build the service from its narrow dependency projection. */
  create(context: SessionCreateContext<Deps>): Service | Promise<Service>;
  /** React to a real session start after the scope is ensured. */
  start?(service: Service, context: SessionStartContext): void | Promise<void>;
  /** Release the service; errors are collected by the stop report. */
  dispose?(service: Service, context: DisposeContext): void | Promise<void>;
}

/**
 * Declare an extension-scoped service.
 *
 * @param definition - Name, dependency definitions, factory, and disposer.
 * @returns The same definition with its dependency and service types kept.
 */
export function defineExtensionService<
  const Name extends string,
  const Deps extends readonly AnyExtensionServiceDefinition[],
  Service,
>(
  definition: ExtensionServiceSpec<Name, Deps, Service>,
): ExtensionServiceDefinition<Name, Deps, Service> {
  return definition;
}

/**
 * Declare a session-scoped service.
 *
 * @param definition - Name, dependency definitions, factory, and disposer.
 * @returns The same definition with its dependency and service types kept.
 */
export function defineSessionService<
  const Name extends string,
  const Deps extends readonly AnyServiceDefinition[],
  Service,
>(
  definition: SessionServiceSpec<Name, Deps, Service>,
): SessionServiceDefinition<Name, Deps, Service> {
  return definition;
}
