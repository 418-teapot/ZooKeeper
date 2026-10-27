/**
 * Public surface of the host-agnostic lifecycle kernel.
 *
 * @module
 */

export {
  defineExtensionService,
  defineSessionService,
  type ExtensionServiceSpec,
  type SessionServiceSpec,
} from "./define.js";
export { createLifecycleKernel } from "./kernel.js";
export {
  type AnyExtensionServiceDefinition,
  type AnyServiceDefinition,
  type AnySessionServiceDefinition,
  type CleanupFailure,
  type CleanupReport,
  type CleanupScope,
  type DependencyServices,
  type DisposeContext,
  type ExtensionCreateContext,
  type ExtensionScope,
  type ExtensionServiceDefinition,
  type LifecycleDeclarations,
  LifecycleDefinitionError,
  type LifecycleKernel,
  type ServiceMap,
  type SessionCreateContext,
  type SessionScope,
  type SessionServiceDefinition,
  type SessionStartContext,
} from "./types.js";
