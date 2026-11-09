/**
 * Cross-host composition contract: one shared assembly service.
 *
 * Both hosts declare a capabilities service and let the shared core
 * composition service assemble the active profile over it.  This suite
 * compares the two real service graphs — pi's declarations and OpenCode's
 * declarations, driven through their own lifecycle wiring — and asserts the
 * facts the shared seam is responsible for:
 *
 *  - the graph order: capabilities, then the composition, then the loop
 *    engine that consumes the composed settle strategies;
 *  - the selection both hosts produce from the same config, including the
 *    empty profile and an invalid orchestrator;
 *  - the pi identity path: the main instance answers the orchestrator its
 *    composition resolved, a sub instance answers its fixed agent, and an
 *    invalid profile leaves both unbound.
 *
 * Boundary: the activated service graphs, because the contract is about
 * what a host obtains from its services, not about the assembly internals
 * (covered by `core/composition.test.ts` and `core/compose.test.ts`).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createConfigScope } from "../core/config-snapshot.js";
import { createContextRuntime } from "../core/context/runtime.js";
import { createLifecycleKernel } from "../core/lifecycle/index.js";
import type { Selection } from "../core/selection.js";
import { createSessionAgentResource } from "../core/session/agent.js";
import {
  contextSessionResources,
  createSessionResourceCatalog,
  type SessionResourceCatalog,
} from "../core/session/resources.js";
import { piScope, resetPiTestState } from "../testkits/pi-wiring.js";
import { createOpenCodeHostServices } from "./opencode/services.js";
import { createPiLifecycleWiring } from "./pi/lifecycle-wiring.js";
import { createPiProcessState, type PiProcessState } from "./pi/process.js";
import { createPiHostServices, type PiServiceHost } from "./pi/services.js";
import { buildPiCapabilities } from "./pi/wire.js";

afterEach(() => {
  resetPiTestState();
});

/** The agent mode table of the fixture profile. */
const RAW = {
  agent: {
    dolphin: { mode: "primary" },
    mola: { mode: "primary" },
    beaver: { mode: "subagent" },
  },
};

/** A profile with two primaries and one settle-contributing hook unit. */
const PROFILE = {
  agents: ["dolphin", "mola"],
  skills: ["wiki-query"],
  hooks: ["todo-continuation"],
  tools: [],
  commands: ["go"],
};

/** The zoo config declaring that profile plus its continuation budget. */
const ZOO = { mode: { poly: PROFILE }, continuation: { max_wakes: 3 } };

/** The same profile without the orchestrator the product requires. */
const INVALID_ZOO = {
  mode: { poly: { ...PROFILE, agents: ["mola"] } },
  continuation: { max_wakes: 3 },
};

/** The instance records every graph under test shares. */
const CONTEXT_RUNTIME = createContextRuntime();

/** The process state the graphs under test run over (one per test). */
let piProcess: PiProcessState;

/** The session records of that process state. */
let SESSION_CATALOG: SessionResourceCatalog;

beforeEach(() => {
  piProcess = createPiProcessState();
  SESSION_CATALOG = createSessionResourceCatalog([
    ...contextSessionResources(CONTEXT_RUNTIME),
    createSessionAgentResource(piProcess.sessionAgents),
  ]);
});

/**
 * Build the pi host declarations of one runtime.
 *
 * @param zoo - The `zoo` section of the generation.
 * @param raw - The whole config root (carries the agent mode table).
 * @param fixedAgent - The agent a sub-session runtime is fixed to.
 * @returns The activated extension services.
 */
async function piServices(
  zoo: Record<string, unknown>,
  raw: Record<string, unknown>,
  fixedAgent?: string,
) {
  const scope = piScope(zoo, raw);
  const host: PiServiceHost = {
    scope,
    process: piProcess,
    piApi: undefined,
    appendEntry: undefined,
    capabilities: () =>
      buildPiCapabilities(
        scope,
        piProcess,
        fixedAgent === undefined ? undefined : { fixedAgent },
      ),
    contextRuntime: CONTEXT_RUNTIME,
    sessionCatalog: SESSION_CATALOG,
    colorizeAgent: (name) => name,
    titleForRun: (run) => run.agent,
    borderColorizeForRun: () => undefined,
  };
  const declarations = createPiHostServices(host);
  const wiring = createPiLifecycleWiring({
    extensionServices: declarations.extension,
    sessionServices: declarations.session,
  });
  const { services } = await wiring.activateExtension();
  return services;
}

/** The host config serving the materialisation facts of the profile. */
function hostConfig(agents: readonly string[]) {
  return {
    config: {
      get: async () => ({
        data: {
          agent: Object.fromEntries(
            agents.map((name) => [name, { mode: "primary" }]),
          ),
        },
      }),
    },
  };
}

/**
 * Build the OpenCode host declarations of one instance.
 *
 * @param zoo - The `zoo` section of the generation.
 * @param raw - The whole config root (carries the agent mode table).
 * @param agents - The agent names the host config materialises.
 * @returns The activated extension services.
 */
async function openCodeServices(
  zoo: Record<string, unknown>,
  raw: Record<string, unknown>,
  agents: readonly string[] = [],
) {
  const declarations = createOpenCodeHostServices({
    scope: createConfigScope(zoo, raw),
    client: hostConfig(agents),
    directory: "",
    process: piProcess,
    contextRuntime: CONTEXT_RUNTIME,
    sessionCatalog: SESSION_CATALOG,
  });
  const kernel = createLifecycleKernel(declarations);
  const extension = await kernel.ensureExtension();
  assert.ok(extension);
  return { services: extension.services, declarations };
}

/** The facts two hosts must agree on for one config. */
function measured(selection: Selection) {
  return {
    status: selection.status,
    selected: selection.report.selected,
    orchestrator: selection.orchestrator,
    agents: selection.agents,
    invalid: selection.report.invalid,
  };
}

describe("host composition — service graph order", () => {
  it("declares the capabilities, the composition and the loop on pi", () => {
    const declarations = createPiHostServices({
      scope: piScope({}, RAW),
      process: piProcess,
      piApi: undefined,
      appendEntry: undefined,
      capabilities: () => buildPiCapabilities(piScope({}, RAW), piProcess),
      contextRuntime: CONTEXT_RUNTIME,
      sessionCatalog: SESSION_CATALOG,
      colorizeAgent: (name) => name,
      titleForRun: (run) => run.agent,
      borderColorizeForRun: () => undefined,
    });
    const names = declarations.extension.map((definition) => definition.name);

    // The composition depends on the provision, and the loop on the
    // composition: the three names appear in that order, after the ports
    // they read.
    assert.deepEqual(names.slice(-3), ["capabilities", "composition", "loop"]);
    const composition = declarations.extension.find(
      (definition) => definition.name === "composition",
    );
    assert.deepEqual(
      composition?.deps.map((definition) => definition.name),
      ["capabilities"],
    );
    const loop = declarations.extension.find(
      (definition) => definition.name === "loop",
    );
    assert.deepEqual(
      loop?.deps.map((definition) => definition.name),
      ["composition"],
    );
  });

  it("declares the capabilities, the composition and the loop on OpenCode", async () => {
    const { declarations } = await openCodeServices({}, RAW);

    assert.deepEqual(
      declarations.extension.map((definition) => definition.name),
      ["runScope", "capabilities", "composition", "loop"],
    );
    assert.deepEqual(
      declarations.extension[1].deps.map((definition) => definition.name),
      ["runScope"],
    );
    assert.deepEqual(
      declarations.extension[2].deps.map((definition) => definition.name),
      ["capabilities"],
    );
    assert.deepEqual(
      declarations.extension[3].deps.map((definition) => definition.name),
      ["composition"],
    );
  });

  it("builds both loop engines from the composed settle strategies", async () => {
    const pi = await piServices(ZOO, RAW);
    const openCode = await openCodeServices(ZOO, RAW, ["dolphin", "mola"]);

    // The strategy is the todo-continuation unit's contribution: both
    // engines exist because both compositions selected it.
    assert.equal(pi.loop.engine === undefined, false);
    assert.equal(openCode.services.loop.engine === undefined, false);
  });

  it("builds no loop engine on either host for an empty profile", async () => {
    const pi = await piServices({}, RAW);
    const openCode = await openCodeServices({}, RAW);

    assert.equal(pi.loop.engine, undefined);
    assert.equal(openCode.services.loop.engine, undefined);
  });
});

describe("host composition — selection agreement", () => {
  it("composes the same selection on both hosts", async () => {
    const pi = await piServices(ZOO, RAW);
    const openCode = await openCodeServices(ZOO, RAW, ["dolphin", "mola"]);

    // The literals are the independent source: the profile enables both
    // primaries, and dolphin is the product's orchestrator.
    assert.deepEqual(measured(pi.composition.selection), {
      status: "ready",
      selected: ["todo-continuation", "go", "dolphin", "mola", "wiki-query"],
      orchestrator: "dolphin",
      agents: ["dolphin", "mola"],
      invalid: null,
    });
    assert.deepEqual(
      measured(openCode.services.composition.selection),
      measured(pi.composition.selection),
    );
    assert.deepEqual(
      openCode.services.composition.composed.agents.map((agent) => agent.name),
      pi.composition.composed.agents.map((agent) => agent.name),
    );
  });

  it("closes both hosts on the same invalid orchestrator", async () => {
    const pi = await piServices(INVALID_ZOO, RAW);
    const openCode = await openCodeServices(INVALID_ZOO, RAW, ["mola"]);

    const expected = {
      status: "invalid",
      selected: ["todo-continuation", "go", "mola", "wiki-query"],
      orchestrator: undefined,
      agents: ["mola"],
      invalid: {
        orchestrator: "dolphin",
        cause: "not-enabled",
        primaries: ["mola"],
      },
    };
    assert.deepEqual(measured(pi.composition.selection), expected);
    assert.deepEqual(
      measured(openCode.services.composition.selection),
      expected,
    );
    assert.deepEqual(pi.composition.composed.agents, []);
    assert.deepEqual(openCode.services.composition.composed.agents, []);
  });

  it("selects nothing on both hosts for an empty profile", async () => {
    const pi = await piServices({}, RAW);
    const openCode = await openCodeServices({}, RAW);

    const expected = {
      status: "disabled",
      selected: [],
      orchestrator: undefined,
      agents: [],
      invalid: null,
    };
    assert.deepEqual(measured(pi.composition.selection), expected);
    assert.deepEqual(
      measured(openCode.services.composition.selection),
      expected,
    );
  });
});

describe("pi identity — main and sub instances", () => {
  it("resolves the orchestrator its composition adopted", async () => {
    const main = await piServices(ZOO, RAW);

    assert.equal(main.capabilities.resolveAgent("sess-main"), "dolphin");
  });

  it("resolves a sub instance's fixed agent", async () => {
    const sub = await piServices(ZOO, RAW, "beaver");

    // The runtime is built for exactly one delegation, so every session of
    // it answers that agent — the orchestrator its composition resolved
    // never takes over.
    assert.equal(sub.capabilities.resolveAgent("sess-child"), "beaver");
    assert.equal(sub.composition.selection.orchestrator, "dolphin");
  });

  it("fails closed when the profile cannot provide the orchestrator", async () => {
    const invalid = await piServices(INVALID_ZOO, RAW);

    assert.equal(invalid.capabilities.resolveAgent("sess-main"), undefined);
    assert.equal(piProcess.sessionAgents.resolve("sess-main"), undefined);
  });
});
