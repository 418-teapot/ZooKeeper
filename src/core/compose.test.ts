/**
 * Tests for `composeProfile` in `src/core/compose.ts`.
 *
 * Covers: full-profile selection, null profile (empty result, no unit
 * instantiation), subset selection preserving the unit array's order,
 * per-kind selection (agent / skill / hook / tool / command), empty
 * category lists, unknown profile names warned via the shared logger,
 * and the active-set handed to unit factories.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../utils/logger.js";
import { composeProfile } from "./compose.js";
import type { ModeProfile } from "./config-types.js";
import type {
  ActiveSet,
  Deps,
  UnitContributions,
  UnitDescriptor,
  UnitKind,
} from "./slots.js";

afterEach(() => {
  _resetForTesting();
});

const DEPS: Deps = {
  limits: {},
  contextConfig: {},
  client: {},
  directory: "/tmp/zoo",
  sessionAgentMap: new Map(),
};

/** The unit registry, in declaration order. */
function makeUnits(): { units: UnitDescriptor[]; calls: string[] } {
  const calls: string[] = [];
  const units: UnitDescriptor[] = [
    mockUnit("dolphin", "agent", () => {
      calls.push("dolphin");
      return {
        kind: "agent",
        agents: [{ name: "dolphin", prompt: "DOLPHIN" }],
      };
    }),
    mockUnit("beaver", "agent", () => {
      calls.push("beaver");
      return { kind: "agent", agents: [{ name: "beaver", prompt: "BEAVER" }] };
    }),
    mockUnit("mola", "agent", () => {
      calls.push("mola");
      return { kind: "agent", agents: [{ name: "mola", prompt: "MOLA" }] };
    }),
    mockUnit("beaver-tdd", "skill", () => {
      calls.push("beaver-tdd");
      return { kind: "skill", skills: [{ name: "beaver-tdd" }] };
    }),
    mockUnit("wiki-query", "skill", () => {
      calls.push("wiki-query");
      return { kind: "skill", skills: [{ name: "wiki-query" }] };
    }),
    mockUnit("task-prompt", "hook", () => {
      calls.push("task-prompt");
      return {
        kind: "hook",
        beforeExec: [{ name: "validateBeforeExec", handle: async () => {} }],
        afterExec: [{ name: "nudgeTaskOutput", handle: async () => {} }],
        transform: [],
        toolDefinition: [
          { name: "enhanceTaskDefinition", handle: async () => {} },
        ],
      };
    }),
    mockUnit("context-pruning", "hook", () => {
      calls.push("context-pruning");
      return {
        kind: "hook",
        beforeExec: [],
        afterExec: [],
        transform: [{ name: "contextPruning", handle: async () => {} }],
        toolDefinition: [],
      };
    }),
    mockUnit("context-metrics", "hook", () => {
      calls.push("context-metrics");
      return {
        kind: "hook",
        beforeExec: [],
        afterExec: [],
        transform: [{ name: "contextMetrics", handle: async () => {} }],
        toolDefinition: [],
      };
    }),
    mockUnit("compress", "tool", () => {
      calls.push("compress");
      return {
        kind: "tool",
        tools: [
          {
            name: "compress",
            description: "compress tool",
            execute: async () => "ok",
          },
        ],
      };
    }),
    mockUnit("decompress", "tool", () => {
      calls.push("decompress");
      return {
        kind: "tool",
        tools: [
          {
            name: "decompress",
            description: "decompress tool",
            execute: async () => "ok",
          },
        ],
      };
    }),
    mockUnit("go", "command", () => {
      calls.push("go");
      return {
        kind: "command",
        commands: [
          { name: "go", description: "handoff", handle: async () => {} },
        ],
      };
    }),
    mockUnit("dcp", "command", () => {
      calls.push("dcp");
      return {
        kind: "command",
        commands: [
          { name: "dcp", description: "context", handle: async () => {} },
        ],
      };
    }),
  ];
  return { units, calls };
}

function mockUnit(
  name: string,
  kind: UnitKind,
  create: (deps: Deps, activeSet: ActiveSet) => UnitContributions,
): UnitDescriptor {
  return { name, kind, create } as UnitDescriptor;
}

/** Profile listing every unit in the registry. */
const ALL_UNITS_PROFILE: ModeProfile = {
  name: "poly",
  agents: ["dolphin", "beaver", "mola"],
  skills: ["beaver-tdd", "wiki-query"],
  hooks: ["task-prompt", "context-pruning", "context-metrics"],
  tools: ["compress", "decompress"],
  commands: ["go", "dcp"],
};

/** Profile enabling a subset of units across several kinds. */
const SUBSET_PROFILE: ModeProfile = {
  name: "lite",
  agents: ["mola"],
  skills: [],
  hooks: ["context-metrics"],
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
  hooks: ["task-prompt", "ghost-hook"],
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

describe("composeProfile — full profile", () => {
  it("instantiates every listed unit in registry order", () => {
    const { units, calls } = makeUnits();
    composeProfile(ALL_UNITS_PROFILE, units, DEPS);
    assert.deepEqual(calls, [
      "dolphin",
      "beaver",
      "mola",
      "beaver-tdd",
      "wiki-query",
      "task-prompt",
      "context-pruning",
      "context-metrics",
      "compress",
      "decompress",
      "go",
      "dcp",
    ]);
  });

  it("collects contributions into the host-agnostic result", () => {
    const { units } = makeUnits();
    const result = composeProfile(ALL_UNITS_PROFILE, units, DEPS);

    assert.deepEqual(result.agents, [
      { name: "dolphin", prompt: "DOLPHIN" },
      { name: "beaver", prompt: "BEAVER" },
      { name: "mola", prompt: "MOLA" },
    ]);
    assert.deepEqual(result.skills, [
      { name: "beaver-tdd" },
      { name: "wiki-query" },
    ]);
    assert.deepEqual(
      result.beforeExec.map((h) => h.name),
      ["validateBeforeExec"],
    );
    assert.deepEqual(
      result.afterExec.map((h) => h.name),
      ["nudgeTaskOutput"],
    );
    assert.deepEqual(
      result.transform.map((h) => h.name),
      ["contextPruning", "contextMetrics"],
    );
    assert.deepEqual(
      result.toolDefinition.map((h) => h.name),
      ["enhanceTaskDefinition"],
    );
    assert.deepEqual(Object.keys(result.tools), ["compress", "decompress"]);
    assert.deepEqual(Object.keys(result.commands), ["go", "dcp"]);
  });
});

// ---------------------------------------------------------------------------
// Null profile
// ---------------------------------------------------------------------------

describe("composeProfile — null profile", () => {
  it("returns an empty result without instantiating any unit", () => {
    const { units, calls } = makeUnits();
    const result = composeProfile(null, units, DEPS);
    assert.deepEqual(calls, []);
    assert.deepEqual(result, {
      agents: [],
      skills: [],
      beforeExec: [],
      afterExec: [],
      transform: [],
      toolDefinition: [],
      tools: {},
      commands: {},
    });
  });
});

// ---------------------------------------------------------------------------
// Subset profile — order preservation
// ---------------------------------------------------------------------------

describe("composeProfile — subset profile", () => {
  it("instantiates only enabled units, preserving registry order", () => {
    const { units, calls } = makeUnits();
    const result = composeProfile(SUBSET_PROFILE, units, DEPS);

    assert.deepEqual(calls, ["mola", "context-metrics", "decompress"]);
    assert.deepEqual(result.agents, [{ name: "mola", prompt: "MOLA" }]);
    assert.deepEqual(result.skills, []);
    assert.deepEqual(
      result.transform.map((h) => h.name),
      ["contextMetrics"],
    );
    assert.deepEqual(result.beforeExec, []);
    assert.deepEqual(result.afterExec, []);
    assert.deepEqual(result.toolDefinition, []);
    assert.deepEqual(Object.keys(result.tools), ["decompress"]);
    assert.deepEqual(Object.keys(result.commands), []);
  });
});

// ---------------------------------------------------------------------------
// Per-kind selection
// ---------------------------------------------------------------------------

describe("composeProfile — per-kind selection", () => {
  it("selects agent / skill / tool / command units independently", () => {
    const { units, calls } = makeUnits();
    const result = composeProfile(ONE_OF_EACH_PROFILE, units, DEPS);

    assert.deepEqual(calls, ["beaver", "wiki-query", "compress", "dcp"]);
    assert.deepEqual(result.agents, [{ name: "beaver", prompt: "BEAVER" }]);
    assert.deepEqual(result.skills, [{ name: "wiki-query" }]);
    assert.deepEqual(result.beforeExec, []);
    assert.deepEqual(result.afterExec, []);
    assert.deepEqual(result.transform, []);
    assert.deepEqual(result.toolDefinition, []);
    assert.deepEqual(Object.keys(result.tools), ["compress"]);
    assert.deepEqual(Object.keys(result.commands), ["dcp"]);
  });
});

// ---------------------------------------------------------------------------
// Empty category lists
// ---------------------------------------------------------------------------

describe("composeProfile — empty category lists", () => {
  it("instantiates nothing and returns empty contributions", () => {
    const { units, calls } = makeUnits();
    const result = composeProfile(EMPTY_PROFILE, units, DEPS);

    assert.deepEqual(calls, []);
    assert.deepEqual(result, {
      agents: [],
      skills: [],
      beforeExec: [],
      afterExec: [],
      transform: [],
      toolDefinition: [],
      tools: {},
      commands: {},
    });
  });
});

// ---------------------------------------------------------------------------
// Unknown profile names
// ---------------------------------------------------------------------------

describe("composeProfile — unknown profile names", () => {
  it("warns once per profile name absent from the unit array", () => {
    const { units, calls } = makeUnits();
    const result = composeProfile(UNKNOWN_PROFILE, units, DEPS);

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
      "task-prompt",
      "compress",
      "go",
    ]);
    assert.equal(result.agents.length, 1);
    assert.equal(Object.keys(result.tools).length, 1);
    assert.equal(Object.keys(result.commands).length, 1);
  });

  it("warns nothing when every profile name is known", () => {
    const { units } = makeUnits();
    composeProfile(ALL_UNITS_PROFILE, units, DEPS);
    const warns = _getBufferForTesting().filter(
      (e) => e.event === "unknown_unit",
    );
    assert.equal(warns.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Active set passed to factories
// ---------------------------------------------------------------------------

describe("composeProfile — active set", () => {
  it("passes profile-derived enablement sets to unit factories", () => {
    let seen: ActiveSet | undefined;
    const unit = mockUnit("task-prompt", "hook", (_deps, activeSet) => {
      seen = activeSet;
      return {
        kind: "hook",
        beforeExec: [],
        afterExec: [],
        transform: [],
        toolDefinition: [],
      };
    });
    composeProfile(ALL_UNITS_PROFILE, [unit], DEPS);

    assert.ok(seen, "factory must receive the active set");
    assert.deepEqual([...seen.agents], ["dolphin", "beaver", "mola"]);
    assert.deepEqual([...seen.skills], ["beaver-tdd", "wiki-query"]);
    assert.deepEqual(
      [...seen.hooks],
      ["task-prompt", "context-pruning", "context-metrics"],
    );
    assert.deepEqual([...seen.tools], ["compress", "decompress"]);
    assert.deepEqual([...seen.commands], ["go", "dcp"]);
  });
});
