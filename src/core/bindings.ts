/**
 * Host capability bindings.
 *
 * The bindings own both halves of the capability contract: the
 * availability keys the planner matches `needs` against, and the values
 * the build step hands to the selected unit factories.  Declaring them in
 * one place is what keeps "the host can provide it" and "the host
 * provides it" from drifting apart: one value list produces both, so a
 * declared key never binds to `undefined` and `bind` never produces a key
 * the declaration omitted.  The bound record is a partial catalog: a host
 * declares only the capabilities it provides.
 *
 * The bindings are a host-level closure, not a dependency-injection
 * container: they carry values only.
 *
 * @module
 */

import type { Capabilities } from "./ports/index.js";
import type { CapabilityKey } from "./unit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The declaration of a host's capabilities. */
export interface CapabilityBindingsInput {
  /**
   * Capability values.  An entry whose value is `undefined` declares
   * nothing — an absent dependency is not a capability (fail-closed by
   * omission).
   */
  values?: Partial<Capabilities>;
}

/**
 * A host's capability declaration: the availability keys plus the binder
 * that materialises the declared values.
 */
export interface CapabilityBindings {
  /** The capability keys the host can provide. */
  readonly keys: ReadonlySet<CapabilityKey>;
  /**
   * Build the declared capability record.
   *
   * @returns The capability values, keyed exactly as {@link keys}.
   */
  bind(): Partial<Capabilities>;
}

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

/**
 * Declare a host's capabilities.
 *
 * The availability keys are derived from the declaration itself, so a key
 * exists exactly when the host has a value for it.  A value that is
 * `undefined` declares nothing.
 *
 * @param input - The capability values.
 * @returns The bindings the assembly reads.
 */
export function capabilityBindings(
  input: CapabilityBindingsInput,
): CapabilityBindings {
  const values = input.values ?? {};

  const boundValues = Object.entries(values).filter(
    ([, value]) => value !== undefined,
  ) as [CapabilityKey, unknown][];

  const keys = new Set<CapabilityKey>(boundValues.map(([key]) => key));

  return {
    keys,
    bind(): Partial<Capabilities> {
      const bound: Record<string, unknown> = {};
      for (const [key, value] of boundValues) {
        bound[key] = value;
      }
      return bound as unknown as Partial<Capabilities>;
    },
  };
}
