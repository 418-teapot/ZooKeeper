/**
 * Tests for the pi event handlers (`src/adapters/pi/handlers.ts`).
 *
 * The handlers are exercised through the production start
 * (`startPi`), which is how pi reaches them: identity-dispatch
 * prompt injection, `resources_discover` skill filtering by the active
 * primary's permission rules, the compose-driven `tool_result` /
 * `context` chains, the todo tool's cache invalidation on
 * `session_tree`, and the widget cache refresh triggers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { BEAVER_PROMPT } from "../../agents/beaver.js";
import type { ComposedResult } from "../../core/compose.js";
import { createContextRuntime } from "../../core/context/runtime.js";
import {
  defineSessionService,
  type WorkPermit,
} from "../../core/lifecycle/index.js";
import {
  DIRECT_WORK_NUDGE,
  JSON_ERROR_REMINDER_MARKER,
  VERIFY_REMINDER,
} from "../../core/prompts.js";
import { createSessionResourceCatalog } from "../../core/session/resources.js";
import {
  composePi,
  joinedText,
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
} from "../../testkits/pi-wiring.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { createPiEventHandlers, type PiEventHandlerDeps } from "./handlers.js";
import { createPiLifecycleWiring } from "./lifecycle-wiring.js";
import { createPiProcessState, type PiProcessState } from "./process.js";
import { piSettleStateService } from "./services.js";
import {
  createPiSessionContexts,
  type PiSessionContexts,
} from "./session-contexts.js";
import type { PiHistoryEntry } from "./subagent-scan.js";

/**
 * The pi process this test file drives: one owner per test, so a runtime and
 * the assertions that read its writes share it.
 */
let piProcess: PiProcessState = createPiProcessState();

beforeEach(() => {
  piProcess = createPiProcessState();
});

afterEach(resetPiTestState);

/** The session id `SESSION_CTX` names, for binding its identity. */
const SESSION_ID = "sess-1";

/**
 * Bind one session to an agent.
 *
 * Identity is per session: a test states which agent drives which session.
 */
/** Start one pi instance over this test's process state. */
function startInstance(
  scope: Parameters<typeof startPi>[0],
  pi?: unknown,
  overrides?: Parameters<typeof startPi>[2],
): ReturnType<typeof startPi> {
  return startPi(scope, pi, overrides, piProcess);
}

function bindAgent(sessionID: string, name: string): void {
  piProcess.sessionAgents.bind(sessionID, name);
}

// The official transcript message components render through the coding-agent
// module-level theme singleton; the built-in dark theme ships with the
// package and needs no configuration.  Bun runs each test file in its own
// worker, so the initialization never leaks into other files.
initTheme();

// ---------------------------------------------------------------------------
// Todo cache invalidation (session_tree)
// ---------------------------------------------------------------------------

describe("session_tree — todo cache invalidation", () => {
  /** The poly profile plus the todo tool, so the unit registers it. */
  const TODO_ZOO = {
    ...POLY_ZOO,
    mode: {
      poly: { ...POLY_PROFILE, tools: [...POLY_PROFILE.tools, "todo"] },
    },
  };

  /**
   * Build a session context whose history scan counts invocations, so the
   * store's cache behaviour is observable through the registered tool.
   */
  function scanCtx(sessionId: string) {
    const scans: { count: number } = { count: 0 };
    const ctx = {
      sessionManager: {
        getSessionId: () => sessionId,
        getBranch: () => {
          scans.count += 1;
          return [];
        },
      },
    };
    return { ctx, scans };
  }

  it("the todo tool registers with its pi card renderers", async () => {
    const api = mockApi();
    await startInstance(piScope(TODO_ZOO, MODES_RAW), api as any);
    const todo = api.tools.find((tool: any) => tool.name === "todo") as any;
    assert.ok(todo, "the todo tool must register when the profile lists it");
    assert.equal(typeof todo.renderCall, "function");
    assert.equal(typeof todo.renderResult, "function");
  });

  it("the tool restores once per cache miss and session_tree forces a re-scan", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(TODO_ZOO, MODES_RAW),
      api as any,
    );
    const todo = api.tools.find((tool: any) => tool.name === "todo") as any;
    assert.ok(todo, "the todo tool must register when the profile lists it");

    const { ctx, scans } = scanCtx("sess-tree");
    // Publish this session to the shared holder: the scan reads the
    // latest handled event's session manager through it.  This seeding path
    // does not refresh the widget, so the scan count below only reflects
    // the tool's cache behaviour.
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );

    await todo.execute("call-1", { op: "view" }, undefined, undefined, ctx);
    assert.equal(scans.count, 1, "a cache miss scans the transcript once");
    await todo.execute("call-2", { op: "view" }, undefined, undefined, ctx);
    assert.equal(scans.count, 1, "a cached read must not re-scan");

    // Tree navigation drops the cache; the widget refresh then re-reads the
    // transcript eagerly, so the next tool call is served from the restored
    // cache instead of scanning again.
    await handlers.sessionTree(undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      scans.count,
      2,
      "tree navigation must re-scan for the restored view",
    );
    await todo.execute("call-3", { op: "view" }, undefined, undefined, ctx);
    assert.equal(
      scans.count,
      2,
      "the eager refresh already repopulated the cache",
    );
  });

  it("is a no-op without a session id in the event context", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(TODO_ZOO, MODES_RAW),
      api as any,
    );
    await assert.doesNotReject(handlers.sessionTree());
    await assert.doesNotReject(handlers.sessionTree(undefined, {}));
    await assert.doesNotReject(
      handlers.sessionTree(undefined, {
        sessionManager: { getSessionId: () => "" },
      }),
    );
  });

  it("piApi absent → no store owned → the handler is a no-op", async () => {
    // Without a real pi API the entry point owns no todo store (the tool
    // never registers, fail-closed): the handler must not crash over it.
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    await assert.doesNotReject(handlers.sessionTree());
    await assert.doesNotReject(
      handlers.sessionTree(undefined, {
        sessionManager: { getSessionId: () => "sess-tree" },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Todo view — widget cache refresh
// ---------------------------------------------------------------------------

describe("todo view — widget cache refresh triggers", () => {
  /** The poly profile plus the todo tool, so the unit registers it. */
  const TODO_ZOO = {
    ...POLY_ZOO,
    mode: {
      poly: { ...POLY_PROFILE, tools: [...POLY_PROFILE.tools, "todo"] },
    },
  };

  /** Let a fire-and-forget cache refresh settle before asserting. */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** A widget-recording ui ctx whose session resolves to `sessionId`. */
  function todoWidgetCtx(sessionId: string) {
    const calls: Array<[string, unknown]> = [];
    const ctx = {
      sessionManager: { getSessionId: () => sessionId },
      ui: {
        notify: () => {},
        setWidget: (key: string, content: unknown) =>
          calls.push([key, content]),
      },
    };
    return { calls, ctx };
  }

  it("a successful todo tool_result refreshes the widget's todo cache", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(TODO_ZOO, MODES_RAW),
      api as any,
    );
    const { calls, ctx } = todoWidgetCtx("sess-todo-widget");
    await handlers.sessionStart({ type: "session_start" }, ctx);
    await flush();

    const todo = api.tools.find((tool: any) => tool.name === "todo") as any;
    await todo.execute(
      "call-1",
      { op: "init", tasks: ["Wire widget"] },
      undefined,
      undefined,
      ctx,
    );

    // Writing the store alone does not touch the widget's todo cache.
    const before = renderZooWidget(calls);
    try {
      assert.ok(!before.lines.join("\n").includes("Wire widget"));
    } finally {
      before.dispose();
    }

    await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "todo",
        toolCallId: "call-1",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
      ctx,
    );
    await flush();

    const after = renderZooWidget(calls);
    try {
      assert.ok(after.lines.join("\n").includes("Wire widget"));
    } finally {
      after.dispose();
    }
  });

  it("ignores other tool names and error results", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(TODO_ZOO, MODES_RAW),
      api as any,
    );
    const { calls, ctx } = todoWidgetCtx("sess-todo-ignore");
    await handlers.sessionStart({ type: "session_start" }, ctx);
    await flush();
    const todo = api.tools.find((tool: any) => tool.name === "todo") as any;
    await todo.execute(
      "call-1",
      { op: "init", tasks: ["Hidden task"] },
      undefined,
      undefined,
      ctx,
    );

    // A non-todo result and a failed todo result must both leave the cache
    // untouched, so the task never reaches the widget.
    await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "call-2",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
      ctx,
    );
    await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "todo",
        toolCallId: "call-3",
        content: [{ type: "text", text: "boom" }],
        isError: true,
      },
      ctx,
    );
    await flush();

    const { lines, dispose } = renderZooWidget(calls);
    try {
      assert.ok(!lines.join("\n").includes("Hidden task"));
    } finally {
      dispose();
    }
  });

  it("session_tree re-fetches the todo cache for the widget", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(TODO_ZOO, MODES_RAW),
      api as any,
    );
    const scans = { count: 0 };
    const ctx = {
      sessionManager: {
        getSessionId: () => "sess-tree-widget",
        getBranch: () => {
          scans.count += 1;
          return [];
        },
      },
      ui: { notify: () => {}, setWidget: () => {} },
    };
    await handlers.sessionStart({ type: "session_start" }, ctx);
    await flush();
    const afterStart = scans.count;

    await handlers.sessionTree(undefined, ctx);
    await flush();
    assert.equal(
      scans.count,
      afterStart + 1,
      "tree navigation must re-read the store for the widget",
    );
  });

  it("keeps each session's widget and todo column on that session", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(TODO_ZOO, MODES_RAW),
      api as any,
    );
    // Each widget needs its own session's primary: the fleet line is
    // primary-driven, and a session without one renders nothing.
    bindAgent("sess-widget-a", "dolphin");
    bindAgent("sess-widget-b", "dolphin");
    const a = todoWidgetCtx("sess-widget-a");
    const b = todoWidgetCtx("sess-widget-b");
    await handlers.sessionStart({ type: "session_start" }, a.ctx);
    await handlers.sessionStart({ type: "session_start" }, b.ctx);
    await flush();
    const todo = api.tools.find((tool: any) => tool.name === "todo") as any;
    await todo.execute(
      "call-a",
      { op: "init", tasks: ["Plan A"] },
      undefined,
      undefined,
      a.ctx,
    );
    await todo.execute(
      "call-b",
      { op: "init", tasks: ["Plan B"] },
      undefined,
      undefined,
      b.ctx,
    );

    // Only session A's tool result refreshes a todo column: it may refresh
    // A's, and must leave B's untouched.
    await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "todo",
        toolCallId: "call-a",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
      a.ctx,
    );
    await flush();

    const renderedA = renderZooWidget(a.calls);
    const renderedB = renderZooWidget(b.calls);
    try {
      const linesA = renderedA.lines.join("\n");
      const linesB = renderedB.lines.join("\n");
      assert.ok(linesA.includes("Plan A"), linesA);
      assert.ok(!linesA.includes("Plan B"), "A never shows B's plan");
      assert.ok(
        !linesB.includes("Plan A"),
        "B's widget must not render A's todo column",
      );
    } finally {
      renderedA.dispose();
      renderedB.dispose();
    }

    // A second session's own result refreshes its own column only.
    await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "todo",
        toolCallId: "call-b",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
      b.ctx,
    );
    await flush();
    const afterB = renderZooWidget(b.calls);
    try {
      assert.ok(afterB.lines.join("\n").includes("Plan B"));
    } finally {
      afterB.dispose();
    }
  });

  it("no store → the three triggers stay harmless", async () => {
    // Without a pi API the factory owns no todo store; the cache then stays
    // empty, so the widget's todo column resolves to no phases.  All three
    // refresh triggers must remain silent no-ops.
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    await assert.doesNotReject(handlers.sessionTree());
    await assert.doesNotReject(() =>
      handlers.sessionStart(undefined, undefined),
    );
    await assert.doesNotReject(() =>
      handlers.toolResult(
        {
          type: "tool_result",
          toolName: "todo",
          toolCallId: "call-1",
          content: [],
          isError: false,
        },
        {},
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Prompt injection + skill discovery handlers
// ---------------------------------------------------------------------------

describe("startPi — prompt injection + skill discovery", () => {
  it("poly full → default primary prompt prepended, all 11 skill dirs discovered", async () => {
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    const result = await handlers.beforeAgentStart(
      {
        messageType: "user",
        systemPrompt: "base",
      },
      SESSION_CTX,
    );
    assert.ok(result);
    assert.ok(result.systemPrompt.startsWith("<Role>"));
    assert.ok(result.systemPrompt.endsWith("base"));

    // The default primary (first in profile array order) is dolphin:
    // its orchestrator prompt is the prepended one.
    assert.ok(result.systemPrompt.includes("对最终交付负责"));

    const resources = await handlers.resourcesDiscover(undefined, SESSION_CTX);
    assert.ok(resources);
    assert.equal(resources.skillPaths.length, 11);
    for (const path of resources.skillPaths) {
      assert.ok(fs.existsSync(path), `${path} must exist`);
      assert.ok(
        POLY_PROFILE.skills.some((name) => path.endsWith(name)),
        `${path} must match a profile skill`,
      );
    }
  });

  it("null profile → prompt untouched, no skill paths", async () => {
    const handlers = await startInstance(piScope({}));
    const result = await handlers.beforeAgentStart(
      {
        messageType: "user",
        systemPrompt: "base",
      },
      SESSION_CTX,
    );
    assert.ok(result);
    assert.equal(result.systemPrompt, "base");

    const resources = await handlers.resourcesDiscover(undefined, SESSION_CTX);
    assert.ok(resources);
    assert.deepEqual(resources.skillPaths, []);
  });

  it("profile without the orchestrator → prompt untouched; no skill paths", async () => {
    // The profile omits the orchestrator, so the selection is invalid and
    // nothing composes.  Bind a sentinel name outside the profile so the
    // assertion is order-independent.
    bindAgent(SESSION_ID, "ghost");
    const zoo = {
      mode: {
        poly: { ...POLY_PROFILE, agents: ["mola"], skills: ["git-commit"] },
      },
    };
    const handlers = await startInstance(piScope(zoo, MODES_RAW), undefined);
    const result = await handlers.beforeAgentStart(
      {
        messageType: "user",
        systemPrompt: "base",
      },
      SESSION_CTX,
    );
    assert.ok(result);
    assert.equal(result.systemPrompt, "base");

    const resources = await handlers.resourcesDiscover(undefined, SESSION_CTX);
    assert.ok(resources);
    assert.deepEqual(resources.skillPaths, []);
  });
});

// ---------------------------------------------------------------------------
// Skill discovery filtering by the primary's permission.skill rules
// ---------------------------------------------------------------------------

describe("startPi — resourcesDiscover skill filtering", () => {
  /** Raw config with skill rules mirroring config.toml's [agent.mola]. */
  const MOLA_SKILLS_RAW = {
    agent: {
      dolphin: { mode: "primary" },
      mola: {
        mode: "primary",
        permission: {
          skill: {
            "*": "deny",
            "first-principles": "allow",
            grill: "allow",
            "mola-plan": "allow",
            "wiki-query": "allow",
          },
        },
      },
    },
  };

  /** Raw config with skill rules mirroring config.toml's [agent.dolphin]. */
  const DOLPHIN_SKILLS_RAW = {
    agent: {
      dolphin: {
        mode: "primary",
        permission: {
          skill: {
            "beaver-*": "deny",
            "kiwi-*": "deny",
            "mola-*": "deny",
          },
        },
      },
    },
  };

  it("primary mola → only his allowed skills are contributed", async () => {
    const handlers = await startInstance(
      piScope(POLY_ZOO, MOLA_SKILLS_RAW),
      undefined,
    );
    // The session resolves dolphin (the poly profile's orchestrator) by
    // default, but only mola declares skill rules — so a session bound to
    // mola filters by his ruleset.
    bindAgent(SESSION_ID, "mola");
    const resources = await handlers.resourcesDiscover(undefined, SESSION_CTX);
    assert.ok(resources);
    const names = resources.skillPaths.map((p) => p.split("/").pop());
    assert.deepEqual(
      names.sort(),
      ["first-principles", "grill", "mola-plan", "wiki-query"].sort(),
      "only mola's allowed skills pass the catch-all deny",
    );
  });

  it("primary dolphin → his denied globs are excluded, the rest stay", async () => {
    const handlers = await startInstance(
      piScope(POLY_ZOO, DOLPHIN_SKILLS_RAW),
      undefined,
    );
    // The session resolves dolphin, the poly profile's orchestrator.
    const resources = await handlers.resourcesDiscover(undefined, SESSION_CTX);
    assert.ok(resources);
    const names = resources.skillPaths.map((p) => p.split("/").pop() ?? "");
    assert.equal(names.length, 7, "4 of the 11 profile skills are denied");
    assert.ok(!names.some((n) => n.startsWith("beaver-")));
    assert.ok(!names.some((n) => n.startsWith("kiwi-")));
    assert.ok(!names.some((n) => n.startsWith("mola-")));
    assert.ok(names.includes("wiki-query"));
    assert.ok(names.includes("git-commit"));
  });

  it("no skill rules for the seeded primary → full profile list unfiltered", async () => {
    // A sentinel primary with no `permission.skill` rules means no
    // filtering applies, so the handler contributes exactly as before the
    // filtering change.
    bindAgent(SESSION_ID, "ghost");
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    const resources = await handlers.resourcesDiscover(undefined, SESSION_CTX);
    assert.ok(resources);
    assert.equal(resources.skillPaths.length, 11);
  });

  it("primary without a skill rules entry → unfiltered (machinery-off)", async () => {
    // The session resolves dolphin, which has no `permission.skill` rules
    // in the raw config → no filtering applies, matching default-allow.
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    const resources = await handlers.resourcesDiscover(undefined, SESSION_CTX);
    assert.ok(resources);
    assert.equal(resources.skillPaths.length, 11);
  });

  it("emits a skills_filtered info event with kept/dropped counts", async () => {
    _resetForTesting();
    const handlers = await startInstance(
      piScope(POLY_ZOO, DOLPHIN_SKILLS_RAW),
      undefined,
    );
    await handlers.resourcesDiscover(undefined, SESSION_CTX);
    const filtered = _getBufferForTesting().filter(
      (entry) => entry.event === "skills_filtered",
    );
    assert.equal(filtered.length, 1, "exactly one filtering event");
    assert.equal(filtered[0].level, "info");
    assert.equal(filtered[0].agent, "dolphin");
    assert.equal(filtered[0].kept, 7);
    assert.equal(filtered[0].dropped, 4);
  });

  it("emits no filtering event when no filtering applies", async () => {
    _resetForTesting();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    await handlers.resourcesDiscover(undefined, SESSION_CTX);
    const filtered = _getBufferForTesting().filter(
      (entry) => entry.event === "skills_filtered",
    );
    assert.deepEqual(filtered, []);
  });
});

// ---------------------------------------------------------------------------
// Identity-dispatch prompt injection
// ---------------------------------------------------------------------------

describe("startPi — identity-dispatch prompt injection", () => {
  it("default primary prompt is prepended", async () => {
    // The main runtime resolves the orchestrator the selection resolved
    // (dolphin) for a session no other source answers.
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );

    const result = await handlers.beforeAgentStart(
      {
        messageType: "user",
        systemPrompt: "base",
      },
      SESSION_CTX,
    );
    assert.ok(result);
    assert.ok(result.systemPrompt.startsWith("<Role>"));
    assert.ok(
      result.systemPrompt.includes("对最终交付负责"),
      "dolphin prompt must be prepended",
    );
    assert.ok(result.systemPrompt.endsWith("base"));
  });

  it("selects the gpt prompt variant from the context model", async () => {
    // Independent wordings: the base line every model gets and the gpt
    // line the gpt family gets.
    const BASE = "- 有职责匹配的 agent 时，**不得**因省事自行接管其工作；";
    const GPT =
      "- 职责匹配只决定可以委派给谁，不决定一定委派或不委派；**不得**因为下一步动作更方便，或因为存在匹配的 agent，就跳过完整交付成本判断；";

    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );

    const gpt = await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      {
        sessionManager: { getSessionId: () => "sess-1" },
        model: { id: "openai/gpt-5.5" },
      },
    );
    assert.ok(gpt);
    assert.ok(gpt.systemPrompt.includes(GPT), "gpt model uses the gpt line");
    assert.ok(!gpt.systemPrompt.includes(BASE));

    const unknown = await handlers.beforeAgentStart(
      {
        messageType: "user",
        systemPrompt: "base",
      },
      SESSION_CTX,
    );
    assert.ok(unknown);
    assert.ok(unknown.systemPrompt.includes(BASE), "no model falls back");
    assert.ok(!unknown.systemPrompt.includes(GPT));
  });

  it("a session bound to the other primary gets that prompt", async () => {
    // The session resolves dolphin by default; a binding written after
    // composition (what a switch does) must be reflected by the next
    // before_agent_start: the second primary (mola) prompt is injected.
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    bindAgent(SESSION_ID, "mola");
    const result = await handlers.beforeAgentStart(
      {
        messageType: "user",
        systemPrompt: "base",
      },
      SESSION_CTX,
    );
    assert.ok(result);
    assert.ok(result.systemPrompt.startsWith("<Role>"));
    assert.ok(
      result.systemPrompt.includes("你是 mola，一个方案规划 agent"),
      "mola prompt must be prepended for the bound session",
    );
    assert.ok(result.systemPrompt.endsWith("base"));
  });

  it("a sub-session runtime injects its fixed agent's prompt", async () => {
    // The inline factory a delegation loads fixes the agent, so every
    // session of that runtime is that delegation — no ambient scope.
    const { publication: handlers } = await startPiRuntime(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
      undefined,
      piProcess,
      { kind: "subagent", agent: "beaver" },
    );
    const result = await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      { sessionManager: { getSessionId: () => "sess-child" } },
    );
    assert.ok(result);
    assert.equal(result.systemPrompt, `${BEAVER_PROMPT}\n\nbase`);
  });

  it("a sub-session runtime injects a non-orchestrator agent's prompt", async () => {
    const { publication: handlers } = await startPiRuntime(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
      undefined,
      piProcess,
      { kind: "subagent", agent: "lynx" },
    );
    const result = await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      { sessionManager: { getSessionId: () => "sess-child" } },
    );
    assert.ok(result);
    const injected = result.systemPrompt;
    assert.ok(injected.startsWith("<Role>"));
    assert.ok(
      injected.includes("你是 lynx"),
      "lynx subagent prompt must be prepended",
    );
    assert.ok(injected.endsWith("base"));
  });

  it("invalid profile → zero injection; resolveAgent stays unresolved", async () => {
    // Bind a primary that is not in the profile: an invalid profile must
    // fail closed (nothing composed, no orchestrator) even when a session
    // binding exists.
    bindAgent(SESSION_ID, "ghost");
    const zoo = {
      mode: {
        poly: {
          agents: ["beaver"],
          skills: [],
          hooks: ["direct-work-nudge"],
          tools: [],
          commands: [],
        },
      },
    };
    const scope = piScope(zoo, {
      agent: { beaver: { mode: "subagent" } },
    });
    const { composed } = await composePi(scope);
    assert.deepEqual(scope.snapshot.agentModes, { beaver: "subagent" });
    // beaver is not the orchestrator and the orchestrator is absent, so the
    // selection is invalid: no agent is composed.
    assert.deepEqual(composed.agents, []);
    assert.deepEqual(composed.report.invalid, {
      orchestrator: "dolphin",
      cause: "not-enabled",
      primaries: [],
    });

    const handlers = await startInstance(
      piScope(zoo, {
        agent: { beaver: { mode: "subagent" } },
      }),
      undefined,
    );
    // The session resolves the bound sentinel, which is not in the
    // profile — zero injection.
    const promptResult = await handlers.beforeAgentStart(
      {
        messageType: "user",
        systemPrompt: "base",
      },
      SESSION_CTX,
    );
    assert.ok(promptResult);
    assert.equal(promptResult.systemPrompt, "base");

    // No orchestrator resolves, so the direct-work nudge gate never
    // matches — zero output change.
    const toolResult = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit",
        content: [{ type: "text", text: "file.ts updated" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.equal(toolResult, undefined);
  });
});

// ---------------------------------------------------------------------------
// Compose-driven tool_result handler
// ---------------------------------------------------------------------------

describe("startPi — compose-driven tool_result", () => {
  it("json-error-nudge in hooks → JSON reminder appended to error output", async () => {
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "browser",
        toolCallId: "call-json",
        content: [{ type: "text", text: "Error: json parse error at line 3" }],
        isError: true,
      },
      SESSION_CTX,
    );
    assert.ok(result, "the reminder must be appended");
    assert.ok(
      joinedText(result).includes(JSON_ERROR_REMINDER_MARKER),
      "output must carry the JSON reminder marker",
    );
  });

  it("hooks without json-error-nudge → tool_result adds no JSON reminder", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: {
          ...POLY_PROFILE,
          hooks: POLY_PROFILE.hooks.filter((h) => h !== "json-error-nudge"),
        },
      },
    };
    const handlers = await startInstance(piScope(zoo, MODES_RAW), undefined);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "browser",
        toolCallId: "call-json",
        content: [{ type: "text", text: "Error: json parse error at line 3" }],
        isError: true,
      },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });

  it("direct-work-nudge in hooks + primary agent → edit nudge appended", async () => {
    // The root session resolves (and binds) to the config-derived default
    // primary (dolphin here), which satisfies the direct-work nudge's
    // gate.
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit",
        content: [{ type: "text", text: "file.ts updated" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.ok(result, "the direct-work nudge must fire");
    assert.ok(
      joinedText(result).includes(DIRECT_WORK_NUDGE),
      "output must carry the delegation reminder",
    );
  });

  it("profile without a primary agent → direct-work nudge skipped", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: { poly: { ...POLY_PROFILE, agents: ["mola"] } },
    };
    const handlers = await startInstance(piScope(zoo, MODES_RAW), undefined);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit",
        content: [{ type: "text", text: "file.ts updated" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });

  it("subagent tool_result → post-subagent nudge fires on the canonical name", async () => {
    // pi registers the delegation tool as "subagent" (the canonical name
    // the core hooks gate on), so the post-subagent nudge fires here.
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "subagent",
        toolCallId: "call-sub",
        content: [{ type: "text", text: "subagent finished the delegation" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.ok(result, "the post-subagent nudge must fire");
    assert.ok(
      joinedText(result).includes(VERIFY_REMINDER),
      "output must carry the VERIFY reminder",
    );
  });

  it("subagent tool_result with JSON error prose → no JSON reminder", async () => {
    // "subagent" is in the JSON-recovery exclude list: subagent output
    // may legitimately mention JSON errors without the orchestrator
    // having sent invalid JSON arguments.
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "subagent",
        toolCallId: "call-sub-json",
        content: [{ type: "text", text: "json parse error in the response" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.ok(result, "the post-subagent nudge still appends for subagent");
    assert.equal(
      joinedText(result).includes(JSON_ERROR_REMINDER_MARKER),
      false,
      "subagent output must be excluded from JSON recovery",
    );
  });

  it("hooks without direct-work-nudge → no delegation nudge even for a primary", async () => {
    const zoo = {
      ...POLY_ZOO,
      mode: {
        poly: {
          ...POLY_PROFILE,
          hooks: POLY_PROFILE.hooks.filter((h) => h !== "direct-work-nudge"),
        },
      },
    };
    const handlers = await startInstance(piScope(zoo, MODES_RAW), undefined);
    const result = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit",
        content: [{ type: "text", text: "file.ts updated" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.equal(result, undefined);
  });
});

describe("pi regression — subagent child session must not get the direct-work nudge", () => {
  it("edit in a beaver child session is untouched; the root session still nudges", async () => {
    // A pi child AgentSession's tool_result resolves through the
    // run-registry-backed resolver, so it maps to the child's own agent
    // ("beaver") and the dolphin-only nudge never leaks into subagent
    // sessions.
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    piProcess.runs.start({
      id: "run-beaver",
      agent: "beaver",
      parentSession: "root-ses",
      startedAt: 100,
    });
    piProcess.runs.update("run-beaver", { childSession: "child-beaver" });

    const childCtx = {
      sessionManager: { getSessionId: () => "child-beaver" },
    };
    const childResult = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit-child",
        content: [{ type: "text", text: "beaver edited a file" }],
        isError: false,
      },
      childCtx,
    );
    assert.equal(
      childResult,
      undefined,
      "the subagent session must not receive the delegation nudge",
    );

    // Same handlers, same tool: the root session still satisfies the
    // gate (resolved to the default primary dolphin).
    const rootResult = await handlers.toolResult(
      {
        type: "tool_result",
        toolName: "edit",
        toolCallId: "call-edit-root",
        content: [{ type: "text", text: "dolphin edited a file" }],
        isError: false,
      },
      SESSION_CTX,
    );
    assert.ok(rootResult, "the root session nudge must still fire");
    assert.ok(
      joinedText(rootResult).includes(DIRECT_WORK_NUDGE),
      "root output must carry the delegation reminder",
    );
  });
});

// ---------------------------------------------------------------------------
// Compose-driven context handler
// ---------------------------------------------------------------------------

describe("startPi — compose-driven context handler", () => {
  it("returns the native pi messages, possibly modified by pruning", async () => {
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    const result = (await handlers.contextHandler(
      {
        type: "context",
        messages: [{ role: "user", content: "hello" }],
      },
      SESSION_CTX,
    )) as { messages: Array<{ role: string; content: string }> } | undefined;
    assert.ok(result, "context handler must return a result");
    assert.equal(result.messages.length, 1);
    // The pruning pipeline injects the per-round line-number prefix on pi.
    assert.equal(result.messages[0].content, "[m1] hello");
  });

  it("returns an empty replacement for an empty message array", async () => {
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    const result = (await handlers.contextHandler(
      { type: "context", messages: [] },
      SESSION_CTX,
    )) as { messages: unknown[] } | undefined;
    assert.ok(result, "context handler must return a result");
    assert.deepEqual(result.messages, []);
  });
});

// ---------------------------------------------------------------------------
// tool_call — delegation gate
// ---------------------------------------------------------------------------

describe("startPi — tool_call delegation gate", () => {
  /** The canonical, well-formed delegation prompt. */
  const PROMPT =
    "**SUMMARY:** implement the thing.\n\n" +
    "**CONTEXT:** all the facts needed.\n\n" +
    "**ACCEPTANCE:** verify it.";

  /** A `subagent` tool_call event delegating to the given target. */
  function subagentCall(agent: string) {
    return {
      type: "tool_call" as const,
      toolName: "subagent",
      toolCallId: "call-gate",
      input: { agent, description: "实现任务", prompt: PROMPT },
    };
  }

  it("registers the gate handler only when the profile composes judges", async () => {
    const gated = await startInstance(piScope(POLY_ZOO, MODES_RAW), undefined);
    assert.equal(gated.hasGateHandlers, true);

    // Neither judge-contributing hook is composed → the gate is null and
    // the key is not registered; a direct call stays inert.
    const ungated = await startInstance(
      piScope(
        {
          ...POLY_ZOO,
          mode: {
            poly: {
              ...POLY_PROFILE,
              hooks: POLY_PROFILE.hooks.filter(
                (h) => h !== "subagent-delegation" && h !== "subagent-prompt",
              ),
            },
          },
        },
        MODES_RAW,
      ),
      undefined,
    );
    assert.equal(ungated.hasGateHandlers, false);
    assert.equal(
      await ungated.toolCall(subagentCall("mola"), SESSION_CTX),
      undefined,
    );
  });

  it("blocks a refused delegation and passes the rest through", async () => {
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      undefined,
    );
    bindAgent(SESSION_ID, "beaver");

    // A non-subagent tool passes through untouched.
    assert.equal(
      await handlers.toolCall(
        {
          type: "tool_call",
          toolName: "bash",
          toolCallId: "call-bash",
          input: { command: "ls" },
        },
        SESSION_CTX,
      ),
      undefined,
    );

    // beaver may delegate to lynx; mola is blocked by the allowlist judge.
    assert.equal(
      await handlers.toolCall(subagentCall("lynx"), SESSION_CTX),
      undefined,
    );
    const refusal = await handlers.toolCall(subagentCall("mola"), SESSION_CTX);
    assert.equal(refusal?.block, true);
    const reason = refusal?.reason ?? "";
    assert.ok(reason.includes("beaver can only delegate to"));
    assert.ok(reason.includes("mola"));
  });

  it("refuses an unselected subagent and a primary target", async () => {
    // The profile leaves lynx out, so a delegation to it would run an
    // agent whose role prompt was never composed.
    const agents = POLY_PROFILE.agents.filter((name) => name !== "lynx");
    const handlers = await startInstance(
      piScope(
        { ...POLY_ZOO, mode: { poly: { ...POLY_PROFILE, agents } } },
        MODES_RAW,
      ),
      undefined,
    );
    bindAgent(SESSION_ID, "beaver");

    const unselected = await handlers.toolCall(
      subagentCall("lynx"),
      SESSION_CTX,
    );
    assert.equal(unselected?.block, true);
    assert.ok(
      (unselected?.reason ?? "").includes("未在当前 profile 的 agents 中启用"),
    );

    // A selected, allowlisted subagent still passes.
    assert.equal(
      await handlers.toolCall(subagentCall("spider"), SESSION_CTX),
      undefined,
    );

    // A selected primary is refused by its role, whatever the caller may
    // delegate to.
    bindAgent(SESSION_ID, "dolphin");
    const primary = await handlers.toolCall(subagentCall("mola"), SESSION_CTX);
    assert.equal(primary?.block, true);
    assert.ok((primary?.reason ?? "").includes("不是可委派的子 agent"));
  });
});

// ---------------------------------------------------------------------------
// Lifecycle scope (ensure / start / shutdown)
// ---------------------------------------------------------------------------

describe("lifecycle scope", () => {
  /** The poly profile plus the todo tool, so the tool bridge is exercised. */
  const TODO_ZOO = {
    ...POLY_ZOO,
    mode: {
      poly: { ...POLY_PROFILE, tools: [...POLY_PROFILE.tools, "todo"] },
    },
  };

  /** A ui ctx that records widget registration and terminal-input binds. */
  function lifecycleCtx(sessionId: string) {
    const state = { widgets: 0, binds: 0, unsubscribes: 0 };
    const ctx = {
      sessionManager: { getSessionId: () => sessionId },
      ui: {
        notify: () => {},
        setWidget: () => {
          state.widgets += 1;
        },
        onTerminalInput: () => {
          state.binds += 1;
          return () => {
            state.unsubscribes += 1;
          };
        },
      },
    };
    return { state, ctx };
  }

  it("ensures the session from the first turn without a session_start", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const { state, ctx } = lifecycleCtx("sess-first-turn");

    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );

    assert.equal(state.widgets, 1, "the first turn seeds the session widget");
    assert.equal(state.binds, 1, "the first turn binds the listener");
  });

  it("re-registers on a repeated start without stacking a listener", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const { state, ctx } = lifecycleCtx("sess-reregister");
    const start = { type: "session_start", reason: "startup" };

    await handlers.sessionStart(start, ctx);
    await handlers.sessionStart(start, ctx);

    assert.equal(state.unsubscribes, 1, "the previous listener is released");
    assert.equal(state.binds - state.unsubscribes, 1, "exactly one live bind");
  });

  it("repaints the fleet for each restored run through the run-change feed", async () => {
    // The history restore owns no notification of its own: every run it
    // creates publishes one run change, and the fleet subscription repaints
    // that run's session.  The start handler therefore adds no repaint of
    // its own — a start with nothing to restore measures the baseline.
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      mockApi() as any,
    );
    /** One finished delegation in a pi message history. */
    const delegation = (id: string, timestamp: number): PiHistoryEntry[] => [
      {
        type: "message",
        message: {
          role: "assistant",
          timestamp,
          content: [
            {
              type: "toolCall",
              id,
              name: "subagent",
              arguments: { agent: "beaver", description: "实现任务" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: id,
          toolName: "subagent",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: timestamp + 10,
        },
      },
    ];

    /** A start ctx whose history is `entries`, with its widget repaint count. */
    const startCtx = (sessionId: string, entries: PiHistoryEntry[]) => {
      const calls: Array<[string, unknown]> = [];
      const state = { renders: 0 };
      const tui = {
        requestRender: () => {
          state.renders += 1;
        },
      };
      return {
        calls,
        state,
        tui,
        ctx: {
          sessionManager: {
            getSessionId: () => sessionId,
            buildContextEntries: () => entries,
          },
          ui: {
            notify: () => {},
            setWidget: (key: string, content: unknown) => {
              calls.push([key, content]);
            },
            onTerminalInput: () => () => {},
          },
        },
      };
    };

    /** Repaints one start causes once the session's widget is attached. */
    const startRepaints = async (
      session: ReturnType<typeof startCtx>,
    ): Promise<number> => {
      // The previous-turn fallback registers the widget without restoring.
      await handlers.beforeAgentStart(
        { messageType: "user", systemPrompt: "base" },
        session.ctx,
      );
      const widget = renderZooWidget(session.calls, 80, session.tui);
      try {
        const before = session.state.renders;
        await handlers.sessionStart(
          { type: "session_start", reason: "resume" },
          session.ctx,
        );
        return session.state.renders - before;
      } finally {
        widget.dispose();
      }
    };

    const restored = startCtx("sess-restore-fleet", [
      ...delegation("call-r1", 10),
      ...delegation("call-r2", 30),
    ]);
    const empty = startCtx("sess-restore-empty", []);

    const withRestore = await startRepaints(restored);
    assert.deepEqual(
      piProcess.runs.topLevel("sess-restore-fleet").map((run) => run.id),
      ["call-r1", "call-r2"],
      "precondition: the start restored both runs",
    );
    const withoutRestore = await startRepaints(empty);

    assert.equal(
      withRestore - withoutRestore,
      2,
      "each restored run repaints the fleet once",
    );
  });

  it("creates and registers nothing without a session id", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const state = { widgets: 0, binds: 0 };
    const ctx = {
      ui: {
        notify: () => {},
        setWidget: () => {
          state.widgets += 1;
        },
        onTerminalInput: () => {
          state.binds += 1;
          return () => {};
        },
      },
    };

    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );

    assert.deepEqual(state, { widgets: 0, binds: 0 });
  });

  it("session_shutdown releases the session resources and stops further writes", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(POLY_ZOO, MODES_RAW),
      api as any,
    );
    const { state, ctx } = lifecycleCtx("sess-shutdown");
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx,
    );
    const registered = state.widgets;

    await handlers.sessionShutdown(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );

    assert.equal(state.unsubscribes, 1, "the listener is released");

    // A late event during teardown must not write to the stopped scope.
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctx,
    );
    assert.equal(state.widgets, registered, "no registration after stop");
    assert.equal(state.binds - state.unsubscribes, 0, "no new listener");
  });

  it("a tool execution bridge admits the call for the event's session", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(TODO_ZOO, MODES_RAW),
      api as any,
    );
    assert.ok(handlers, "handlers are wired");
    const todo = api.tools.find((tool: any) => tool.name === "todo") as any;
    const ctx = { sessionManager: { getSessionId: () => "sess-tool-first" } };

    await todo.execute(
      "call-first",
      { op: "init", tasks: ["bridge"] },
      undefined,
      undefined,
      ctx,
    );
    const view = await todo.execute(
      "call-second",
      { op: "view" },
      undefined,
      undefined,
      ctx,
    );

    // Both calls ran through the bridge under the same session scope, so the
    // second reads back the plan the first wrote.
    assert.ok(joinedText(view).includes("Overall: 0/1 done, 1 open."));
  });

  it("publishes the tool event's context before ensuring the session", async () => {
    const api = mockApi();
    await startInstance(piScope(TODO_ZOO, MODES_RAW), api as any);
    const todo = api.tools.find((tool: any) => tool.name === "todo") as any;
    // A tool call may be the FIRST event a session produces (flows without a
    // `session_start`).  Its context must be published before the session
    // scope is ensured, so the todo restore already resolves this session's
    // transcript instead of finding no context at all.
    const ctx = {
      sessionManager: {
        getSessionId: () => "sess-tool-plan",
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "call-0",
              toolName: "todo",
              content: [],
              isError: false,
              details: {
                op: "init",
                phases: [
                  {
                    name: "Todos",
                    tasks: [{ content: "Restored from transcript" }],
                  },
                ],
              },
            },
          },
        ],
      },
    };

    const view = await todo.execute(
      "call-view",
      { op: "view" },
      undefined,
      undefined,
      ctx,
    );

    assert.ok(
      joinedText(view).includes("Restored from transcript"),
      "the first tool event must already see its own session's transcript",
    );
  });

  it("restores two interleaved sessions' plans from their own transcripts", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(TODO_ZOO, MODES_RAW),
      api as any,
    );
    const todo = api.tools.find((tool: any) => tool.name === "todo") as any;
    const plan = (task: string) => ({
      sessionManager: {
        getSessionId: () => `sess-${task}`,
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: `call-${task}`,
              toolName: "todo",
              content: [],
              isError: false,
              details: {
                op: "init",
                phases: [
                  {
                    name: "Todos",
                    tasks: [{ content: `plan ${task}` }],
                  },
                ],
              },
            },
          },
        ],
      },
    });
    const first = plan("a");
    const second = plan("b");
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      first,
    );
    await handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      second,
    );

    // The latest handled session is `sess-b`; a read for `sess-a` must still
    // restore a's plan.
    const viewA = await todo.execute(
      "call-a",
      { op: "view" },
      undefined,
      undefined,
      first,
    );
    const viewB = await todo.execute(
      "call-b",
      { op: "view" },
      undefined,
      undefined,
      second,
    );
    assert.ok(joinedText(viewA).includes("plan a"), joinedText(viewA));
    assert.ok(!joinedText(viewA).includes("plan b"));
    assert.ok(joinedText(viewB).includes("plan b"), joinedText(viewB));
  });

  it("a stopped session's todo state is not resurrected by a late tool call", async () => {
    const api = mockApi();
    const handlers = await startInstance(
      piScope(TODO_ZOO, MODES_RAW),
      api as any,
    );
    const todo = api.tools.find((tool: any) => tool.name === "todo") as any;
    const ctx = lifecycleCtx("sess-stopped-todo");
    await handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctx.ctx,
    );
    await todo.execute(
      "call-init",
      { op: "init", tasks: ["before-stop"] },
      undefined,
      undefined,
      ctx.ctx,
    );

    await handlers.sessionShutdown(
      { type: "session_shutdown", reason: "quit" },
      ctx.ctx,
    );

    // A tool call that arrives during teardown must not reach the stopped
    // session's state: the plan belonged to the scope that just stopped, so
    // the late call sees an empty list instead of a resurrected one.
    const view = await todo.execute(
      "call-view",
      { op: "view" },
      undefined,
      undefined,
      ctx.ctx,
    );
    assert.ok(
      !joinedText(view).includes("before-stop"),
      "the stopped session's plan must not survive its scope",
    );
  });

  it("a command execution bridge admits the call for the event's session", async () => {
    const api = mockApi();
    await startInstance(piScope(POLY_ZOO, MODES_RAW), api as any);
    const dcp = api.commands.find((command) => command.name === "dcp");
    assert.ok(dcp && typeof dcp.handler === "function");
    const before = api.appendedEntries.length;

    await (dcp.handler as (args: string, ctx: unknown) => Promise<void>)("", {
      sessionManager: { getSessionId: () => "sess-command-first" },
      ui: { notify: () => {} },
    });

    // The admitted command body ran: with no context report available it
    // posts its failure notice into the session chat.
    assert.equal(api.appendedEntries.length - before, 1);
    assert.equal(api.appendedEntries.at(-1)?.customType, "zoo-notice");
  });
});

// ---------------------------------------------------------------------------
// Event admission (runSession)
// ---------------------------------------------------------------------------

describe("startPi — event admission", () => {
  /** An empty composition: the admitted business paths need no contribution. */
  const EMPTY_COMPOSED: ComposedResult = {
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
  };

  /** The session id an event context names. */
  function idOf(ctx: unknown): string | undefined {
    return (
      ctx as { sessionManager?: { getSessionId(): string } } | undefined
    )?.sessionManager?.getSessionId();
  }

  /** A pi event context whose session resolves to `sessionID`. */
  function ctxOf(sessionID: string) {
    return { sessionManager: { getSessionId: () => sessionID } };
  }

  /**
   * Build the handlers over a real lifecycle wiring and recording business
   * callbacks, so a handler's admission is observable without the composed
   * profile.
   */
  function harness(
    options: { composed?: ComposedResult; holdCaller?: Promise<void> } = {},
  ) {
    const log: string[] = [];
    const bound: string[] = [];
    const invalidated: string[] = [];
    const permits: WorkPermit[] = [];
    const wiring = createPiLifecycleWiring({
      extensionServices: [],
      sessionServices: [
        // The handlers' settle bookkeeping: each session's prompt depth and
        // last run's messages.
        piSettleStateService,
        // These handlers compose no settle strategy, so the session serves
        // no loop handle.
        defineSessionService({
          name: "loopSession",
          deps: [],
          create: () => undefined,
        }),
        defineSessionService({
          name: "worker",
          deps: [],
          create: ({ sessionID }) => ({ sessionID }),
          dispose: (service, { reason }) => {
            log.push(`dispose:${service.sessionID}:${reason}`);
          },
        }),
      ],
      sessionCatalog: createSessionResourceCatalog([]),
      getSessionID: (ctx) => idOf(ctx),
    });
    const sessionContexts: PiSessionContexts = createPiSessionContexts();
    const bind = sessionContexts.bind.bind(sessionContexts);
    sessionContexts.bind = (sessionID, ctx) => {
      if (sessionID === undefined) return;
      bound.push(sessionID);
      log.push(`bind:${sessionID}`);
      bind(sessionID, ctx);
    };
    const deps: PiEventHandlerDeps = {
      sessionContexts,
      contextRuntime: createContextRuntime(),
      composed: options.composed ?? EMPTY_COMPOSED,
      hasSettledHandlers: false,
      skillPermissions: {},
      getSelectedSkills: () => [],
      applyActiveTools: () => log.push("trim"),
      registerFleetWidget: (sessionID) => log.push(`widget:${sessionID}`),
      refreshTodoView: (sessionID) => log.push(`todo:${sessionID}`),
      seedTodoView: (sessionID) => log.push(`seed:${sessionID}`),
      claimPendingSwitchOps: (sessionID, facts) =>
        log.push(`claim:${sessionID}:${facts.reason}:${facts.parentSession}`),
      drainPendingSwitchOps: () => log.push("drain"),
      runs: piProcess.runs,
      invalidateTodo: (sessionId) => invalidated.push(sessionId),
      resolveAgent: () => undefined,
      resolveCallerAgent: async () => {
        await options.holdCaller;
        return undefined;
      },
      runSession: (ctx, work, signal) =>
        wiring.runSession(
          ctx,
          (permit, services) => {
            permits.push(permit);
            return work(permit, {
              settle: services.settleState,
              loop: services.loopSession,
            });
          },
          signal,
        ),
      startSession: (event, ctx) => {
        log.push("start");
        return wiring.startSession(event, ctx);
      },
      stopExtension: (event) => {
        log.push("stop");
        return wiring.stopExtension(event);
      },
    };
    return {
      log,
      bound,
      invalidated,
      permits,
      handlers: createPiEventHandlers(deps),
    };
  }

  /** Let an admitted call reach its work. */
  async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("admits the work for the session its own event context names", async () => {
    const h = harness();

    const first = await h.handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctxOf("s1"),
    );
    const second = await h.handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctxOf("s2"),
    );

    assert.deepEqual(first, { systemPrompt: "base" });
    assert.deepEqual(second, { systemPrompt: "base" });
    // Each call binds its own context: no event falls back to whichever
    // session was handled last.
    assert.deepEqual(
      h.permits.map((permit) => permit.sessionID),
      ["s1", "s2"],
    );
    assert.deepEqual(h.bound, ["s1", "s2"]);
  });

  it("passes the event's own session id to the context transform", async () => {
    const seen: Array<string | undefined> = [];
    const h = harness({
      composed: {
        ...EMPTY_COMPOSED,
        transform: [
          {
            name: "probe",
            handle: (_output, sessionID) => {
              seen.push(sessionID);
            },
          },
        ],
      },
    });

    await h.handlers.contextHandler(
      { type: "context", messages: [] },
      ctxOf("s1"),
    );
    await h.handlers.contextHandler(
      { type: "context", messages: [] },
      ctxOf("s2"),
    );

    // The transform addresses the session the event was admitted for, so a
    // second session's context transform never reads the first one's state.
    assert.deepEqual(seen, ["s1", "s2"]);
  });

  it("routes every session surface to the session of its own event", async () => {
    const h = harness();

    await h.handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctxOf("s1"),
    );
    await h.handlers.sessionStart(
      { type: "session_start", reason: "resume" },
      ctxOf("s2"),
    );

    // Interleaved sessions never share a surface: each bind, claim, widget
    // write and todo refresh carries the id of the event that caused it.
    // The post-restore repaint is the fleet subscription's, not the
    // handler's.
    assert.deepEqual(h.log, [
      "start",
      "bind:s1",
      "claim:s1:startup:undefined",
      "trim",
      "widget:s1",
      "todo:s1",
      "start",
      "bind:s2",
      "claim:s2:resume:undefined",
      "trim",
      "widget:s2",
      "todo:s2",
    ]);
  });

  it("refreshes the todo column of the session its tool result belongs to", async () => {
    const h = harness();
    const result = {
      type: "tool_result" as const,
      toolName: "todo",
      toolCallId: "call-1",
      content: [],
      isError: false,
    };

    await h.handlers.toolResult(result, ctxOf("s1"));
    await h.handlers.toolResult(result, ctxOf("s2"));

    assert.deepEqual(h.log, ["bind:s1", "todo:s1", "bind:s2", "todo:s2"]);
  });

  it("runs no business and binds nothing without a session id", async () => {
    const h = harness();

    for (const ctx of [undefined, {}, ctxOf(""), ctxOf("   ")]) {
      assert.equal(
        await h.handlers.beforeAgentStart(
          { messageType: "user", systemPrompt: "base" },
          ctx,
        ),
        undefined,
      );
      assert.equal(
        await h.handlers.resourcesDiscover(undefined, ctx),
        undefined,
      );
      await h.handlers.sessionTree(undefined, ctx);
      assert.equal(
        await h.handlers.toolResult(
          {
            type: "tool_result",
            toolName: "todo",
            toolCallId: "call-1",
            content: [],
            isError: false,
          },
          ctx as never,
        ),
        undefined,
      );
    }

    assert.deepEqual(h.bound, []);
    assert.deepEqual(h.invalidated, []);
    assert.deepEqual(h.log, []);
  });

  it("runs nothing once the extension stopped", async () => {
    const h = harness();
    await h.handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctxOf("s1"),
    );
    await h.handlers.sessionShutdown(
      { type: "session_shutdown", reason: "quit" },
      ctxOf("s1"),
    );
    const admitted = [...h.log];

    assert.equal(
      await h.handlers.beforeAgentStart(
        { messageType: "user", systemPrompt: "base" },
        ctxOf("s1"),
      ),
      undefined,
    );
    await h.handlers.sessionTree(undefined, ctxOf("s1"));

    assert.deepEqual(h.log, admitted);
    assert.deepEqual(h.invalidated, []);
  });

  it("runs the start notice first and the session business after it", async () => {
    const h = harness();

    await h.handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      ctxOf("s1"),
    );

    assert.deepEqual(h.log, [
      "start",
      "bind:s1",
      "claim:s1:startup:undefined",
      "trim",
      "widget:s1",
      "todo:s1",
    ]);
  });

  it("runs the start notice even when the business is refused", async () => {
    const h = harness();

    await h.handlers.sessionStart(
      { type: "session_start", reason: "startup" },
      undefined,
    );

    // The control path keeps its own entry: no business follows it, and
    // nothing is bound.
    assert.deepEqual(h.log, ["start"]);
    assert.deepEqual(h.bound, []);
  });

  it("stops on shutdown even when the business is refused", async () => {
    const h = harness();
    await h.handlers.beforeAgentStart(
      { messageType: "user", systemPrompt: "base" },
      ctxOf("s1"),
    );

    await h.handlers.sessionShutdown(
      { type: "session_shutdown", reason: "quit" },
      undefined,
    );

    assert.ok(h.log.includes("dispose:s1:quit"), h.log.join(","));
  });

  it("revokes a running event's permit at shutdown and waits for it", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      composed: {
        ...EMPTY_COMPOSED,
        gate: () => null,
        gateNeedsCaller: true,
      },
      holdCaller: held,
    });

    const running = h.handlers.toolCall(
      {
        type: "tool_call",
        toolName: "subagent",
        toolCallId: "call-1",
        input: { agent: "lynx", prompt: "t" },
      },
      ctxOf("s1"),
    );
    await tick();
    const permit = h.permits.at(-1);
    assert.ok(permit);
    assert.equal(permit.isActive(), true);

    const stopping = h.handlers.sessionShutdown(
      { type: "session_shutdown", reason: "quit" },
      ctxOf("s1"),
    );
    await tick();

    // The permit is revoked at once, and the scope is not disposed while
    // the admitted work still runs.
    assert.equal(permit.signal.aborted, true);
    assert.ok(!h.log.includes("dispose:s1:quit"));

    release?.();
    await stopping;
    assert.equal(await running, undefined);
    assert.ok(h.log.includes("dispose:s1:quit"));
  });
});
