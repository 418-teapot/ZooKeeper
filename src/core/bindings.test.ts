/**
 * Tests for the capability bindings in `src/core/bindings.ts`.
 *
 * The bindings are the single source of the availability set the planner
 * reads and of the capability values the build step hands to factories.
 * The invariant under test is that the declared keys and the bound record
 * can never disagree, and that a key is never bound to `undefined`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilityBindings } from "./bindings.js";
import type { ModeProfile } from "./config-types.js";
import type { Capabilities } from "./ports/index.js";
import { planSelection, type Selection } from "./selection.js";

/** A trivial frozen selection used as the bind input. */
const SELECTION: Selection = planSelection({
  profile: null,
  units: [],
  available: new Set(),
  agentModes: {},
});

/** A profile whose selected agents make the primaries observable. */
const PRIMARY_SELECTION: Selection = planSelection({
  profile: {
    name: "p",
    agents: ["mola", "dolphin"],
    skills: [],
    hooks: [],
    tools: [],
    commands: [],
  } satisfies ModeProfile,
  units: [
    {
      name: "dolphin",
      kind: "agent",
      needs: [],
      wants: [],
      uses: [],
      create: () => ({ kind: "agent", agents: [] }),
    },
    {
      name: "mola",
      kind: "agent",
      needs: [],
      wants: [],
      uses: [],
      create: () => ({ kind: "agent", agents: [] }),
    },
  ],
  available: new Set(),
  agentModes: { mola: "primary", dolphin: "primary" },
});

describe("capabilityBindings — keys", () => {
  it("derives the availability keys from the supplied values", () => {
    const bindings = capabilityBindings({
      values: {
        directory: "/tmp/zoo",
        limits: {},
        resolveAgent: () => undefined,
      },
    });

    assert.deepEqual([...bindings.keys].sort(), [
      "directory",
      "limits",
      "resolveAgent",
    ]);
  });

  it("drops a value that is undefined instead of claiming the key", () => {
    const bindings = capabilityBindings({
      values: { directory: "/tmp/zoo", switchHost: undefined },
    });

    assert.deepEqual([...bindings.keys], ["directory"]);
  });

  it("counts a selection-dependent key as available", () => {
    const bindings = capabilityBindings({
      values: { directory: "/tmp/zoo" },
      selected: {
        switchHost: () =>
          ({
            applySwitch: async () => {},
          }) as unknown as Capabilities["switchHost"],
      },
    });

    assert.deepEqual([...bindings.keys].sort(), ["directory", "switchHost"]);
  });

  it("is empty for empty inputs", () => {
    assert.deepEqual([...capabilityBindings({}).keys], []);
  });
});

describe("capabilityBindings — bind", () => {
  it("binds exactly the declared keys with the declared values", () => {
    const resolveAgent = () => "dolphin";
    const bindings = capabilityBindings({
      values: { directory: "/tmp/zoo", resolveAgent, limits: {} },
    });

    const bound = bindings.bind(SELECTION);

    assert.deepEqual(Object.keys(bound).sort(), [...bindings.keys].sort());
    assert.equal(bound.directory, "/tmp/zoo");
    assert.equal(bound.resolveAgent, resolveAgent);
  });

  it("resolves a selection-dependent value from the selection", () => {
    const bindings = capabilityBindings({
      values: {},
      selected: {
        directory: (selection) => selection.primaries[0] ?? "",
      },
    });

    const bound = bindings.bind(PRIMARY_SELECTION);

    assert.deepEqual(Object.keys(bound), ["directory"]);
    assert.equal(bound.directory, "mola");
  });

  it("throws when a declared key resolves to undefined", () => {
    const bindings = capabilityBindings({
      values: { limits: {} },
      selected: {
        directory: () => undefined as unknown as Capabilities["directory"],
      },
    });

    assert.throws(
      () => bindings.bind(SELECTION),
      /directory/,
      "a declared key must never bind to undefined",
    );
  });

  it("passes the selection through to every resolver unchanged", () => {
    let seen: Selection | undefined;
    const bindings = capabilityBindings({
      selected: {
        directory: (selection) => {
          seen = selection;
          return "/tmp/zoo";
        },
      },
    });

    bindings.bind(PRIMARY_SELECTION);

    assert.equal(seen, PRIMARY_SELECTION);
  });

  it("binds a by-value handoff target for any selection", () => {
    // The `/go` handoff target is a host fact, not a selection fact: each
    // handoff call carries its own executor, so the same target serves a
    // role-agnostic selection and one that resolved an orchestrator.
    const target = {
      create: async () => ({ id: "s", agent: "a" }),
      installAgent: () => {},
      deliver: async () => {},
      focus: () => {},
    } as unknown as Capabilities["handoffTarget"];
    const bindings = capabilityBindings({ values: { handoffTarget: target } });

    assert.equal(bindings.bind(SELECTION).handoffTarget, target);
    assert.equal(bindings.bind(PRIMARY_SELECTION).handoffTarget, target);
  });
});
