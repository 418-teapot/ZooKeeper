/**
 * Tests for the pi host wiring (`src/adapters/pi/wire.ts`).
 *
 * Covers: `composePi` composing the full registry from the
 * active `[zoo.mode.*]` profile (agents/skills/hooks/tools/commands,
 * unconditional pruning contribution, primary-agent Map gating,
 * null/invalid profile → empty composition), `buildPiResolveAgent`'s
 * session identity resolution, the published start (`registerTool` /
 * `registerCommand` / entry renderer / `plugin_init`), the primary
 * tool-deny trim, and the `zoo` fleet widget (seeding, colorization,
 * enter-inspect wiring and post-restart hydration).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ASK_TOOL_NAME, type QuestionChannel } from "../../core/ask.js";
import { project } from "../../core/context/lens.js";
import { createContextRuntime } from "../../core/context/runtime.js";
import type { CleanupReport, WorkPermit } from "../../core/lifecycle/index.js";
import type {
  SwitchHost,
  SwitchNewSessionOps,
} from "../../core/ports/switch.js";
import type { SubagentDriver } from "../../core/subagent/driver.js";
import type { RunRegistry } from "../../core/subagent/registry.js";
import { createTodoStore } from "../../core/todo/store.js";
import type { ToolCallContext, ToolContribution } from "../../core/unit.js";
import { enhanceSubagentDefinition } from "../../hooks/subagent-prompt/index.js";
import { formHarness } from "../../testkits/ask-form.js";
import { callFor, permitFor } from "../../testkits/context-runtime.js";
import {
  COLORS_RAW,
  composePi,
  fakePiToolHost,
  MODES_RAW,
  mockApi,
  POLY_PROFILE,
  POLY_ZOO,
  piScope,
  renderZooWidget,
  resetPiTestState,
  SESSION_CTX,
  startPi,
  startPiRuntime,
  WIDGET_THEME,
  WIDGET_TUI,
} from "../../testkits/pi-wiring.js";
import { cleanupPlanDir, writePlanFile } from "../../testkits/plans.js";
import { stubTui } from "../../testkits/theme.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import { validateCompressArgs } from "../../tools/compress.js";
import {
  _flushForTesting,
  _getBufferForTesting,
  initLogger,
  log,
} from "../../utils/logger.js";
import { createPiQuestionChannel } from "./ask-form.js";
import { createPiHandoffTarget } from "./handoff-target.js";
import { beginHydration, resetHydration, waitForHydration } from "./hydrate.js";
import type { PiSessionWorkRunner } from "./lifecycle-wiring.js";
import { createPiProcessState, type PiProcessState } from "./process.js";
import { buildPiSubagentExtension } from "./publisher.js";
import {
  applyToolDefinitionContributions,
  buildPiCommandRegistrationPlan,
} from "./registration.js";
import { createPiHandoffIdentity } from "./switch-host.js";
import { TRANSCRIPT_UNAVAILABLE_NOTICE } from "./tui/transcript.js";
import {
  buildPiResolveAgent,
  buildPiToolExecute,
  loadPiHtmlConverter,
} from "./wire.js";

/**
 * The pi process this test file drives: one owner per test, exactly as one
 * pi process keeps its state across the reloads of one generation.
 */
let piProcess: PiProcessState = createPiProcessState();

beforeEach(() => {
  piProcess = createPiProcessState();
});

afterEach(resetPiTestState);

/** Compose one generation over this test's process state. */
function compose(
  scope: Parameters<typeof composePi>[0],
  deps?: Parameters<typeof composePi>[1],
): ReturnType<typeof composePi> {
  return composePi(scope, deps, piProcess);
}

/** Start one pi instance over this test's process state. */
function startInstance(
  scope: Parameters<typeof startPi>[0],
  pi?: unknown,
  overrides?: Parameters<typeof startPi>[2],
): ReturnType<typeof startPi> {
  return startPi(scope, pi, overrides, piProcess);
}

// The official transcript message components render through the coding-agent
// module-level theme singleton; the built-in dark theme ships with the
// package and needs no configuration.  Bun runs each test file in its own
// worker, so the initialization never leaks into other files.
initTheme();

// ---------------------------------------------------------------------------
// Profile-driven selection
// ---------------------------------------------------------------------------

describe("composePi — profile-driven selection", () => {
  it("poly full profile → 7 agents incl. dolphin prompt, 11 skills", async () => {
    const { composed, profile } = await compose(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    assert.equal(profile?.name, "poly");
    assert.equal(composed.agents.length, 7);
    assert.equal(composed.skills.length, 11);
    const dolphin = composed.agents.find((a) => a.name === "dolphin");
    assert.ok(dolphin, "dolphin must be composed");
    assert.ok(dolphin.prompt.startsWith("<Role>"));
    assert.ok(dolphin.prompt.includes("持续维护一个交付闭环"));
  });

  it("poly full profile → full-registry composition incl. hooks/tools/commands", async () => {
    const { composed } = await compose(piScope(POLY_ZOO, MODES_RAW), undefined);
    // afterExec from the registry's hook units, in registry order.
    assert.deepEqual(
      composed.afterExec.map((h) => h.name),
      [
        "nudgeSubagentOutput",
        "recoverJsonError",
        "nudgeDirectWork",
        "nudgePostSubagent",
      ],
    );
    // context-pruning is not gated on client capabilities — the
    // unit contributes unconditionally, so the transform handler
    // appears.
    assert.deepEqual(
      composed.transform.map((h) => h.name),
      ["contextPruning"],
    );
    // The delegation strategy lives in the composed gate (judge slot);
    // the pi host consumes it inside the subagent tool's execute.
    assert.equal(
      typeof composed.gate,
      "function",
      "composed gate must be a function when delegation judges are enabled",
    );
    // Tool units require a tool host; this profile-driven composition
    // carries none, so no tool activates.  Commands still compose.
    assert.deepEqual(Object.keys(composed.tools).sort(), []);
    assert.deepEqual(Object.keys(composed.commands).sort(), ["dcp", "go"]);
  });

  it("agents=[dolphin] → only dolphin, no skills", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, agents: ["dolphin"], skills: [] } },
    };
    const { composed } = await compose(piScope(zoo, MODES_RAW), undefined);
    assert.deepEqual(
      composed.agents.map((a) => a.name),
      ["dolphin"],
    );
    assert.deepEqual(composed.skills, []);
  });

  it("agents=[mola] → invalid profile (no orchestrator), nothing composes", async () => {
    // dolphin is the product's orchestrator; a profile that omits it
    // cannot run, and the remaining primary is never promoted.
    const zoo = {
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, agents: ["mola"] } },
    };
    const { composed } = await compose(piScope(zoo, MODES_RAW), undefined);
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(composed.report.invalid, {
      orchestrator: "dolphin",
      cause: "not-enabled",
      primaries: ["mola"],
    });
  });

  it("empty agents/skills lists → empty contributions", async () => {
    const zoo = {
      mode: { poly: { ...POLY_PROFILE, agents: [], skills: [] } },
    };
    const { composed } = await compose(piScope(zoo, MODES_RAW), undefined);
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(composed.skills, []);
  });

  it("absent zoo.mode → null profile, empty contributions", async () => {
    const { composed, profile } = await compose(piScope({}));
    assert.equal(profile, null);
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(composed.skills, []);
    assert.deepEqual(composed.afterExec, []);
    assert.deepEqual(composed.transform, []);
  });

  it("flags only the replacing commands for control admission", async () => {
    // The replacing claim is explicit metadata on the contribution, never a
    // command-name lookup: `/go` and the `/<agent>` switches set it, every
    // other command leaves it unset and runs as ordinary session work.
    const switchHost: SwitchHost = {
      getBaselineTools: () => [],
      setActiveTools: () => {},
      getPrimary: () => undefined,
      setPrimary: () => {},
      newSession: async () => ({ cancelled: false }),
    };
    // The pi switch surface is what contributes the `/<agent>` commands, so
    // a stub host brings them into the same composition.
    const { composed } = await compose(piScope(POLY_ZOO, MODES_RAW), {
      switchHost,
    });
    const plan = buildPiCommandRegistrationPlan(composed.commands);
    assert.deepEqual(
      plan
        .filter((registration) => registration.replacesSession)
        .map((registration) => registration.name)
        .sort(),
      ["dolphin", "go", "mola"],
    );
    assert.equal(
      plan.find((registration) => registration.name === "dcp")?.replacesSession,
      false,
    );
  });

  it("poly full profile → no unknown_unit warnings (all names match the registry)", async () => {
    // pi composes the full profile against the full registry: every
    // hooks/tools/commands/agents/skills name must match a unit or the
    // selection engine warns.
    await compose(piScope(POLY_ZOO, MODES_RAW), undefined);
    const unknownUnits = _getBufferForTesting().filter(
      (entry) => entry.event === "unknown_unit",
    );
    assert.deepEqual(unknownUnits, []);
  });

  it("unknown hooks/tools profile names reach the unknown_unit warning path", async () => {
    // The full-profile composition surfaces unmatched category names to
    // the engine.
    const zoo = {
      mode: {
        poly: {
          ...POLY_PROFILE,
          hooks: [...POLY_PROFILE.hooks, "ghost-hook"],
          tools: [...POLY_PROFILE.tools, "ghost-tool"],
        },
      },
    };
    await compose(piScope(zoo, MODES_RAW), undefined);
    const unknownUnits = _getBufferForTesting().filter(
      (entry) => entry.event === "unknown_unit",
    );
    assert.deepEqual(
      unknownUnits.map((u) => u.name),
      ["ghost-hook", "ghost-tool"],
    );
  });

  it("ambiguous zoo.mode (two tables) → null profile, empty contributions", async () => {
    // No mode state file: multi-profile selection must fail closed.
    process.env.ZOO_MODE_FILE = join(
      tmpdir(),
      "zoo-mode-test-nonexistent.json",
    );
    const zoo = {
      mode: { poly: POLY_PROFILE, slim: { agents: [], skills: [] } },
    };
    const { composed, profile } = await compose(
      piScope(zoo, MODES_RAW),
      undefined,
    );
    assert.equal(profile, null);
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(composed.skills, []);
  });

  it("poly profile listing todo + host todoStore/toolHost → todo composes", async () => {
    // The pi entry point forwards its host ports into deps; with both
    // supplied the fail-closed todo unit contributes its tool.
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: { ...POLY_PROFILE, tools: [...POLY_PROFILE.tools, "todo"] },
      },
    };
    const { composed } = await compose(piScope(zoo, MODES_RAW), {
      toolHost: fakePiToolHost(),
      todoStore: createTodoStore(async () => []),
    });
    assert.ok(composed.tools.todo, "todo must register on the pi host");
    assert.equal(composed.tools.todo.name, "todo");
    assert.equal(typeof composed.tools.todo.execute, "function");
    // The sibling tools are unaffected by the host-port gate.
    assert.deepEqual(Object.keys(composed.tools).sort(), [
      "compress",
      "decompress",
      "todo",
    ]);
    // Every profile name matched a registry unit — no unknown_unit warning.
    assert.deepEqual(
      _getBufferForTesting().filter((e) => e.event === "unknown_unit"),
      [],
    );
  });

  it("the composed todo tool serves state through the host's store instance", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: { ...POLY_PROFILE, tools: [...POLY_PROFILE.tools, "todo"] },
      },
    };
    const store = createTodoStore(async () => []);
    const { composed } = await compose(piScope(zoo, MODES_RAW), {
      toolHost: fakePiToolHost(),
      todoStore: store,
    });
    // Mutating through the composed tool must land in the very store the
    // host injected (no hidden re-creation), so the host's own invalidation
    // and the tool always share one cache.
    await composed.tools.todo?.execute(
      { op: "init", tasks: ["Injected"] },
      callFor("sess-compose", { permit: permitFor("sess-compose") }),
    );
    const phases = await store.get("sess-compose");
    assert.equal(phases[0]?.tasks[0]?.content, "Injected");
  });

  it("contributes no todo tool when the host supplies no todoStore", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: { ...POLY_PROFILE, tools: [...POLY_PROFILE.tools, "todo"] },
      },
    };
    const { composed } = await compose(piScope(zoo, MODES_RAW), {
      toolHost: fakePiToolHost(),
    });
    assert.equal(
      composed.tools.todo,
      undefined,
      "no todo store → the todo unit must fail closed",
    );
  });

  it("registers the todo tool from its store alone, without tool services", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: { ...POLY_PROFILE, tools: [...POLY_PROFILE.tools, "todo"] },
      },
    };
    const { composed } = await compose(piScope(zoo, MODES_RAW), {
      todoStore: createTodoStore(async () => []),
    });
    assert.ok(composed.tools.todo, "the todo unit needs only its store");
    // compress and decompress still need the tool host: absent it, they
    // stay unregistered.
    assert.deepEqual(Object.keys(composed.tools), ["todo"]);
  });

  it("the pi definition boundary passes the composed todo tool through untouched", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: { ...POLY_PROFILE, tools: [...POLY_PROFILE.tools, "todo"] },
      },
    };
    const { composed } = await compose(piScope(zoo, MODES_RAW), {
      toolHost: fakePiToolHost(),
      todoStore: createTodoStore(async () => []),
    });
    const todo = composed.tools.todo;
    assert.ok(todo);

    // Definition enhancers only target the subagent tool.
    const enhanced = await applyToolDefinitionContributions(composed.tools, [
      { name: "enhanceSubagentDefinition", handle: enhanceSubagentDefinition },
    ]);
    assert.equal(enhanced.todo, todo, "no enhancer may rewrite the todo tool");
  });

  it("the same todo-listing profile with no host ports → no todo tool", async () => {
    // Without the tool host the todo unit is skipped, so the composed
    // tool surface stays empty.
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: { ...POLY_PROFILE, tools: [...POLY_PROFILE.tools, "todo"] },
      },
    };
    const { composed } = await compose(piScope(zoo, MODES_RAW), undefined);
    assert.equal(composed.tools.todo, undefined);
    assert.deepEqual(Object.keys(composed.tools).sort(), []);
  });
});

// ---------------------------------------------------------------------------
// Session agent identity — buildPiResolveAgent paths
// ---------------------------------------------------------------------------

describe("buildPiResolveAgent — session identity resolution", () => {
  /** The orchestrator the selection resolves for the poly profile. */
  const ORCHESTRATOR = "dolphin";

  /** Main-runtime sources over this test's process state. */
  function mainSources() {
    return {
      sessionAgents: piProcess.sessionAgents,
      runs: piProcess.runs,
      orchestrator: () => ORCHESTRATOR,
    };
  }

  it("a recorded child session resolves to its delegated run agent", () => {
    piProcess.runs.start({
      id: "run-1",
      agent: "beaver",
      parentSession: "root-ses",
      startedAt: 100,
    });
    piProcess.runs.update("run-1", { childSession: "child-beaver" });
    const resolve = buildPiResolveAgent(mainSources());
    assert.equal(resolve("child-beaver"), "beaver");
  });

  it("the child-session answer is bound so later lookups skip the run table", () => {
    piProcess.runs.start({
      id: "run-1",
      agent: "beaver",
      parentSession: "root-ses",
      startedAt: 100,
    });
    piProcess.runs.update("run-1", { childSession: "child-beaver" });
    // The run table answers once, then only the binding can.
    let lookups = 0;
    const runs = {
      findByChildSession: (sessionID: string) => {
        lookups += 1;
        return piProcess.runs.findByChildSession(sessionID);
      },
    } as unknown as RunRegistry;
    const resolve = buildPiResolveAgent({
      ...mainSources(),
      runs,
    });
    assert.equal(piProcess.sessionAgents.resolve("child-beaver"), undefined);
    assert.equal(resolve("child-beaver"), "beaver");
    assert.equal(piProcess.sessionAgents.resolve("child-beaver"), "beaver");
    assert.equal(resolve("child-beaver"), "beaver");
    assert.equal(lookups, 1, "the memoized binding answers the second lookup");
  });

  it("two process owners never exchange identities", () => {
    // Each owner carries the facts of one process.  A resolver reads only
    // the owner it was given, so a child session known to one owner is
    // unknown to the other.
    const other = createPiProcessState();
    piProcess.runs.start({
      id: "run-1",
      agent: "beaver",
      parentSession: "root-ses",
      startedAt: 100,
    });
    piProcess.runs.update("run-1", { childSession: "child-beaver" });
    const mine = buildPiResolveAgent(mainSources());
    const theirs = buildPiResolveAgent({
      sessionAgents: other.sessionAgents,
      runs: other.runs,
      orchestrator: () => ORCHESTRATOR,
    });

    assert.equal(mine("child-beaver"), "beaver");
    assert.equal(
      other.sessionAgents.resolve("child-beaver"),
      undefined,
      "the other owner learns nothing from this one",
    );
    assert.equal(theirs("child-beaver"), ORCHESTRATOR);
  });

  it("a session the run table does not know falls through to the orchestrator", () => {
    const resolve = buildPiResolveAgent(mainSources());
    assert.equal(resolve("root-ses"), "dolphin");
  });

  it("a sub-session runtime resolves its fixed agent before any run report", () => {
    // The delegation's first events precede the run's first progress
    // report, so the run table cannot answer yet: the runtime's own fixed
    // agent must.
    const resolve = buildPiResolveAgent({
      sessionAgents: piProcess.sessionAgents,
      runs: piProcess.runs,
      fixedAgent: "lynx",
      orchestrator: () => ORCHESTRATOR,
    });
    assert.equal(resolve("child-of-lynx"), "lynx");
    assert.equal(piProcess.sessionAgents.resolve("child-of-lynx"), "lynx");
  });

  it("two concurrent sub-session runtimes never exchange identities", async () => {
    // Each runtime is built for one delegation; their sessions are distinct
    // and their events interleave.
    const beaver = buildPiResolveAgent({
      sessionAgents: piProcess.sessionAgents,
      runs: piProcess.runs,
      fixedAgent: "beaver",
      orchestrator: () => ORCHESTRATOR,
    });
    const lynx = buildPiResolveAgent({
      sessionAgents: piProcess.sessionAgents,
      runs: piProcess.runs,
      fixedAgent: "lynx",
      orchestrator: () => ORCHESTRATOR,
    });

    /** Resolve after a real async yield, so interleaving is observable. */
    const probe = async (
      resolve: (sessionID: string) => string | undefined,
      sessionID: string,
      expected: string,
    ): Promise<string | undefined> => {
      const first = resolve(sessionID);
      await Promise.resolve();
      const afterYield = resolve(sessionID);
      assert.equal(afterYield, expected);
      assert.equal(first, afterYield);
      return afterYield;
    };

    const [left, right] = await Promise.all([
      probe(beaver, "sess-beaver", "beaver"),
      probe(lynx, "sess-lynx", "lynx"),
      probe(beaver, "sess-beaver-2", "beaver"),
      probe(lynx, "sess-lynx-2", "lynx"),
    ]);

    assert.equal(left, "beaver");
    assert.equal(right, "lynx");
    assert.equal(piProcess.sessionAgents.resolve("sess-beaver"), "beaver");
    assert.equal(piProcess.sessionAgents.resolve("sess-lynx"), "lynx");
    assert.equal(piProcess.sessionAgents.resolve("sess-beaver-2"), "beaver");
    assert.equal(piProcess.sessionAgents.resolve("sess-lynx-2"), "lynx");
  });

  it("a pending replacement target never answers for an unknown session", () => {
    // A switch target binds only at the replacement's own `session_start`
    // (see `switch-host.ts`); no unresolvable session may read it.
    piProcess.switchOps.begin("sess-old");
    piProcess.switchOps.stash({ primary: "mola" });
    const resolve = buildPiResolveAgent(mainSources());

    assert.equal(resolve("sess-unrelated"), ORCHESTRATOR);
    assert.equal(
      piProcess.sessionAgents.resolve("sess-unrelated"),
      ORCHESTRATOR,
    );
    // The target is still unclaimed: the replacement's own start takes it.
    assert.equal(
      piProcess.switchOps.claim("sess-new", {
        reason: "new",
        parentSession: "sess-old",
      }),
      "mola",
    );
  });

  it("a claimed replacement target answers from the registry", () => {
    piProcess.switchOps.begin("sess-old");
    piProcess.switchOps.stash({ primary: "mola" });
    assert.equal(
      piProcess.switchOps.claim("sess-new", {
        reason: "new",
        parentSession: "sess-old",
      }),
      "mola",
    );
    const resolve = buildPiResolveAgent(mainSources());

    // The start bound the target before the session's bind-time events.
    piProcess.sessionAgents.bind("sess-new", "mola");
    assert.equal(resolve("sess-new"), "mola");
  });

  it("the orchestrator answer is bound and repeats hit the registry", () => {
    const resolve = buildPiResolveAgent(mainSources());
    assert.equal(piProcess.sessionAgents.resolve("root-ses-2"), undefined);
    assert.equal(resolve("root-ses-2"), "dolphin");
    // The main session is bound, so repeated lookups skip the sources.
    assert.equal(piProcess.sessionAgents.resolve("root-ses-2"), "dolphin");
    assert.equal(resolve("root-ses-2"), "dolphin");
  });

  it("a pre-existing registry binding wins over fresh resolution", () => {
    piProcess.sessionAgents.bind("bound-ses", "mola");
    const resolve = buildPiResolveAgent({
      sessionAgents: piProcess.sessionAgents,
      runs: piProcess.runs,
      fixedAgent: "boy",
      orchestrator: () => ORCHESTRATOR,
    });
    assert.equal(resolve("bound-ses"), "mola");
  });

  it("no source answering → undefined (fail-closed, no binding created)", () => {
    const resolve = buildPiResolveAgent({
      sessionAgents: piProcess.sessionAgents,
      runs: piProcess.runs,
      orchestrator: () => undefined,
    });
    assert.equal(resolve("any-session"), undefined);
    assert.equal(piProcess.sessionAgents.resolve("any-session"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fetch converter availability (probed before selection)
// ---------------------------------------------------------------------------

describe("composePi — fetch converter availability", () => {
  /** The poly profile with only the fetch tool enabled. */
  const FETCH_ZOO = {
    ...POLY_ZOO,
    mode: { poly: { ...POLY_PROFILE, tools: ["fetch"] } },
  };
  /** A converter stub the pipeline would accept. */
  const converter = (html: string) => html;
  /** A head truncator stub that keeps everything. */
  const truncate = (content: string) => ({
    content,
    truncated: false,
    totalLines: 1,
    totalBytes: content.length,
    outputLines: 1,
  });

  /**
   * Read the levels of the buffered `converter_unavailable` warnings.
   *
   * @returns One level per emitted warning, in emission order.
   */
  function converterWarnings(): unknown[] {
    return _getBufferForTesting()
      .filter(
        (entry) =>
          entry.hook === "fetch-tool" &&
          entry.event === "converter_unavailable",
      )
      .map((entry) => entry.level);
  }

  it("selects fetch when the converter probe succeeds", async () => {
    const { composed } = await compose(piScope(FETCH_ZOO, MODES_RAW), {
      loadHtmlConverter: () => converter,
      truncateHead: truncate,
    });

    assert.deepEqual(Object.keys(composed.tools), ["fetch"]);
    assert.ok(composed.report.selected.includes("fetch"));
  });

  it("skips fetch when the converter probe reports no addon", async () => {
    const { composed } = await compose(piScope(FETCH_ZOO, MODES_RAW), {
      loadHtmlConverter: () => null,
      truncateHead: truncate,
    });

    assert.deepEqual(composed.tools, {});
    assert.deepEqual(
      composed.report.skipped.filter((skip) => skip.name === "fetch"),
      [{ name: "fetch", missing: ["htmlConverter"] }],
    );
  });

  it("does not probe the converter when the profile is absent", async () => {
    // A null profile selects nothing and instantiates nothing, so probing
    // the native addon there would only emit a spurious
    // `converter_unavailable` warning for a unit that can never run.
    let probes = 0;
    const { composed, profile } = await compose(piScope({}, MODES_RAW), {
      loadHtmlConverter: () => {
        probes += 1;
        return converter;
      },
      truncateHead: truncate,
    });

    assert.equal(profile, null);
    assert.equal(probes, 0);
    assert.deepEqual(composed.tools, {});
  });

  it("skips fetch when the host binds no converter loader", async () => {
    const { composed } = await compose(piScope(FETCH_ZOO, MODES_RAW), {
      truncateHead: truncate,
    });

    assert.deepEqual(composed.tools, {});
    assert.deepEqual(
      composed.report.skipped.filter((skip) => skip.name === "fetch"),
      [{ name: "fetch", missing: ["htmlConverter"] }],
    );
  });

  it("returns the loader's converter unchanged without warning", () => {
    assert.equal(
      loadPiHtmlConverter(() => converter),
      converter,
    );
    assert.equal(
      _getBufferForTesting().filter((entry) => entry.hook === "fetch-tool")
        .length,
      0,
      "a usable converter must not warn",
    );
  });

  it("warns converter_unavailable once per probe and declares no converter", async () => {
    // `loadPiHtmlConverter` is the wrapper the pi entry point binds: the
    // loader's `null` is the addon's absence, and the wrapper is
    // fail-closed (one warn per probe, no capability).
    const probe = () => loadPiHtmlConverter(() => null);
    assert.equal(probe(), null);
    assert.deepEqual(converterWarnings(), ["warn"]);

    const { composed } = await compose(piScope(FETCH_ZOO, MODES_RAW), {
      loadHtmlConverter: probe,
      truncateHead: truncate,
    });
    // The assembly probes exactly once more, and binds no converter.
    assert.deepEqual(converterWarnings(), ["warn", "warn"]);
    assert.deepEqual(composed.tools, {});
    assert.deepEqual(
      composed.report.skipped.filter((skip) => skip.name === "fetch"),
      [{ name: "fetch", missing: ["htmlConverter"] }],
    );
  });
});

// ---------------------------------------------------------------------------
// Orchestrator seeding
// ---------------------------------------------------------------------------

describe("composePi — session agent resolution", () => {
  it("resolves the selection's orchestrator for an unbound session", async () => {
    const { resolveAgent } = await compose(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );

    assert.equal(resolveAgent("sess-main"), "dolphin");
  });

  it("lets a binding written after composition win (a switch target)", async () => {
    // The extension factory re-runs on every session replacement; the
    // switch writes the session binding before `newSession`, so the fresh
    // composition must keep that choice instead of re-resolving it.
    const { resolveAgent } = await compose(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    piProcess.sessionAgents.bind("sess-main", "mola");

    assert.equal(resolveAgent("sess-main"), "mola");
  });

  it("follows the declared orchestrator, not the profile's agent order", async () => {
    // mola is listed first and is a primary, yet the role belongs to
    // dolphin: resolution must follow the declared role.
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: { ...POLY_PROFILE, agents: ["mola", "dolphin"] },
      },
    };

    const { resolveAgent } = await compose(piScope(zoo, MODES_RAW), undefined);

    assert.equal(resolveAgent("sess-main"), "dolphin");
  });

  it("resolves nothing when the profile cannot provide the orchestrator", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, agents: ["beaver", "lynx"] } },
    };

    const { resolveAgent } = await compose(piScope(zoo, MODES_RAW), undefined);

    assert.equal(resolveAgent("sess-main"), undefined);
    assert.equal(piProcess.sessionAgents.resolve("sess-main"), undefined);
  });

  it("resolves a sub-session runtime to its fixed agent", async () => {
    // The inline factory of a delegation fixes the agent, so every session
    // of that runtime answers with it — even before the run reports.
    const { resolveAgent } = await compose(piScope(POLY_ZOO, MODES_RAW), {
      fixedAgent: "beaver",
    });

    assert.equal(resolveAgent("sess-child"), "beaver");
  });
});

describe("startPi — registerTool wiring", () => {
  it("registers compress and decompress with pi when the profile enables them", async () => {
    const api = mockApi();
    await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any);
    const toolNames = api.tools.map((tool: any) => tool.name);
    assert.deepEqual(toolNames.sort(), ["compress", "decompress"]);
  });

  it("sets label to the tool name and wraps parameters in an object schema", async () => {
    const api = mockApi();
    await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any);
    const compress = api.tools.find((tool: any) => tool.name === "compress");
    assert.ok(compress);
    assert.equal((compress as any).label, "compress");
    assert.equal((compress as any).parameters.type, "object");
    assert.deepEqual((compress as any).parameters.required, ["ranges"]);
    assert.ok((compress as any).parameters.properties.ranges);
  });

  it("bridged compress schema accepts what validateCompressArgs accepts", async () => {
    const api = mockApi();
    await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any);
    const compress = api.tools.find((tool: any) => tool.name === "compress") as
      | {
          parameters: {
            properties: Record<string, unknown>;
            required: string[];
          };
        }
      | undefined;
    assert.ok(compress);

    // Valid input must satisfy both the bridged schema and the tool's own
    // validator.
    const validArgs = {
      ranges: [
        {
          fromRef: "m2",
          toRef: "m3",
          title: "summary",
          summary: "body",
        },
      ],
    };
    assert.doesNotThrow(() => validateCompressArgs(validArgs));
    assert.ok(
      compress.parameters.required.includes("ranges"),
      "schema must require ranges",
    );
    assert.ok(
      "ranges" in compress.parameters.properties,
      "schema must declare ranges",
    );

    // Malformed input is rejected by validateCompressArgs and is missing
    // the required ranges field.
    assert.throws(() => validateCompressArgs({}));
    assert.equal(
      (compress.parameters.required as string[]).includes("ranges"),
      true,
    );
  });

  it("execute wrapper delegates to the contribution and propagates errors", async () => {
    const api = mockApi();
    await startInstance(
      piScope(
        {
          mode: {
            poly: {
              ...POLY_PROFILE,
              tools: ["decompress"],
              hooks: POLY_PROFILE.hooks.filter((h) => h !== "context-pruning"),
            },
          },
        },
        MODES_RAW,
      ),
      api as any,
    );
    const decompress = api.tools.find(
      (tool: any) => tool.name === "decompress",
    );
    assert.ok(decompress);

    // Missing blockId is rejected by the tool's own validator; the pi
    // execute wrapper does not swallow tool errors.
    await assert.rejects(
      async () =>
        (decompress as any).execute("call-1", {}, undefined, undefined, {
          sessionManager: { getSessionId: () => "sess-decompress" },
        }),
      /blockId/,
    );
  });

  it("merges a contribution's details into the bridge's own, never over it", async () => {
    // The terminal details carry the bridge's fact pointer (the run's
    // sub-session path); a contribution's write-back slot is merged INTO it,
    // so a tool payload adds keys (ask's `questions`) but can never displace
    // `sessionPath`.
    piProcess.runs.start({
      id: "call-ask",
      agent: "beaver",
      parentSession: "sess-1",
    });
    piProcess.runs.update("call-ask", { sessionPath: "/tmp/ask-run.jsonl" });
    const api = mockApi();
    await startInstance(
      piScope(
        { mode: { poly: { ...POLY_PROFILE, tools: ["ask"] } } },
        MODES_RAW,
      ),
      api as any,
    );
    const ask = api.tools.find((tool: any) => tool.name === "ask") as
      | { execute: (...args: unknown[]) => Promise<unknown> }
      | undefined;
    assert.ok(ask, "the pi host must register the ask tool");
    // No TUI in the fake context, so the form short-circuits to `no-ui`
    // while still handing back its structured per-question payload.
    const result = (await ask.execute(
      "call-ask",
      { questions: [{ question: "One?", options: [{ label: "A1" }] }] },
      undefined,
      undefined,
      {
        sessionManager: { getSessionId: () => "sess-ask" },
        mode: "print",
      },
    )) as { details?: Record<string, unknown> };
    assert.equal(result.details?.sessionPath, "/tmp/ask-run.jsonl");
    assert.ok(
      Array.isArray(result.details?.questions),
      "the tool's payload must survive the merge",
    );
  });

  it("registers the subagent tool when the profile lists it and a driver is wired", async () => {
    const api = mockApi();
    api.activeTools.push("bash", "edit", "subagent", "compress", "decompress");
    await startInstance(
      piScope(
        {
          mode: {
            poly: {
              ...POLY_PROFILE,
              tools: ["compress", "decompress", "subagent"],
            },
          },
        },
        MODES_RAW,
      ),
      api as any,
    );
    const names = api.tools.map((tool: any) => tool.name).sort();
    assert.deepEqual(names, ["compress", "decompress", "subagent"]);
    // The registered subagent tool forwards the pi signal into its execute
    // bridge: the registered handler receives (callId, params, signal, ...).
    const subagent = api.tools.find((tool: any) => tool.name === "subagent");
    assert.ok(subagent, "subagent tool must be registered");
    assert.equal(typeof (subagent as any).execute, "function");
    // The registration boundary installs pi's TUI card renderers by tool
    // name: the subagent transcript card draws from the structured
    // progress details, and every other tool registers without one.
    assert.equal(typeof (subagent as any).renderCall, "function");
    assert.equal(typeof (subagent as any).renderResult, "function");
    for (const name of ["compress", "decompress"]) {
      const plain = api.tools.find((tool: any) => tool.name === name) as any;
      assert.equal(plain.renderCall, undefined, `${name} gets no renderer`);
      assert.equal(plain.renderResult, undefined, `${name} gets no renderer`);
    }
  });

  it("enforces the composed delegation gate on the tool_call event", async () => {
    // The gate belongs to the path, not the mechanism: pi's native
    // `tool_call` event is the gate's enforcement point (the tool itself
    // never observes the policy).  A refused delegation returns
    // `{ block: true, reason }`, which pi surfaces as an error tool result.
    const api = mockApi();
    api.activeTools.push("bash", "edit", "subagent", "compress", "decompress");
    const handlers = await startInstance(
      piScope(
        {
          mode: {
            poly: {
              ...POLY_PROFILE,
              tools: ["subagent"],
            },
          },
        },
        MODES_RAW,
      ),
      api as any,
    );

    // Caller beaver may only delegate to lynx / spider — mola is blocked
    // by the composed allowlist judge.  The subagent prompt is well-formed so
    // the subagent-prompt judge (the other composed judge) lets it through
    // and the allowlist judge is the one that refuses.
    piProcess.sessionAgents.bind("sess-gate", "beaver");
    const refusal = await handlers.toolCall(
      {
        type: "tool_call",
        toolName: "subagent",
        toolCallId: "call-gate",
        input: {
          agent: "mola",
          description: "实现任务",
          prompt:
            "**SUMMARY:** implement the thing.\n\n" +
            "**CONTEXT:** all the facts needed.\n\n" +
            "**ACCEPTANCE:** verify it.",
        },
      },
      { sessionManager: { getSessionId: () => "sess-gate" } },
    );
    assert.equal(refusal?.block, true, "a refusal must block the call");
    const reason = refusal?.reason ?? "";
    assert.ok(
      reason.includes("can only delegate to"),
      `allowlist reason missing: ${reason}`,
    );
    assert.ok(reason.includes("mola"), "reason must name the target");

    // The refusal is a warn log entry naming the refusing judge.
    const blocked = _getBufferForTesting().filter(
      (e) =>
        e.event === "delegation_blocked" && e.judge === "judgeDelegationTarget",
    );
    assert.equal(blocked.length, 1, "one allowlist refusal expected");
    assert.equal(blocked[0].target, "mola");
    assert.equal(blocked[0].caller, "beaver");
    assert.equal(blocked[0].level, "warn");
    assert.equal(blocked[0].sessionId, "sess-gate");
    // The allowlist judge reports no structured cause, and the gate must
    // not assign one: the field stays absent.
    assert.equal("cause" in blocked[0], false, "no cause on allowlist");
  });

  it("logs the target-role cause for a refused target", async () => {
    // dolphin may delegate anywhere, so only the target's declared role
    // refuses mola; the refusal carries the structured cause.
    const api = mockApi();
    api.activeTools.push("bash", "edit", "subagent", "compress", "decompress");
    const handlers = await startInstance(
      piScope(
        {
          mode: {
            poly: {
              ...POLY_PROFILE,
              tools: ["subagent"],
            },
          },
        },
        MODES_RAW,
      ),
      api as any,
    );

    piProcess.sessionAgents.bind("sess-cause", "dolphin");
    const refusal = await handlers.toolCall(
      {
        type: "tool_call",
        toolName: "subagent",
        toolCallId: "call-cause",
        input: {
          agent: "mola",
          description: "实现任务",
          prompt:
            "**SUMMARY:** implement the thing.\n\n" +
            "**CONTEXT:** all the facts needed.\n\n" +
            "**ACCEPTANCE:** verify it.",
        },
      },
      { sessionManager: { getSessionId: () => "sess-cause" } },
    );
    assert.equal(refusal?.block, true, "a refusal must block the call");

    const blocked = _getBufferForTesting().filter(
      (e) =>
        e.event === "delegation_blocked" && e.judge === "judgeDelegationTarget",
    );
    assert.equal(blocked.length, 1, "one target-role refusal expected");
    assert.equal(blocked[0].target, "mola");
    assert.equal(blocked[0].cause, "not-a-subagent");
  });

  it("forwards the pi signal through the bridge to the tool execute", async () => {
    const api = mockApi();
    api.activeTools.push("bash", "edit", "subagent", "compress", "decompress");
    // The profile enables only the subagent tool.  A fake driver keeps the
    // bridge under test without loading the real pi SDK.  It emits one
    // progress report so the empty-partial repaint path through the bridge
    // is exercised.
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        ctx.onProgress?.({ done: false });
        return { kind: "ok", text: "done" };
      },
    };
    await startInstance(
      piScope(
        {
          mode: {
            poly: {
              ...POLY_PROFILE,
              tools: ["subagent"],
              hooks: [],
            },
          },
        },
        MODES_RAW,
      ),
      api as any,
      { subagentDriver: driver },
    );
    const subagent = api.tools.find((tool: any) => tool.name === "subagent") as
      | { execute: (...args: unknown[]) => Promise<unknown> }
      | undefined;
    assert.ok(subagent);

    const controller = new AbortController();
    // The bridge wraps the tool's string return into pi's result shape and
    // forwards the signal into the tool execute; assert the wrapped shape
    // (a pi tool result with a text part) is returned.  The parent model is
    // NOT forwarded — strict mode reads the agents.json configured model
    // only, never the parent session's model.
    const repaintPartials: unknown[] = [];
    const result = await subagent.execute(
      "call-1",
      { agent: "beaver", description: "实现任务", prompt: "t" },
      controller.signal,
      (partial: unknown) => {
        repaintPartials.push(partial);
      },
      {
        sessionManager: { getSessionId: () => "sess-1" },
        model: { provider: "Dummy", id: "dummy-small" },
      },
    );
    const wrapped = result as { content?: { type?: string; text?: string }[] };
    assert.ok(
      Array.isArray(wrapped.content),
      "bridge must wrap in content parts",
    );
    assert.ok(
      wrapped.content?.some((part) => part.type === "text"),
      "bridge must produce a text part",
    );
    // The empty-partial repaint path is pinned end-to-end: the driver's
    // progress report travels through the bridge's `onUpdate` forwarding
    // (pi's tool-signature slot) and reaches the capturing callback as a
    // content-free repaint signal, not a text channel.
    assert.equal(repaintPartials.length, 1);
    assert.deepEqual(
      repaintPartials[0],
      { content: [] },
      "the bridge must forward the empty repaint partial",
    );
    assert.equal(
      (repaintPartials[0] as { content: unknown[] }).content.length,
      0,
      "the repaint partial must carry no text",
    );
  });
});

// ---------------------------------------------------------------------------
// Command registration wiring
// ---------------------------------------------------------------------------

describe("startPi — registerCommand wiring", () => {
  it("registers composed commands with pi when the profile enables them", async () => {
    const api = mockApi();
    // rawConfig supplies the `[agent.*].mode` table, so the switch unit
    // derives the primaries (dolphin, mola) and contributes a command
    // per primary alongside go/dcp — names are config-derived.
    await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any);
    const names = api.commands.map((c) => c.name).sort();
    assert.deepEqual(names, ["dcp", "dolphin", "go", "mola"]);
  });

  it("preserves description and a handler on each registration", async () => {
    const api = mockApi();
    await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any);
    const dcp = api.commands.find((c) => c.name === "dcp");
    assert.ok(dcp, "dcp must be registered");
    assert.equal(dcp.description, "显示上下文用量与缓存命中率");
    assert.equal(typeof dcp.handler, "function");
  });

  it("null profile registers no commands (fail-closed)", async () => {
    const api = mockApi();
    await startInstance(piScope({}), api as any);
    assert.deepEqual(api.commands, []);
  });

  it("commands registered for a profile without commands list stay empty", async () => {
    const api = mockApi();
    await startInstance(
      piScope(
        {
          mode: {
            poly: { ...POLY_PROFILE, commands: [] },
          },
        },
        MODES_RAW,
      ),
      api as any,
    );
    assert.deepEqual(api.commands, []);
  });

  it("/dcp context appends a zoo-notice custom entry (persistent, no LLM context)", async () => {
    const api = mockApi();
    const runtime = createContextRuntime();
    await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any, {
      contextRuntime: runtime,
    });
    const dcp = api.commands.find((c) => c.name === "dcp");
    assert.ok(dcp && typeof dcp.handler === "function");

    // pi offers no host history read, so /dcp reports over the round view
    // published by the context transform — the projection the model holds.
    runtime.publishRoundView("sess-dcp", {
      projection: project(
        [
          {
            role: "user",
            hidden: false,
            regions: [{ kind: "content", get: () => "hi" }],
          },
        ],
        [],
      ),
      numbered: [],
    });
    const ctx = {
      sessionManager: {
        getSessionId: () => "sess-dcp",
      },
    };
    try {
      await (dcp.handler as (args: string, ctx: unknown) => Promise<void>)(
        "context",
        ctx,
      );
    } finally {
      runtime.clearRoundView("sess-dcp");
    }

    assert.ok(
      api.appendedEntries.length >= 1,
      "dcp must append a custom entry",
    );
    const entry = api.appendedEntries.find(
      (e) => e.customType === "zoo-notice",
    );
    assert.ok(entry, "dcp report must go through the zoo-notice custom entry");
    assert.equal(typeof (entry.data as any)?.content, "string");
    assert.ok(String((entry.data as any)?.content).includes("上下文报告"));
  });

  it("/dcp errors route through notifySessionError into appendEntry", async () => {
    const api = mockApi();
    await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any);
    const dcp = api.commands.find((c) => c.name === "dcp");
    assert.ok(dcp && typeof dcp.handler === "function");

    // pi's tool host exposes no history read and no round view is
    // published, so `/dcp context` fails to resolve its source; the
    // handler surfaces the failure through notifySessionError →
    // appendEntry.
    await (dcp.handler as (args: string, ctx: unknown) => Promise<void>)(
      "context",
      { sessionManager: { getSessionId: () => "sess-dcp" } },
    );

    const entry = api.appendedEntries.find(
      (e) => e.customType === "zoo-notice",
    );
    assert.ok(entry, "dcp error must be surfaced via appendEntry");
    assert.ok(
      String((entry.data as any)?.content).includes("无法获取会话消息"),
    );
  });

  it("/go hands the plan off to the orchestrator the selection resolved", async () => {
    const api = mockApi();
    const dir = makeTmpDir("zoo-pi-go-handoff");
    writePlanFile(
      dir,
      "demo-plan.md",
      {
        status: "planning-done",
        slug: "demo-plan",
      },
      "body",
    );
    const sessions: any[] = [];
    try {
      await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any, {
        directory: dir,
      });
      const go = api.commands.find((c) => c.name === "go");
      assert.ok(go && typeof go.handler === "function");

      // The planning session runs as another primary: the handoff must
      // bind the replaced session to the selection's orchestrator, not keep
      // this one.
      piProcess.sessionAgents.bind("sess-go", "mola");
      await (go.handler as (args: string, ctx: unknown) => Promise<void>)("", {
        sessionManager: { getSessionId: () => "sess-go" },
        newSession: async (options: any) => {
          sessions.push(options);
          await options?.withSession?.({ sendUserMessage: async () => {} });
          return { cancelled: false };
        },
      });

      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].parentSession, "sess-go");
      // The parentage session carries the executor the handoff resolved,
      // and the replacement's own start claims it before binding.
      assert.equal(piProcess.sessionAgents.resolve("sess-go"), "dolphin");
      assert.equal(
        piProcess.switchOps.claim("sess-dolphin", {
          reason: "new",
          parentSession: "sess-go",
        }),
        "dolphin",
      );
      assert.ok(
        fs
          .readFileSync(join(dir, ".zoo/plans/demo-plan.md"), "utf-8")
          .includes("status: executing"),
      );
    } finally {
      cleanupPlanDir(dir);
    }
  });

  it("registers tools over the unified host; registration itself appends nothing", async () => {
    // The single pi tool host serves both tools and commands with the
    // same appendEntry-backed notify (`zoo-notice`) — one unified
    // in-session channel.  Registering a tool is side-effect free —
    // entries only appear once the tool actually executes and notifies.
    const api = mockApi();
    await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any);

    const compress = api.tools.find((t: any) => t.name === "compress");
    assert.ok(compress, "compress tool must be registered");
    assert.equal(api.appendedEntries.length, 0, "no custom entry appended yet");
  });

  it("registers a zoo-notice entry renderer with pi", async () => {
    const api = mockApi();
    await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any);
    const renderer = api.renderers.find((r) => r.customType === "zoo-notice");
    assert.ok(renderer, "zoo-notice entry renderer must be registered");
    assert.equal(typeof renderer.renderer, "function");
  });

  it("registers the zoo-notice renderer even without dcp enabled", async () => {
    // The renderer is unconditional: every in-session notification is a
    // zoo-notice entry, so a profile that enables no /dcp command still
    // needs the renderer.
    const api = mockApi();
    await startInstance(
      piScope(
        {
          mode: {
            poly: { ...POLY_PROFILE, commands: [] },
          },
        },
        MODES_RAW,
      ),
      api as any,
    );
    assert.ok(
      api.renderers.some(
        (r) =>
          r.customType === "zoo-notice" && typeof r.renderer === "function",
      ),
      "zoo-notice renderer must be registered even without /dcp",
    );
  });

  it("non-null profile with dcp enabled still registers the renderer", async () => {
    // A profile that registers dcp (but no other command) must register
    // the zoo-notice entry renderer so reports draw a card in the TUI.
    const api = mockApi();
    await startInstance(
      piScope(
        {
          mode: {
            poly: { ...POLY_PROFILE, commands: ["dcp"] },
          },
        },
        MODES_RAW,
      ),
      api as any,
    );
    const renderer = api.renderers.find((r) => r.customType === "zoo-notice");
    assert.ok(renderer, "zoo-notice entry renderer must be registered");
    assert.equal(typeof renderer.renderer, "function");
  });

  it("null profile still registers the zoo-notice renderer when the API supports it", async () => {
    // The renderer is a pure UI helper for any zoo-notice entry: it is
    // registered regardless of the profile (a null profile merely yields
    // no notifications to render).
    const api = mockApi();
    await startInstance(piScope({}), api as any);
    assert.ok(
      api.renderers.some(
        (r) =>
          r.customType === "zoo-notice" && typeof r.renderer === "function",
      ),
      "zoo-notice renderer must be registered for a null profile",
    );
  });
});

// ---------------------------------------------------------------------------
// Primary-switch command wiring
// ---------------------------------------------------------------------------

describe("startPi — primary-switch command wiring", () => {
  /**
   * A command ctx with the session manager + a ui surface for setWidget
   * and a `newSession` that simulates pi replacing the session and
   * running pi.ts's `newSession` wrapper's `withSession` callback against
   * the fresh `ReplacedSessionContext` (whose `ui.setWidget` forwards to
   * the recording callback).  The wrapper builds the
   * `SwitchNewSessionOps` facade: `setWidget` binds to the fresh ui
   * immediately; the tool trim is stashed into the module-level pending
   * slot and applied when the new session's first `before_agent_start`
   * drains it.
   */
  function switchCtx(
    setWidget: (key: string, content: string[] | undefined) => void = () => {},
  ): {
    sessionManager: { getSessionId(): string };
    ui: {
      notify(): void;
      setWidget(
        key: string,
        content: string[] | undefined,
        options?: { placement?: "aboveEditor" | "belowEditor" },
      ): void;
    };
    newSession(options?: {
      parentSession?: string;
      withSession?: (newCtx: unknown) => void | Promise<void>;
    }): Promise<{ cancelled: boolean }>;
  } {
    return {
      sessionManager: { getSessionId: () => "sess-switch" },
      ui: { notify: () => {}, setWidget },
      async newSession(options) {
        // pi passes the fresh ReplacedSessionContext to withSession.
        await options?.withSession?.({
          ui: { setWidget },
          sessionManager: { getSessionId: () => "sess-new" },
        });
        return { cancelled: false };
      },
    };
  }

  /**
   * Record every deferred switch trim this process takes.
   *
   * The queued trim reaches the host writer only through the pending-slot
   * drain of the session that claimed it, so the record tells which session
   * took the trim and what it carried.
   *
   * @returns The drain records, in call order.
   */
  function recordSwitchDrains(): Array<{
    sessionID: string;
    tools: string[] | undefined;
  }> {
    const records: Array<{ sessionID: string; tools: string[] | undefined }> =
      [];
    const store = piProcess.switchOps;
    const drain = store.drain.bind(store);
    store.drain = (sessionID) => {
      const tools = drain(sessionID);
      records.push({ sessionID, tools });
      return tools;
    };
    return records;
  }

  it("registers one /<agent> command per configured primary", async () => {
    const api = mockApi();
    await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any);
    const switchNames = api.commands
      .map((c) => c.name)
      .filter((n) => ["dolphin", "mola"].includes(n))
      .sort();
    assert.deepEqual(switchNames, ["dolphin", "mola"]);
  });

  it("switch command replaces the session: trims denied tools and nudges the fleet widget", async () => {
    const api = mockApi();
    api.activeTools.push("webfetch", "edit", "bash");
    const handlers = await startInstance(
      piScope(POLY_ZOO, {
        ...MODES_RAW,
        agent: {
          ...MODES_RAW.agent,
          dolphin: {
            mode: "primary",
            permission: { webfetch: "deny", websearch: "deny", bash: {} },
          },
        },
      }),
      api as any,
    );
    const dolphin = api.commands.find((c) => c.name === "dolphin");
    assert.ok(dolphin && typeof dolphin.handler === "function");

    // The replacement session starts as mola, then switches to dolphin.
    piProcess.sessionAgents.bind("sess-switch", "mola");

    // The switch command's `setWidget("zoo", ...)` is a "primary changed"
    // notification routed to the fleet widget (it reads the session's
    // primary), so the mock ui never receives a string-array widget for zoo.
    await (dolphin.handler as (args: string, ctx: unknown) => Promise<void>)(
      "",
      switchCtx(() => {}),
    );

    // The replacement session's bind-time handlers run before its first
    // turn and resolve the target the switch published, so the widget it
    // registers already renders the new primary.
    const { calls, ctx } = widgetRecordingCtx("sess-new", "sess-switch");
    await handlers.sessionStart({ type: "session_start", reason: "new" }, ctx);
    assert.equal(piProcess.sessionAgents.resolve("sess-new"), "dolphin");
    const { lines, dispose } = renderZooWidget(calls);
    assert.ok(lines[0].includes("dolphin"), lines[0]);
    assert.ok(!lines[0].includes("mola"), lines[0]);
    dispose();

    // The tool trim was queued (pi's replaced-session context cannot
    // reach it); the new session's first before_agent_start drains the
    // pending ops with the fresh (non-stale) API.  No confirmation entry
    // is appended: the widget already shows the active primary.
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      { sessionManager: { getSessionId: () => "sess-new" } },
    );
    // Tool-level deny (webfetch) removed; bash (fine-grained sub-table)
    // kept in the active set.
    assert.deepEqual(api.activeTools, ["edit", "bash"]);
  });

  it("resources_discover of the replacement session filters by the switch target", async () => {
    // The replacement session's skill contribution runs at bind time, so the
    // target the switch published must already answer there.
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, {
        agent: {
          dolphin: {
            mode: "primary",
            permission: { skill: { "*": "deny", "git-commit": "allow" } },
          },
          mola: {
            mode: "primary",
            permission: { skill: { "*": "deny", grill: "allow" } },
          },
        },
      }),
      api as any,
    );
    const mola = api.commands.find((c) => c.name === "mola");
    assert.ok(mola && typeof mola.handler === "function");
    piProcess.sessionAgents.bind("sess-switch", "dolphin");

    await (mola.handler as (args: string, ctx: unknown) => Promise<void>)(
      "",
      switchCtx(() => {}),
    );

    // The start of the session pi created for the switch claims the target,
    // so the bind-time skill filter runs as mola.
    await handlers.sessionStart(
      { type: "session_start", reason: "new" },
      startCtx("sess-new", "sess-switch"),
    );
    const resources = await handlers.resourcesDiscover(undefined, {
      sessionManager: { getSessionId: () => "sess-new" },
    });
    assert.ok(resources);
    assert.deepEqual(
      resources.skillPaths.map((path) => path.split("/").pop()),
      ["grill"],
    );
  });

  it("the deferred switch trim follows the ask visibility rule", async () => {
    const api = mockApi();
    const writes: string[][] = [];
    const set = api.setActiveTools.bind(api);
    api.setActiveTools = (names: string[]) => {
      writes.push([...names]);
      set(names);
    };
    const drains = recordSwitchDrains();
    // The host configuration activated ask; the session that drains the
    // queued trim cannot ask.
    api.activeTools.push("bash", "ask");
    const handlers = await startInstance(
      piScope(
        { mode: { poly: { ...POLY_PROFILE, tools: ["compress", "ask"] } } },
        MODES_RAW,
      ),
      api as any,
    );
    const target = api.commands.find((c) => c.name === "dolphin");
    assert.ok(target && typeof target.handler === "function");
    piProcess.sessionAgents.bind("sess-switch", "mola");

    await (target.handler as (args: string, ctx: unknown) => Promise<void>)(
      "",
      switchCtx(() => {}),
    );
    // The replacement's own start claims the queued trim.  That start can
    // ask, so its bind-time apply keeps ask and the trim stays queued for
    // the drain below.
    await handlers.sessionStart(
      { type: "session_start", reason: "new" },
      {
        ...startCtx("sess-new", "sess-switch"),
        mode: "tui",
        ui: { custom() {} },
      },
    );
    assert.deepEqual(writes, [], "the bind-time apply keeps the live set");

    // The first turn of the replacement session drains the queued trim with
    // a context that cannot ask, so the write under test is the drain's.
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      { sessionManager: { getSessionId: () => "sess-new" }, mode: "print" },
    );

    assert.deepEqual(
      drains,
      [{ sessionID: "sess-new", tools: ["bash", "ask"] }],
      "the claim must hand the deferred trim to the session's drain",
    );
    assert.deepEqual(api.activeTools, ["bash"]);
    assert.deepEqual(
      writes,
      [["bash"]],
      "the drain writes the ask-trimmed set exactly once",
    );
  });

  it("the deferred switch trim keeps the target's ask deny", async () => {
    const api = mockApi();
    const writes: string[][] = [];
    const set = api.setActiveTools.bind(api);
    api.setActiveTools = (names: string[]) => {
      writes.push([...names]);
      set(names);
    };
    const drains = recordSwitchDrains();
    // The replacement session can ask, and its primary denies ask.
    api.activeTools.push("bash", "edit", "ask");
    const handlers = await startInstance(
      piScope(
        { mode: { poly: { ...POLY_PROFILE, tools: ["compress", "ask"] } } },
        {
          agent: {
            ...MODES_RAW.agent,
            dolphin: { mode: "primary", permission: { ask: "deny" } },
          },
        },
      ),
      api as any,
    );
    const target = api.commands.find((c) => c.name === "dolphin");
    assert.ok(target && typeof target.handler === "function");
    piProcess.sessionAgents.bind("sess-switch", "mola");

    await (target.handler as (args: string, ctx: unknown) => Promise<void>)(
      "",
      switchCtx(() => {}),
    );
    // The replacement's own start claims the queued trim; its primary
    // already denies ask, so the stashed trim carries no ask tool.
    await handlers.sessionStart(
      { type: "session_start", reason: "new" },
      {
        ...startCtx("sess-new", "sess-switch"),
        mode: "tui",
        ui: { custom() {} },
      },
    );
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      askCtx(true, "sess-new"),
    );

    assert.deepEqual(
      drains,
      [{ sessionID: "sess-new", tools: ["bash", "edit"] }],
      "the claim must hand the deferred trim to the session's drain",
    );
    assert.deepEqual(api.activeTools, ["bash", "edit"]);
    for (const write of writes) {
      assert.ok(!write.includes("ask"), `a write kept ask: ${write}`);
    }
  });

  it("no agent-role table → invalid profile → no switch commands", async () => {
    // Without the role table no primary (and therefore no orchestrator)
    // resolves, so the profile is invalid and contributes no command.
    const api = mockApi();
    await startInstance(piScope(POLY_ZOO), api as any);
    const switchNames = api.commands
      .map((c) => c.name)
      .filter((n) => ["dolphin", "mola"].includes(n));
    assert.deepEqual(switchNames, []);
    assert.deepEqual(api.commands, []);
  });
});

// ---------------------------------------------------------------------------
// Switch replacement claim
// ---------------------------------------------------------------------------

/**
 * A `session_start` context reporting the session pi started and the session
 * it replaces.
 *
 * pi records the replaced session on the new session's header, so a start
 * that carries no parent (`/new`) or another reason is not the replacement.
 *
 * @param sessionID - The session this start names.
 * @param parentSession - The replaced session, or undefined for a plain new
 *   session.
 * @returns The duck-typed pi event context.
 */
function startCtx(
  sessionID: string,
  parentSession?: string,
): {
  sessionManager: {
    getSessionId(): string;
    getHeader(): { parentSession?: string };
  };
} {
  return {
    sessionManager: {
      getSessionId: () => sessionID,
      getHeader: () => ({ parentSession }),
    },
  };
}

describe("startPi — switch replacement claim", () => {
  it("an unrelated session_start never takes the pending switch target", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    // A switch published its target and awaits its own replacement.
    piProcess.switchOps.begin("sess-old");
    piProcess.switchOps.stash({ primary: "mola" });

    // A reload / resume / startup of another session binds nothing new.
    await handlers.sessionStart(
      { type: "session_start", reason: "reload" },
      startCtx("sess-other"),
    );

    assert.equal(piProcess.sessionAgents.resolve("sess-other"), "dolphin");
    // The replacement target still waits for its own session.
    assert.equal(
      piProcess.switchOps.claim("sess-new", {
        reason: "new",
        parentSession: "sess-old",
      }),
      "mola",
    );
  });

  it("a plain /new session never takes the pending switch target", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    piProcess.switchOps.begin("sess-old");
    piProcess.switchOps.stash({ primary: "mola" });

    // pi's own `/new` passes no parent session, so its start carries none.
    await handlers.sessionStart(
      { type: "session_start", reason: "new" },
      startCtx("sess-plain"),
    );

    assert.equal(piProcess.sessionAgents.resolve("sess-plain"), "dolphin");
    assert.equal(
      piProcess.switchOps.claim("sess-new", {
        reason: "new",
        parentSession: "sess-old",
      }),
      "mola",
    );
  });

  it("carries the target into a second runtime of the same process", async () => {
    const api = mockApi();
    const oldRuntime = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const mola = oldRuntime.commands.find((c) => c.name === "mola");
    assert.ok(mola && typeof mola.handler === "function");
    piProcess.sessionAgents.bind("sess-old", "dolphin");
    await (mola.handler as (args: string, ctx: unknown) => Promise<void>)("", {
      sessionManager: { getSessionId: () => "sess-old" },
      ui: { notify: () => {}, setWidget: () => {} },
      newSession: async (options?: {
        withSession?: (newCtx: unknown) => void | Promise<void>;
      }) => {
        await options?.withSession?.({
          ui: { setWidget: () => {} },
          sessionManager: { getSessionId: () => "sess-new" },
        });
        return { cancelled: false };
      },
    });
    // The runtime that handled the switch keeps only the published target:
    // nothing resolves the new session yet.
    assert.equal(piProcess.sessionAgents.resolve("sess-new"), undefined);

    // pi re-ran the factory: the second runtime's handlers own the new
    // session's bind-time events.
    const fresh = await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any);
    await fresh.sessionStart(
      { type: "session_start", reason: "new" },
      startCtx("sess-new", "sess-old"),
    );

    assert.equal(piProcess.sessionAgents.resolve("sess-new"), "mola");
    assert.equal(
      piProcess.switchOps.claim("sess-again", {
        reason: "new",
        parentSession: "sess-old",
      }),
      undefined,
      "the claimed replacement is spent",
    );
  });

  it("a failed switch command leaks nothing to the next session", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const mola = api.commands.find((c) => c.name === "mola");
    assert.ok(mola && typeof mola.handler === "function");
    // The session runs as dolphin (the orchestrator) and switches to mola;
    // pi fails the replacement, so no session was created.
    piProcess.sessionAgents.bind("sess-switch", "dolphin");

    await (mola.handler as (args: string, ctx: unknown) => Promise<void>)("", {
      sessionManager: { getSessionId: () => "sess-switch" },
      ui: { notify: () => {}, setWidget: () => {} },
      newSession: async () => {
        throw new Error("boom");
      },
    });

    // The command reported the failure, restored the surviving session's
    // primary and dropped the target it published.
    assert.equal(piProcess.sessionAgents.resolve("sess-switch"), "dolphin");
    assert.equal(
      piProcess.switchOps.claim("sess-later", {
        reason: "new",
        parentSession: "sess-switch",
      }),
      undefined,
      "the failed switch left no target to claim",
    );

    // A later session start — even one parented to the session that failed
    // to switch — never inherits the failed target.
    await handlers.sessionStart(
      { type: "session_start", reason: "new" },
      startCtx("sess-later", "sess-switch"),
    );
    assert.equal(piProcess.sessionAgents.resolve("sess-later"), "dolphin");
  });

  it("a reload of the replacement keeps its claimed target", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    piProcess.switchOps.begin("sess-old");
    piProcess.switchOps.stash({ primary: "mola" });
    await handlers.sessionStart(
      { type: "session_start", reason: "new" },
      startCtx("sess-new", "sess-old"),
    );

    // pi replays `session_start` on a reload: the claim is spent, but the
    // binding it wrote answers the session from then on.
    await handlers.sessionStart(
      { type: "session_start", reason: "reload" },
      startCtx("sess-new", undefined),
    );

    assert.equal(piProcess.sessionAgents.resolve("sess-new"), "mola");
  });

  it("the replacement session_start binds the published target", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    piProcess.switchOps.begin("sess-old");
    piProcess.switchOps.stash({ primary: "mola" });

    // The replacement pi created for `sess-old` starts with reason "new"
    // and records `sess-old` as its parent.
    await handlers.sessionStart(
      { type: "session_start", reason: "new" },
      startCtx("sess-new", "sess-old"),
    );

    assert.equal(piProcess.sessionAgents.resolve("sess-new"), "mola");
    assert.equal(
      piProcess.switchOps.claim("sess-again", {
        reason: "new",
        parentSession: "sess-old",
      }),
      undefined,
      "the claimed target leaves no pending state behind",
    );
  });
});

// ---------------------------------------------------------------------------
// Primary tool-deny trim (main session)
// ---------------------------------------------------------------------------

/**
 * Per-agent tool-level denies used by the main-session trim tests.
 *
 * dolphin (the profile's default primary) denies `websearch` but NOT
 * `fetch` — mirroring the config.toml decision that dolphin may fetch.
 * beaver denies `fetch`, so a beaver-driven session must lose it.
 */
const PERM_DENY_RAW = {
  agent: {
    ...MODES_RAW.agent,
    dolphin: { mode: "primary", permission: { websearch: "deny" } },
    beaver: { mode: "primary", permission: { fetch: "deny" } },
  },
};

describe("startPi — primary tool-deny trim (main session)", () => {
  /** A reference tool set carrying the fetch tool the deny tests target. */
  const ALL_TOOLS = ["fetch", "edit", "bash"];

  /** Bind the session under test, so the trim has a primary to read. */
  function bindSession(name: string): void {
    piProcess.sessionAgents.bind("sess-1", name);
  }

  it("trims a beaver-primary session's fetch at session start", async () => {
    const api = mockApi();
    api.activeTools.push(...ALL_TOOLS);
    const handlers = await startInstance(
      piScope(POLY_ZOO, PERM_DENY_RAW),
      api as any,
    );
    bindSession("beaver");
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      SESSION_CTX,
    );
    assert.deepEqual(api.activeTools, ["edit", "bash"]);
  });

  it("keeps fetch for a dolphin session (dolphin denies websearch only)", async () => {
    const api = mockApi();
    api.activeTools.push(...ALL_TOOLS);
    const handlers = await startInstance(
      piScope(POLY_ZOO, PERM_DENY_RAW),
      api as any,
    );
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      SESSION_CTX,
    );
    assert.deepEqual(api.activeTools, ALL_TOOLS);
  });

  it("applies the trim from before_agent_start (fallback) and is idempotent", async () => {
    const api = mockApi();
    api.activeTools.push(...ALL_TOOLS);
    const handlers = await startInstance(
      piScope(POLY_ZOO, PERM_DENY_RAW),
      api as any,
    );
    bindSession("beaver");
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      SESSION_CTX,
    );
    assert.deepEqual(api.activeTools, ["edit", "bash"]);
    // Repeated calls filter the FIXED baseline, so denies never accumulate.
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      SESSION_CTX,
    );
    assert.deepEqual(api.activeTools, ["edit", "bash"]);
  });

  it("restores fetch when switching from beaver back to dolphin", async () => {
    const api = mockApi();
    api.activeTools.push(...ALL_TOOLS);
    const handlers = await startInstance(
      piScope(POLY_ZOO, PERM_DENY_RAW),
      api as any,
    );
    bindSession("beaver");
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      SESSION_CTX,
    );
    assert.deepEqual(api.activeTools, ["edit", "bash"]);
    bindSession("dolphin");
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      SESSION_CTX,
    );
    assert.deepEqual(api.activeTools, ALL_TOOLS);
  });

  it("does not trim a subagent session's tool face", async () => {
    // The driver already restricts a child session's tools via the
    // capability allowlist; the primary denies are not its identity.
    const api = mockApi();
    api.activeTools.push(...ALL_TOOLS);
    const { publication: handlers } = await startPiRuntime(
      piScope(POLY_ZOO, PERM_DENY_RAW),
      api as any,
      undefined,
      piProcess,
      { kind: "subagent", agent: "beaver" },
    );
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      SESSION_CTX,
    );
    assert.deepEqual(api.activeTools, ALL_TOOLS);
  });

  it("computes subagent capabilities from the untrimmed baseline", async () => {
    const api = mockApi();
    api.activeTools.push("fetch", "edit", "bash", "subagent", "ask");
    const requested: string[][] = [];
    const driver: SubagentDriver = {
      async run(request) {
        requested.push(request.tools);
        return { kind: "ok", text: "done" };
      },
    };
    const handlers = await startInstance(
      piScope(
        {
          mode: {
            poly: { ...POLY_PROFILE, tools: ["subagent", "ask"], hooks: [] },
          },
        },
        PERM_DENY_RAW,
      ),
      api as any,
      { subagentDriver: driver },
    );
    bindSession("beaver");
    // The main session trims beaver's fetch, and its own context can ask, so
    // the live face keeps ask.
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      askCtx(true, "sess-1"),
    );
    assert.deepEqual(api.activeTools, ["edit", "bash", "subagent", "ask"]);

    const subagent = api.tools.find((tool: any) => tool.name === "subagent") as
      | { execute: (...args: unknown[]) => Promise<unknown> }
      | undefined;
    assert.ok(subagent);
    await subagent.execute(
      "call-capability",
      { agent: "lynx", description: "调研任务", prompt: "t" },
      undefined,
      undefined,
      askCtx(true, "sess-1"),
    );

    // lynx denies nothing: its face is the untrimmed baseline minus ask.  The
    // caller's fetch deny must not leak, and ask needs a channel a sub-session
    // never has.
    assert.deepEqual(requested[0], ["bash", "edit", "fetch", "subagent"]);
  });

  it("leaves the tool set untouched with no baseline (fail-closed)", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, PERM_DENY_RAW),
      api as any,
    );
    bindSession("beaver");
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      SESSION_CTX,
    );
    assert.deepEqual(api.activeTools, []);
  });

  it("serves no baseline after the extension stopped", async () => {
    const api = mockApi();
    api.activeTools.push(...ALL_TOOLS);
    const handlers = await startInstance(
      piScope(POLY_ZOO, PERM_DENY_RAW),
      api as any,
    );
    bindSession("beaver");
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      SESSION_CTX,
    );
    assert.deepEqual(api.activeTools, ["edit", "bash"], "trimmed at bind");
    await handlers.sessionShutdown(
      { type: "session_shutdown", reason: "quit" },
      SESSION_CTX,
    );

    // The host re-registers its tools for the replacement runtime.  The
    // stopped extension must not filter that set through a baseline it
    // captured earlier: a stale cache would silently remove the new tools.
    api.activeTools.push("fetch");
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      SESSION_CTX,
    );

    assert.deepEqual(api.activeTools, ["edit", "bash", "fetch"]);
  });

  it("/go handoff: the executor primary's deny is trimmed in the new session", async () => {
    const api = mockApi();
    api.activeTools.push(...ALL_TOOLS);
    const handlers = await startInstance(
      piScope(POLY_ZOO, PERM_DENY_RAW),
      api as any,
    );
    piProcess.sessionAgents.bind("sess-go", "dolphin");
    // The /go handoff binds the replaced session to the executor (beaver)
    // and publishes it for the replacement session; the generic trim in the
    // new session's bind-time handler then removes beaver's deny.
    const target = createPiHandoffTarget({
      getCommandCtx: () => ({
        newSession: async (options) => {
          await options?.withSession?.({ sendUserMessage: async () => {} });
          return { cancelled: false };
        },
      }),
      identity: createPiHandoffIdentity(piProcess),
    });
    const session = await target.create({
      parentage: "sess-go",
      title: "t",
      agent: "beaver",
    });
    await target.installAgent(session);
    await target.deliver(session, "plan ref");
    assert.equal(piProcess.sessionAgents.resolve("sess-go"), "beaver");
    await handlers.sessionStart(
      { type: "session_start", reason: "new" },
      startCtx("sess-1", "sess-go"),
    );
    assert.deepEqual(api.activeTools, ["edit", "bash"]);
  });
});

// ---------------------------------------------------------------------------
// Ask tool visibility
// ---------------------------------------------------------------------------

/**
 * The poly profile plus the ask tool.
 *
 * The ask unit contributes its tool only on pi (the question-channel
 * provider is present), so this profile is what the visibility rule acts
 * on.
 */
const ASK_ZOO = {
  mode: { poly: { ...POLY_PROFILE, tools: ["compress", "ask"] } },
};

/**
 * A pi tool context naming one session.
 *
 * `tui` supplies the mode and the custom-component surface the question
 * channel needs; without them the host cannot ask.
 */
function askCtx(tui: boolean, sessionID = "sess-ask") {
  const base = { sessionManager: { getSessionId: () => sessionID } };
  return tui
    ? { ...base, mode: "tui", ui: { custom: () => {} } }
    : { ...base, mode: "print" };
}

describe("startPi — ask tool visibility", () => {
  /** The host double, also recording every active-tool write. */
  function recordingApi() {
    const api = mockApi();
    const writes: string[][] = [];
    const set = api.setActiveTools.bind(api);
    api.setActiveTools = (names: string[]) => {
      writes.push([...names]);
      set(names);
    };
    return { api, writes };
  }

  it("registers ask inactive and leaves the other tools at pi's default", async () => {
    const { api } = recordingApi();
    await startInstance(piScope(ASK_ZOO, MODES_RAW), api as any);

    const ask = api.tools.find((tool: any) => tool.name === "ask") as
      | { defaultActive?: boolean }
      | undefined;
    assert.ok(ask, "the pi host registers ask");
    assert.equal(ask.defaultActive, false);
    const compress = api.tools.find((tool: any) => tool.name === "compress") as
      | { defaultActive?: boolean }
      | undefined;
    assert.ok(compress);
    assert.equal(compress.defaultActive, undefined);
  });

  it("activates ask at session start when the session can ask", async () => {
    const { api } = recordingApi();
    api.activeTools.push("bash", "edit");
    const handlers = await startInstance(
      piScope(ASK_ZOO, MODES_RAW),
      api as any,
    );

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      askCtx(true),
    );

    assert.deepEqual(api.activeTools, ["bash", "edit", "ask"]);
  });

  it("removes ask at session start when the session cannot ask", async () => {
    const { api, writes } = recordingApi();
    // The host configuration activated ask, and no session binds it back.
    api.activeTools.push("bash", "ask");
    const handlers = await startInstance(
      piScope(ASK_ZOO, MODES_RAW),
      api as any,
    );

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      askCtx(false),
    );

    assert.deepEqual(api.activeTools, ["bash"]);
    assert.deepEqual(writes, [["bash"]]);
  });

  it("re-corrects ask on session_tree and before_agent_start", async () => {
    const { api, writes } = recordingApi();
    api.activeTools.push("bash", "edit");
    const handlers = await startInstance(
      piScope(ASK_ZOO, MODES_RAW),
      api as any,
    );

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      askCtx(true),
    );
    assert.deepEqual(api.activeTools, ["bash", "edit", "ask"]);

    await handlers.sessionTree(undefined, askCtx(false));
    assert.deepEqual(api.activeTools, ["bash", "edit"]);

    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      askCtx(true),
    );
    assert.deepEqual(api.activeTools, ["bash", "edit", "ask"]);

    // Each write carries the answer of its own context: ask is visible
    // exactly when that event could ask.
    assert.deepEqual(writes, [
      ["bash", "edit", "ask"],
      ["bash", "edit"],
      ["bash", "edit", "ask"],
    ]);
  });

  it("keeps the primary deny while correcting ask", async () => {
    const { api } = recordingApi();
    api.activeTools.push("fetch", "bash", "ask");
    const handlers = await startInstance(
      piScope(ASK_ZOO, {
        agent: {
          ...MODES_RAW.agent,
          dolphin: { mode: "primary", permission: { fetch: "deny" } },
        },
      }),
      api as any,
    );

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      askCtx(true),
    );

    assert.deepEqual(api.activeTools, ["bash", "ask"]);
  });

  it("keeps ask hidden when the primary denies it and the session can ask", async () => {
    const { api, writes } = recordingApi();
    api.activeTools.push("bash", "edit", "ask");
    const handlers = await startInstance(
      piScope(ASK_ZOO, {
        agent: {
          ...MODES_RAW.agent,
          dolphin: { mode: "primary", permission: { ask: "deny" } },
        },
      }),
      api as any,
    );

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      askCtx(true),
    );

    assert.deepEqual(api.activeTools, ["bash", "edit"]);
    for (const write of writes) {
      assert.ok(!write.includes("ask"), `a write kept ask: ${write}`);
    }
  });

  it("drives visibility and execution from one injected provider", async () => {
    const { api } = recordingApi();
    api.activeTools.push("bash");
    const asked: string[][] = [];
    // A remote-style channel: it answers for a context the local pi
    // provider cannot (no TUI), so a shared provider is the only way both
    // surfaces can agree.
    const channel: QuestionChannel = {
      ask: async (request) => {
        asked.push(request.questions.map((question) => question.question));
        return request.questions.map(() => ({ status: "declined" as const }));
      },
    };
    const handlers = await startInstance(
      piScope(ASK_ZOO, MODES_RAW),
      api as any,
      {
        askQuestionChannel: (hostCtx) =>
          (hostCtx as { remoteAsk?: boolean }).remoteAsk === true
            ? channel
            : undefined,
      },
    );
    const ctx = {
      sessionManager: { getSessionId: () => "sess-ask" },
      remoteAsk: true,
    };

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    assert.deepEqual(api.activeTools, ["bash", ASK_TOOL_NAME]);

    const ask = api.tools.find((tool: any) => tool.name === ASK_TOOL_NAME) as
      | { execute: (...args: unknown[]) => Promise<unknown> }
      | undefined;
    assert.ok(ask, "the pi host registers ask");
    await ask.execute(
      "call-remote",
      { questions: [{ question: "Remote?" }] },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(asked, [["Remote?"]]);
  });

  it("writes only when the resolved active set changes", async () => {
    const { api, writes } = recordingApi();
    api.activeTools.push("bash", "edit");
    const handlers = await startInstance(
      piScope(ASK_ZOO, MODES_RAW),
      api as any,
    );

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      askCtx(true),
    );
    assert.deepEqual(writes, [["bash", "edit", ASK_TOOL_NAME]]);

    // A steady-state event resolves the same set: the host must not be
    // rewritten, because a write rebuilds the system prompt.
    await handlers.sessionTree(undefined, askCtx(true));
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      askCtx(true),
    );
    assert.equal(writes.length, 1, "a steady-state event must not write");

    // A channel change still writes.
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      askCtx(false),
    );
    assert.deepEqual(writes, [
      ["bash", "edit", ASK_TOOL_NAME],
      ["bash", "edit"],
    ]);
  });

  it("corrects ask on the live set when no baseline exists", async () => {
    const { api, writes } = recordingApi();
    const handlers = await startInstance(
      piScope(ASK_ZOO, MODES_RAW),
      api as any,
    );

    // The host reports no active tool, so no baseline exists; the live set
    // is still the truth the ask rule acts on.
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      askCtx(true),
    );
    assert.deepEqual(writes, [[ASK_TOOL_NAME]]);

    // An external configuration activated ask; a session that cannot ask
    // removes it and keeps its other tools.
    api.activeTools.length = 0;
    api.activeTools.push("bash", ASK_TOOL_NAME);
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      askCtx(false),
    );
    assert.deepEqual(api.activeTools, ["bash"]);
    assert.deepEqual(writes, [[ASK_TOOL_NAME], ["bash"]]);
  });

  it("removes an externally activated ask when no primary resolves", async () => {
    const { api, writes } = recordingApi();
    api.activeTools.push("bash", ASK_TOOL_NAME);
    // No agent-role table → the profile resolves no orchestrator, so no
    // session resolves a primary and the permission side answers a deny.
    const handlers = await startInstance(piScope(ASK_ZOO), api as any);

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      askCtx(true),
    );
    assert.deepEqual(api.activeTools, ["bash"]);
    assert.deepEqual(writes, [["bash"]]);
  });

  it("writes by the rule when the host reports no current set", async () => {
    const { api, writes } = recordingApi();
    api.activeTools.push("bash", "edit");
    const handlers = await startInstance(
      piScope(ASK_ZOO, MODES_RAW),
      api as any,
    );

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      askCtx(true),
    );
    assert.deepEqual(writes, [["bash", "edit", ASK_TOOL_NAME]]);

    // A host that stops reporting its active set still receives the rule's
    // answer instead of a skipped write.
    (api as any).getActiveTools = undefined;
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      askCtx(false),
    );
    assert.deepEqual(writes, [
      ["bash", "edit", ASK_TOOL_NAME],
      ["bash", "edit"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Widget seeding on session start
// ---------------------------------------------------------------------------

/**
 * A ui ctx that records setWidget calls (key + content).
 *
 * @param sessionID - The session the context names.
 * @param parentSession - The replaced session pi records on the start, for
 *   a replacement session.
 * @returns The recorded calls and the duck-typed pi context.
 */
function widgetRecordingCtx(
  sessionID = "sess-seed",
  parentSession?: string,
): {
  calls: Array<[string, unknown]>;
  ctx: {
    sessionManager: {
      getSessionId(): string;
      getHeader(): { parentSession?: string };
    };
    ui: {
      notify(): void;
      setWidget(key: string, content: unknown): void;
    };
  };
} {
  const calls: Array<[string, unknown]> = [];
  const ctx = {
    sessionManager: {
      getSessionId: () => sessionID,
      getHeader: () => ({ parentSession }),
    },
    ui: {
      notify: () => {},
      setWidget: (key: string, content: unknown) => calls.push([key, content]),
    },
  };
  return { calls, ctx };
}

/**
 * A per-session ui ctx recording the widget registrations and the live
 * terminal-input subscriptions of exactly that session.
 */
function routableSessionCtx(sessionId: string): {
  calls: Array<[string, unknown]>;
  live(): number;
  ctx: {
    sessionManager: { getSessionId(): string };
    ui: {
      notify(): void;
      setWidget(key: string, content: unknown): void;
      onTerminalInput(): () => void;
    };
  };
} {
  const calls: Array<[string, unknown]> = [];
  let live = 0;
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: () => {},
      setWidget: (key: string, content: unknown) => calls.push([key, content]),
      onTerminalInput: () => {
        live += 1;
        return () => {
          live -= 1;
        };
      },
    },
  };
  return { calls, live: () => live, ctx };
}

/**
 * A ui ctx that records setWidget calls AND captures the terminal-input
 * handler (so tests can drive the fleet widget's keyboard through the pi
 * entry point's `onTerminalInput` wiring end-to-end).  An optional `custom`
 * surface can be supplied to model the pi `ui.custom` overlay opener cached
 * in the shared context holder.
 */
function widgetInputCtx(
  opts: { custom?: (factory: unknown, options: unknown) => unknown } = {},
): {
  calls: Array<[string, unknown]>;
  inputHandler: (data: string) => unknown;
  ctx: {
    sessionManager: { getSessionId(): string };
    ui: {
      notify(): void;
      setWidget(key: string, content: unknown): void;
      onTerminalInput(handler: (data: string) => unknown): () => void;
      custom?: (factory: unknown, options: unknown) => unknown;
    };
  };
} {
  const calls: Array<[string, unknown]> = [];
  let inputHandler: ((data: string) => unknown) | undefined;
  const ctx: {
    sessionManager: { getSessionId(): string };
    ui: {
      notify(): void;
      setWidget(key: string, content: unknown): void;
      onTerminalInput(handler: (data: string) => unknown): () => void;
      custom?: (factory: unknown, options: unknown) => unknown;
    };
  } = {
    sessionManager: { getSessionId: () => "sess-enter" },
    ui: {
      notify: () => {},
      setWidget: (key: string, content: unknown) => calls.push([key, content]),
      onTerminalInput: (handler: (data: string) => unknown) => {
        inputHandler = handler;
        return () => {
          if (inputHandler === handler) inputHandler = undefined;
        };
      },
      ...(opts.custom !== undefined ? { custom: opts.custom } : {}),
    },
  };
  return {
    calls,
    inputHandler: (data: string) => inputHandler?.(data),
    ctx,
  };
}

/**
 * A TUI stub with a focused empty editor component, so the fleet widget's
 * keyboard state machine can be driven (the editor-focus guard requires a
 * component exposing render/invalidate/handleInput/getText/setText).
 */
function focusedEditorTui(): unknown {
  return {
    ...stubTui(),
    focusedComponent: {
      render: () => [],
      invalidate: () => {},
      handleInput: () => {},
      getText: () => "",
      setText: () => {},
    },
  };
}

describe("startPi — widget seeding", () => {
  it("first beforeAgentStart registers the fleet widget factory under zoo", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const { calls, ctx } = widgetRecordingCtx();

    // The first per-session event registers the `zoo` fleet widget (a
    // component factory) with the default primary (dolphin) — even though
    // no switch has happened.
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "zoo");
    assert.equal(typeof calls[0][1], "function");
  });

  it("beforeAgentStart seeds the todo column one-shot when session_start never ran", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    // The store's first read scans the transcript, so the fallback seed is
    // observable through a counted history scan.
    const scans = { count: 0 };
    const ctx = {
      sessionManager: {
        getSessionId: () => "sess-fallback",
        getBranch: () => {
          scans.count += 1;
          return [];
        },
      },
      ui: { notify: () => {}, setWidget: () => {} },
    };

    // No session_start: the first LLM turn must seed the widget's todo
    // column so a plan rendered before startup still appears.
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );
    assert.equal(scans.count, 1, "the first turn seeds the todo column");
    // Later turns are one-shot: the store is never re-read.
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );
    assert.equal(scans.count, 1, "the todo seed must be one-shot");
  });

  it("re-registers on later beforeAgentStart events without stacking the listener", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    // Registration is idempotent: every trigger re-seeds the widget (pi's
    // setWidget disposes the prior component) and re-binds the listener only
    // after releasing the previous one — so the subscription count never
    // grows.
    let activeSubscriptions = 0;
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      sessionManager: { getSessionId: () => "sess-bas" },
      ui: {
        notify: () => {},
        setWidget: (key: string, content: unknown) =>
          calls.push([key, content]),
        onTerminalInput: () => {
          activeSubscriptions += 1;
          return () => {
            activeSubscriptions -= 1;
          };
        },
      },
    };

    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );
    assert.equal(calls.length, 2, "each trigger re-registers the widget");
    assert.equal(
      activeSubscriptions,
      1,
      "the terminal-input listener must not stack",
    );
  });

  it("session_start registers the fleet widget; a later beforeAgentStart re-registers idempotently", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    // A ui that records setWidget calls and counts live terminal-input
    // subscriptions, so the idempotent re-registration can be asserted to
    // release the previous listener instead of stacking a second one.
    let activeSubscriptions = 0;
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      sessionManager: { getSessionId: () => "sess-seed" },
      ui: {
        notify: () => {},
        setWidget: (key: string, content: unknown) =>
          calls.push([key, content]),
        onTerminalInput: () => {
          activeSubscriptions += 1;
          return () => {
            activeSubscriptions -= 1;
          };
        },
      },
    };

    // session_start fires at startup/resume (before any LLM turn), so the
    // widget must be registered immediately with the default primary.
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    assert.equal(calls.length, 1);
    assert.equal(activeSubscriptions, 1);

    // A later beforeAgentStart (first LLM turn) re-runs the registration
    // (idempotent — re-seeding is safe) without stacking the listener.
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );
    assert.equal(calls.length, 2, "registration re-runs on each trigger");
    assert.equal(
      activeSubscriptions,
      1,
      "the terminal-input listener must not stack",
    );
  });

  it("routes each session's registration to its own fleet resources", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const first = routableSessionCtx("sess-a");
    const second = routableSessionCtx("sess-b");

    // The two sessions are observed interleaved: a's scope is created
    // first, b's second, and a's first LLM turn arrives only afterwards.
    // Each registration must reach the resources of the session the event
    // names, never "whichever scope was created last".
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      first.ctx,
    );
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      second.ctx,
    );
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      first.ctx,
    );

    assert.equal(
      first.calls.length,
      2,
      "session a re-registers its own widget",
    );
    assert.equal(
      second.calls.length,
      1,
      "session b keeps its single registration",
    );
    // Re-registering for session a releases a's OWN previous listener: the
    // listener session b bound must stay live.
    assert.equal(first.live(), 1, "session a keeps exactly one listener");
    assert.equal(second.live(), 1, "session b's listener is not torn down");
  });

  it("re-registers the fleet widget after its component is disposed (reload/resume)", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    // A ui that records setWidget calls AND counts live onTerminalInput
    // subscriptions (returning a real unsubscribe), so a re-registration can
    // be asserted to release the previous listener instead of stacking it.
    let activeSubscriptions = 0;
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      sessionManager: { getSessionId: () => "sess-reload" },
      ui: {
        notify: () => {},
        setWidget: (key: string, content: unknown) =>
          calls.push([key, content]),
        onTerminalInput: () => {
          activeSubscriptions += 1;
          return () => {
            activeSubscriptions -= 1;
          };
        },
      },
    };

    // First session_start registers the widget and binds one listener.
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    assert.equal(calls.length, 1);
    assert.equal(activeSubscriptions, 1);

    // Simulate pi destroying the widget component on reload / resume: invoke
    // the registered component's dispose (releases the listener and clears
    // the one-shot flag).
    const { dispose } = renderZooWidget(calls);
    dispose();
    assert.equal(
      activeSubscriptions,
      0,
      "dispose must release the terminal-input listener",
    );

    // The replayed session_start (reason: reload/resume) must re-register the
    // widget instead of leaving it permanently gone, and must not stack a
    // second terminal-input listener.
    await handlers.sessionStart(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    assert.equal(calls.length, 2, "the widget must re-register after disposal");
    assert.equal(
      activeSubscriptions,
      1,
      "re-registration must not stack terminal-input listeners",
    );
  });

  it("session_start stays silent without a ui surface on ctx", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    // A ui-less ctx (e.g. headless / RPC mode) must not crash the seed:
    // the fail-closed no-ui path no-ops silently.
    await assert.doesNotReject(() =>
      handlers.sessionStart(
        { type: "session_start", reason: "startup" },
        { sessionManager: { getSessionId: () => "sess" } },
      ),
    );
  });

  it("session_start stays silent when the profile cannot provide the orchestrator", async () => {
    const api = mockApi();
    // The profile omits the orchestrator, so the selection is invalid:
    // no orchestrator resolves for the session and no seed may run.
    const handlers = await startInstance(
      piScope(
        { mode: { poly: { ...POLY_PROFILE, agents: ["beaver"] } } },
        MODES_RAW,
      ),
      api as any,
    );
    let widgetCalls = 0;
    const ctx = {
      sessionManager: { getSessionId: () => "sess" },
      ui: {
        notify: () => {},
        setWidget: () => {
          widgetCalls += 1;
        },
      },
    };
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    assert.equal(widgetCalls, 0, "no orchestrator → no seed");
    assert.equal(piProcess.sessionAgents.resolve("sess"), undefined);
  });

  it("stays silent without a pi switch host (no API)", async () => {
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    let widgetCalls = 0;
    const ctx = {
      sessionManager: { getSessionId: () => "sess" },
      ui: {
        notify: () => {},
        setWidget: () => {
          widgetCalls += 1;
        },
      },
    };
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );
    assert.equal(widgetCalls, 0, "no host → no seed");
  });

  it("stays silent when the profile cannot provide the orchestrator", async () => {
    const api = mockApi();
    // An invalid selection resolves no orchestrator, so the bind-time seed
    // stays off.
    const handlers = await startInstance(
      piScope(
        { mode: { poly: { ...POLY_PROFILE, agents: ["beaver"] } } },
        MODES_RAW,
      ),
      api as any,
    );
    let widgetCalls = 0;
    const ctx = {
      sessionManager: { getSessionId: () => "sess" },
      ui: {
        notify: () => {},
        setWidget: () => {
          widgetCalls += 1;
        },
      },
    };
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );
    assert.equal(widgetCalls, 0, "no orchestrator → no seed");
    assert.equal(piProcess.sessionAgents.resolve("sess"), undefined);
  });

  it("session_start rebuilds the run registry from the message history", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const history = () => [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-hist-1",
              name: "subagent",
              arguments: { agent: "beaver", description: "实现任务" },
            },
          ],
          timestamp: 1000,
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-hist-1",
          toolName: "subagent",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2000,
        },
      },
      // An in-flight call when pi exited → rebuilt as aborted.
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-hist-2",
              name: "subagent",
              arguments: { agent: "lynx" },
            },
          ],
          timestamp: 3000,
        },
      },
    ];
    const ctx = {
      sessionManager: {
        getSessionId: () => "sess-restore",
        buildContextEntries: history,
      },
      ui: { notify: () => {}, setWidget: () => {} },
    };

    // A fresh session_start (pi restore / resume) must seed the registry so
    // the fleet widget renders historical subagent runs.
    await handlers.sessionStart(
      { type: "session_start", reason: "resume" },
      ctx,
    );

    assert.equal(piProcess.runs.topLevel("sess-restore").length, 2);
    const done = piProcess.runs.get("call-hist-1");
    assert.equal(done?.status, "done");
    assert.equal(done?.agent, "beaver");
    assert.equal(done?.label, "实现任务");
    assert.equal(done?.startedAt, 1000);
    assert.equal(done?.endedAt, 2000);
    const interrupted = piProcess.runs.get("call-hist-2");
    assert.equal(interrupted?.status, "aborted");
    assert.equal(interrupted?.endedAt, 3000);
  });

  it("session_start registry rebuild is idempotent across repeated triggers", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const history = () => [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-x",
              name: "subagent",
              arguments: { agent: "spider" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-x",
          toolName: "subagent",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        },
      },
    ];
    const ctx = {
      sessionManager: {
        getSessionId: () => "sess-again",
        buildContextEntries: history,
      },
      ui: { notify: () => {}, setWidget: () => {} },
    };

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    await handlers.sessionStart(
      { type: "session_start", reason: "resume" },
      ctx,
    );

    assert.equal(
      piProcess.runs.topLevel("sess-again").length,
      1,
      "no duplicate entries",
    );
    assert.equal(piProcess.runs.get("call-x")?.status, "done");
  });

  it("session_start leaves the registry untouched without a session manager history", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    // A ui + session-id-only ctx (no buildContextEntries) must not crash and
    // must not touch the registry (fresh session → nothing to rebuild).
    await assert.doesNotReject(() =>
      handlers.sessionStart(
        { type: "session_start", reason: "startup" },
        { sessionManager: { getSessionId: () => "sess" } },
      ),
    );
    assert.equal(piProcess.runs.topLevel("sess").length, 0);
  });

  it("session_start rebuilds even when buildContextEntries reads `this`", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    // Regression: pi's real SessionManager.buildContextEntries reads
    // `this.getEntries()`, so the mock must be `this`-dependent too.
    // The function must be invoked as a method
    // (`sessionManager.buildContextEntries()`): extracting the reference
    // first (`const f = sm.buildContextEntries; f()`) unbinds `this` and
    // crashes — swallowed by the try/catch as `registry_rebuild_failed`, so
    // the registry stays empty.  Calling it as a method keeps `this` bound
    // and seeds the registry.
    class MockSessionManager {
      private readonly entries = [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-bind-1",
                name: "subagent",
                arguments: { agent: "lynx", description: "搜索代码" },
              },
            ],
            timestamp: 4000,
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-bind-1",
            toolName: "subagent",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 5000,
          },
        },
      ];
      getSessionId(): string {
        return "sess-bind";
      }
      // A `this`-dependent method mirroring pi's SessionManager.
      buildContextEntries(): unknown[] {
        return this.entries;
      }
    }
    const ctx = {
      sessionManager: new MockSessionManager(),
      ui: { notify: () => {}, setWidget: () => {} },
    };

    await handlers.sessionStart(
      { type: "session_start", reason: "resume" },
      ctx,
    );

    // The rebuild must run to completion: the registry is seeded and no
    // exception is surfaced to the caller.
    assert.equal(piProcess.runs.topLevel("sess-bind").length, 1);
    const run = piProcess.runs.get("call-bind-1");
    assert.equal(run?.status, "done");
    assert.equal(run?.agent, "lynx");
    assert.equal(run?.label, "搜索代码");
    assert.equal(run?.startedAt, 4000);
    assert.equal(run?.endedAt, 5000);
  });
});

// ---------------------------------------------------------------------------
// session_start — no stop cleanup
// ---------------------------------------------------------------------------

describe("startPi — session_start is not a stop", () => {
  it("keeps the session's published round view on a resume", async () => {
    const api = mockApi();
    const runtime = createContextRuntime();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
      {
        contextRuntime: runtime,
      },
    );
    // Only a session stop releases the runtime records, so a resume must
    // leave the session's records untouched — the next pruning round
    // republishes the view anyway.
    runtime.publishRoundView("sess-rv", {
      projection: project(
        [
          {
            role: "user",
            hidden: false,
            regions: [{ kind: "content", get: () => "hi" }],
          },
        ],
        [],
      ),
      numbered: [],
    });
    assert.ok(runtime.roundView("sess-rv"), "the view starts published");
    piProcess.sessionAgents.bind("sess-rv", "dolphin");

    await handlers.sessionStart(
      { type: "session_start", reason: "resume" },
      {
        sessionManager: { getSessionId: () => "sess-rv" },
        ui: { notify: () => {}, setWidget: () => {} },
      },
    );

    assert.ok(
      runtime.roundView("sess-rv"),
      "a start notice must not clear the cached round view",
    );
    assert.equal(
      piProcess.sessionAgents.resolve("sess-rv"),
      "dolphin",
      "a start notice keeps the session's other records too",
    );
  });
});

// ---------------------------------------------------------------------------
// Fleet widget enter-inspect wiring
// ---------------------------------------------------------------------------

describe("startPi — fleet widget enter-inspect wiring", () => {
  it("enter on a selected run opens the transcript overlay via ui.custom", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    let opened = 0;
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f, _options) => {
        opened += 1;
        factory = f;
        return Promise.resolve(undefined);
      },
    });

    // Session start registers the fleet widget + terminal-input listener and
    // caches the command ctx (with ui.custom) in the shared holder.
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    // Attach the widget to a TUI with a focused empty editor so its keyboard
    // state machine can be driven (kept alive for the key sequence).
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());

    piProcess.runs.start({
      id: "run-enter",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });

    // Expand (↓) selects the run; enter must open the read-only overlay.
    inputHandler("\u001b[B");
    const result = inputHandler("\r");
    assert.deepEqual(result, { consume: true }, "enter must be consumed");
    assert.equal(opened, 1, "ui.custom must be called once");
    assert.equal(typeof factory, "function", "a component factory is passed");
    dispose();
  });

  it("collapses the fleet widget to the stable one-line state before opening the overlay", async () => {
    // Root cause regression: the overlay compositor line-diffs the base
    // content.  An expanded widget (~10 lines) that collapses mid-overlay
    // (the editor-focus guard on each keypress) mutates the base length
    // under the open overlay, forcing a full symmetric re-paint.  enterRun
    // must collapse the widget BEFORE the overlay opens.
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    let opened = 0;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: () => {
        opened += 1;
        return Promise.resolve(undefined);
      },
    });

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());

    piProcess.runs.start({
      id: "run-collapse",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });

    // Expand (↓) so the widget is NOT already collapsed — the enter path
    // must collapse it before the overlay opens.
    inputHandler("\u001b[B");
    assert.ok(
      renderZooWidget(calls, 80, focusedEditorTui()).lines.length > 1,
      "precondition: the widget is expanded",
    );
    inputHandler("\r");
    assert.equal(opened, 1, "the overlay must open");
    // After enter, the widget renders the single-line collapsed state.
    const after = renderZooWidget(calls, 80, focusedEditorTui()).lines;
    assert.equal(after.length, 1, "widget must be collapsed for the overlay");
    dispose();
  });

  it("keeps the widget collapsed after the overlay closes; ↓ re-expands", async () => {
    // Overlay close (pi re-renders the base) must find the widget in the
    // stable one-line state the enter path collapsed it into — a length
    // change at close would repaint the whole base again.  The normal ↓
    // path still re-expands afterwards (unchanged semantics).
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    let opened = 0;
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f, _options) => {
        opened += 1;
        factory = f;
        return Promise.resolve(undefined);
      },
    });

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());

    piProcess.runs.start({
      id: "run-close",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });

    inputHandler("\u001b[B"); // expand
    inputHandler("\r"); // open the overlay (collapses the widget)
    assert.equal(opened, 1);
    // Simulate pi closing the overlay: build the overlay component and drive
    // its esc key (the close path routes through the component's `done`).
    let closed = 0;
    const overlay = (
      factory as (
        tui: unknown,
        theme: unknown,
        _keybindings: unknown,
        done: (result: undefined) => void,
      ) => { handleInput(data: string): void }
    )(WIDGET_TUI, WIDGET_THEME, undefined, () => {
      closed += 1;
    });
    overlay.handleInput("\u001b");
    assert.equal(closed, 1, "esc must close the overlay");
    const after = renderZooWidget(calls, 80, focusedEditorTui()).lines;
    assert.equal(after.length, 1, "widget stays collapsed after overlay close");
    // The collapsed state never steals keys; ↓ re-expands as before.
    const result = inputHandler("\u001b[B");
    assert.deepEqual(result, { consume: true });
    assert.ok(
      renderZooWidget(calls, 80, focusedEditorTui()).lines.length > 1,
      "↓ must re-expand after the overlay closed",
    );
    dispose();
  });

  it("does not open an overlay when the cached ctx exposes no ui.custom", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    // No ui.custom on the cached ctx (a host ui surface without the overlay
    // opener).
    const { calls, inputHandler, ctx } = widgetInputCtx();
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());
    piProcess.runs.start({
      id: "run-no-ctx",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });

    inputHandler("\u001b[B");
    const result = inputHandler("\r");
    assert.equal(
      result,
      undefined,
      "enter must fall through when no ui.custom is cached",
    );
    dispose();
  });

  it("opens the overlay for a run with an empty log (empty-transcript line)", async () => {
    // The log is the single data source: a run whose log carries no facts
    // yet still opens (the key is consumed) and explains itself.
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f: unknown) => {
        factory = f;
        return Promise.resolve(undefined);
      },
    });
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());
    piProcess.runs.start({
      id: "run-empty",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });

    inputHandler("\u001b[B");
    const result = inputHandler("\r");
    assert.deepEqual(result, { consume: true }, "enter must be consumed");
    const component = (factory as (tui: unknown, theme: unknown) => unknown)(
      WIDGET_TUI,
      WIDGET_THEME,
    );
    const lines = (component as { render(width: number): string[] }).render(80);
    assert.ok(
      lines.some((l) => l.includes("(empty transcript)")),
      `the empty-log line must render: ${lines.join(" | ")}`,
    );
    dispose();
  });

  it("keeps an open overlay intact when the run finishes mid-view (log released)", async () => {
    // The overlay opened on the run's LIVE log; while it is open the run
    // finishes, and the registry swaps the run's log for a fresh empty one
    // (resident memory tracks active work only).  The open overlay keeps
    // projecting the log it was handed — it must neither crash nor blank
    // out; it simply stops receiving appends.
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f: unknown) => {
        factory = f;
        return Promise.resolve(undefined);
      },
    });
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());
    piProcess.runs.start({
      id: "run-midfinish",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });
    inputHandler("\u001b[B");
    const result = inputHandler("\r");
    assert.deepEqual(result, { consume: true });
    const component = (factory as (tui: unknown, theme: unknown) => unknown)(
      WIDGET_TUI,
      WIDGET_THEME,
    );
    const render = (): string[] =>
      (component as { render(width: number): string[] }).render(80);
    piProcess.runs
      .get("run-midfinish")
      ?.log.appendMessage([{ type: "text", text: "visible before finish" }]);
    assert.ok(
      render().some((l) => l.includes("visible before finish")),
      `the live fact must render while the run runs: ${render().join(" | ")}`,
    );
    // The run finishes while the overlay is open → the registry releases the
    // live log.  The open overlay keeps what it already projected.
    piProcess.runs.finish("run-midfinish", { status: "done" });
    assert.equal(
      piProcess.runs.get("run-midfinish")?.log.facts().length,
      0,
      "the terminal run must hold no facts",
    );
    assert.doesNotThrow(() => render(), "the alive overlay must not crash");
    assert.ok(
      render().some((l) => l.includes("visible before finish")),
      `the open overlay must keep its projected content: ${render().join(" | ")}`,
    );
    dispose();
  });

  it("renders facts appended while the overlay is open (live log subscription)", async () => {
    // The composition seam: a running run's log delivers onto the open
    // overlay through the log's single stream subscription — no polling, no
    // bus.
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f: unknown) => {
        factory = f;
        return Promise.resolve(undefined);
      },
    });
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());
    piProcess.runs.start({
      id: "run-running",
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
    });
    inputHandler("\u001b[B");
    const result = inputHandler("\r");
    assert.deepEqual(result, { consume: true });
    const component = (factory as (tui: unknown, theme: unknown) => unknown)(
      WIDGET_TUI,
      WIDGET_THEME,
    );
    const render = (): string[] =>
      (component as { render(width: number): string[] }).render(80);
    let lines = render();
    assert.ok(
      lines.some((l) => l.includes("(empty transcript)")),
      lines.join(" | "),
    );
    // A message fact appended while the overlay is open becomes visible.
    piProcess.runs
      .get("run-running")
      ?.log.appendMessage([{ type: "text", text: "live-tail" }]);
    lines = render();
    assert.ok(
      lines.some((l) => l.includes("live-tail")),
      `the live message must render: ${lines.join(" | ")}`,
    );
    dispose();
  });
});
// ---------------------------------------------------------------------------
// Fleet widget enter-inspect — post-restart hydration of rebuilt runs
// ---------------------------------------------------------------------------

describe("startPi — fleet widget enter-inspect hydration", () => {
  afterEach(() => {
    resetHydration();
  });

  /** One `message` line of a pi session jsonl. */
  function line(message: unknown): string {
    return JSON.stringify({
      type: "message",
      id: `m${Math.random().toString(36).slice(2)}`,
      parentId: null,
      timestamp: "2026-08-31T00:00:00.000Z",
      message,
    });
  }

  /** Write a minimal pi session jsonl (header + given message records). */
  async function writeSession(messages: unknown[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zoo-enter-hydrate-"));
    const path = join(dir, "session.jsonl");
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "ses-enter-hydrate",
      timestamp: "2026-08-31T00:00:00.000Z",
      cwd: "/tmp",
    });
    await writeFile(path, [header, ...messages.map(line)].join("\n"), "utf-8");
    return path;
  }

  /**
   * Wire a session, register one run, press the selection keys and enter,
   * then hand back the overlay-open counters and a render helper.
   */
  async function openOverlayOn(
    run: { id: string; sessionPath?: string; finish?: boolean },
    presses = 1,
    beforeFinish?: (id: string) => void,
  ): Promise<{
    opened: () => number;
    renderOverlay: () => string[];
    dispose: () => void;
  }> {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    let opened = 0;
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f: unknown) => {
        opened += 1;
        factory = f;
        return Promise.resolve(undefined);
      },
    });
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 80, focusedEditorTui());
    piProcess.runs.start({
      id: run.id,
      agent: "beaver",
      parentSession: "sess-enter",
      startedAt: 1000,
      ...(run.sessionPath !== undefined
        ? { sessionPath: run.sessionPath }
        : {}),
    });
    beforeFinish?.(run.id);
    if (run.finish === true) piProcess.runs.finish(run.id, { status: "done" });
    inputHandler("\u001b[B"); // expand + select the run
    for (let i = 0; i < presses; i++) inputHandler("\r");
    return {
      opened: () => opened,
      renderOverlay: () => {
        const component = (
          factory as (
            tui: unknown,
            theme: unknown,
            kb: unknown,
            done: (r: undefined) => void,
          ) => { render(width: number): string[] }
        )(WIDGET_TUI, WIDGET_THEME, undefined, () => {});
        return component.render(80);
      },
      dispose,
    };
  }

  it("opens the overlay on the hydrated facts of a scanner-rebuilt run", async () => {
    // A run rebuilt by the history scanner carries lifecycle metadata and a
    // sessionPath but an EMPTY log; entering it must show the persisted
    // transcript, never "(empty transcript)".
    const path = await writeSession([
      {
        role: "assistant",
        content: [{ type: "text", text: "restored from disk" }],
        timestamp: 100,
      },
    ]);
    const h = await openOverlayOn({
      id: "run-rebuilt",
      sessionPath: path,
      finish: true,
    });
    await waitForHydration("run-rebuilt");
    // The overlay opens from the load's settle continuation — let it run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.opened(), 1, "the settled load must open the overlay");
    const lines = h.renderOverlay();
    assert.ok(
      lines.some((l) => l.includes("restored from disk")),
      `the hydrated fact must render: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("(empty transcript)")),
      lines.join(" | "),
    );
    h.dispose();
  });

  it("hydrates a just-finished live run from its persisted sub-session file", async () => {
    // The registry releases a run's fact log when it finishes, so a run
    // that finished LIVE takes the same hydration gate the post-restart
    // scanner-rebuilt runs do: terminal + empty registry log → rebuild the
    // transcript from the persisted sub-session file.
    const path = await writeSession([
      {
        role: "assistant",
        content: [{ type: "text", text: "final answer from disk" }],
        timestamp: 100,
      },
    ]);
    const h = await openOverlayOn(
      { id: "run-just-done", sessionPath: path, finish: true },
      1,
      (id) => {
        // The run appended facts while it was live (the driver's in-memory
        // record, mirrored on disk by pi's session persistence).
        piProcess.runs
          .get(id)
          ?.log.appendMessage([
            { type: "text", text: "live fact, released at finish" },
          ]);
      },
    );
    assert.equal(
      piProcess.runs.get("run-just-done")?.log.facts().length,
      0,
      "finish must release the live run's in-memory log",
    );
    await waitForHydration("run-just-done");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.opened(), 1, "the settled load must open the overlay");
    const lines = h.renderOverlay();
    assert.ok(
      lines.some((l) => l.includes("final answer from disk")),
      `the hydrated transcript must render: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("live fact, released at finish")),
      `the released in-memory facts must not leak: ${lines.join(" | ")}`,
    );
    h.dispose();
  });

  it("opens synchronously when the shared cache already holds the log", async () => {
    // The dedupe the inline card relies on: a warm cache (the card already
    // loaded this run) means enter opens right on the keypress.
    const path = await writeSession([
      {
        role: "assistant",
        content: [{ type: "text", text: "warm cache" }],
        timestamp: 100,
      },
    ]);
    beginHydration("run-warm", path);
    await waitForHydration("run-warm");
    const h = await openOverlayOn({
      id: "run-warm",
      sessionPath: path,
      finish: true,
    });
    assert.equal(h.opened(), 1, "a warm hydration must open on the keypress");
    const lines = h.renderOverlay();
    assert.ok(
      lines.some((l) => l.includes("warm cache")),
      lines.join(" | "),
    );
    h.dispose();
  });

  it("states the unavailable notice when the session file cannot be read", async () => {
    // Hydration failure stays cached for that run until eviction:
    // the overlay still opens and says why there is nothing to show.
    const h = await openOverlayOn({
      id: "run-gone",
      sessionPath: "/nonexistent/zoo-enter-hydrate/none.jsonl",
      finish: true,
    });
    await waitForHydration("run-gone");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.opened(), 1, "the failed load must still open the overlay");
    const lines = h.renderOverlay();
    assert.ok(
      lines.some((l) => l.includes(TRANSCRIPT_UNAVAILABLE_NOTICE)),
      `the unavailable notice must render: ${lines.join(" | ")}`,
    );
    assert.ok(
      !lines.some((l) => l.includes("(empty transcript)")),
      lines.join(" | "),
    );
    h.dispose();
  });

  it("never swaps a still-running run onto a file snapshot", async () => {
    // A running run's log is the live source: hydrating it from the partially
    // written session file would both duplicate facts and cut the overlay off
    // from the driver's appends.  Enter must open the live log immediately.
    const path = await writeSession([
      {
        role: "assistant",
        content: [{ type: "text", text: "stale file snapshot" }],
        timestamp: 100,
      },
    ]);
    const h = await openOverlayOn({ id: "run-live", sessionPath: path });
    assert.equal(h.opened(), 1, "a running run opens on the keypress");
    piProcess.runs
      .get("run-live")
      ?.log.appendMessage([{ type: "text", text: "live tail fact" }]);
    const lines = h.renderOverlay();
    assert.ok(
      lines.some((l) => l.includes("live tail fact")),
      lines.join(" | "),
    );
    assert.ok(
      !lines.some((l) => l.includes("stale file snapshot")),
      "the file snapshot must not be projected over the live log",
    );
    h.dispose();
  });

  it("opens a single overlay when enter is pressed twice during the load", async () => {
    // The deferred open is async; a second keypress while the load is in
    // flight must not stack a second overlay on the same run.
    const path = await writeSession([
      {
        role: "assistant",
        content: [{ type: "text", text: "once only" }],
        timestamp: 100,
      },
    ]);
    const h = await openOverlayOn(
      { id: "run-twice", sessionPath: path, finish: true },
      2,
    );
    await waitForHydration("run-twice");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.opened(), 1, "exactly one overlay may open per run");
    h.dispose();
  });
});
// ---------------------------------------------------------------------------
// Fleet widget enter-inspect — overlay border + title agent colorization
// ---------------------------------------------------------------------------

describe("startPi — transcript overlay border + title agent color", () => {
  /** Open the overlay for a run and render its component with a stub theme. */
  async function renderOverlayFor(
    raw: unknown,
    run: { id: string; agent: string; label?: string },
  ): Promise<string[]> {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, raw as any),
      api as any,
    );
    let factory: unknown;
    const { calls, inputHandler, ctx } = widgetInputCtx({
      custom: (f: unknown) => {
        factory = f;
        return Promise.resolve(undefined);
      },
    });
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const { dispose } = renderZooWidget(calls, 200, focusedEditorTui());
    piProcess.runs.start({
      id: run.id,
      agent: run.agent,
      parentSession: "sess-enter",
      startedAt: 1000,
      ...(run.label !== undefined ? { label: run.label } : {}),
    });
    inputHandler("\u001b[B");
    inputHandler("\r");
    const component = (factory as (tui: unknown, theme: unknown) => unknown)(
      WIDGET_TUI,
      WIDGET_THEME,
    );
    const lines = (component as { render(width: number): string[] }).render(
      200,
    );
    dispose();
    return lines;
  }

  it("colors the overlay title line with the inspected run's agent color", async () => {
    const lines = await renderOverlayFor(COLORS_RAW, {
      id: "run-color",
      agent: "beaver",
    });
    // beaver's configured color #39C5BB wraps the whole title line in the
    // truecolor sequence; the hint keeps its own dim color.
    const title = lines.find((l) => l.includes("beaver"));
    assert.ok(title, "the title line must be present");
    // The whole title line is wrapped as one colorized unit in beaver's
    // truecolor sequence (#39C5BB = 57,197,187) — the full-screen surface
    // has no border glyphs to colorize separately.  (runTitle pre-wraps the
    // agent name, so the sequence appears twice; padding follows after.)
    const esc = "\x1b[38;2;57;197;187m";
    assert.ok(title.startsWith(esc), title);
    assert.ok(title.includes(`${esc}beaver\x1b[39m`), title);
    assert.ok(
      lines.every((l) => !l.includes("╭") && !l.includes("│")),
      lines.join("\n"),
    );
  });

  it("falls back to the fixed title color when the agent has no configured color", async () => {
    // MODES_RAW declares no agent colors → the overlay title line falls back
    // to the stub theme's `border` color (current default).
    const lines = await renderOverlayFor(MODES_RAW, {
      id: "run-nocolor",
      agent: "beaver",
    });
    const title = lines.find((l) => l.includes("beaver"));
    assert.ok(title, "the title line must be present");
    assert.ok(title.includes("<border>beaver</border>"), title);
    assert.ok(
      lines.every((l) => !l.includes("╭") && !l.includes("│")),
      lines.join("\n"),
    );
  });

  it("colors the title agent name with the run's configured color", async () => {
    // beaver carries #39C5BB in COLORS_RAW → the title's agent name is
    // pre-colorized by `runTitle` (the same `colorizeAgent` source as the
    // widget) before the overlay renders it.  pi's width handling preserves
    // ANSI, so the wrapped name survives verbatim in the rendered title line.
    const lines = await renderOverlayFor(COLORS_RAW, {
      id: "run-title-color",
      agent: "beaver",
      label: "实现任务",
    });
    const esc = "\x1b[38;2;57;197;187m"; // #39C5BB = 57,197,187
    const title = lines.find((l) => l.includes("实现任务"));
    assert.ok(title, lines.join("\n"));
    assert.ok(title.includes(`${esc}beaver\x1b[39m · 实现任务`), title);
  });

  it("keeps the title agent name plain when the agent has no configured color", async () => {
    // MODES_RAW declares no colors → `runTitle` falls back to the plain
    // agent name (fail-closed), so the title carries no agent truecolor
    // foreground sequence.  (The overlay's width padding may still emit a
    // neutral `\x1b[0m` reset — that is pi-tui truncation, not coloring.)
    const lines = await renderOverlayFor(MODES_RAW, {
      id: "run-title-nocolor",
      agent: "beaver",
      label: "实现任务",
    });
    const title = lines.find((l) => l.includes("实现任务"));
    assert.ok(title, lines.join("\n"));
    assert.ok(title.includes("beaver · 实现任务"), title);
    assert.ok(
      !title.includes("\x1b[38;2;"),
      `no agent truecolor sequence in the title: ${JSON.stringify(title)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Zoo widget colorization
// ---------------------------------------------------------------------------

describe("startPi — zoo widget colorization", () => {
  /** The truecolor ANSI wrapper for an agent name. */
  function colorize(name: string, hex: string): string {
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    return `\x1b[38;2;${r};${g};${b}m${name}\x1b[39m`;
  }

  it("registers the fleet widget whose collapsed line uses the ANSI-wrapped primary when its color is configured", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, COLORS_RAW),
      api as any,
    );
    const { calls, ctx } = widgetRecordingCtx();
    // The default primary (dolphin) carries #66CCFF → the widget's collapsed
    // line embeds the truecolor-wrapped name (inside the muted status hue).
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );
    const { lines, dispose } = renderZooWidget(calls);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(colorize("dolphin", "#66CCFF")), lines[0]);
    dispose();
  });

  it("leaves the collapsed primary plain when it has no configured color", async () => {
    const api = mockApi();
    // MODES_RAW has no color fields → the colors map is empty, so the
    // primary falls back to the plain agent name (fail-closed).
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const { calls, ctx } = widgetRecordingCtx();
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );
    const { lines, dispose } = renderZooWidget(calls);
    assert.ok(lines[0].includes("dolphin"), lines[0]);
    assert.ok(!lines[0].includes("\u001b["), "no ANSI when uncolored");
    dispose();
  });

  it("leaves the collapsed primary plain when the color for that agent is malformed", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, {
        ...MODES_RAW,
        agent: {
          ...MODES_RAW.agent,
          dolphin: { mode: "primary", color: "red" }, // invalid hex
          mola: { mode: "primary", color: "#FFA500" },
        },
      }),
      api as any,
    );
    const { calls, ctx } = widgetRecordingCtx();
    // Malformed color is omitted by the parser → the primary stays plain.
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );
    const { lines, dispose } = renderZooWidget(calls);
    assert.ok(lines[0].includes("dolphin"), lines[0]);
    assert.ok(!lines[0].includes("\u001b["), "no ANSI for a malformed color");
    dispose();
  });
});

// ---------------------------------------------------------------------------
// Primary-switch command widget colorization
// ---------------------------------------------------------------------------

describe("startPi — primary-switch widget colorization", () => {
  /**
   * A command ctx whose newSession runs withSession against a
   * per-fresh-session facade (mirroring pi.ts's implementation:
   * setWidget binds to the fresh ui, setActiveTools / appendEntry apply
   * to the mock API as the deferred drain would).
   */
  function switchCtx(
    setWidget: (key: string, lines: string[] | undefined) => void = () => {},
  ): {
    sessionManager: { getSessionId(): string };
    ui: {
      notify(): void;
      setWidget(
        key: string,
        lines: string[] | undefined,
        options?: { placement?: "aboveEditor" | "belowEditor" },
      ): void;
    };
    newSession(options?: {
      parentSession?: string;
      withSession?: (newCtx: unknown) => void | Promise<void>;
    }): Promise<{ cancelled: boolean }>;
  } {
    return {
      sessionManager: { getSessionId: () => "sess-switch" },
      ui: { notify: () => {}, setWidget },
      async newSession(options) {
        // pi passes the fresh ReplacedSessionContext to withSession.
        await options?.withSession?.({
          ui: { setWidget },
          sessionManager: { getSessionId: () => "sess-new" },
        });
        return { cancelled: false };
      },
    };
  }

  it("switch command nudges the fleet widget which renders the ANSI-wrapped target name", async () => {
    const api = mockApi();
    api.activeTools.push("webfetch", "edit");
    const handlers = await startInstance(
      piScope(POLY_ZOO, {
        agent: {
          ...COLORS_RAW.agent,
          mola: { mode: "primary", color: "#FFA500" },
        },
      }),
      api as any,
    );
    const mola = api.commands.find((c) => c.name === "mola");
    assert.ok(mola && typeof mola.handler === "function");

    // The switch publishes its target (not a string-array widget): it is a
    // "primary changed" notification the fleet widget turns into a
    // re-render of the session's own primary.
    await (mola.handler as (args: string, ctx: unknown) => Promise<void>)(
      "",
      switchCtx(() => {}),
    );

    // The replacement session registers its widget at bind time and already
    // resolves the switched primary, rendered with its configured color.
    const { calls, ctx } = widgetRecordingCtx("sess-new", "sess-switch");
    await handlers.sessionStart({ type: "session_start", reason: "new" }, ctx);
    assert.equal(piProcess.sessionAgents.resolve("sess-new"), "mola");
    const { lines, dispose } = renderZooWidget(calls);
    const r = 0xff;
    const g = 0xa5;
    const b = 0x00;
    assert.ok(
      lines[0].includes(`\x1b[38;2;${r};${g};${b}mmola\x1b[39m`),
      lines[0],
    );
    dispose();
  });

  it("switch command leaves the fleet-widget primary plain for an agent without a color", async () => {
    const api = mockApi();
    api.activeTools.push("webfetch", "edit");
    // COLORS_RAW has no color for spider; MODES_RAW has no colors at all.
    // Build with MODES_RAW so the colors map is empty → plain name.
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const dolphin = api.commands.find((c) => c.name === "dolphin");
    assert.ok(dolphin && typeof dolphin.handler === "function");

    piProcess.sessionAgents.bind("sess-switch", "mola");
    await (dolphin.handler as (args: string, ctx: unknown) => Promise<void>)(
      "",
      switchCtx(() => {}),
    );

    // The replacement session's bind-time handlers resolve the switched
    // primary and render it plainly (it has no configured color).
    const { calls, ctx } = widgetRecordingCtx("sess-new");
    await handlers.sessionStart({ type: "session_start", reason: "new" }, ctx);
    assert.equal(piProcess.sessionAgents.resolve("sess-new"), "dolphin");

    const { lines, dispose } = renderZooWidget(calls);
    assert.ok(lines[0].includes("dolphin"), lines[0]);
    assert.ok(!lines[0].includes("\u001b["), "no ANSI for an uncolored agent");
    dispose();
  });
});

// ---------------------------------------------------------------------------
// Tool admission
// ---------------------------------------------------------------------------

describe("buildPiToolExecute — tool admission", () => {
  /** A recording permit the fake admission issues. */
  function fakePermit(): WorkPermit {
    const controller = new AbortController();
    return {
      sessionID: "sess-tool",
      signal: controller.signal,
      isActive: () => !controller.signal.aborted,
    };
  }

  /** A tool whose call context and arguments the test records. */
  function recordingTool(calls: {
    call: ToolCallContext[];
    args: unknown[];
  }): ToolContribution {
    return {
      name: "probe",
      description: "probe",
      execute: async (args, call) => {
        calls.args.push(args);
        calls.call.push(call);
        return { text: "ok" };
      },
    };
  }

  it("runs the whole call under the permit it is handed", async () => {
    const permit = fakePermit();
    const calls = { call: [] as ToolCallContext[], args: [] as unknown[] };
    const published: Array<[string, unknown]> = [];
    const ctx = { sessionManager: { getSessionId: () => "sess-tool" } };
    const admitted: unknown[] = [];
    const run: PiSessionWorkRunner = {
      runSession: async (callCtx, work) => {
        admitted.push(callCtx);
        // The tool bridge reads no session service.
        return work(permit, {});
      },
    };
    const partials: unknown[] = [];
    const onUpdate = (partial: unknown) => partials.push(partial);
    const caller = new AbortController();

    const result = await buildPiToolExecute(
      recordingTool(calls),
      run,
      (sessionID, callCtx) => published.push([sessionID, callCtx]),
      createPiQuestionChannel,
      piProcess.runs,
    )("call-1", { a: 1 }, caller.signal, onUpdate, ctx);

    // The call is admitted for its own context, which is bound under the
    // permit's session id.
    assert.deepEqual(admitted, [ctx]);
    assert.deepEqual(published, [["sess-tool", ctx]]);

    // The tool receives a host-neutral context: the permit's session and
    // signal (never pi's native one), the permit itself, and the pi
    // tool-call id.
    assert.deepEqual(calls.args, [{ a: 1 }]);
    const call = calls.call[0];
    assert.equal(call?.sessionID, "sess-tool");
    assert.equal(call?.permit, permit);
    assert.equal(call?.signal, permit.signal);
    assert.notEqual(call?.signal, caller.signal);
    assert.equal(call?.callID, "call-1");
    assert.equal(call?.questionChannel, undefined);

    // The repaint request is the adapter's own content-free partial.
    call?.notifyChanged?.();
    assert.deepEqual(partials, [{ content: [] }]);

    assert.deepEqual(result, {
      content: [{ type: "text", text: "ok" }],
      details: {},
    });
  });

  it("survives a throwing repaint callback", async () => {
    const calls = { call: [] as ToolCallContext[], args: [] as unknown[] };
    const run: PiSessionWorkRunner = {
      runSession: async (_ctx, work) => work(fakePermit(), {}),
    };
    const result = await buildPiToolExecute(
      {
        name: "probe",
        description: "probe",
        execute: async (_args, call) => {
          call.notifyChanged?.();
          call.notifyChanged?.();
          return { text: "ok" };
        },
      },
      run,
      () => {},
      createPiQuestionChannel,
      piProcess.runs,
    )(
      "call-1",
      {},
      undefined,
      () => {
        throw new Error("ui exploded");
      },
      { sessionManager: { getSessionId: () => "sess-tool" } },
    );

    assert.deepEqual(calls.args, []);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "ok" }],
      details: {},
    });
  });

  it("builds the question channel from pi's own execution context", async () => {
    const calls = { call: [] as ToolCallContext[], args: [] as unknown[] };
    const run: PiSessionWorkRunner = {
      runSession: async (_ctx, work) => work(fakePermit(), {}),
    };
    const form = formHarness();
    const result = await buildPiToolExecute(
      {
        name: "probe",
        description: "probe",
        execute: async (_args, call) => {
          calls.call.push(call);
          return { text: "asked" };
        },
      },
      run,
      () => {},
      createPiQuestionChannel,
      piProcess.runs,
    )("call-1", {}, undefined, undefined, {
      sessionManager: { getSessionId: () => "sess-tool" },
      mode: "tui",
      ui: form,
    });

    assert.deepEqual(result, {
      content: [{ type: "text", text: "asked" }],
      details: {},
    });
    const channel = calls.call[0]?.questionChannel;
    assert.ok(channel, "an interactive context yields a channel");
  });

  it("merges the tool's structured data into the terminal details", async () => {
    const run: PiSessionWorkRunner = {
      runSession: async (_ctx, work) => work(fakePermit(), {}),
    };
    piProcess.runs.start({
      id: "call-data",
      agent: "beaver",
      parentSession: "sess-tool",
    });
    piProcess.runs.update("call-data", { sessionPath: "/tmp/run.jsonl" });
    const result = await buildPiToolExecute(
      {
        name: "probe",
        description: "probe",
        execute: async () => ({
          text: "ok",
          data: { questions: [], sessionPath: "/tmp/forged.jsonl" },
        }),
      },
      run,
      () => {},
      createPiQuestionChannel,
      piProcess.runs,
    )("call-data", {}, undefined, undefined, {
      sessionManager: { getSessionId: () => "sess-tool" },
    });

    assert.deepEqual(result.details, {
      questions: [],
      sessionPath: "/tmp/run.jsonl",
    });
  });

  it("runs nothing and publishes nothing when the call is refused", async () => {
    const calls = { call: [] as ToolCallContext[], args: [] as unknown[] };
    const published: unknown[] = [];
    const run: PiSessionWorkRunner = { runSession: async () => undefined };

    const result = await buildPiToolExecute(
      recordingTool(calls),
      run,
      (ctx) => published.push(ctx),
      createPiQuestionChannel,
      piProcess.runs,
    )("call-1", {}, undefined, undefined, {
      sessionManager: { getSessionId: () => "s" },
    });

    // The host still receives a result in its own shape, and the tool never
    // ran.
    assert.deepEqual(result, { content: [], details: {} });
    assert.deepEqual(calls.args, []);
    assert.deepEqual(published, []);
  });
});

describe("startPi — tool and command admission", () => {
  /** The profile with the two stateless tools, so the bridge registers. */
  const TOOL_ZOO = {
    ...POLY_ZOO,
    mode: {
      poly: {
        ...POLY_PROFILE,
        tools: ["decompress"],
        hooks: POLY_PROFILE.hooks.filter((h) => h !== "context-pruning"),
      },
    },
  };

  it("runs no tool after the session stopped", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(TOOL_ZOO, MODES_RAW),
      api as any,
    );
    const decompress = api.tools.find(
      (tool: any) => tool.name === "decompress",
    ) as { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    assert.ok(decompress);
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      SESSION_CTX,
    );
    await handlers.sessionShutdown(
      { type: "session_shutdown", reason: "quit" },
      SESSION_CTX,
    );

    // A malformed call would reject if the tool ran; a refused call reports
    // an empty result instead.
    const result = await decompress.execute(
      "call-late",
      {},
      undefined,
      undefined,
      SESSION_CTX,
    );

    assert.deepEqual(result, { content: [], details: {} });
  });

  it("runs no tool without a session id", async () => {
    const api = mockApi();
    await startInstance(piScope(TOOL_ZOO, MODES_RAW), api as any);
    const decompress = api.tools.find(
      (tool: any) => tool.name === "decompress",
    ) as { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    assert.ok(decompress);

    const result = await decompress.execute(
      "call-no-session",
      {},
      undefined,
      undefined,
      {},
    );

    assert.deepEqual(result, { content: [], details: {} });
  });

  it("a cancelled caller refuses that call only", async () => {
    const api = mockApi();
    const signals: AbortSignal[] = [];
    const releases: Array<() => void> = [];
    const driver: SubagentDriver = {
      async run(_req, ctx) {
        signals.push(ctx.signal);
        await new Promise<void>((resolve) => releases.push(resolve));
        return { kind: "ok", text: "done" };
      },
    };
    await startInstance(
      piScope(
        {
          mode: {
            poly: { ...POLY_PROFILE, tools: ["subagent"], hooks: [] },
          },
        },
        MODES_RAW,
      ),
      api as any,
      { subagentDriver: driver },
    );
    const subagent = api.tools.find((tool: any) => tool.name === "subagent") as
      | { execute: (...args: unknown[]) => Promise<unknown> }
      | undefined;
    assert.ok(subagent);
    const input = { agent: "beaver", description: "实现任务", prompt: "t" };

    const cancelled = new AbortController();
    const cancelledCall = subagent.execute(
      "call-a",
      input,
      cancelled.signal,
      undefined,
      SESSION_CTX,
    );
    const liveCall = subagent.execute(
      "call-b",
      input,
      undefined,
      undefined,
      SESSION_CTX,
    );
    while (signals.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    cancelled.abort();
    assert.equal(signals[0]?.aborted, true, "the cancelled call is revoked");
    assert.equal(signals[1]?.aborted, false, "the other call keeps running");

    for (const release of releases) release();
    await Promise.all([cancelledCall, liveCall]);
  });

  it("does not wait for a replacing command at the shutdown it triggers", async () => {
    // pi tears the replaced session down INSIDE `newSession` (its
    // `session_shutdown` reaches this runtime).  A command admitted as
    // session work would be waited on by that stop and never return, so a
    // replacing command is a control operation.
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const mola = api.commands.find((command) => command.name === "mola");
    assert.ok(mola && typeof mola.handler === "function");

    const switched = await (
      mola.handler as (args: string, ctx: unknown) => Promise<void>
    )("", {
      sessionManager: { getSessionId: () => "sess-switch" },
      ui: { notify: () => {}, setWidget: () => {} },
      newSession: async (options?: {
        withSession?: (ops: SwitchNewSessionOps) => void | Promise<void>;
      }) => {
        await handlers.sessionShutdown(
          { type: "session_shutdown", reason: "new" },
          { sessionManager: { getSessionId: () => "sess-switch" } },
        );
        await options?.withSession?.({
          setWidget: () => {},
          setActiveTools: () => {},
        });
        return { cancelled: false };
      },
    });

    assert.equal(switched, undefined);
    // The replacement ran to its end: its own start claims the target.
    assert.equal(
      piProcess.switchOps.claim("sess-new", {
        reason: "new",
        parentSession: "sess-switch",
      }),
      "mola",
    );
    assert.equal(piProcess.sessionAgents.resolve("sess-switch"), "mola");
  });

  it("does not wait for a plan handoff at the shutdown it triggers", async () => {
    // `/go` replaces the session it belongs to, exactly like a primary
    // switch: the shutdown `newSession` raises must not wait for the
    // command, or the handoff would deadlock the stop it performs.
    const api = mockApi();
    const dir = makeTmpDir("zoo-pi-go-control");
    writePlanFile(
      dir,
      "demo-plan.md",
      { status: "planning-done", slug: "demo-plan" },
      "body",
    );
    try {
      const handlers = await startInstance(
        piScope(POLY_ZOO, MODES_RAW),
        api as any,
        {
          directory: dir,
        },
      );
      const go = api.commands.find((command) => command.name === "go");
      assert.ok(go && typeof go.handler === "function");
      const ctx = { sessionManager: { getSessionId: () => "sess-go" } };
      let stopSettledDuringReplacement = false;

      await (go.handler as (args: string, ctx: unknown) => Promise<void>)("", {
        ...ctx,
        newSession: async (options?: {
          withSession?: (newCtx: {
            sendUserMessage(content: string): Promise<void>;
          }) => void | Promise<void>;
        }) => {
          let settled = false;
          const stopped = handlers
            .sessionShutdown({ type: "session_shutdown", reason: "new" }, ctx)
            .then(() => {
              settled = true;
            });
          await new Promise((resolve) => setTimeout(resolve, 0));
          stopSettledDuringReplacement = settled;
          await options?.withSession?.({ sendUserMessage: async () => {} });
          await stopped;
          return { cancelled: false };
        },
      });

      assert.equal(
        stopSettledDuringReplacement,
        true,
        "the stop must not wait for /go",
      );
      // The handoff still ran to its end: executor published, plan moved.
      assert.equal(
        piProcess.switchOps.claim("sess-dolphin", {
          reason: "new",
          parentSession: "sess-go",
        }),
        "dolphin",
      );
      assert.ok(
        fs
          .readFileSync(join(dir, ".zoo/plans/demo-plan.md"), "utf-8")
          .includes("status: executing"),
      );
    } finally {
      cleanupPlanDir(dir);
    }
  });

  it("waits for an ordinary command at the shutdown it triggers", async () => {
    // `/debug` is ordinary session work: the stop cancels it and waits for
    // it to return, so it never outlives the session it belongs to.
    const api = mockApi();
    const dir = makeTmpDir("zoo-pi-debug-admission");
    let releaseExec: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const zdebugExec = async () => {
      signalStarted?.();
      await new Promise<void>((resolve) => {
        releaseExec = resolve;
      });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const handlers = await startInstance(
      piScope(
        {
          ...POLY_ZOO,
          // `/debug` registers only when the wake budget parses.
          autodebug: { max_wakes: 3 },
          mode: { poly: { ...POLY_PROFILE, commands: ["debug"] } },
        },
        MODES_RAW,
      ),
      api as any,
      { directory: dir, zdebugExec },
    );
    const debug = api.commands.find((command) => command.name === "debug");
    assert.ok(debug && typeof debug.handler === "function");
    const ctx = { sessionManager: { getSessionId: () => "sess-debug" } };

    const running = (
      debug.handler as (args: string, ctx: unknown) => Promise<void>
    )("调查目标", ctx);
    await started;

    let stopSettled = false;
    const stopped = handlers
      .sessionShutdown({ type: "session_shutdown", reason: "quit" }, ctx)
      .then(() => {
        stopSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stopSettled, false, "the stop must wait for the command");

    // Releasing the command lets it return, and only then does the stop
    // complete.
    releaseExec?.();
    await running;
    await stopped;
    assert.equal(stopSettled, true);
  });

  it("runs no command after the session stopped", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const dcp = api.commands.find((command) => command.name === "dcp");
    assert.ok(dcp && typeof dcp.handler === "function");
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      SESSION_CTX,
    );
    await handlers.sessionShutdown(
      { type: "session_shutdown", reason: "quit" },
      SESSION_CTX,
    );
    const appended = api.appendedEntries.length;

    await (dcp.handler as (args: string, ctx: unknown) => Promise<void>)(
      "context",
      SESSION_CTX,
    );

    // The command body appends a report when it runs; a late command adds
    // nothing.
    assert.equal(api.appendedEntries.length, appended);
  });

  it("runs no command without a session id", async () => {
    const api = mockApi();
    await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any);
    const dcp = api.commands.find((command) => command.name === "dcp");
    assert.ok(dcp && typeof dcp.handler === "function");

    await (dcp.handler as (args: string, ctx: unknown) => Promise<void>)(
      "context",
      {},
    );

    assert.equal(api.appendedEntries.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed behaviour
// ---------------------------------------------------------------------------

describe("startPi — null profile fail-closed", () => {
  it("all six handlers no-op with a null profile", async () => {
    const handlers = await startInstance(piScope({}));
    // session_start with a ui ctx must not seed anything without a profile
    // (no pi switch host → fail-closed silent no-op).
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      {
        sessionManager: { getSessionId: () => "sess-null" },
        ui: { notify: () => {}, setWidget: () => {} },
      },
    );
    const prompt = await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      SESSION_CTX,
    );
    assert.ok(prompt);
    assert.equal(prompt.systemPrompt, "base");
    const resources = await handlers.resourcesDiscover(undefined, SESSION_CTX);
    assert.deepEqual(resources?.skillPaths, []);
    assert.equal(
      await handlers.toolResult(
        {
          type: "tool_result",
          toolName: "edit",
          toolCallId: "call-1",
          content: [{ type: "text", text: "x" }],
          isError: false,
        },
        SESSION_CTX,
      ),
      undefined,
    );
    const contextResult = await handlers.contextHandler(
      { type: "context", messages: [{ role: "user", content: "hi" }] },
      SESSION_CTX,
    );
    assert.deepEqual(contextResult, {
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(
      await handlers.messageEnd(
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[m3] hi" }],
          },
        },
        SESSION_CTX,
      ),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// plugin_init load-time event
// ---------------------------------------------------------------------------

describe("startPi — plugin_init load-time event", () => {
  it("emits plugin_init once at load with agents/skills/limits fields", async () => {
    // Init the logger so the load-time plugin_init is attributed to a
    // temp log dir instead of tripping the one-time used-before-init
    // warning (isolation pattern used across this file).
    const logDir = makeTmpDir("zoo-pi-log");
    try {
      initLogger("pi", { logDir });
      await startInstance(piScope(POLY_ZOO, MODES_RAW), undefined);
      const inits = _getBufferForTesting().filter(
        (entry) => entry.event === "plugin_init",
      );
      assert.equal(inits.length, 1, "exactly one plugin_init at load");
      const init = inits[0];
      assert.equal(init.hook, "plugin");
      assert.equal(init.sessionId, "");
      assert.equal(init.level, "info");
      assert.deepEqual(
        init.agents,
        POLY_PROFILE.agents,
        "agents must list the composed agent names",
      );
      assert.deepEqual(
        init.skills,
        POLY_PROFILE.skills,
        "skills must list the composed skill names",
      );
      assert.deepEqual(init.limits, {
        contextWordLimit: 200,
        promptWordLimit: 500,
      });
    } finally {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("null profile → plugin_init with empty agents/skills", async () => {
    const logDir = makeTmpDir("zoo-pi-log");
    try {
      initLogger("pi", { logDir });
      await startInstance(piScope({}));
      const inits = _getBufferForTesting().filter(
        (entry) => entry.event === "plugin_init",
      );
      assert.equal(inits.length, 1);
      assert.deepEqual(inits[0].agents, []);
      assert.deepEqual(inits[0].skills, []);
    } finally {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("buffers plugin_init sessionless; flush into the first pi session's file", async () => {
    const logDir = makeTmpDir("zoo-pi-log");
    try {
      initLogger("pi", { logDir });
      await startInstance(piScope(POLY_ZOO));

      // Load-time plugin_init is sessionless and no session exists yet:
      // it stays buffered and no pi.log host-level file is created.
      _flushForTesting();
      assert.equal(
        fs.existsSync(join(logDir, "pi.log")),
        false,
        "no host-level pi.log may be created",
      );
      assert.ok(
        _getBufferForTesting().some((e) => e.event === "plugin_init"),
        "plugin_init must remain buffered until a session exists",
      );

      // The first sessioned entry establishes the primary pi session;
      // the buffered plugin_init now flushes into its file.
      log.info({ hook: "plugin", event: "handler", sessionId: "pi-sess" });
      _flushForTesting();

      const primaryFile = join(logDir, "pi-pi-sess.log");
      assert.ok(
        fs.existsSync(primaryFile),
        "primary pi session file must exist",
      );
      const lines = fs.readFileSync(primaryFile, "utf-8").trimEnd().split("\n");
      const events = lines.map((line) => JSON.parse(line).event);
      assert.ok(
        events.includes("plugin_init"),
        "buffered plugin_init must land in the first pi session's file",
      );
      assert.equal(
        fs.existsSync(join(logDir, "pi.log")),
        false,
        "no host-level pi.log may be created",
      );
    } finally {
      try {
        fs.rmSync(logDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Sub-session inline extension
// ---------------------------------------------------------------------------

describe("buildPiSubagentExtension — the child runtime's ZooKeeper", () => {
  it("writes its session identity into the parent runtime's process state", async () => {
    // The child runtime is one delegation inside the parent's process: it
    // inherits the parent's owner, so the identity it resolves is the one
    // the parent's surfaces read.  A child that created its own owner would
    // leave the parent's store empty.
    const api = mockApi();
    await buildPiSubagentExtension(piScope(POLY_ZOO, MODES_RAW), {
      agent: "beaver",
      process: piProcess,
    })(api as any);

    await api.handlers.before_agent_start?.(
      { messageType: "user", systemPrompt: "base" },
      { sessionManager: { getSessionId: () => "sess-inherited" } },
    );

    assert.equal(
      piProcess.sessionAgents.resolve("sess-inherited"),
      "beaver",
      "the child binds into the parent's session registry",
    );
  });

  it("reports the close handle of the wiring it builds", async () => {
    const api = mockApi();

    const handle = await startPiRuntime(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
      {
        entryPath: "/zoo/src/pi.ts",
      },
      piProcess,
    );

    const first = await handle.stop();
    assert.deepEqual(first, { errors: [] });
    // The extension scope is terminal: a repeated close reports the same
    // outcome and disposes nothing twice.
    assert.deepEqual(await handle.stop(), first);
  });

  it("closes a child runtime whose start fails, without reporting a close", async () => {
    const api = mockApi();
    const failing = {
      ...api,
      registerCommand(): void {
        throw new Error("child write failed");
      },
    };
    const closes: Array<() => Promise<CleanupReport>> = [];
    const factory = buildPiSubagentExtension(piScope(POLY_ZOO, MODES_RAW), {
      agent: "beaver",
      process: piProcess,
      onClose: (close) => closes.push(close),
    });

    // The child start closes its own runtime, so the caller receives the
    // failure and no close handle: nothing is left for it to stop.
    await assert.rejects(factory(failing as any), /child write failed/);
    assert.deepEqual(closes, [], "a failed start reports no close handle");
  });

  it("builds the child handlers over the captured config snapshot", async () => {
    // A profile carrying the subagent tool: the child wires its own driver,
    // which is what lets a nested sub-session create its own inline factory.
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: { ...POLY_PROFILE, tools: ["subagent"] },
      },
    };
    const api = mockApi();
    const closes: Array<() => Promise<CleanupReport>> = [];
    const factory = buildPiSubagentExtension(piScope(zoo, MODES_RAW), {
      agent: "beaver",
      process: piProcess,
      entryPath: "/zoo/src/pi.ts",
      onClose: (close) => closes.push(close),
    });

    await factory(api as any);

    // The child runtime is fixed to the delegated agent, so its own
    // session resolves that agent with no ambient identity.
    await (api.handlers.before_agent_start as (...args: unknown[]) => unknown)(
      { messageType: "user", systemPrompt: "base" },
      { sessionManager: { getSessionId: () => "sess-child" } },
    );
    assert.equal(piProcess.sessionAgents.resolve("sess-child"), "beaver");

    // The child registers the same profile's surfaces and logs exactly one
    // composition anchor, so the config snapshot is composed once and never
    // re-read.
    assert.equal(typeof api.handlers.before_agent_start, "function");
    assert.equal(typeof api.handlers.context, "function");
    assert.ok(
      api.tools.some((tool: any) => tool.name === "subagent"),
      "the child wires its own subagent driver",
    );
    const inits = _getBufferForTesting().filter(
      (entry) => entry.event === "plugin_init",
    );
    assert.equal(inits.length, 1);
    assert.equal(
      (inits[0].agents as string[]).length,
      POLY_PROFILE.agents.length,
    );
    // The close handle of the child's own scope reaches the caller.
    assert.equal(closes.length, 1);
    assert.deepEqual(await closes[0](), { errors: [] });
  });
});

// ---------------------------------------------------------------------------
// Configuration generation — one immutable snapshot per process scope
// ---------------------------------------------------------------------------

describe("process scope — one configuration generation per scope", () => {
  /** The base names of the skill directories a discover result carries. */
  function skillNames(
    resources: { skillPaths: string[] } | undefined,
  ): string[] {
    return (resources?.skillPaths ?? []).map(
      (path) => path.split("/").pop() ?? "",
    );
  }

  it("parses the static config once per generation, not per instance", async () => {
    // An invalid `[zoo.ask]` section warns when the generation is parsed.
    // Neither the main instance nor the sub-session it spawns parses again:
    // both read the scope's snapshot.
    const scope = piScope({ ...POLY_ZOO, ask: "not-a-table" }, MODES_RAW);
    const validWarnings = () =>
      _getBufferForTesting().filter(
        (entry) => entry.event === "ask_config_invalid",
      ).length;

    const parentApi = mockApi();
    await startInstance(scope, parentApi as any);
    assert.equal(validWarnings(), 1, "the generation parses once");

    const childApi = mockApi();
    await buildPiSubagentExtension(scope, {
      agent: "beaver",
      process: piProcess,
    })(childApi as any);
    assert.equal(validWarnings(), 1, "a sub-session must not parse again");
  });

  it("hands the parent's snapshot to its sub-session", async () => {
    // The generation's skill rules filter each instance by its own
    // primary, and the child answers from the SAME snapshot the parent
    // read: one scope, two instances, no second parse.
    const raw = {
      agent: {
        dolphin: {
          mode: "primary",
          permission: { skill: { "*": "deny", grill: "allow" } },
        },
        lynx: {
          mode: "subagent",
          permission: { skill: { "*": "deny", "wiki-query": "allow" } },
        },
      },
    };
    const scope = piScope(POLY_ZOO, raw);
    assert.equal(Object.isFrozen(scope.snapshot.skillPermissions), true);

    const parentApi = mockApi();
    const parent = await startInstance(scope, parentApi as any);
    piProcess.sessionAgents.bind("sess-parent", "dolphin");
    const parentResources = await parent.resourcesDiscover(undefined, {
      sessionManager: { getSessionId: () => "sess-parent" },
    });
    assert.deepEqual(skillNames(parentResources), ["grill"]);

    const childApi = mockApi();
    await buildPiSubagentExtension(scope, {
      agent: "lynx",
      process: piProcess,
    })(childApi as any);
    const childResources = (await (
      childApi.handlers.resources_discover as (...args: unknown[]) => unknown
    )(undefined, SESSION_CTX)) as { skillPaths: string[] } | undefined;
    assert.deepEqual(skillNames(childResources), ["wiki-query"]);
  });

  it("resolves sub-session models from the generation, never agents.json", async () => {
    // Strict mode: the snapshot's model map is the sole source.  This
    // process' own agents.json carries an entry for `beaver`, so a
    // fail-closed result proves the file is never read here.
    const zoo = {
      mode: { poly: { ...POLY_PROFILE, tools: ["subagent"], hooks: [] } },
    };
    const resolved: string[] = [];
    const driver: SubagentDriver = {
      async run(request) {
        resolved.push(request.model);
        return { kind: "ok", text: "done" };
      },
    };
    const input = { agent: "beaver", description: "实现任务", prompt: "t" };

    const configuredApi = mockApi();
    await startInstance(
      piScope(zoo, MODES_RAW, { beaver: "Dummy/dummy-small" }),
      configuredApi as any,
      { subagentDriver: driver },
    );
    const configured = configuredApi.tools.find(
      (tool: any) => tool.name === "subagent",
    ) as { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    assert.ok(configured);
    await configured.execute(
      "call-model",
      input,
      undefined,
      undefined,
      SESSION_CTX,
    );
    assert.deepEqual(resolved, ["Dummy/dummy-small"]);

    // An empty map closes the delegation: no inheritance, no fallback.
    const emptyScope = piScope(zoo, MODES_RAW, {});
    const closedApi = mockApi();
    await startInstance(emptyScope, closedApi as any, {
      subagentDriver: driver,
    });
    const closed = closedApi.tools.find(
      (tool: any) => tool.name === "subagent",
    ) as { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    assert.ok(closed);
    const refused = (await closed.execute(
      "call-missing-model",
      input,
      undefined,
      undefined,
      SESSION_CTX,
    )) as { content: { text?: string }[] };
    assert.ok(
      refused.content[0]?.text?.includes("未配置子 agent 模型"),
      "a missing entry reports the actionable error",
    );
    assert.deepEqual(resolved, ["Dummy/dummy-small"], "the driver never ran");

    // The sub-session inherits that same map: a child built from this
    // generation answers exactly like its parent, so the delegation closes
    // there too.
    const childApi = mockApi();
    await buildPiSubagentExtension(emptyScope, {
      agent: "beaver",
      process: piProcess,
    })(childApi as any);
    const child = childApi.tools.find(
      (tool: any) => tool.name === "subagent",
    ) as { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    assert.ok(child, "the child wires its own subagent tool");
    const childRefused = (await child.execute(
      "call-child-model",
      input,
      undefined,
      undefined,
      SESSION_CTX,
    )) as { content: { text?: string }[] };
    assert.ok(
      childRefused.content[0]?.text?.includes("未配置子 agent 模型"),
      "the child reads the parent's model map too",
    );
  });
});
