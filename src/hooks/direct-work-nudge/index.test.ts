/**
 * Tests for the Direct Work Nudge hook.
 *
 * Covers edit/write firing, non-matching tools, null/undefined output,
 * case-insensitivity, no path exemptions, consecutive calls, constants,
 * grep/glob search delegation, plan nudge scenarios, and integration
 * via the plugin entry point (including event/message.updated →
 * sessionAgentMap agent gating).
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { zookeeper } from "../../index.js";
import {
  DIRECT_WORK_NUDGE,
  nudgeDirectWork,
  SEARCH_DELEGATE_NUDGE,
} from "./index.js";

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

/**
 * Simulate a message.updated event that sets the agent in sessionAgentMap.
 */
function messageUpdatedEvent(
  agent: string,
  sessionID?: string,
): Parameters<Awaited<ReturnType<typeof zookeeper>>["event"]>[0] {
  const sid =
    sessionID ?? `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return {
    event: {
      type: "message.updated",
      properties: {
        info: { agent, sessionID: sid },
      },
    },
  };
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
// Agent filtering happens at the plugin entry point via sessionAgentMap.
// ---------------------------------------------------------------------------

describe("agent-agnostic: fires for any caller", () => {
  it("nudges edit regardless of what may be in sessionAgentMap", async () => {
    // nudgeDirectWork has no agent awareness. It always fires for edit/write.
    const res = await applyReminder("edit", "some edit output");
    assertHasReminder(res);
  });

  it("nudges grep regardless of what may be in sessionAgentMap", async () => {
    const res = await applyReminder("grep", "search results");
    assertHasSearchReminder(res);
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
// Integration: via plugin entry point (agent-gated by sessionAgentMap)
// Agent identity flows: event(message.updated) → sessionAgentMap →
// tool.execute.after → nudgeDirectWork (if dolphin).
// ---------------------------------------------------------------------------

describe("integration: tool.execute.after via plugin", () => {
  it("edit tool appends reminder when message.updated set dolphin", async () => {
    const plugin = await zookeeper({ client: {} });
    const sid = uniqueSid();
    await plugin.event(messageUpdatedEvent("dolphin", sid));
    const output: { output?: string } = {
      output: "fixed formatting in index.ts",
    };
    await plugin["tool.execute.after"](
      { tool: "edit", sessionID: sid, callID: "c1" },
      output,
    );
    assert.ok(output.output?.includes("DELEGATION REQUIRED"));
    assert.ok(output.output?.includes("Contract R1"));
  });

  it("edit tool skips nudge when message.updated set beaver", async () => {
    const plugin = await zookeeper({ client: {} });
    const sid = uniqueSid();
    await plugin.event(messageUpdatedEvent("beaver", sid));
    const output: { output?: string } = {
      output: "edited something as subagent",
    };
    await plugin["tool.execute.after"](
      { tool: "edit", sessionID: sid, callID: "c1" },
      output,
    );
    assert.equal(output.output, "edited something as subagent");
  });

  it("edit tool skips nudge when sessionAgentMap has no entry", async () => {
    const plugin = await zookeeper({ client: {} });
    const sid = uniqueSid();
    const output: { output?: string } = {
      output: "edited without known agent",
    };
    await plugin["tool.execute.after"](
      { tool: "edit", sessionID: sid, callID: "c1" },
      output,
    );
    assert.equal(output.output, "edited without known agent");
  });

  it("bash tool remains unchanged via plugin", async () => {
    const plugin = await zookeeper({ client: {} });
    const sid = uniqueSid();
    await plugin.event(messageUpdatedEvent("dolphin", sid));
    const output: { output?: string } = {
      output: "ls output here",
    };
    await plugin["tool.execute.after"](
      { tool: "bash", sessionID: sid, callID: "c1" },
      output,
    );
    assert.equal(output.output, "ls output here");
  });

  it("grep tool appends search nudge when message.updated set dolphin", async () => {
    const plugin = await zookeeper({ client: {} });
    const sid = uniqueSid();
    await plugin.event(messageUpdatedEvent("dolphin", sid));
    const output: { output?: string } = { output: "found matches" };
    await plugin["tool.execute.after"](
      { tool: "grep", sessionID: sid, callID: "c1" },
      output,
    );
    assertHasSearchReminder(output);
  });

  it("grep tool skips nudge when message.updated set lynx", async () => {
    const plugin = await zookeeper({ client: {} });
    const sid = uniqueSid();
    await plugin.event(messageUpdatedEvent("lynx", sid));
    const output: { output?: string } = {
      output: "searched as subagent",
    };
    await plugin["tool.execute.after"](
      { tool: "grep", sessionID: sid, callID: "c1" },
      output,
    );
    assert.equal(output.output, "searched as subagent");
  });
});

// ---------------------------------------------------------------------------
// sessionAgentMap lifecycle — event hook cleanup
// ---------------------------------------------------------------------------

describe("integration: sessionAgentMap lifecycle", () => {
  it("session.deleted event clears the agent map entry", async () => {
    const plugin = await zookeeper({ client: {} });
    const sid = uniqueSid();
    await plugin.event(messageUpdatedEvent("dolphin", sid));
    // Verify populated — edit should nudge
    let output: { output?: string } = { output: "first edit" };
    await plugin["tool.execute.after"](
      { tool: "edit", sessionID: sid, callID: "c1" },
      output,
    );
    assertHasReminder(output);

    // Simulate session.deleted
    await plugin.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: sid } },
      },
    });

    // After deletion, edit should NOT nudge (no agent info)
    output = { output: "second edit" };
    await plugin["tool.execute.after"](
      { tool: "edit", sessionID: sid, callID: "c2" },
      output,
    );
    assert.equal(output.output, "second edit");
  });

  it("message.updated overwrites previous agent for same session", async () => {
    const plugin = await zookeeper({ client: {} });
    const sid = uniqueSid();
    // First: set as beaver
    await plugin.event(messageUpdatedEvent("beaver", sid));
    let output: { output?: string } = { output: "beaver edit" };
    await plugin["tool.execute.after"](
      { tool: "edit", sessionID: sid, callID: "c1" },
      output,
    );
    assert.equal(output.output, "beaver edit");

    // Then: overwrite as dolphin
    await plugin.event(messageUpdatedEvent("dolphin", sid));
    output = { output: "dolphin edit" };
    await plugin["tool.execute.after"](
      { tool: "edit", sessionID: sid, callID: "c2" },
      output,
    );
    assertHasReminder(output);
  });

  it("non-message.updated events do not affect agent map", async () => {
    const plugin = await zookeeper({ client: {} });
    const sid = uniqueSid();
    // Send an unrelated event
    await plugin.event({
      event: { type: "session.created", properties: {} },
    });
    // No agent should be set for this session
    const output: { output?: string } = {
      output: "edited without agent",
    };
    await plugin["tool.execute.after"](
      { tool: "edit", sessionID: sid, callID: "c1" },
      output,
    );
    assert.equal(output.output, "edited without agent");
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
