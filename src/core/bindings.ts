/**
 * Host capability bindings.
 *
 * The bindings own both halves of the capability contract: the
 * availability keys the planner matches `needs` against, and the values
 * the build step hands to the selected unit factories.  Declaring them in
 * one place is what keeps "the host can provide it" and "the host
 * provides it" from drifting apart: `bind` can only produce the keys the
 * bindings declared, and a declared key never binds to `undefined`.
 *
 * A value that does not depend on the selection is bound by value; a
 * value constructed from the selection (e.g. a session → agent resolver
 * whose root-session fallback is the orchestrator the selection
 * resolved) is bound by resolver.  The bindings are a host-level
 * closure, not a dependency-injection container.
 *
 * @module
 */

import type { Capabilities } from "./ports/index.js";
import type { Selection } from "./selection.js";
import type { CapabilityKey } from "./unit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Selection-dependent capability resolvers.
 *
 * Each key names a capability the host will provide; the resolver builds
 * its value from the finished selection.  A resolver must never return
 * `undefined` — a capability the host cannot build must not be declared.
 */
export type SelectedCapabilities = {
  [K in CapabilityKey]?: (selection: Selection) => Capabilities[K];
};

/** The declaration of a host's capabilities. */
export interface CapabilityBindingsInput {
  /**
   * Selection-independent capability values.  An entry whose value is
   * `undefined` declares nothing — an absent dependency is not a
   * capability (fail-closed by omission).
   */
  values?: Partial<Capabilities>;
  /** Selection-dependent capability values, keyed by capability. */
  selected?: SelectedCapabilities;
}

/**
 * A host's capability declaration: the availability keys plus the binder
 * that materialises the complete capability record for a selection.
 */
export interface CapabilityBindings {
  /** The capability keys the host can provide. */
  readonly keys: ReadonlySet<CapabilityKey>;
  /**
   * Build the complete capability record for a selection.
   *
   * Throws when a declared key cannot be bound, because the planner
   * decided what to run from the same key set.
   *
   * @param selection - The finished selection.
   * @returns The capability record, keyed exactly as {@link keys}.
   */
  bind(selection: Selection): Capabilities;
}

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

/**
 * Assert that a bound record carries exactly the declared keys.
 *
 * @param bound - The bound capability record.
 * @param keys - The declared availability keys.
 */
function assertSameKeys(
  bound: Record<string, unknown>,
  keys: ReadonlySet<CapabilityKey>,
): void {
  const boundKeys = Object.keys(bound);
  if (
    boundKeys.length === keys.size &&
    boundKeys.every((key) => keys.has(key as CapabilityKey))
  ) {
    return;
  }
  throw new Error(
    `capability bindings are inconsistent: declared [${[...keys].sort().join(", ")}], ` +
      `bound [${boundKeys.sort().join(", ")}]`,
  );
}

/**
 * Declare a host's capabilities.
 *
 * The availability keys are derived from the declaration itself, so a key
 * exists exactly when the host has a value for it.  Values that are
 * `undefined` declare nothing; a selection-dependent resolver that
 * returns `undefined` is a declaration bug and throws at bind time.
 *
 * @param input - The selection-independent values and the resolvers.
 * @returns The bindings the assembly reads.
 */
export function capabilityBindings(
  input: CapabilityBindingsInput,
): CapabilityBindings {
  const values = input.values ?? {};
  const selected = input.selected ?? {};

  const boundValues = Object.entries(values).filter(
    ([, value]) => value !== undefined,
  ) as [CapabilityKey, unknown][];

  const keys = new Set<CapabilityKey>(boundValues.map(([key]) => key));
  for (const key of Object.keys(selected)) {
    keys.add(key as CapabilityKey);
  }

  return {
    keys,
    bind(selection: Selection): Capabilities {
      const bound: Record<string, unknown> = {};
      for (const [key, value] of boundValues) {
        bound[key] = value;
      }
      for (const [key, resolve] of Object.entries(selected)) {
        const value = (resolve as (s: Selection) => unknown)(selection);
        if (value === undefined) {
          throw new Error(
            `capability "${key}" is declared by the bindings but resolved to undefined`,
          );
        }
        bound[key] = value;
      }
      assertSameKeys(bound, keys);
      return bound as unknown as Capabilities;
    },
  };
}
