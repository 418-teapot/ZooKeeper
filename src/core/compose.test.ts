/**
 * Tests for the assembly pipeline in `src/core/compose.ts`.
 *
 * Stage boundaries under test: the planner decides what runs (order,
 * `needs` skipping, unknown names), the binder supplies the capability
 * record, and the build stage runs every selected factory exactly once.
 * The expectations are profile/registry literals, never a re-run of the
 * planner's own logic.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../utils/logger.js";
import { capabilityBindings } from "./bindings.js";
import {
  assemble,
  buildComposition,
  type ComposedResult,
  type CompositionReport,
} from "./compose.js";
import type { ModeProfile } from "./config-types.js";
import type { Capabilities } from "./ports/index.js";
import type { SelectionFacts } from "./selection.js";
import { type HostMaterialisation, planSelection } from "./selection.js";
import {
  defineAgent,
  defineHook,
  type HookUnitContributions,
  type UnitContributions,
  type UnitDescriptor,
  type UnitKind,
} from "./unit.js";

afterEach(() => {
  _resetForTesting();
});

const BASE_CAPS: Partial<Capabilities> = {
  limits: {},
  contextConfig: {},
  directory: "/tmp/zoo",
  resolveAgent: () => undefined,
};

/** Assemble a profile against the unit array and a capability bag. */
function run(
  profile: ModeProfile | null,
  units: readonly UnitDescriptor[],
  values: Partial<Capabilities> = BASE_CAPS,
  agentModes: Record<string, "primary" | "subagent"> = {},
  orchestrator?: string,
  materialisation?: HostMaterialisation,
): { composed: ComposedResult; report: CompositionReport; calls: string[] } {
  const calls: string[] = [];
  const recording = units.map((unit) => {
    const original = unit.create.bind(unit);
    return {
      ...unit,
      create: (caps: Partial<Capabilities>, selected: SelectionFacts) => {
        calls.push(unit.name);
        return original(caps, selected);
      },
    } as UnitDescriptor;
  });
  const { composed } = assemble({
    profile,
    units: recording,
    bindings: capabilityBindings({ values }),
    agentModes,
    orchestrator,
    materialisation,
  });
  return { composed, report: composed.report, calls };
}

/** The unit registry, in declaration order. */
function makeUnits(): UnitDescriptor[] {
  return [
    mockUnit("dolphin", "agent", () => ({
      kind: "agent",
      agents: [{ name: "dolphin", prompt: "DOLPHIN" }],
    })),
    mockUnit("beaver", "agent", () => ({
      kind: "agent",
      agents: [{ name: "beaver", prompt: "BEAVER" }],
    })),
    mockUnit("mola", "agent", () => ({
      kind: "agent",
      agents: [{ name: "mola", prompt: "MOLA" }],
    })),
    mockUnit("beaver-tdd", "skill", () => ({
      kind: "skill",
      skills: [{ name: "beaver-tdd" }],
    })),
    mockUnit("wiki-query", "skill", () => ({
      kind: "skill",
      skills: [{ name: "wiki-query" }],
    })),
    mockHookUnit("subagent-prompt", () => ({
      afterExec: [{ name: "nudgeSubagentOutput", handle: async () => {} }],
      toolDefinition: [
        { name: "enhanceSubagentDefinition", handle: async () => {} },
      ],
      delegation: [{ name: "judgeSubagentPrompt", judge: () => null }],
    })),
    mockHookUnit("context-pruning", () => ({
      transform: [{ name: "contextPruning", handle: async () => {} }],
    })),
    mockUnit("compress", "tool", () => ({
      kind: "tool",
      tools: [
        {
          name: "compress",
          description: "compress tool",
          execute: async () => "ok",
        },
      ],
    })),
    mockUnit("decompress", "tool", () => ({
      kind: "tool",
      tools: [
        {
          name: "decompress",
          description: "decompress tool",
          execute: async () => "ok",
        },
      ],
    })),
    mockUnit("go", "command", () => ({
      kind: "command",
      commands: [
        { name: "go", description: "handoff", handle: async () => {} },
      ],
    })),
    mockUnit("dcp", "command", () => ({
      kind: "command",
      commands: [
        { name: "dcp", description: "context", handle: async () => {} },
      ],
    })),
  ];
}

/** A raw descriptor with no declared needs, wants, or uses. */
function mockUnit(
  name: string,
  kind: UnitKind,
  create: (
    caps: Partial<Capabilities>,
    facts: SelectionFacts,
  ) => UnitContributions,
  needs: readonly (keyof Capabilities)[] = [],
  wants: readonly (keyof Capabilities)[] = [],
  uses: readonly (keyof SelectionFacts)[] = [],
): UnitDescriptor {
  return { name, kind, needs, wants, uses, create } as UnitDescriptor;
}

/**
 * A hook unit whose factory names only the slots it contributes to.
 *
 * Hook units go through `defineHook` rather than the raw descriptor, so
 * the mocks exercise the same slot completion the real registry does.
 */
function mockHookUnit(
  name: string,
  create: (
    caps: Partial<Capabilities>,
    uses: Record<string, unknown>,
  ) => Partial<Omit<HookUnitContributions, "kind">>,
  needs: readonly (keyof Capabilities)[] = [],
  uses: readonly (keyof SelectionFacts)[] = [],
): UnitDescriptor {
  return defineHook({ name, needs, uses, create });
}

/** Profile listing every unit in the registry. */
const ALL_UNITS_PROFILE: ModeProfile = {
  name: "poly",
  agents: ["dolphin", "beaver", "mola"],
  skills: ["beaver-tdd", "wiki-query"],
  hooks: ["subagent-prompt", "context-pruning"],
  tools: ["compress", "decompress"],
  commands: ["go", "dcp"],
};

/** Profile enabling a subset of units across several kinds. */
const SUBSET_PROFILE: ModeProfile = {
  name: "lite",
  agents: ["mola"],
  skills: [],
  hooks: ["context-pruning"],
  tools: ["decompress"],
  commands: [],
};

/** Profile with every category empty (non-null, no defaults). */
const EMPTY_PROFILE: ModeProfile = {
  name: "empty",
  agents: [],
  skills: [],
  hooks: [],
  tools: [],
  commands: [],
};

/** Profile naming units absent from the registry, one per category. */
const UNKNOWN_PROFILE: ModeProfile = {
  name: "poly",
  agents: ["dolphin", "ghost-agent"],
  skills: ["beaver-tdd", "ghost-skill"],
  hooks: ["subagent-prompt", "ghost-hook"],
  tools: ["compress", "ghost-tool"],
  commands: ["go", "ghost-command"],
};

/** Profile enabling exactly one unit of each kind, empty hook list. */
const ONE_OF_EACH_PROFILE: ModeProfile = {
  name: "one",
  agents: ["beaver"],
  skills: ["wiki-query"],
  hooks: [],
  tools: ["compress"],
  commands: ["dcp"],
};

// ---------------------------------------------------------------------------
// Full profile
// ---------------------------------------------------------------------------

describe("assemble — full profile", () => {
  it("instantiates every listed unit once, in registry order", () => {
    const { calls, report } = run(ALL_UNITS_PROFILE, makeUnits());
    assert.deepEqual(calls, [
      "dolphin",
      "beaver",
      "mola",
      "beaver-tdd",
      "wiki-query",
      "subagent-prompt",
      "context-pruning",
      "compress",
      "decompress",
      "go",
      "dcp",
    ]);
    assert.deepEqual(report.selected, calls);
  });

  it("collects contributions into the host-agnostic result", () => {
    const { composed } = run(ALL_UNITS_PROFILE, makeUnits());

    assert.deepEqual(composed.agents, [
      { name: "dolphin", prompt: "DOLPHIN" },
      { name: "beaver", prompt: "BEAVER" },
      { name: "mola", prompt: "MOLA" },
    ]);
    assert.deepEqual(composed.skills, [
      { name: "beaver-tdd" },
      { name: "wiki-query" },
    ]);
    assert.deepEqual(
      composed.afterExec.map((h) => h.name),
      ["nudgeSubagentOutput"],
    );
    assert.deepEqual(
      composed.transform.map((h) => h.name),
      ["contextPruning"],
    );
    assert.deepEqual(composed.textComplete, []);
    assert.deepEqual(
      composed.toolDefinition.map((h) => h.name),
      ["enhanceSubagentDefinition"],
    );
    assert.ok(
      composed.gate !== null,
      "delegation judges must compose into a gate",
    );
    assert.equal(
      composed.gate?.({ caller: "beaver", target: "kiwi", prompt: "x" }),
      null,
      "allow-all mock judges let the delegation pass",
    );
    assert.equal(composed.gateNeedsCaller, false);
    assert.deepEqual(Object.keys(composed.tools), ["compress", "decompress"]);
    assert.deepEqual(Object.keys(composed.commands), ["go", "dcp"]);
  });
});

// ---------------------------------------------------------------------------
// gateNeedsCaller aggregation
// ---------------------------------------------------------------------------

describe("assemble — gateNeedsCaller aggregation", () => {
  it("is false when no enabled judge needs the caller", () => {
    const { composed } = run(ALL_UNITS_PROFILE, makeUnits());
    assert.equal(composed.gateNeedsCaller, false);
  });

  it("is true when any enabled judge needs the caller", () => {
    const unit = mockHookUnit("subagent-delegation", () => ({
      delegation: [
        {
          name: "judgeDelegationTarget",
          needsCaller: true,
          judge: () => null,
        },
      ],
    }));
    const profile: ModeProfile = {
      name: "td",
      agents: [],
      skills: [],
      hooks: ["subagent-delegation"],
      tools: [],
      commands: [],
    };
    const { composed } = run(profile, [unit]);
    assert.equal(composed.gateNeedsCaller, true);
  });

  it("is false for a null profile", () => {
    const { composed } = run(null, makeUnits());
    assert.equal(composed.gateNeedsCaller, false);
  });
});

// ---------------------------------------------------------------------------
// Null profile
// ---------------------------------------------------------------------------

describe("assemble — null profile", () => {
  it("returns an empty result without instantiating any unit", () => {
    const { calls, composed } = run(null, makeUnits());
    assert.deepEqual(calls, []);
    assert.deepEqual(composed, {
      agents: [],
      skills: [],
      afterExec: [],
      transform: [],
      textComplete: [],
      toolDefinition: [],
      onSettled: [],
      tools: {},
      commands: {},
      gate: null,
      gateNeedsCaller: false,
      report: {
        selected: [],
        skipped: [],
        unknown: [],
        invalid: null,
        unmaterialised: [],
        hostFact: null,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Subset profile — order preservation
// ---------------------------------------------------------------------------

describe("assemble — subset profile", () => {
  it("instantiates only enabled units, preserving registry order", () => {
    const { calls, composed } = run(SUBSET_PROFILE, makeUnits());

    assert.deepEqual(calls, ["mola", "context-pruning", "decompress"]);
    assert.deepEqual(composed.agents, [{ name: "mola", prompt: "MOLA" }]);
    assert.deepEqual(composed.skills, []);
    assert.deepEqual(
      composed.transform.map((h) => h.name),
      ["contextPruning"],
    );
    assert.deepEqual(composed.afterExec, []);
    assert.deepEqual(composed.toolDefinition, []);
    assert.deepEqual(Object.keys(composed.tools), ["decompress"]);
    assert.deepEqual(Object.keys(composed.commands), []);
  });
});

// ---------------------------------------------------------------------------
// Per-kind selection
// ---------------------------------------------------------------------------

describe("assemble — per-kind selection", () => {
  it("selects agent / skill / tool / command units independently", () => {
    const { calls, composed } = run(ONE_OF_EACH_PROFILE, makeUnits());

    assert.deepEqual(calls, ["beaver", "wiki-query", "compress", "dcp"]);
    assert.deepEqual(composed.agents, [{ name: "beaver", prompt: "BEAVER" }]);
    assert.deepEqual(composed.skills, [{ name: "wiki-query" }]);
    assert.deepEqual(composed.afterExec, []);
    assert.deepEqual(composed.transform, []);
    assert.deepEqual(composed.toolDefinition, []);
    assert.deepEqual(Object.keys(composed.tools), ["compress"]);
    assert.deepEqual(Object.keys(composed.commands), ["dcp"]);
  });

  it("selects nothing for an empty profile (no defaults)", () => {
    const { calls, composed } = run(EMPTY_PROFILE, makeUnits());
    assert.deepEqual(calls, []);
    assert.deepEqual(composed.report, {
      selected: [],
      skipped: [],
      unknown: [],
      invalid: null,
      unmaterialised: [],
      hostFact: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Orchestrator role policy
// ---------------------------------------------------------------------------

/** The role map the full profile's agents declare. */
const FULL_MODES: Record<string, "primary" | "subagent"> = {
  dolphin: "primary",
  beaver: "subagent",
  mola: "primary",
};

describe("assemble — orchestrator role policy", () => {
  it("instantiates the profile when the declared orchestrator is a primary", () => {
    // mola is the second agent of the profile, so the role is never
    // inferred from array position.
    const { calls, report } = run(
      ALL_UNITS_PROFILE,
      makeUnits(),
      BASE_CAPS,
      FULL_MODES,
      "mola",
    );

    assert.equal(calls.length, 11);
    assert.deepEqual(report.invalid, null);
  });

  it("runs no factory when the declared orchestrator is unavailable", () => {
    // The profile enables three agents, two of them primary, but the
    // declared orchestrator is none of them: nothing may run.
    const { calls, composed } = run(
      ALL_UNITS_PROFILE,
      makeUnits(),
      BASE_CAPS,
      FULL_MODES,
      "ghost",
    );

    assert.deepEqual(calls, [], "no unit factory may run on invalid input");
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(Object.keys(composed.tools), []);
    assert.deepEqual(composed.report.invalid, {
      orchestrator: "ghost",
      cause: "unknown-unit",
      primaries: ["dolphin", "mola"],
    });
  });

  it("never promotes another primary into the declared role", () => {
    // dolphin is a selected primary while the declared orchestrator is
    // not primary: the selection is invalid, not silently re-roled.
    const { calls, composed } = run(
      ALL_UNITS_PROFILE,
      makeUnits(),
      BASE_CAPS,
      FULL_MODES,
      "beaver",
    );

    assert.deepEqual(calls, []);
    assert.deepEqual(composed.report.invalid, {
      orchestrator: "beaver",
      cause: "not-primary",
      primaries: ["dolphin", "mola"],
    });
  });

  it("never binds capabilities for an invalid selection", () => {
    const { selection } = assemble({
      profile: ALL_UNITS_PROFILE,
      units: makeUnits(),
      bindings: capabilityBindings({
        values: BASE_CAPS,
        selected: {
          handoffTarget: () => {
            throw new Error("an invalid selection must not bind");
          },
        },
      }),
      agentModes: FULL_MODES,
      orchestrator: "ghost",
    });

    assert.equal(selection.status, "invalid");
  });

  it("runs no factory when the host will not materialise a selected agent", () => {
    // The profile resolves dolphin as its orchestrator and the host
    // materialises it, but beaver and mola are missing from the host's
    // agent table: no unit factory may run.
    const { calls, composed } = run(
      ALL_UNITS_PROFILE,
      makeUnits(),
      BASE_CAPS,
      FULL_MODES,
      "dolphin",
      {
        kind: "available",
        facts: { agents: ["dolphin"], defaultAgents: ["dolphin"] },
      },
    );

    assert.deepEqual(calls, [], "no unit factory may run on invalid input");
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(composed.report.unmaterialised, ["beaver", "mola"]);
  });

  it("runs no factory when the host refuses the orchestrator as default", () => {
    const { calls, composed } = run(
      ALL_UNITS_PROFILE,
      makeUnits(),
      BASE_CAPS,
      FULL_MODES,
      "dolphin",
      {
        kind: "available",
        facts: {
          agents: ["dolphin", "beaver", "mola"],
          defaultAgents: ["mola"],
        },
      },
    );

    assert.deepEqual(calls, []);
    assert.deepEqual(composed.report.invalid, {
      orchestrator: "dolphin",
      cause: "not-default-agent",
      primaries: ["dolphin", "mola"],
    });
  });

  it("logs an invalid selection caused by host materialisation", () => {
    run(ALL_UNITS_PROFILE, makeUnits(), BASE_CAPS, FULL_MODES, "dolphin", {
      kind: "available",
      facts: { agents: ["dolphin"], defaultAgents: ["dolphin"] },
    });

    const entry = _getBufferForTesting().find(
      (e) => e.event === "selection_invalid",
    );
    assert.ok(entry, "expected a selection_invalid log entry");
    const ee = entry as Record<string, unknown>;
    assert.equal(ee.level, "error");
    assert.deepEqual(ee.unmaterialised, ["beaver", "mola"]);
  });

  it("instantiates nothing when the host could not answer what it materialises", () => {
    const { calls, composed, report } = run(
      ALL_UNITS_PROFILE,
      makeUnits(),
      BASE_CAPS,
      FULL_MODES,
      "dolphin",
      {
        kind: "unavailable",
        cause: "no-api",
        detail: "宿主 SDK 客户端缺少 config.get",
      },
    );

    assert.deepEqual(
      calls,
      [],
      "no unit factory may run on unknown host facts",
    );
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(Object.keys(composed.tools), []);
    assert.deepEqual(composed.commands, {});
    assert.deepEqual(report.hostFact, {
      fact: "materialisation",
      cause: "no-api",
      detail: "宿主 SDK 客户端缺少 config.get",
    });
  });

  it("never binds capabilities when the host facts are unavailable", () => {
    const { selection, composed } = assemble({
      profile: ALL_UNITS_PROFILE,
      units: makeUnits(),
      bindings: capabilityBindings({
        values: BASE_CAPS,
        selected: {
          handoffTarget: () => {
            throw new Error("an undecidable selection must not bind");
          },
        },
      }),
      agentModes: FULL_MODES,
      orchestrator: "dolphin",
      materialisation: {
        kind: "unavailable",
        cause: "request-failed",
        detail: "instance not ready",
      },
    });

    assert.equal(selection.status, "invalid");
    assert.deepEqual(composed.agents, []);
  });

  it("logs the unanswered host fact on the invalid selection entry", () => {
    run(ALL_UNITS_PROFILE, makeUnits(), BASE_CAPS, FULL_MODES, "dolphin", {
      kind: "unavailable",
      cause: "no-data",
      detail: "宿主 config.get 未返回配置数据",
    });

    const entry = _getBufferForTesting().find(
      (e) => e.event === "selection_invalid",
    );
    assert.ok(entry, "expected a selection_invalid log entry");
    const ee = entry as Record<string, unknown>;
    assert.equal(ee.level, "error");
    assert.deepEqual(ee.hostFact, {
      fact: "materialisation",
      cause: "no-data",
      detail: "宿主 config.get 未返回配置数据",
    });
  });

  it("stays disabled for a null profile even with a declared role", () => {
    const { calls, composed } = run(
      null,
      makeUnits(),
      BASE_CAPS,
      FULL_MODES,
      "mola",
    );

    assert.deepEqual(calls, []);
    assert.deepEqual(composed.report.invalid, null);
  });

  it("logs the invalid role so the profile error is actionable", () => {
    run(ALL_UNITS_PROFILE, makeUnits(), BASE_CAPS, FULL_MODES, "ghost");

    const entry = _getBufferForTesting().find(
      (e) => e.event === "selection_invalid",
    );
    assert.ok(entry, "expected a selection_invalid log entry");
    const ee = entry as Record<string, unknown>;
    assert.equal(ee.hook, "compose");
    assert.equal(ee.level, "error");
    assert.equal(ee.orchestrator, "ghost");
    assert.equal(ee.cause, "unknown-unit");
    assert.deepEqual(ee.primaries, ["dolphin", "mola"]);
  });
});

// ---------------------------------------------------------------------------
// Capability matching (needs / wants)
// ---------------------------------------------------------------------------

/** A profile enabling exactly the given tool units, every other kind empty. */
function toolProfile(tools: string[]): ModeProfile {
  return {
    name: "cap",
    agents: [],
    skills: [],
    hooks: [],
    tools,
    commands: [],
  };
}

const TOOL_HOST: NonNullable<Partial<Capabilities>["toolHost"]> = {
  resolveSessionId: () => "s",
  async notify(): Promise<void> {},
};

describe("assemble — capability matching", () => {
  it("runs a unit whose needs are all bound and reports it", () => {
    const unit = mockUnit(
      "compress",
      "tool",
      () => ({
        kind: "tool",
        tools: [
          { name: "compress", description: "c", execute: async () => "ok" },
        ],
      }),
      ["toolHost", "contextConfig"],
    );

    const { calls, report, composed } = run(toolProfile(["compress"]), [unit], {
      ...BASE_CAPS,
      toolHost: TOOL_HOST,
    });

    assert.deepEqual(calls, ["compress"]);
    assert.deepEqual(report.selected, ["compress"]);
    assert.deepEqual(report.skipped, []);
    assert.deepEqual(Object.keys(composed.tools), ["compress"]);
  });

  it("skips a unit with an unbindable need without running its factory", () => {
    const unit = mockUnit(
      "compress",
      "tool",
      () => ({ kind: "tool", tools: [] }),
      ["toolHost", "contextConfig"],
    );

    // `BASE_CAPS` carries `contextConfig` but no `toolHost`.
    const { calls, report, composed } = run(toolProfile(["compress"]), [unit], {
      ...BASE_CAPS,
    });

    assert.deepEqual(calls, [], "a skipped unit's factory must never run");
    assert.deepEqual(report.selected, []);
    assert.deepEqual(report.skipped, [
      { name: "compress", missing: ["toolHost"] },
    ]);
    assert.deepEqual(composed.tools, {});
  });

  it("records every missing need in declaration order", () => {
    const unit = mockUnit(
      "compress",
      "tool",
      () => ({ kind: "tool", tools: [] }),
      ["toolHost", "contextConfig"],
    );

    const { report } = run(toolProfile(["compress"]), [unit], {});

    assert.deepEqual(report.skipped, [
      { name: "compress", missing: ["toolHost", "contextConfig"] },
    ]);
  });

  it("runs a unit whose optional wants are unbound", () => {
    const unit = mockUnit(
      "todo",
      "tool",
      () => ({
        kind: "tool",
        tools: [{ name: "todo", description: "t", execute: async () => "ok" }],
      }),
      ["toolHost"],
      ["todoRenderer"],
    );

    const { report, composed } = run(toolProfile(["todo"]), [unit], {
      ...BASE_CAPS,
      toolHost: TOOL_HOST,
    });

    assert.deepEqual(report.selected, ["todo"]);
    assert.deepEqual(report.skipped, []);
    assert.deepEqual(Object.keys(composed.tools), ["todo"]);
  });

  it("hands the factory only its declared needs and wants", () => {
    let seen: Record<string, unknown> | undefined;
    const unit = mockUnit(
      "compress",
      "tool",
      (caps) => {
        seen = caps as Record<string, unknown>;
        return { kind: "tool", tools: [] };
      },
      ["toolHost", "contextConfig"],
    );

    run(toolProfile(["compress"]), [unit], {
      ...BASE_CAPS,
      toolHost: TOOL_HOST,
    });

    assert.deepEqual(Object.keys(seen ?? {}).sort(), [
      "contextConfig",
      "toolHost",
    ]);
  });

  it("passes thunk capabilities through without ever invoking them", () => {
    // Ports carry behavior, not values: the build stage must hand the thunk
    // over by reference and never call it — the unit decides the timing
    // (pi's tool baseline is forbidden during extension load).
    let calls = 0;
    const baseline = () => {
      calls++;
      return ["x"];
    };
    let seen: Partial<Capabilities> | undefined;
    const unit = mockUnit(
      "subagent",
      "tool",
      (caps) => {
        seen = caps;
        return { kind: "tool", tools: [] };
      },
      ["toolHost"],
      ["subagentBaseline"],
    );

    const { report } = run(toolProfile(["subagent"]), [unit], {
      ...BASE_CAPS,
      toolHost: TOOL_HOST,
      subagentBaseline: baseline,
    });

    assert.deepEqual(report.selected, ["subagent"]);
    assert.equal(calls, 0, "the build stage must not invoke capability thunks");
    assert.equal(seen?.subagentBaseline, baseline, "passed by reference");
    assert.deepEqual(seen?.subagentBaseline?.(), ["x"]);
    assert.equal(calls, 1);
  });
});

// ---------------------------------------------------------------------------
// Factory count
// ---------------------------------------------------------------------------

describe("assemble — factory count", () => {
  it("runs every selected factory exactly once", () => {
    const { calls } = run(ALL_UNITS_PROFILE, makeUnits());
    assert.equal(calls.length, 11);
    assert.equal(new Set(calls).size, 11);
  });

  it("builds only from the plan's selected units", () => {
    const selection = planSelection({
      profile: SUBSET_PROFILE,
      units: makeUnits(),
      available: new Set(),
      agentModes: {},
    });
    let built = 0;
    const units = selection.chosen.map((unit: UnitDescriptor) => ({
      ...unit,
      create: (caps: Partial<Capabilities>, selected: SelectionFacts) => {
        built++;
        return unit.create(caps, selected);
      },
    }));
    const composed = buildComposition(selection, {
      ...BASE_CAPS,
    } as Capabilities);

    assert.equal(built, 0, "the planner never instantiates");
    assert.deepEqual(
      Object.keys(composed.tools),
      ["decompress"],
      "the build used the planned selection",
    );
    assert.equal(units.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Uses projection
// ---------------------------------------------------------------------------

describe("assemble — uses projection", () => {
  it("projects only the declared facts, in profile order", () => {
    let seen: Record<string, unknown> | undefined;
    const unit = defineHook({
      name: "uses-probe",
      needs: [],
      uses: ["tools", "agents"],
      create: (_caps, uses) => {
        seen = uses as Record<string, unknown>;
        return {};
      },
    });

    run({ ...ALL_UNITS_PROFILE, hooks: ["uses-probe"] }, [
      ...makeUnits(),
      unit,
    ]);

    assert.deepEqual(seen, {
      tools: ["compress", "decompress"],
      agents: ["dolphin", "beaver", "mola"],
    });
  });

  it("gives a unit that declares no uses an empty projection", () => {
    let seen: Record<string, unknown> | undefined;
    const unit = defineHook({
      name: "uses-probe",
      needs: [],
      create: (_caps, uses) => {
        seen = uses as Record<string, unknown>;
        return {};
      },
    });

    run({ ...ALL_UNITS_PROFILE, hooks: ["uses-probe"] }, [
      ...makeUnits(),
      unit,
    ]);

    assert.deepEqual(seen, {});
  });

  it("reads the full static selection even from a unit built first", () => {
    // The hook unit sits before the tool unit in the registry, so its
    // factory runs before `compress` is built.  The projection is a
    // selection fact, not a registration side effect: it already knows the
    // tool was selected.
    let seen: readonly string[] | undefined;
    const seenTools = (uses: Record<string, unknown>): void => {
      seen = uses.tools as readonly string[];
    };
    const pruning = defineHook({
      name: "pruning",
      needs: [],
      uses: ["tools"],
      create: (_caps, uses) => {
        seenTools(uses as Record<string, unknown>);
        return {};
      },
    });
    const compress = mockUnit("compress", "tool", () => ({
      kind: "tool",
      tools: [
        { name: "compress", description: "c", execute: async () => "ok" },
      ],
    }));
    const profile: ModeProfile = {
      name: "p",
      agents: [],
      skills: [],
      hooks: ["pruning"],
      tools: ["compress"],
      commands: [],
    };

    const { calls } = run(profile, [pruning, compress]);

    assert.deepEqual(calls, ["pruning", "compress"]);
    assert.deepEqual(seen, ["compress"]);
  });

  it("does not activate anything implicitly through a read fact", () => {
    // The tool is declared by the profile but not selected (its need is
    // unbindable); a reader of the `tools` fact must not see it.
    const compress = mockUnit(
      "compress",
      "tool",
      () => ({ kind: "tool", tools: [] }),
      ["toolHost"],
    );
    let seen: readonly string[] | undefined;
    const pruning = defineHook({
      name: "pruning",
      needs: [],
      uses: ["tools"],
      create: (_caps, uses) => {
        seen = (uses as { tools: readonly string[] }).tools;
        return {};
      },
    });
    const profile: ModeProfile = {
      name: "p",
      agents: [],
      skills: [],
      hooks: ["pruning"],
      tools: ["compress"],
      commands: [],
    };

    const { report } = run(profile, [pruning, compress]);

    assert.deepEqual(seen, []);
    assert.deepEqual(report.skipped, [
      { name: "compress", missing: ["toolHost"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Agent contributions
// ---------------------------------------------------------------------------

describe("assemble — agent contributions", () => {
  it("contributes exactly the selected agents, one contribution each", () => {
    const agent = (name: string) =>
      defineAgent({
        name,
        needs: [],
        create: () => ({ prompt: name.toUpperCase() }),
      });

    const { composed } = run(
      {
        ...ALL_UNITS_PROFILE,
        agents: ["mola", "beaver"],
        skills: [],
        hooks: [],
        tools: [],
        commands: [],
      },
      [agent("dolphin"), agent("beaver"), agent("mola")],
    );

    assert.deepEqual(composed.agents, [
      { name: "beaver", prompt: "BEAVER" },
      { name: "mola", prompt: "MOLA" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Unknown profile names
// ---------------------------------------------------------------------------

describe("assemble — unknown profile names", () => {
  it("warns once per profile name absent from the unit array", () => {
    const { calls, composed } = run(UNKNOWN_PROFILE, makeUnits());

    const warns = _getBufferForTesting().filter(
      (e) => e.event === "unknown_unit",
    );
    assert.equal(warns.length, 5);
    assert.deepEqual(
      warns.map((w) => [w.category, w.name]),
      [
        ["agents", "ghost-agent"],
        ["skills", "ghost-skill"],
        ["hooks", "ghost-hook"],
        ["tools", "ghost-tool"],
        ["commands", "ghost-command"],
      ],
    );

    // Known names still instantiate and contribute.
    assert.deepEqual(calls, [
      "dolphin",
      "beaver-tdd",
      "subagent-prompt",
      "compress",
      "go",
    ]);
    assert.equal(composed.agents.length, 1);
    assert.equal(Object.keys(composed.tools).length, 1);
    assert.equal(Object.keys(composed.commands).length, 1);
  });

  it("records the unknown names in the report", () => {
    const { report } = run(UNKNOWN_PROFILE, makeUnits());
    assert.deepEqual(report.unknown, [
      { category: "agents", name: "ghost-agent" },
      { category: "skills", name: "ghost-skill" },
      { category: "hooks", name: "ghost-hook" },
      { category: "tools", name: "ghost-tool" },
      { category: "commands", name: "ghost-command" },
    ]);
  });

  it("warns nothing when every profile name is known", () => {
    run(ALL_UNITS_PROFILE, makeUnits());
    const warns = _getBufferForTesting().filter(
      (e) => e.event === "unknown_unit",
    );
    assert.equal(warns.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Frozen selection
// ---------------------------------------------------------------------------

describe("assemble — selection", () => {
  it("returns the frozen selection the build ran from", () => {
    const units = makeUnits();
    const { selection, composed } = assemble({
      profile: ALL_UNITS_PROFILE,
      units,
      bindings: capabilityBindings({ values: BASE_CAPS }),
      agentModes: { dolphin: "primary" },
    });

    assert.equal(Object.isFrozen(selection), true);
    assert.deepEqual(selection.primaries, ["dolphin"]);
    assert.deepEqual(selection.report.selected, composed.report.selected);
    assert.equal(selection.chosen.length, 11);
  });
});
