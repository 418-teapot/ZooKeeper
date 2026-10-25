/**
 * Tests for the pure selection planner in `src/core/selection.ts`.
 *
 * The planner is the only place that decides which declared units run:
 * it reads the mode profile, the unit array, the capability availability
 * keys and the agent-modes map, and returns an immutable `Selection`.
 * Every expectation here is an independent literal (a known profile /
 * registry pair), never a re-computation of the planner's own logic.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModeProfile } from "./config-types.js";
import { planSelection } from "./selection.js";
import type { CapabilityKey, UnitDescriptor, UnitKind } from "./unit.js";

/** A descriptor whose factory must never run under the planner. */
function mockUnit(
  name: string,
  kind: UnitKind,
  needs: readonly CapabilityKey[] = [],
): UnitDescriptor {
  return {
    name,
    kind,
    needs,
    wants: [],
    uses: [],
    create() {
      throw new Error("the planner must never instantiate a unit");
    },
  } as UnitDescriptor;
}

/** The registry used by most cases, deliberately not in profile order. */
const UNITS: UnitDescriptor[] = [
  mockUnit("pruning", "hook"),
  mockUnit("compress", "tool"),
  mockUnit("dolphin", "agent"),
  mockUnit("switch", "command"),
  mockUnit("mola", "agent"),
  mockUnit("beaver-tdd", "skill"),
];

/** A profile listing agents in a different order than the registry. */
const PROFILE: ModeProfile = {
  name: "poly",
  agents: ["mola", "dolphin"],
  skills: ["beaver-tdd"],
  hooks: ["pruning"],
  tools: ["compress"],
  commands: ["switch"],
};

describe("planSelection — registry order", () => {
  it("selects the enabled units in registry order, not profile order", () => {
    const selection = planSelection({
      profile: PROFILE,
      units: UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: {},
    });

    assert.deepEqual(
      selection.chosen.map((unit) => unit.name),
      ["pruning", "compress", "dolphin", "switch", "mola", "beaver-tdd"],
    );
    assert.deepEqual(selection.report.selected, [
      "pruning",
      "compress",
      "dolphin",
      "switch",
      "mola",
      "beaver-tdd",
    ]);
    assert.deepEqual(selection.report.skipped, []);
    assert.deepEqual(selection.report.unknown, []);
  });

  it("keeps the profile's declaration order in the category facts", () => {
    const selection = planSelection({
      profile: PROFILE,
      units: UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: {},
    });

    assert.deepEqual(selection.agents, ["mola", "dolphin"]);
    assert.deepEqual(selection.tools, ["compress"]);
  });

  it("keeps no global view for a category without a consuming unit", () => {
    const selection = planSelection({
      profile: PROFILE,
      units: UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: {},
    });

    assert.deepEqual(Object.keys(selection).sort(), [
      "agents",
      "chosen",
      "orchestrator",
      "primaries",
      "report",
      "status",
      "tools",
    ]);
  });

  it("hands back the very descriptors the registry declares", () => {
    const selection = planSelection({
      profile: PROFILE,
      units: UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: {},
    });

    assert.equal(selection.chosen[0], UNITS[0]);
    assert.equal(selection.chosen[2], UNITS[2]);
  });
});

describe("planSelection — needs", () => {
  it("skips a unit whose needs are unavailable and records the keys", () => {
    const units = [
      mockUnit("fetch", "tool", ["htmlConverter", "truncateHead"]),
    ];
    const profile: ModeProfile = {
      name: "p",
      agents: [],
      skills: [],
      hooks: [],
      tools: ["fetch"],
      commands: [],
    };

    const selection = planSelection({
      profile,
      units,
      available: new Set<CapabilityKey>(["truncateHead"]),
      agentModes: {},
    });

    assert.deepEqual(selection.chosen, []);
    assert.deepEqual(selection.report.skipped, [
      { name: "fetch", missing: ["htmlConverter"] },
    ]);
    assert.deepEqual(selection.report.selected, []);
    assert.deepEqual(selection.tools, []);
  });

  it("selects a unit whose needs are all available", () => {
    const units = [
      mockUnit("fetch", "tool", ["htmlConverter", "truncateHead"]),
    ];
    const profile: ModeProfile = {
      name: "p",
      agents: [],
      skills: [],
      hooks: [],
      tools: ["fetch"],
      commands: [],
    };

    const selection = planSelection({
      profile,
      units,
      available: new Set<CapabilityKey>(["htmlConverter", "truncateHead"]),
      agentModes: {},
    });

    assert.deepEqual(selection.report.selected, ["fetch"]);
    assert.deepEqual(selection.tools, ["fetch"]);
  });

  it("drops a needs-skipped agent from the agent facts", () => {
    const units = [
      mockUnit("dolphin", "agent"),
      mockUnit("mola", "agent", ["toolHost"]),
    ];
    const profile: ModeProfile = {
      name: "p",
      agents: ["dolphin", "mola"],
      skills: [],
      hooks: [],
      tools: [],
      commands: [],
    };

    const selection = planSelection({
      profile,
      units,
      available: new Set<CapabilityKey>(),
      agentModes: {},
    });

    assert.deepEqual(selection.agents, ["dolphin"]);
    assert.deepEqual(selection.report.skipped, [
      { name: "mola", missing: ["toolHost"] },
    ]);
  });

  it("treats a want as non-blocking", () => {
    const units: UnitDescriptor[] = [
      {
        name: "dcp",
        kind: "command",
        needs: [],
        wants: ["toolHost", "contextConfig"],
        uses: [],
        create: () => {
          throw new Error("never called");
        },
      } as UnitDescriptor,
    ];
    const profile: ModeProfile = {
      name: "p",
      agents: [],
      skills: [],
      hooks: [],
      tools: [],
      commands: ["dcp"],
    };

    const selection = planSelection({
      profile,
      units,
      available: new Set<CapabilityKey>(),
      agentModes: {},
    });

    assert.deepEqual(selection.report.selected, ["dcp"]);
    assert.deepEqual(selection.report.skipped, []);
  });
});

describe("planSelection — unknown profile names", () => {
  it("records names the registry cannot resolve, per category", () => {
    const profile: ModeProfile = {
      name: "p",
      agents: ["dolphin", "ghost"],
      skills: [],
      hooks: [],
      tools: ["ghost-tool"],
      commands: [],
    };

    const selection = planSelection({
      profile,
      units: UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: {},
    });

    assert.deepEqual(selection.report.unknown, [
      { category: "agents", name: "ghost" },
      { category: "tools", name: "ghost-tool" },
    ]);
    assert.deepEqual(selection.agents, ["dolphin"]);
    assert.deepEqual(selection.tools, []);
  });
});

describe("planSelection — null profile", () => {
  it("selects nothing and reports nothing unknown", () => {
    const selection = planSelection({
      profile: null,
      units: UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: {},
    });

    assert.deepEqual(selection.chosen, []);
    assert.deepEqual(selection.report, {
      selected: [],
      skipped: [],
      unknown: [],
      invalid: null,
      unmaterialised: [],
    });
    assert.deepEqual(selection.agents, []);
    assert.deepEqual(selection.primaries, []);
    assert.deepEqual(selection.tools, []);
    assert.equal(selection.orchestrator, undefined);
    assert.equal(selection.status, "disabled");
  });
});

describe("planSelection — primaries", () => {
  it("derives the primaries from the selected agents in profile order", () => {
    const units = [
      mockUnit("dolphin", "agent"),
      mockUnit("mola", "agent"),
      mockUnit("beaver", "agent"),
    ];
    const profile: ModeProfile = {
      name: "p",
      agents: ["mola", "beaver", "dolphin"],
      skills: [],
      hooks: [],
      tools: [],
      commands: [],
    };

    const selection = planSelection({
      profile,
      units,
      available: new Set<CapabilityKey>(),
      agentModes: {
        dolphin: "primary",
        mola: "primary",
        beaver: "subagent",
      },
    });

    assert.deepEqual(selection.primaries, ["mola", "dolphin"]);
  });

  it("is empty when no selected agent is marked primary", () => {
    const selection = planSelection({
      profile: PROFILE,
      units: UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: { dolphin: "subagent", mola: "subagent" },
    });

    assert.deepEqual(selection.primaries, []);
  });

  it("excludes a needs-skipped agent from the primaries", () => {
    const units = [
      mockUnit("dolphin", "agent"),
      mockUnit("mola", "agent", ["toolHost"]),
    ];
    const profile: ModeProfile = {
      name: "p",
      agents: ["mola", "dolphin"],
      skills: [],
      hooks: [],
      tools: [],
      commands: [],
    };

    const selection = planSelection({
      profile,
      units,
      available: new Set<CapabilityKey>(),
      agentModes: { dolphin: "primary", mola: "primary" },
    });

    assert.deepEqual(selection.agents, ["dolphin"]);
    assert.deepEqual(selection.primaries, ["dolphin"]);
  });

  it("is empty when no agent modes are configured", () => {
    const selection = planSelection({
      profile: PROFILE,
      units: UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: {},
    });

    assert.deepEqual(selection.primaries, []);
  });
});

describe("planSelection — orchestrator role policy", () => {
  /** Agents in the registry, with the profile enabling them. */
  const ROLE_UNITS: UnitDescriptor[] = [
    mockUnit("dolphin", "agent"),
    mockUnit("mola", "agent"),
    mockUnit("beaver", "agent"),
  ];

  /** A profile whose orchestrator is deliberately not the first agent. */
  const ROLE_PROFILE: ModeProfile = {
    name: "p",
    agents: ["mola", "dolphin"],
    skills: [],
    hooks: [],
    tools: [],
    commands: [],
  };

  const PRIMARY_MODES = { dolphin: "primary", mola: "primary" } as const;

  it("resolves a declared orchestrator that is not the first primary", () => {
    const selection = planSelection({
      profile: ROLE_PROFILE,
      units: ROLE_UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: PRIMARY_MODES,
      orchestrator: "dolphin",
    });

    assert.equal(selection.status, "ready");
    assert.equal(selection.orchestrator, "dolphin");
    assert.deepEqual(selection.report.invalid, null);
    // Every primary stays declared; the orchestrator is a role on top.
    assert.deepEqual(selection.primaries, ["mola", "dolphin"]);
  });

  it("selects role-agnostically when the host declares no orchestrator", () => {
    const selection = planSelection({
      profile: ROLE_PROFILE,
      units: ROLE_UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: PRIMARY_MODES,
    });

    assert.equal(selection.status, "ready");
    assert.equal(selection.orchestrator, undefined);
    assert.deepEqual(selection.report.invalid, null);
  });

  it("is invalid when the orchestrator is not a declared unit", () => {
    const selection = planSelection({
      profile: ROLE_PROFILE,
      units: ROLE_UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: PRIMARY_MODES,
      orchestrator: "ghost",
    });

    assert.equal(selection.status, "invalid");
    assert.equal(selection.orchestrator, undefined);
    assert.deepEqual(selection.report.invalid, {
      orchestrator: "ghost",
      cause: "unknown-unit",
      primaries: ["mola", "dolphin"],
    });
  });

  it("is invalid when the profile does not enable the orchestrator", () => {
    const selection = planSelection({
      profile: ROLE_PROFILE,
      units: ROLE_UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: { ...PRIMARY_MODES, beaver: "primary" },
      orchestrator: "beaver",
    });

    assert.equal(selection.status, "invalid");
    assert.deepEqual(selection.report.invalid, {
      orchestrator: "beaver",
      cause: "not-enabled",
      primaries: ["mola", "dolphin"],
    });
  });

  it("is invalid when the orchestrator's own needs are missing", () => {
    const units = [
      mockUnit("mola", "agent", ["toolHost"]),
      mockUnit("dolphin", "agent"),
    ];
    const selection = planSelection({
      profile: ROLE_PROFILE,
      units,
      available: new Set<CapabilityKey>(),
      agentModes: PRIMARY_MODES,
      orchestrator: "mola",
    });

    assert.equal(selection.status, "invalid");
    assert.deepEqual(selection.report.invalid, {
      orchestrator: "mola",
      cause: "needs-missing",
      primaries: ["dolphin"],
    });
    // The remaining primary is never promoted to orchestrator.
    assert.equal(selection.orchestrator, undefined);
  });

  it("is invalid when the orchestrator is selected but not a primary", () => {
    const selection = planSelection({
      profile: ROLE_PROFILE,
      units: ROLE_UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: { dolphin: "primary", mola: "subagent" },
      orchestrator: "mola",
    });

    assert.equal(selection.status, "invalid");
    assert.deepEqual(selection.report.invalid, {
      orchestrator: "mola",
      cause: "not-primary",
      primaries: ["dolphin"],
    });
    assert.equal(selection.orchestrator, undefined);
  });

  it("freezes the invalid reason together with its primaries", () => {
    const selection = planSelection({
      profile: ROLE_PROFILE,
      units: ROLE_UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: PRIMARY_MODES,
      orchestrator: "ghost",
    });

    const invalid = selection.report.invalid;
    assert.ok(invalid);
    assert.equal(Object.isFrozen(invalid), true);
    assert.equal(Object.isFrozen(invalid.primaries), true);
  });
});

describe("planSelection — host materialisation", () => {
  /** The registry of the materialisation cases. */
  const MATERIALISED_UNITS: UnitDescriptor[] = [
    mockUnit("dolphin", "agent"),
    mockUnit("mola", "agent"),
  ];

  /** A profile enabling both agents of that registry. */
  const TWO_AGENTS: ModeProfile = {
    name: "p",
    agents: ["dolphin", "mola"],
    skills: [],
    hooks: [],
    tools: [],
    commands: [],
  };

  /** Both agents declared primary in the config's role table. */
  const TWO_PRIMARIES = { dolphin: "primary", mola: "primary" } as const;

  it("is ready when the host materialises every selected agent", () => {
    const selection = planSelection({
      profile: TWO_AGENTS,
      units: MATERIALISED_UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: TWO_PRIMARIES,
      orchestrator: "dolphin",
      materialisation: {
        agents: ["dolphin", "mola", "user-own"],
        defaultAgents: ["dolphin", "mola"],
      },
    });

    assert.equal(selection.status, "ready");
    assert.equal(selection.orchestrator, "dolphin");
    assert.deepEqual(selection.report.unmaterialised, []);
    assert.deepEqual(selection.report.invalid, null);
  });

  it("is invalid when the host will not materialise a selected agent", () => {
    const selection = planSelection({
      profile: TWO_AGENTS,
      units: MATERIALISED_UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: TWO_PRIMARIES,
      orchestrator: "dolphin",
      materialisation: { agents: ["dolphin"], defaultAgents: ["dolphin"] },
    });

    assert.equal(selection.status, "invalid");
    assert.equal(selection.orchestrator, undefined);
    assert.deepEqual(selection.report.unmaterialised, ["mola"]);
    // The role itself resolved: only the host fact is missing.
    assert.deepEqual(selection.report.invalid, null);
  });

  it("is invalid when the host refuses the orchestrator as a default agent", () => {
    const selection = planSelection({
      profile: TWO_AGENTS,
      units: MATERIALISED_UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: TWO_PRIMARIES,
      orchestrator: "dolphin",
      materialisation: {
        agents: ["dolphin", "mola"],
        defaultAgents: ["mola"],
      },
    });

    assert.equal(selection.status, "invalid");
    assert.equal(selection.orchestrator, undefined);
    assert.deepEqual(selection.report.unmaterialised, []);
    assert.deepEqual(selection.report.invalid, {
      orchestrator: "dolphin",
      cause: "not-default-agent",
      primaries: ["dolphin", "mola"],
    });
  });

  it("stays role-agnostic without a declared orchestrator", () => {
    const selection = planSelection({
      profile: TWO_AGENTS,
      units: MATERIALISED_UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: TWO_PRIMARIES,
      materialisation: {
        agents: ["dolphin", "mola"],
        defaultAgents: [],
      },
    });

    assert.equal(selection.status, "ready");
    assert.equal(selection.orchestrator, undefined);
  });

  it("leaves a null profile disabled whatever the host materialises", () => {
    const selection = planSelection({
      profile: null,
      units: MATERIALISED_UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: TWO_PRIMARIES,
      orchestrator: "dolphin",
      materialisation: { agents: [], defaultAgents: [] },
    });

    assert.equal(selection.status, "disabled");
    assert.deepEqual(selection.report.unmaterialised, []);
    assert.deepEqual(selection.report.invalid, null);
  });

  it("freezes the unmaterialised list", () => {
    const selection = planSelection({
      profile: TWO_AGENTS,
      units: MATERIALISED_UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: TWO_PRIMARIES,
      materialisation: { agents: [], defaultAgents: [] },
    });

    assert.equal(Object.isFrozen(selection.report.unmaterialised), true);
    assert.deepEqual(selection.report.unmaterialised, ["dolphin", "mola"]);
  });
});

describe("planSelection — immutability", () => {
  it("freezes the selection so no late assignment can change it", () => {
    const selection = planSelection({
      profile: PROFILE,
      units: UNITS,
      available: new Set<CapabilityKey>(),
      agentModes: {},
    });

    assert.equal(Object.isFrozen(selection), true);
    assert.equal(Object.isFrozen(selection.agents), true);
    assert.equal(Object.isFrozen(selection.chosen), true);
    assert.equal(Object.isFrozen(selection.report.selected), true);
    assert.throws(() => {
      (selection as unknown as { agents: string[] }).agents = [];
    });
    assert.throws(() => {
      (selection.agents as string[]).push("late");
    });
    assert.deepEqual(selection.agents, ["mola", "dolphin"]);
  });
});
