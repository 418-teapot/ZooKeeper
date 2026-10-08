/**
 * Tests for the pi event handlers (`src/adapters/pi/handlers.ts`).
 *
 * The handlers are exercised through the host wiring
 * (`buildPiHandlers`), which is how pi reaches them: identity-dispatch
 * prompt injection, `resources_discover` skill filtering by the active
 * primary's permission rules, the compose-driven `tool_result` /
 * `context` chains, the todo tool's cache invalidation on
 * `session_tree`, and the widget cache refresh triggers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { BEAVER_PROMPT } from "../../agents/beaver.js";
import {
  DIRECT_WORK_NUDGE,
  JSON_ERROR_REMINDER_MARKER,
  VERIFY_REMINDER,
} from "../../core/prompts.js";
import {
  getPrimary,
  runWithIdentity,
  setPrimary,
} from "../../core/subagent/identity.js";
import { startRun, updateRun } from "../../core/subagent/registry.js";
import {
  joinedText,
  MODES_RAW,
  mockApi,
  POLY_PROFILE,
  POLY_ZOO,
  renderZooWidget,
  resetPiTestState,
  SESSION_CTX,
} from "../../testkits/pi-wiring.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { buildPiContributions, buildPiHandlers } from "./wire.js";

afterEach(resetPiTestState);

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

  it("the tool restores once per cache miss and session_tree forces a re-scan", async () => {
    const api = mockApi();
    const handlers = buildPiHandlers(TODO_ZOO, api as any, MODES_RAW);
    const todo = api.tools.find((tool: any) => tool.name === "todo") as any;
    assert.ok(todo, "the todo tool must register when the profile lists it");
    assert.equal(
      todo.executionMode,
      undefined,
      "no host-level serialisation asked for",
    );

    const { ctx, scans } = scanCtx("sess-tree");
    // Seed the holder's live session: the scan reads the session manager
    // through it (pi exposes exactly one live session per instance).  This
    // seeding path does not refresh the widget, so the scan count below
    // only reflects the tool's cache behaviour.
    await handlers.beforeAgentStart({ systemPrompt: "base" }, ctx);

    await todo.execute("call-1", { op: "view" }, undefined, undefined, ctx);
    assert.equal(scans.count, 1, "a cache miss scans the transcript once");
    await todo.execute("call-2", { op: "view" }, undefined, undefined, ctx);
    assert.equal(scans.count, 1, "a cached read must not re-scan");

    // Tree navigation drops the cache; the widget refresh then re-reads the
    // transcript eagerly, so the next tool call is served from the restored
    // cache instead of scanning again.
    handlers.sessionTree(undefined, ctx);
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

  it("is a no-op without a session id in the event context", () => {
    const api = mockApi();
    const handlers = buildPiHandlers(TODO_ZOO, api as any, MODES_RAW);
    assert.doesNotThrow(() => handlers.sessionTree());
    assert.doesNotThrow(() => handlers.sessionTree(undefined, {}));
    assert.doesNotThrow(() =>
      handlers.sessionTree(undefined, {
        sessionManager: { getSessionId: () => "" },
      }),
    );
  });

  it("piApi absent → no store owned → the handler is a no-op", () => {
    // Without a real pi API the entry point owns no todo store (the tool
    // never registers, fail-closed): the handler must not crash over it.
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    assert.doesNotThrow(() => handlers.sessionTree());
    assert.doesNotThrow(() =>
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
    const handlers = buildPiHandlers(TODO_ZOO, api as any, MODES_RAW);
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
    const handlers = buildPiHandlers(TODO_ZOO, api as any, MODES_RAW);
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
    const handlers = buildPiHandlers(TODO_ZOO, api as any, MODES_RAW);
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

    handlers.sessionTree(undefined, ctx);
    await flush();
    assert.equal(
      scans.count,
      afterStart + 1,
      "tree navigation must re-read the store for the widget",
    );
  });

  it("no store → the three triggers stay harmless", async () => {
    // Without a pi API the factory owns no todo store; the cache then stays
    // empty, so the widget's todo column resolves to no phases.  All three
    // refresh triggers must remain silent no-ops.
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    assert.doesNotThrow(() => handlers.sessionTree());
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

describe("buildPiHandlers — prompt injection + skill discovery", () => {
  it("poly full → default primary prompt prepended, all 11 skill dirs discovered", async () => {
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    const result = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.ok(result.systemPrompt.startsWith("<Role>"));
    assert.ok(result.systemPrompt.endsWith("base"));

    // The default primary (first in profile array order) is dolphin:
    // its orchestrator prompt is the prepended one.
    assert.ok(result.systemPrompt.includes("对最终交付负责"));

    const resources = await handlers.resourcesDiscover();
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
    const handlers = buildPiHandlers({});
    const result = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.equal(result.systemPrompt, "base");

    const resources = await handlers.resourcesDiscover();
    assert.deepEqual(resources.skillPaths, []);
  });

  it("profile without a primary agent → prompt untouched; skills filtered", async () => {
    // A stale module-level primary from another test must never inject: a
    // profile whose only agent has no valid mode has no primary, so the
    // identity machinery stays off.  Seed a sentinel name outside the
    // profile so the assertion is order-independent.
    setPrimary("ghost");
    const zoo = {
      mode: {
        poly: { ...POLY_PROFILE, agents: ["mola"], skills: ["git-commit"] },
      },
    };
    const handlers = buildPiHandlers(zoo);
    const result = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.equal(result.systemPrompt, "base");

    const resources = await handlers.resourcesDiscover();
    assert.equal(resources.skillPaths.length, 1);
    assert.ok(resources.skillPaths[0].endsWith("git-commit"));
  });
});

// ---------------------------------------------------------------------------
// Skill discovery filtering by the primary's permission.skill rules
// ---------------------------------------------------------------------------

describe("buildPiHandlers — resourcesDiscover skill filtering", () => {
  /** Raw config with skill rules mirroring config.toml's [agent.mola]. */
  const MOLA_SKILLS_RAW = {
    agent: {
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
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MOLA_SKILLS_RAW);
    // Composition seeds the default primary from the poly agents array
    // (dolphin), but here only mola declares skill rules — so a switch to
    // mola filters by his ruleset.
    setPrimary("mola");
    const resources = await handlers.resourcesDiscover();
    const names = resources.skillPaths.map((p) => p.split("/").pop());
    assert.deepEqual(
      names.sort(),
      ["first-principles", "grill", "mola-plan", "wiki-query"].sort(),
      "only mola's allowed skills pass the catch-all deny",
    );
  });

  it("primary dolphin → his denied globs are excluded, the rest stay", async () => {
    const handlers = buildPiHandlers(POLY_ZOO, undefined, DOLPHIN_SKILLS_RAW);
    // Dolphin is the default primary from the poly agents array.
    assert.equal(getPrimary(), "dolphin");
    const resources = await handlers.resourcesDiscover();
    const names = resources.skillPaths.map((p) => p.split("/").pop() ?? "");
    assert.equal(names.length, 7, "4 of the 11 profile skills are denied");
    assert.ok(!names.some((n) => n.startsWith("beaver-")));
    assert.ok(!names.some((n) => n.startsWith("kiwi-")));
    assert.ok(!names.some((n) => n.startsWith("mola-")));
    assert.ok(names.includes("wiki-query"));
    assert.ok(names.includes("git-commit"));
  });

  it("no primary → full profile list contributed unfiltered", async () => {
    // No rawConfig means no skill rules; a stale sentinel primary from
    // another test is reset so the identity machinery stays off → the
    // handler must contribute exactly as before the filtering change.
    setPrimary("ghost");
    const handlers = buildPiHandlers(POLY_ZOO);
    const resources = await handlers.resourcesDiscover();
    assert.equal(resources.skillPaths.length, 11);
  });

  it("primary without a skill rules entry → unfiltered (machinery-off)", async () => {
    // The primary (dolphin) is set but has no `permission.skill` rules in
    // the raw config → no filtering applies, matching default-allow.
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    assert.equal(getPrimary(), "dolphin");
    const resources = await handlers.resourcesDiscover();
    assert.equal(resources.skillPaths.length, 11);
  });

  it("emits a skills_filtered info event with kept/dropped counts", async () => {
    _resetForTesting();
    const handlers = buildPiHandlers(POLY_ZOO, undefined, DOLPHIN_SKILLS_RAW);
    setPrimary("dolphin");
    await handlers.resourcesDiscover();
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
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    await handlers.resourcesDiscover();
    const filtered = _getBufferForTesting().filter(
      (entry) => entry.event === "skills_filtered",
    );
    assert.deepEqual(filtered, []);
  });
});

// ---------------------------------------------------------------------------
// Identity-dispatch prompt injection
// ---------------------------------------------------------------------------

describe("buildPiHandlers — identity-dispatch prompt injection", () => {
  it("default primary (first in profile order) prompt is prepended", async () => {
    // buildPiContributions seeds the identity state with the default
    // primary (dolphin, first in the poly agents array); outside any
    // sub-session scope resolveIdentity falls back to that primary.
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    assert.equal(getPrimary(), "dolphin");

    const result = await handlers.beforeAgentStart({ systemPrompt: "base" });
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

    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    assert.equal(getPrimary(), "dolphin");

    const gpt = await handlers.beforeAgentStart(
      { systemPrompt: "base" },
      { model: { id: "openai/gpt-5.5" } },
    );
    assert.ok(gpt.systemPrompt.includes(GPT), "gpt model uses the gpt line");
    assert.ok(!gpt.systemPrompt.includes(BASE));

    const unknown = await handlers.beforeAgentStart({ systemPrompt: "base" });
    assert.ok(unknown.systemPrompt.includes(BASE), "no model falls back");
    assert.ok(!unknown.systemPrompt.includes(GPT));
  });

  it("setPrimary to the other configured primary switches the injected prompt", async () => {
    // Composition seeds the default primary (dolphin).  A runtime switch
    // (setPrimary after build) must be reflected by the next
    // before_agent_start: the second primary (mola) prompt is injected.
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    setPrimary("mola");
    const result = await handlers.beforeAgentStart({ systemPrompt: "base" });
    assert.ok(result.systemPrompt.startsWith("<Role>"));
    assert.ok(
      result.systemPrompt.includes("你是 mola，一个方案规划 agent"),
      "mola prompt must be prepended after setPrimary",
    );
    assert.ok(result.systemPrompt.endsWith("base"));
  });

  it("inside runWithIdentity the subagent's prompt is prepended", async () => {
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    let injected = "";
    await runWithIdentity({ kind: "subagent", name: "beaver" }, async () => {
      const result = await handlers.beforeAgentStart({
        systemPrompt: "base",
      });
      injected = result.systemPrompt;
    });
    assert.equal(injected, `${BEAVER_PROMPT}\n\nbase`);
  });

  it("subagent resolves by the same name lookup when not the default primary", async () => {
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    let injected = "";
    await runWithIdentity({ kind: "subagent", name: "lynx" }, async () => {
      const result = await handlers.beforeAgentStart({
        systemPrompt: "base",
      });
      injected = result.systemPrompt;
    });
    assert.ok(injected.startsWith("<Role>"));
    assert.ok(
      injected.includes("你是 lynx"),
      "lynx subagent prompt must be prepended",
    );
    assert.ok(injected.endsWith("base"));
  });

  it("empty primary set → zero injection; resolveAgent undefined", async () => {
    // Pre-seed a primary that is not in the profile: the empty-primary
    // profile must fail closed (no setPrimary call) even when a stale
    // module-level primary exists.
    setPrimary("ghost");
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
    const { composed, agentModes } = buildPiContributions(zoo, undefined, {
      agent: {},
    });
    assert.deepEqual(agentModes, {});
    // beaver is composed (it is in the profile agents list) but no
    // primary is derived from it — the identity machinery stays off.
    assert.deepEqual(
      composed.agents.map((a) => a.name),
      ["beaver"],
    );

    const handlers = buildPiHandlers(zoo, undefined, { agent: {} });
    // resolveIdentity falls back to the stale sentinel, which is not in
    // the profile — zero injection.
    const promptResult = await handlers.beforeAgentStart({
      systemPrompt: "base",
    });
    assert.equal(promptResult.systemPrompt, "base");

    // The unresolvable agent (no primary, no binding) means the
    // direct-work nudge gate never matches — zero output change.
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

describe("buildPiHandlers — compose-driven tool_result", () => {
  it("json-error-nudge in hooks → JSON reminder appended to error output", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
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
    const handlers = buildPiHandlers(zoo);
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
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
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
    const handlers = buildPiHandlers(zoo);
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
    const handlers = buildPiHandlers(POLY_ZOO);
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
    const handlers = buildPiHandlers(POLY_ZOO);
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
    const handlers = buildPiHandlers(zoo);
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
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    startRun({
      id: "run-beaver",
      agent: "beaver",
      parentSession: "root-ses",
      startedAt: 100,
    });
    updateRun("run-beaver", { childSession: "child-beaver" });

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

describe("buildPiHandlers — compose-driven context handler", () => {
  it("returns the native pi messages, possibly modified by pruning", async () => {
    const handlers = buildPiHandlers(POLY_ZOO);
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
    const handlers = buildPiHandlers(POLY_ZOO);
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

describe("buildPiHandlers — tool_call delegation gate", () => {
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

  it("registers the gate handler only when the profile composes judges", () => {
    const gated = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    assert.equal(gated.hasGateHandlers, true);

    // Neither judge-contributing hook is composed → the gate is null and
    // the key is not registered; a direct call stays inert.
    const ungated = buildPiHandlers(
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
      undefined,
      MODES_RAW,
    );
    assert.equal(ungated.hasGateHandlers, false);
    assert.equal(
      ungated.toolCall(subagentCall("mola"), SESSION_CTX),
      undefined,
    );
  });

  it("blocks a refused delegation and passes the rest through", () => {
    const handlers = buildPiHandlers(POLY_ZOO, undefined, MODES_RAW);
    setPrimary("beaver");

    // A non-subagent tool passes through untouched.
    assert.equal(
      handlers.toolCall(
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
      handlers.toolCall(subagentCall("lynx"), SESSION_CTX),
      undefined,
    );
    const refusal = handlers.toolCall(subagentCall("mola"), SESSION_CTX);
    assert.equal(refusal?.block, true);
    const reason = refusal?.reason ?? "";
    assert.ok(reason.includes("beaver can only delegate to"));
    assert.ok(reason.includes("mola"));
  });
});
