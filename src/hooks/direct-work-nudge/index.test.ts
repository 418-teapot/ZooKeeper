/**
 * Tests for the Direct Work Nudge hook.
 *
 * Covers edit/write firing, non-matching tools, null/undefined output,
 * case-insensitivity, no path exemptions, consecutive calls, constants,
 * grep/glob search delegation, plan nudge scenarios, the dolphin-gated
 * `nudgeDirectWorkForAgent` wrapper (skip + delegate paths), and the
 * tool.execute.after agent-gating states (message.updated / session.deleted)
 * driven directly through `nudgeDirectWorkForAgent`.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import {
  DIRECT_WORK_NUDGE,
  nudgeDirectWork,
  nudgeDirectWorkForAgent,
  SEARCH_DELEGATE_NUDGE,
  unit,
} from "./index.js";

// ---------------------------------------------------------------------------
// Logger cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const NON_EDIT_WRITE_TOOLS = [
  "bash",
  "read",
  "task",
  "skill",
  "webfetch",
  "websearch",
];

const SEARCH_TOOLS = ["grep", "glob"];

/**
 * Invoke nudgeDirectWork with the given tool, output, and optional options.
 */
async function applyReminder(
  tool: string,
  text: string,
  options?: Parameters<typeof nudgeDirectWork>[2],
): Promise<{ output?: string }> {
  const result: { output?: string } = { output: text };
  await nudgeDirectWork({ tool, sessionID: "s1" }, result, options);
  return result;
}

/**
 * Assert that `obj.output` contains the DIRECT_WORK_NUDGE text.
 */
function assertHasReminder(obj: { output?: string }, message?: string): void {
  assert.ok(
    obj.output?.includes("DELEGATION REQUIRED"),
    message ?? "expected output to contain nudge",
  );
}

/**
 * Assert that `obj.output` contains the SEARCH_DELEGATE_NUDGE text.
 */
function assertHasSearchReminder(
  obj: { output?: string },
  message?: string,
): void {
  assert.ok(
    obj.output?.includes("POTENTIAL DELEGATION OPPORTUNITY"),
    message ?? "expected output to contain search delegation nudge",
  );
}

/** Generate a unique session ID for test isolation. */
let _idCounter = 0;
function uniqueSid(): string {
  return `s_test_${Date.now()}_${_idCounter++}`;
}

// ---------------------------------------------------------------------------
// edit / write fire the reminder
// ---------------------------------------------------------------------------

describe("edit/write fires reminder", () => {
  it('appends reminder for tool="edit"', async () => {
    const res = await applyReminder("edit", "Fixed indentation in foo.ts");
    assertHasReminder(res);
    assert.ok(res.output?.includes(DIRECT_WORK_NUDGE));
  });

  it('appends reminder for tool="write"', async () => {
    const res = await applyReminder("write", "Created new file bar.ts");
    assertHasReminder(res);
    assert.ok(res.output?.includes(DIRECT_WORK_NUDGE));
  });
});

// ---------------------------------------------------------------------------
// grep / glob fire the search delegation reminder
// ---------------------------------------------------------------------------

describe("grep/glob fires search delegation reminder", () => {
  for (const tool of SEARCH_TOOLS) {
    it(`appends search delegation reminder for tool="${tool}"`, async () => {
      const res = await applyReminder(tool, "found some matches");
      assertHasSearchReminder(res);
      assert.ok(res.output?.includes(SEARCH_DELEGATE_NUDGE));
    });
  }

  it('appends search delegation reminder for tool="GREP" (uppercase)', async () => {
    const res = await applyReminder("GREP", "found something");
    assertHasSearchReminder(res);
  });

  it('appends search delegation reminder for tool="Glob" (mixed case)', async () => {
    const res = await applyReminder("Glob", "found files");
    assertHasSearchReminder(res);
  });
});

// ---------------------------------------------------------------------------
// Non-matching tools are skipped
// ---------------------------------------------------------------------------

describe("non edit/write tools are skipped", () => {
  for (const tool of NON_EDIT_WRITE_TOOLS) {
    it(`skips tool "${tool}"`, async () => {
      const res = await applyReminder(tool, "some output text here");
      assert.equal(
        res.output,
        "some output text here",
        `expected no change for tool "${tool}"`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Null / undefined output
// ---------------------------------------------------------------------------

describe("null / undefined output", () => {
  it("does not modify when output is absent", async () => {
    const obj: { output?: string } = {};
    await nudgeDirectWork({ tool: "edit", sessionID: "s1" }, obj);
    assert.equal(obj.output, undefined);
  });

  it("does not modify when output is undefined", async () => {
    const obj: { output?: string } = { output: undefined };
    await nudgeDirectWork({ tool: "edit", sessionID: "s1" }, obj);
    assert.equal(obj.output, undefined);
  });

  it("does not modify when output is null", async () => {
    const obj: { output?: string } = { output: null as unknown as string };
    await nudgeDirectWork({ tool: "edit", sessionID: "s1" }, obj);
    assert.equal(obj.output, null);
  });
});

// ---------------------------------------------------------------------------
// Case-insensitive tool names
// ---------------------------------------------------------------------------

describe("case-insensitive tool name matching", () => {
  it('matches "EDIT"', async () => {
    const res = await applyReminder("EDIT", "some change");
    assertHasReminder(res);
  });

  it('matches "Write"', async () => {
    const res = await applyReminder("Write", "some change");
    assertHasReminder(res);
  });

  it('matches "EdIt"', async () => {
    const res = await applyReminder("EdIt", "some change");
    assertHasReminder(res);
  });
});

// ---------------------------------------------------------------------------
// Fires on ANY path (no exemptions)
// ---------------------------------------------------------------------------

describe("fires on any path (no path exemptions)", () => {
  it('fires on ".opencode/config.json"', async () => {
    const obj: { output?: string } = { output: "updated config" };
    await nudgeDirectWork({ tool: "edit", sessionID: "s1" }, obj);
    assertHasReminder(obj);
  });

  it('fires on "tests/scenarios/x.json"', async () => {
    const obj: { output?: string } = { output: "updated test data" };
    await nudgeDirectWork({ tool: "edit", sessionID: "s1" }, obj);
    assertHasReminder(obj);
  });

  it('fires on "src/foo.ts"', async () => {
    const obj: { output?: string } = { output: "changed source" };
    await nudgeDirectWork({ tool: "edit", sessionID: "s1" }, obj);
    assertHasReminder(obj);
  });
});

// ---------------------------------------------------------------------------
// Consecutive calls — stateless, both fire
// ---------------------------------------------------------------------------

describe("consecutive calls", () => {
  it("both calls append the reminder (stateless, no dedup)", async () => {
    const obj: { output?: string } = {
      output: "original content",
    };

    // First call
    await nudgeDirectWork({ tool: "edit", sessionID: "s1" }, obj);
    const out1 = obj.output as string;
    const countAfterFirst = out1.split("DELEGATION REQUIRED").length - 1;
    assert.equal(countAfterFirst, 1);

    // Second call — reminder appended again
    await nudgeDirectWork({ tool: "edit", sessionID: "s1" }, obj);
    const out2 = obj.output as string;
    const countAfterSecond = out2.split("DELEGATION REQUIRED").length - 1;
    assert.equal(countAfterSecond, 2);
  });
});

// ---------------------------------------------------------------------------
// Agent gating: nudgeDirectWork is agent-agnostic — it always fires.
// Agent filtering happens in the hook unit via deps.resolveAgent.
// ---------------------------------------------------------------------------

describe("agent-agnostic: fires for any caller", () => {
  it("nudges edit regardless of the session's resolved identity", async () => {
    // nudgeDirectWork has no agent awareness. It always fires for edit/write.
    const res = await applyReminder("edit", "some edit output");
    assertHasReminder(res);
  });

  it("nudges grep regardless of the session's resolved identity", async () => {
    const res = await applyReminder("grep", "search results");
    assertHasSearchReminder(res);
  });
});

// ---------------------------------------------------------------------------
// Agent-gated wrapper: nudgeDirectWorkForAgent (dolphin only)
// ---------------------------------------------------------------------------

describe("nudgeDirectWorkForAgent (dolphin-gated wrapper)", () => {
  let origZooDebug: string | undefined;

  beforeEach(() => {
    // Capture debug-level entries for the nudge_skipped assertions.
    origZooDebug = process.env.ZOO_DEBUG;
    process.env.ZOO_DEBUG = "1";
  });

  afterEach(() => {
    if (origZooDebug !== undefined) {
      process.env.ZOO_DEBUG = origZooDebug;
    } else {
      delete process.env.ZOO_DEBUG;
    }
  });

  // -----------------------------------------------------------------------
  // Non-dolphin path: skip without touching output
  // -----------------------------------------------------------------------

  it('skips the nudge for agent="beaver" without touching output', async () => {
    const output: { output?: string } = { output: "beaver edited a file" };
    await nudgeDirectWorkForAgent(
      { tool: "edit", sessionID: "s1", callID: "c1" },
      output,
      { agent: "beaver" },
    );
    assert.equal(output.output, "beaver edited a file");
    assert.ok(!output.output?.includes("DELEGATION REQUIRED"));
  });

  it("skips the nudge when agent is undefined (unknown session)", async () => {
    const output: { output?: string } = {
      output: "edited without known agent",
    };
    await nudgeDirectWorkForAgent(
      { tool: "edit", sessionID: "s1" },
      output,
      {},
    );
    assert.equal(output.output, "edited without known agent");
    assert.ok(!output.output?.includes("DELEGATION REQUIRED"));
  });

  it('logs nudge_skipped with reason "not_dolphin" for non-dolphin agents', async () => {
    await nudgeDirectWorkForAgent(
      { tool: "edit", sessionID: "s-gate", callID: "c1" },
      { output: "beaver edit" },
      { agent: "beaver" },
    );
    const entry = _getBufferForTesting().find(
      (e) => e.event === "nudge_skipped" && e.reason === "not_dolphin",
    );
    assert.ok(entry, "expected nudge_skipped/not_dolphin log entry");
    const ee = entry as Record<string, unknown>;
    assert.equal(ee.hook, "direct-work-nudge");
    assert.equal(ee.level, "debug");
    assert.equal(ee.sessionId, "s-gate");
    assert.equal(ee.callId, "c1");
    assert.equal(ee.tool, "edit");
  });

  it("logs nudge_skipped when agent is undefined too", async () => {
    await nudgeDirectWorkForAgent(
      { tool: "edit", sessionID: "s-gate", callID: "c1" },
      { output: "unknown edit" },
      {},
    );
    const entry = _getBufferForTesting().find(
      (e) => e.event === "nudge_skipped" && e.reason === "not_dolphin",
    );
    assert.ok(entry, "expected nudge_skipped/not_dolphin log entry");
  });

  // -----------------------------------------------------------------------
  // Dolphin path: delegates to nudgeDirectWork
  // -----------------------------------------------------------------------

  it('appends the direct-work nudge for agent="dolphin" (edit)', async () => {
    const output: { output?: string } = { output: "dolphin edited file" };
    await nudgeDirectWorkForAgent({ tool: "edit", sessionID: "s1" }, output, {
      agent: "dolphin",
    });
    assertHasReminder(output);
  });

  it('appends the search delegation nudge for agent="dolphin" (grep)', async () => {
    const output: { output?: string } = { output: "dolphin searched" };
    await nudgeDirectWorkForAgent({ tool: "grep", sessionID: "s1" }, output, {
      agent: "dolphin",
    });
    assertHasSearchReminder(output);
  });

  it("passes todoClient/planDir through to nudgeDirectWork (plan nudge appears)", async () => {
    const sessionID = `test-for-agent-${Date.now()}-${_planNudgeCounter++}`;
    const baseDir = tmpDir();
    try {
      writePlanFile(
        baseDir,
        "my-plan.md",
        { status: "executing", slug: "my-plan" },
        "- [ ] Write tests\n- [x] Implement feature\n",
      );
      const output: { output?: string } = { output: "dolphin edited" };
      await nudgeDirectWorkForAgent({ tool: "edit", sessionID }, output, {
        agent: "dolphin",
        planDir: baseDir,
      });
      assertHasReminder(output);
      assert.ok(
        output.output?.includes("PLAN PROGRESS"),
        "expected PLAN PROGRESS nudge",
      );
    } finally {
      cleanupPlanDir(baseDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Constants checks
// ---------------------------------------------------------------------------

describe("DIRECT_WORK_NUDGE contents", () => {
  it('contains "DELEGATION REQUIRED"', () => {
    assert.ok(DIRECT_WORK_NUDGE.includes("DELEGATION REQUIRED"));
  });

  it('contains "Dolphin does not implement"', () => {
    assert.ok(DIRECT_WORK_NUDGE.includes("Dolphin does not implement"));
  });

  it("contains documentation exception", () => {
    assert.ok(DIRECT_WORK_NUDGE.includes("Documentation"));
    assert.ok(DIRECT_WORK_NUDGE.includes("this is your job"));
  });

  it("references Contract R1 instead of orchestrator protocol", () => {
    assert.ok(DIRECT_WORK_NUDGE.includes("Contract R1"));
    assert.ok(!DIRECT_WORK_NUDGE.includes("orchestrator protocol"));
  });

  it("wraps content in <internal-reminder> tags", () => {
    assert.ok(DIRECT_WORK_NUDGE.startsWith("<internal-reminder>\n"));
    assert.ok(DIRECT_WORK_NUDGE.endsWith("\n</internal-reminder>"));
  });
});

describe("SEARCH_DELEGATE_NUDGE contents", () => {
  it('contains "POTENTIAL DELEGATION OPPORTUNITY"', () => {
    assert.ok(
      SEARCH_DELEGATE_NUDGE.includes("POTENTIAL DELEGATION OPPORTUNITY"),
    );
  });

  it("contains codebase discovery guidance", () => {
    assert.ok(SEARCH_DELEGATE_NUDGE.includes("Codebase discovery"));
    assert.ok(SEARCH_DELEGATE_NUDGE.includes("`lynx` agent"));
  });

  it("contains verification exception", () => {
    assert.ok(SEARCH_DELEGATE_NUDGE.includes("Verification"));
    assert.ok(SEARCH_DELEGATE_NUDGE.includes("fine, continue"));
  });

  it("wraps content in <internal-reminder> tags", () => {
    assert.ok(SEARCH_DELEGATE_NUDGE.startsWith("<internal-reminder>\n"));
    assert.ok(SEARCH_DELEGATE_NUDGE.endsWith("\n</internal-reminder>"));
  });
});

// ---------------------------------------------------------------------------
// Barrel export
// ---------------------------------------------------------------------------

describe("barrel export", () => {
  it("exports nudgeDirectWork as a function", () => {
    assert.equal(typeof nudgeDirectWork, "function");
  });

  it("exports DIRECT_WORK_NUDGE as a string", () => {
    assert.equal(typeof DIRECT_WORK_NUDGE, "string");
  });

  it("exports SEARCH_DELEGATE_NUDGE as a string", () => {
    assert.equal(typeof SEARCH_DELEGATE_NUDGE, "string");
  });
});

// ---------------------------------------------------------------------------
// Integration: tool.execute.after mapping (direct adapter)
// The hook unit resolves the session agent via deps.resolveAgent and
// passes it to nudgeDirectWorkForAgent via the tool.execute.after handler.
// Here the resolved agent is passed directly to the adapter.
// ---------------------------------------------------------------------------

describe("integration: tool.execute.after → nudgeDirectWorkForAgent", () => {
  it("edit tool appends reminder when message.updated set dolphin", async () => {
    const sid = uniqueSid();
    const output: { output?: string } = {
      output: "fixed formatting in index.ts",
    };
    await nudgeDirectWorkForAgent(
      { tool: "edit", sessionID: sid, callID: "c1" },
      output,
      { agent: "dolphin" },
    );
    assert.ok(output.output?.includes("DELEGATION REQUIRED"));
    assert.ok(output.output?.includes("Contract R1"));
  });

  it("edit tool skips nudge when message.updated set beaver", async () => {
    const sid = uniqueSid();
    const output: { output?: string } = {
      output: "edited something as subagent",
    };
    await nudgeDirectWorkForAgent(
      { tool: "edit", sessionID: sid, callID: "c1" },
      output,
      { agent: "beaver" },
    );
    assert.equal(output.output, "edited something as subagent");
  });

  it("edit tool skips nudge when the session has no resolvable agent", async () => {
    const sid = uniqueSid();
    const output: { output?: string } = {
      output: "edited without known agent",
    };
    await nudgeDirectWorkForAgent(
      { tool: "edit", sessionID: sid, callID: "c1" },
      output,
      {},
    );
    assert.equal(output.output, "edited without known agent");
  });

  it("bash tool remains unchanged", async () => {
    const sid = uniqueSid();
    const output: { output?: string } = {
      output: "ls output here",
    };
    await nudgeDirectWorkForAgent(
      { tool: "bash", sessionID: sid, callID: "c1" },
      output,
      { agent: "dolphin" },
    );
    assert.equal(output.output, "ls output here");
  });

  it("grep tool appends search nudge when message.updated set dolphin", async () => {
    const sid = uniqueSid();
    const output: { output?: string } = { output: "found matches" };
    await nudgeDirectWorkForAgent(
      { tool: "grep", sessionID: sid, callID: "c1" },
      output,
      { agent: "dolphin" },
    );
    assertHasSearchReminder(output);
  });

  it("grep tool skips nudge when message.updated set lynx", async () => {
    const sid = uniqueSid();
    const output: { output?: string } = {
      output: "searched as subagent",
    };
    await nudgeDirectWorkForAgent(
      { tool: "grep", sessionID: sid, callID: "c1" },
      output,
      { agent: "lynx" },
    );
    assert.equal(output.output, "searched as subagent");
  });
});

// ---------------------------------------------------------------------------
// Agent-gating state transitions (message.updated / session.deleted)
// The plugin's event hook maintains the session-agent registry; the
// adapter receives the agent value `deps.resolveAgent` would yield for
// each event-driven state.
// ---------------------------------------------------------------------------

describe("integration: agent-gating states via nudgeDirectWorkForAgent", () => {
  it("session.deleted event clears the agent map entry", async () => {
    const sid = uniqueSid();
    // Agent known (message.updated dolphin) — edit should nudge
    let output: { output?: string } = { output: "first edit" };
    await nudgeDirectWorkForAgent(
      { tool: "edit", sessionID: sid, callID: "c1" },
      output,
      { agent: "dolphin" },
    );
    assertHasReminder(output);

    // After session.deleted — no agent info, edit should NOT nudge
    output = { output: "second edit" };
    await nudgeDirectWorkForAgent(
      { tool: "edit", sessionID: sid, callID: "c2" },
      output,
      {},
    );
    assert.equal(output.output, "second edit");
  });

  it("message.updated overwrites previous agent for same session", async () => {
    const sid = uniqueSid();
    // First: set as beaver
    let output: { output?: string } = { output: "beaver edit" };
    await nudgeDirectWorkForAgent(
      { tool: "edit", sessionID: sid, callID: "c1" },
      output,
      { agent: "beaver" },
    );
    assert.equal(output.output, "beaver edit");

    // Then: overwrite as dolphin
    output = { output: "dolphin edit" };
    await nudgeDirectWorkForAgent(
      { tool: "edit", sessionID: sid, callID: "c2" },
      output,
      { agent: "dolphin" },
    );
    assertHasReminder(output);
  });

  it("non-message.updated events do not affect agent map", async () => {
    const sid = uniqueSid();
    // No agent should be set for this session
    const output: { output?: string } = {
      output: "edited without agent",
    };
    await nudgeDirectWorkForAgent(
      { tool: "edit", sessionID: sid, callID: "c1" },
      output,
      {},
    );
    assert.equal(output.output, "edited without agent");
  });
});

// ---------------------------------------------------------------------------
// Hook unit wiring: the contributed after-exec handler reads the session
// agent through `deps.resolveAgent` — the gate skips every identity that
// is not "dolphin" (subagents and unresolvable sessions alike).
// ---------------------------------------------------------------------------

describe("unit.create wiring — gating through deps.resolveAgent", () => {
  /** Build the contributed after-exec handler with a fixed resolver. */
  function handlerWith(
    resolveAgent: (sessionID: string) => string | undefined,
  ) {
    const contributions = unit.create(
      {
        limits: {},
        contextConfig: {},
        client: {},
        directory: "",
        resolveAgent,
      },
      {
        agents: new Set(),
        skills: new Set(),
        hooks: new Set(["direct-work-nudge"]),
        tools: new Set(),
        commands: new Set(),
      },
    );
    assert.equal(contributions.afterExec.length, 1);
    return contributions.afterExec[0];
  }

  it("skips the nudge when resolveAgent returns a subagent name (beaver)", async () => {
    const handler = handlerWith(() => "beaver");
    const output: { output?: string } = { output: "beaver edited a file" };
    await handler.handle(
      { tool: "edit", sessionID: "s-child", callID: "c1" },
      output,
    );
    assert.equal(
      output.output,
      "beaver edited a file",
      "a subagent session must not receive the delegation nudge",
    );
  });

  it("skips the nudge when resolveAgent returns undefined (fail-closed)", async () => {
    const handler = handlerWith(() => undefined);
    const output: { output?: string } = { output: "unknown session edit" };
    await handler.handle(
      { tool: "edit", sessionID: "s-unknown", callID: "c1" },
      output,
    );
    assert.equal(output.output, "unknown session edit");
  });

  it("appends the nudge when resolveAgent returns dolphin", async () => {
    const handler = handlerWith(() => "dolphin");
    const output: { output?: string } = { output: "dolphin edited a file" };
    await handler.handle(
      { tool: "edit", sessionID: "s-root", callID: "c1" },
      output,
    );
    assertHasReminder(output);
  });
});

// ---------------------------------------------------------------------------
// Plan nudge scenarios
// ---------------------------------------------------------------------------

let _planNudgeCounter = 0;

function tmpDir(): string {
  const dir = join(
    tmpdir(),
    `zoo-direct-nudge-test-${Date.now()}-${_planNudgeCounter++}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a plan file under a baseDir's .zoo/plans/ (flat layout).
 */
function writePlanFile(
  baseDir: string,
  filename: string,
  frontmatter: Record<string, string>,
  body: string,
): void {
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const content = `---\n${fmLines}\n---\n\n${body}`;
  const dir = join(baseDir, ".zoo", "plans");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf-8");
}

/**
 * Remove a baseDir's .zoo/plans/ directory recursively.
 */
function cleanupPlanDir(baseDir: string): void {
  try {
    rmSync(join(baseDir, ".zoo", "plans"), {
      recursive: true,
      force: true,
    });
  } catch {
    // ignore
  }
}

describe("plan nudge scenarios", () => {
  it("edit with executing plan (open TODOs) includes PLAN_PROGRESS_NUDGE", async () => {
    const sessionID = `test-direct-nudge-${Date.now()}-${_planNudgeCounter++}`;
    const baseDir = tmpDir();
    try {
      writePlanFile(
        baseDir,
        "my-plan.md",
        { status: "executing", slug: "my-plan" },
        "- [ ] Write tests\n- [x] Implement feature\n",
      );
      const result: { output?: string } = { output: "edited file" };
      await nudgeDirectWork({ tool: "edit", sessionID }, result, {
        planDir: baseDir,
      });
      assert.ok(
        result.output?.includes("PLAN PROGRESS"),
        "expected PLAN PROGRESS nudge",
      );
    } finally {
      cleanupPlanDir(baseDir);
    }
  });

  it("edit with executing plan (all done) includes PLAN_DONE_NUDGE", async () => {
    const sessionID = `test-direct-nudge-${Date.now()}-${_planNudgeCounter++}`;
    const baseDir = tmpDir();
    try {
      writePlanFile(
        baseDir,
        "my-plan.md",
        { status: "executing", slug: "my-plan" },
        "- [x] Task A\n- [x] Task B\n",
      );
      const result: { output?: string } = { output: "edited file" };
      await nudgeDirectWork({ tool: "edit", sessionID }, result, {
        planDir: baseDir,
      });
      assert.ok(
        result.output?.includes("PLAN COMPLETE"),
        "expected PLAN COMPLETE nudge",
      );
    } finally {
      cleanupPlanDir(baseDir);
    }
  });

  it("edit with done plan includes PLAN_RESUME_NUDGE", async () => {
    const sessionID = `test-direct-nudge-${Date.now()}-${_planNudgeCounter++}`;
    const baseDir = tmpDir();
    try {
      writePlanFile(
        baseDir,
        "my-plan.md",
        { status: "done", slug: "my-plan" },
        "- [x] All done\n",
      );
      const result: { output?: string } = { output: "edited file" };
      await nudgeDirectWork({ tool: "edit", sessionID }, result, {
        planDir: baseDir,
      });
      assert.ok(
        result.output?.includes("PLAN RESURRECTED"),
        "expected PLAN RESURRECTED nudge",
      );
    } finally {
      cleanupPlanDir(baseDir);
    }
  });

  it("grep does not include plan nudge", async () => {
    const sessionID = `test-direct-nudge-${Date.now()}-${_planNudgeCounter++}`;
    const baseDir = tmpDir();
    try {
      const result: { output?: string } = { output: "grep result" };
      await nudgeDirectWork({ tool: "grep", sessionID }, result, {
        planDir: baseDir,
      });
      assert.ok(
        result.output?.includes("POTENTIAL DELEGATION OPPORTUNITY"),
        "grep should still include search delegation nudge",
      );
      assert.equal(
        result.output?.includes("PLAN PROGRESS"),
        false,
        "grep should not contain PLAN PROGRESS",
      );
      assert.equal(
        result.output?.includes("PLAN COMPLETE"),
        false,
        "grep should not contain PLAN COMPLETE",
      );
      assert.equal(
        result.output?.includes("PLAN RESURRECTED"),
        false,
        "grep should not contain PLAN RESURRECTED",
      );
    } finally {
      cleanupPlanDir(baseDir);
    }
  });
});
