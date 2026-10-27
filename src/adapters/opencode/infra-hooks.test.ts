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
import type { Decision } from "../../core/loop/settle.js";
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

/** A settle strategy that always wakes. */
const WAKE = {
  name: "strategy",
  maxWakes: 3,
  async handle(): Promise<Decision> {
    return { kind: "wake", text: "finish the work" };
  },
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
 * @param agents - Session → agent bindings the resolver answers from.
 * @param orchestrator - The orchestrator the selection resolved.
 * @returns The hooks, the lifecycle, and the recorded `promptAsync` bodies.
 */
function makeHooks(
  agents: Record<string, string>,
  orchestrator: string | undefined,
) {
  const wakes: Array<{ agent?: string; parts: unknown[] }> = [];
  const declarations = createOpenCodeHostServices({ onSettled: [WAKE] });
  const wiring = createOpenCodeLifecycleWiring({
    extensionServices: declarations.extension,
    sessionServices: declarations.session,
  });
  const hooks = buildInfraHooks({
    client: {
      session: {
        messages: async () => SETTLED_TRANSCRIPT,
        promptAsync: async (input: { body: { agent?: string } }) => {
          wakes.push(input.body as { agent?: string; parts: unknown[] });
          return {};
        },
      },
    },
    resolveAgent: (sessionID) => agents[sessionID],
    promptVariants: [],
    orchestrator,
    sessions: {
      sessionState: async (sessionID) =>
        sessionScopeState(await wiring.ensureSession(sessionID)),
      handleEvent: (event) => wiring.handleEvent(event),
    },
  });
  return { hooks, wakes, wiring };
}

/** Send one `session.idle` event for `sessionID`. */
async function idle(
  hooks: ReturnType<typeof makeHooks>["hooks"],
  sessionID: string,
): Promise<void> {
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID } },
  });
}

describe("infra hooks — orchestrator gate", () => {
  it("wakes the session that resolved as the declared orchestrator", async () => {
    const { hooks, wakes } = makeHooks({ s1: "planner" }, "planner");

    await idle(hooks, "s1");

    assert.equal(wakes.length, 1, "the orchestrator session must wake");
    assert.equal(wakes[0].agent, "planner");
  });

  it("does not treat a known agent as the orchestrator by name", async () => {
    // dolphin is a real agent, but this selection's orchestrator is
    // another one: only the resolved role may wake.
    const { hooks, wakes } = makeHooks({ s1: "dolphin" }, "planner");

    await idle(hooks, "s1");

    assert.equal(wakes.length, 0);
  });

  it("stays inert when the selection resolved no orchestrator", async () => {
    const { hooks, wakes } = makeHooks({ s1: "dolphin" }, undefined);

    await idle(hooks, "s1");

    assert.equal(wakes.length, 0);
  });
});

describe("infra hooks — per-session state", () => {
  /** Send one `session.error` abort for `sessionID`. */
  async function abort(
    hooks: ReturnType<typeof makeHooks>["hooks"],
    sessionID: string,
  ): Promise<void> {
    await hooks.event({
      event: {
        type: "session.error",
        properties: { sessionID, error: { name: "MessageAbortedError" } },
      },
    });
  }

  it("records an abort on a session whose first event is the abort", async () => {
    const { hooks, wakes } = makeHooks({ s1: "planner" }, "planner");

    // No `session.created` ever arrives: the abort is the first thing this
    // instance hears about the session.
    await abort(hooks, "s1");
    await idle(hooks, "s1");

    assert.equal(wakes.length, 0, "the aborted turn must stay silent");
  });

  it("consumes the abort once, so the next settle is judged again", async () => {
    const { hooks, wakes } = makeHooks({ s1: "planner" }, "planner");

    await abort(hooks, "s1");
    await idle(hooks, "s1");
    await idle(hooks, "s1");

    assert.equal(wakes.length, 1, "the second settle is not aborted");
  });

  it("keeps one session's abort away from its sibling", async () => {
    const { hooks, wakes } = makeHooks(
      { s1: "planner", s2: "planner" },
      "planner",
    );

    await abort(hooks, "s1");
    await idle(hooks, "s2");

    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].agent, "planner");
  });
});
