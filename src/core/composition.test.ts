/**
 * Tests for the shared composition service (`composition.ts`).
 *
 * The service is the one assembly seam both hosts run: it reads the
 * scope's snapshot, binds the host capabilities it was handed and returns
 * the host-agnostic `Assembly`.  The expectations below are what a
 * consumer of the activated service observes — the selection, the composed
 * contributions, and the selection the host identity state adopted — never
 * how the factory reaches them.
 *
 * The units are local probes: the suite states the contract of the service,
 * so the real registry (covered by `compose.test.ts`) is not needed here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defineCompositionService,
  type HostCapabilities,
} from "./composition.js";
import {
  type ConfigSnapshot,
  createConfigScope,
  type ProcessScope,
} from "./config-snapshot.js";
import {
  createLifecycleKernel,
  defineExtensionService,
} from "./lifecycle/index.js";
import type { HostMaterialisation, Selection } from "./selection.js";
import type { UnitDescriptor } from "./unit.js";

/** The orchestrator role the probes declare. */
const ROLE = "probe";

/**
 * A probe agent unit that records every factory run.
 *
 * @param runs - Receives one entry per instantiation.
 * @returns The unit descriptor.
 */
function probeAgent(runs: string[]): UnitDescriptor {
  return {
    name: ROLE,
    kind: "agent",
    needs: ["limits"],
    wants: [],
    uses: [],
    create: () => {
      runs.push(ROLE);
      return { kind: "agent", agents: [{ name: ROLE, prompt: "probe" }] };
    },
  };
}

/** A probe agent unit whose `needs` name an unbindable key. */
const NEEDY: UnitDescriptor = {
  name: ROLE,
  kind: "agent",
  needs: ["agentPermissions"],
  wants: [],
  uses: [],
  create: () => {
    throw new Error("a skipped unit must never run its factory");
  },
};

/**
 * The snapshot of one profile generation.
 *
 * @param zoo - The `zoo` section; an empty one declares no profile.
 * @param raw - The whole config root (carries the agent mode table).
 * @returns The frozen scope.
 */
function scopeOf(
  zoo: Record<string, unknown>,
  raw: Record<string, unknown>,
): ProcessScope<ConfigSnapshot> {
  return createConfigScope(zoo, raw);
}

/** A zoo section enabling the probe agent. */
const ZOO = { mode: { poly: { agents: [ROLE], skills: [] } } };

/** The agent table marking the probe as a primary. */
const RAW = { agent: { [ROLE]: { mode: "primary" } } };

/** A capabilities declaration over a fixed host provision. */
function capabilitiesOf(provision: HostCapabilities) {
  return defineExtensionService({
    name: "capabilities",
    deps: [],
    create: () => provision,
  });
}

/**
 * Compose one scope through the real service graph.
 *
 * @param provision - The host's capability provision.
 * @param options - The scope, units, and declared orchestrator role.
 * @returns The activated composition service value.
 */
async function compose(
  provision: HostCapabilities,
  options: {
    scope: ProcessScope<ConfigSnapshot>;
    units?: readonly UnitDescriptor[];
    orchestrator?: string;
  },
) {
  const capabilities = capabilitiesOf(provision);
  const composition = defineCompositionService({
    capabilities,
    scope: options.scope,
    units: options.units ?? [probeAgent([])],
    ...(options.orchestrator === undefined
      ? {}
      : { orchestrator: options.orchestrator }),
  });
  const kernel = createLifecycleKernel({
    extension: [capabilities, composition],
    session: [],
  });
  const extension = await kernel.ensureExtension();
  assert.ok(extension);
  return extension.services.composition;
}

describe("composition service — ready selection", () => {
  it("composes the scope's profile over the host capabilities", async () => {
    const scope = scopeOf(ZOO, RAW);
    const assembly = await compose(
      { values: { limits: { contextWordLimit: 200, promptWordLimit: 500 } } },
      { scope, orchestrator: ROLE },
    );

    assert.equal(assembly.selection.status, "ready");
    assert.equal(assembly.selection.orchestrator, ROLE);
    assert.deepEqual(
      assembly.composed.agents.map((agent) => agent.name),
      [ROLE],
    );
  });

  it("adopts the selection it composed", async () => {
    const adopted: Selection[] = [];
    const scope = scopeOf(ZOO, RAW);

    await compose(
      {
        values: { limits: { contextWordLimit: 200, promptWordLimit: 500 } },
        adopt: (selection) => adopted.push(selection),
      },
      { scope, orchestrator: ROLE },
    );

    assert.equal(adopted.length, 1, "one adoption per composition");
    assert.equal(adopted[0].orchestrator, ROLE);
    assert.equal(adopted[0].status, "ready");
  });
});

describe("composition service — closed selections", () => {
  it("instantiates nothing when the scope declares no profile", async () => {
    const runs: string[] = [];
    const adopted: Selection[] = [];
    const scope = scopeOf({}, RAW);

    const assembly = await compose(
      { values: {}, adopt: (selection) => adopted.push(selection) },
      { scope, units: [probeAgent(runs)], orchestrator: ROLE },
    );

    assert.equal(assembly.selection.status, "disabled");
    assert.deepEqual(assembly.composed.agents, []);
    assert.deepEqual(runs, [], "no factory may run for a disabled profile");
    // An unresolved role stays undefined, so a consumer fails closed.
    assert.equal(adopted[0].orchestrator, undefined);
  });

  it("instantiates nothing when the declared role is not a primary", async () => {
    const runs: string[] = [];
    const adopted: Selection[] = [];
    const scope = scopeOf(ZOO, { agent: { [ROLE]: { mode: "subagent" } } });

    const assembly = await compose(
      {
        values: { limits: { contextWordLimit: 200, promptWordLimit: 500 } },
        adopt: (selection) => adopted.push(selection),
      },
      { scope, units: [probeAgent(runs)], orchestrator: ROLE },
    );

    assert.equal(assembly.selection.status, "invalid");
    assert.deepEqual(assembly.composed.report.invalid, {
      orchestrator: ROLE,
      cause: "not-primary",
      primaries: [],
    });
    assert.deepEqual(runs, [], "an invalid selection runs no factory");
    assert.equal(adopted[0].orchestrator, undefined);
  });

  it("skips a unit whose needs the host cannot bind", async () => {
    const scope = scopeOf(ZOO, RAW);

    const assembly = await compose(
      { values: { limits: { contextWordLimit: 200, promptWordLimit: 500 } } },
      { scope, units: [NEEDY], orchestrator: ROLE },
    );

    assert.deepEqual(assembly.selection.report.skipped, [
      { name: ROLE, missing: ["agentPermissions"] },
    ]);
    assert.deepEqual(assembly.composed.agents, []);
    assert.deepEqual(assembly.selection.report.invalid, {
      orchestrator: ROLE,
      cause: "needs-missing",
      primaries: [],
    });
  });

  it("closes the selection when the host cannot answer materialisation", async () => {
    const runs: string[] = [];
    const scope = scopeOf(ZOO, RAW);
    const materialisation: HostMaterialisation = {
      kind: "unavailable",
      cause: "no-data",
      detail: "config.get returned no data",
    };

    const assembly = await compose(
      {
        values: { limits: { contextWordLimit: 200, promptWordLimit: 500 } },
        materialisation,
      },
      { scope, units: [probeAgent(runs)], orchestrator: ROLE },
    );

    assert.equal(assembly.selection.status, "invalid");
    assert.deepEqual(assembly.selection.report.hostFact, {
      fact: "materialisation",
      cause: "no-data",
      detail: "config.get returned no data",
    });
    assert.deepEqual(runs, []);
  });

  it("closes the selection on an agent the host will not materialise", async () => {
    const scope = scopeOf(ZOO, RAW);

    const assembly = await compose(
      {
        values: { limits: { contextWordLimit: 200, promptWordLimit: 500 } },
        materialisation: {
          kind: "available",
          facts: { agents: [], defaultAgents: [] },
        },
      },
      { scope, units: [probeAgent([])], orchestrator: ROLE },
    );

    assert.equal(assembly.selection.status, "invalid");
    assert.deepEqual(assembly.selection.report.unmaterialised, [ROLE]);
  });
});
