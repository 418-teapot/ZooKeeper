/**
 * Tests for the always-on infrastructure hooks' orchestrator gate.
 *
 * The settle/wake path is role-gated: only a session whose resolved agent
 * is the orchestrator the selection declared may wake, and the wake is
 * delivered to that same agent.  The name is an assembly input, never a
 * constant of this module — a profile that resolved no orchestrator keeps
 * the path inert (fail-closed).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createConfigScope } from "../../core/config-snapshot.js";
import { createContextRuntime } from "../../core/context/runtime.js";
import { createProcessState } from "../../core/process-state.js";
import { createSessionAgentResource } from "../../core/session/agent.js";
import {
  contextSessionResources,
  createSessionResourceCatalog,
} from "../../core/session/resources.js";
import { makeTmpDir } from "../../testkits/tmp.js";
import { _resetForTesting, initLogger } from "../../utils/logger.js";
import { buildInfraHooks } from "./infra-hooks.js";
import { createOpenCodeLifecycleWiring } from "./lifecycle-wiring.js";
import { createOpenCodeHostServices, sessionScopeState } from "./services.js";

let _loggerDir: string;

beforeEach(() => {
  _resetForTesting();
  _loggerDir = makeTmpDir("zoo-infra-hooks");
  initLogger("opencode", { logDir: _loggerDir });
});

afterEach(() => {
  _resetForTesting();
  try {
    rmSync(_loggerDir, { recursive: true, force: true });
  } catch {
    // the shard files are best-effort cleanup
  }
});

/**
 * The profile the compositions under test run: the product's orchestrator
 * plus the todo-continuation strategy, which is the settle strategy the
 * engine is built from.
 */
const ZOO = {
  mode: {
    poly: {
      agents: ["dolphin", "mola"],
      skills: [],
      hooks: ["todo-continuation"],
      tools: [],
      commands: [],
    },
  },
  continuation: { max_wakes: 3 },
};

/** The agent table marking both profile agents primary. */
const AGENTS: Record<string, unknown> = {
  dolphin: { mode: "primary" },
  mola: { mode: "primary" },
};

/** The host config serving the materialisation facts of the profile. */
const HOST_CONFIG = {
  config: { get: async () => ({ data: { agent: AGENTS } }) },
};

/** The todo list one settled turn is judged against: unfinished work. */
const ACTIVE_TODOS = {
  data: [{ content: "finish the work", status: "in_progress" }],
};

/** The transcript a settled turn is classified from: plain, no tools. */
const SETTLED_TRANSCRIPT = {
  data: [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
  ],
};

/**
 * Build the infrastructure hooks over the real OpenCode lifecycle wiring.
 *
 * The profile decides the orchestrator the gate compares against, so a
 * busier configuration is a `ready` one and an empty one resolves no role.
 *
 * @param agents - Session → agent bindings the resolver answers from.
 * @param ready - Whether the instance runs the profile (and thus a role).
 * @returns The hooks, the lifecycle, and the recorded `promptAsync` bodies.
 */
async function makeHooks(
  agents: Record<string, string>,
  ready = true,
): Promise<{
  hooks: ReturnType<typeof buildInfraHooks>;
  wakes: Array<{ agent?: string; parts: unknown[] }>;
  wiring: ReturnType<typeof createOpenCodeLifecycleWiring>;
}> {
  const wakes: Array<{ agent?: string; parts: unknown[] }> = [];
  const contextRuntime = createContextRuntime();
  const process = createProcessState();
  const sessionCatalog = createSessionResourceCatalog([
    ...contextSessionResources(contextRuntime),
    createSessionAgentResource(process.sessionAgents),
  ]);
  const client = {
    ...(ready ? HOST_CONFIG : {}),
    session: {
      messages: async () => SETTLED_TRANSCRIPT,
      todo: async () => ACTIVE_TODOS,
      promptAsync: async (input: { body: { agent?: string } }) => {
        wakes.push(input.body as { agent?: string; parts: unknown[] });
        return {};
      },
    },
  };
  const declarations = createOpenCodeHostServices({
    scope: createConfigScope(ready ? ZOO : {}, ready ? { agent: AGENTS } : {}),
    client,
    directory: "",
    process,
    contextRuntime,
    sessionCatalog,
  });
  const wiring = createOpenCodeLifecycleWiring({
    extensionServices: declarations.extension,
    sessionServices: declarations.session,
    sessionCatalog,
  });
  const { services } = await wiring.activateExtension();
  const hooks = buildInfraHooks({
    client,
    sessionAgents: process.sessionAgents,
    resolveAgent: (sessionID) => agents[sessionID],
    promptVariants: [],
    orchestrator: services.composition.selection.orchestrator,
    contextRuntime,
    sessions: {
      sessionState: async (sessionID) =>
        sessionScopeState(await wiring.ensureSession(sessionID)),
      handleEvent: (event) => wiring.handleEvent(event),
    },
  });
  return { hooks, wakes, wiring };
}

/** The hooks one activated instance exposes. */
type Hooks = Awaited<ReturnType<typeof makeHooks>>["hooks"];

/** Send one `session.idle` event for `sessionID`. */
async function idle(hooks: Hooks, sessionID: string): Promise<void> {
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID } },
  });
}

describe("infra hooks — orchestrator gate", () => {
  it("wakes the session that resolved as the declared orchestrator", async () => {
    const { hooks, wakes } = await makeHooks({ s1: "dolphin" });

    await idle(hooks, "s1");

    assert.equal(wakes.length, 1, "the orchestrator session must wake");
    assert.equal(wakes[0].agent, "dolphin");
  });

  it("does not treat a known agent as the orchestrator by name", async () => {
    // mola is a real primary of the profile, but the selection resolves
    // dolphin as the orchestrator: only the resolved role may wake.
    const { hooks, wakes } = await makeHooks({ s1: "mola" });

    await idle(hooks, "s1");

    assert.equal(wakes.length, 0);
  });

  it("stays inert when the selection resolved no orchestrator", async () => {
    const { hooks, wakes } = await makeHooks({ s1: "dolphin" }, false);

    await idle(hooks, "s1");

    assert.equal(wakes.length, 0);
  });
});

describe("infra hooks — per-session state", () => {
  /** Send one `session.error` abort for `sessionID`. */
  async function abort(hooks: Hooks, sessionID: string): Promise<void> {
    await hooks.event({
      event: {
        type: "session.error",
        properties: { sessionID, error: { name: "MessageAbortedError" } },
      },
    });
  }

  it("records an abort on a session whose first event is the abort", async () => {
    const { hooks, wakes } = await makeHooks({ s1: "dolphin" });

    // No `session.created` ever arrives: the abort is the first thing this
    // instance hears about the session.
    await abort(hooks, "s1");
    await idle(hooks, "s1");

    assert.equal(wakes.length, 0, "the aborted turn must stay silent");
  });

  it("consumes the abort once, so the next settle is judged again", async () => {
    const { hooks, wakes } = await makeHooks({ s1: "dolphin" });

    await abort(hooks, "s1");
    await idle(hooks, "s1");
    await idle(hooks, "s1");

    assert.equal(wakes.length, 1, "the second settle is not aborted");
  });

  it("keeps one session's abort away from its sibling", async () => {
    const { hooks, wakes } = await makeHooks({
      s1: "dolphin",
      s2: "dolphin",
    });

    await abort(hooks, "s1");
    await idle(hooks, "s2");

    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].agent, "dolphin");
  });
});
