/**
 * Tests for the Direct Work Nudge hook.
 *
 * Covers edit/write firing, non-matching tools, null/undefined output,
 * case-insensitivity, no path exemptions, consecutive calls, constants,
 * and integration via the plugin entry point.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
 * Create a mock client that returns the given agent name for any session.
 */
function mockClient(agent: string) {
  return { getSession: async () => ({ agent }) };
}

/** Pre-built mock build client used by most tests. */
const BUILD_CLIENT = mockClient("dolphin");

/**
 * Invoke nudgeDirectWork with the given tool, output, and optional client.
 *
 * Defaults to a mock build client.  Pass `null` to test the no-client path.
 */
async function applyReminder(
  tool: string,
  text: string,
  client?: Parameters<typeof nudgeDirectWork>[0],
): Promise<{ output?: string }> {
  const result: { output?: string } = { output: text };
  await nudgeDirectWork(
    client ?? BUILD_CLIENT,
    { tool, sessionID: "s1" },
    result,
  );
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
    await nudgeDirectWork(BUILD_CLIENT, { tool: "edit", sessionID: "s1" }, obj);
    assert.equal(obj.output, undefined);
  });

  it("does not modify when output is undefined", async () => {
    const obj: { output?: string } = { output: undefined };
    await nudgeDirectWork(BUILD_CLIENT, { tool: "edit", sessionID: "s1" }, obj);
    assert.equal(obj.output, undefined);
  });

  it("does not modify when output is null", async () => {
    const obj: { output?: string } = { output: null as unknown as string };
    await nudgeDirectWork(BUILD_CLIENT, { tool: "edit", sessionID: "s1" }, obj);
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
    await nudgeDirectWork(BUILD_CLIENT, { tool: "edit", sessionID: "s1" }, obj);
    assertHasReminder(obj);
  });

  it('fires on "tests/scenarios/x.json"', async () => {
    const obj: { output?: string } = { output: "updated test data" };
    await nudgeDirectWork(BUILD_CLIENT, { tool: "edit", sessionID: "s1" }, obj);
    assertHasReminder(obj);
  });

  it('fires on "src/foo.ts"', async () => {
    const obj: { output?: string } = { output: "changed source" };
    await nudgeDirectWork(BUILD_CLIENT, { tool: "edit", sessionID: "s1" }, obj);
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
    await nudgeDirectWork(BUILD_CLIENT, { tool: "edit", sessionID: "s1" }, obj);
    const out1 = obj.output as string;
    const countAfterFirst = out1.split("DELEGATION REQUIRED").length - 1;
    assert.equal(countAfterFirst, 1);

    // Second call — reminder appended again
    await nudgeDirectWork(BUILD_CLIENT, { tool: "edit", sessionID: "s1" }, obj);
    const out2 = obj.output as string;
    const countAfterSecond = out2.split("DELEGATION REQUIRED").length - 1;
    assert.equal(countAfterSecond, 2);
  });
});

// ---------------------------------------------------------------------------
// Subagent filtering — only build gets the nudge
// ---------------------------------------------------------------------------

describe("subagent filtering", () => {
  const SUBAGENTS = ["lynx", "beaver", "spider"];

  for (const agent of SUBAGENTS) {
    it(`does not nudge "${agent}" agent`, async () => {
      const c = mockClient(agent);
      const obj: { output?: string } = {
        output: "edited something as subagent",
      };
      await nudgeDirectWork(c, { tool: "edit", sessionID: "s1" }, obj);
      assert.equal(obj.output, "edited something as subagent");
    });
  }

  it("skips nudge when client is null (no client available)", async () => {
    const obj: { output?: string } = { output: "edited something" };
    await nudgeDirectWork(null, { tool: "edit", sessionID: "s1" }, obj);
    assert.equal(obj.output, "edited something");
  });

  it("nudges when getSession returns agent='dolphin'", async () => {
    const obj: { output?: string } = { output: "edited something" };
    await nudgeDirectWork(BUILD_CLIENT, { tool: "edit", sessionID: "s1" }, obj);
    assertHasReminder(obj);
  });

  it("skips nudge when getSession throws", async () => {
    const badClient = {
      getSession: async () => {
        throw new Error("fail");
      },
    };
    const obj: { output?: string } = { output: "edited something" };
    await nudgeDirectWork(badClient, { tool: "edit", sessionID: "s1" }, obj);
    assert.equal(obj.output, "edited something");
  });

  for (const tool of SEARCH_TOOLS) {
    it(`does not nudge "${tool}" for non-dolphin agent`, async () => {
      const c = mockClient("lynx");
      const obj: { output?: string } = {
        output: "searched as subagent",
      };
      await nudgeDirectWork(c, { tool, sessionID: "s1" }, obj);
      assert.equal(obj.output, "searched as subagent");
    });
  }

  it("skips grep nudge when client is null", async () => {
    const obj: { output?: string } = { output: "searched something" };
    await nudgeDirectWork(null, { tool: "grep", sessionID: "s1" }, obj);
    assert.equal(obj.output, "searched something");
  });

  it("nudges grep when agent is dolphin", async () => {
    const obj: { output?: string } = { output: "searched something" };
    await nudgeDirectWork(BUILD_CLIENT, { tool: "grep", sessionID: "s1" }, obj);
    assertHasSearchReminder(obj);
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
// Integration: via plugin entry point
// ---------------------------------------------------------------------------

describe("integration: tool.execute.after via plugin", () => {
  it("edit tool appends reminder via plugin", async () => {
    const plugin = await zookeeper({ client: BUILD_CLIENT });
    const output: { output?: string } = {
      output: "fixed formatting in index.ts",
    };
    await plugin["tool.execute.after"](
      { tool: "edit", sessionID: "s1", callID: "c1" },
      output,
    );
    assert.ok(output.output?.includes("DELEGATION REQUIRED"));
    assert.ok(output.output?.includes("Contract R1"));
  });

  it("bash tool remains unchanged via plugin", async () => {
    const plugin = await zookeeper({ client: BUILD_CLIENT });
    const output: { output?: string } = {
      output: "ls output here",
    };
    await plugin["tool.execute.after"](
      { tool: "bash", sessionID: "s1", callID: "c1" },
      output,
    );
    assert.equal(output.output, "ls output here");
  });
});

// ---------------------------------------------------------------------------
// Plan nudge scenarios
// ---------------------------------------------------------------------------

/**
 * Write a plan file under ~/.zoo/plans/<sessionID>/.
 */
function writePlanFile(
  sessionID: string,
  filename: string,
  frontmatter: Record<string, string>,
  body: string,
): void {
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const content = `---\n${fmLines}\n---\n\n${body}`;
  const dir = join(homedir(), ".zoo", "plans", sessionID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf-8");
}

/**
 * Remove a session's plan directory recursively.
 */
function cleanupPlanDir(sessionID: string): void {
  try {
    rmSync(join(homedir(), ".zoo", "plans", sessionID), {
      recursive: true,
      force: true,
    });
  } catch {
    // ignore
  }
}

let _planNudgeCounter = 0;

describe("plan nudge scenarios", () => {
  it("dolphin edit with executing plan (open TODOs) includes PLAN_PROGRESS_NUDGE", async () => {
    const sessionID = `test-direct-nudge-${Date.now()}-${_planNudgeCounter++}`;
    try {
      writePlanFile(
        sessionID,
        "my-plan.md",
        { status: "executing", slug: "my-plan" },
        "- [ ] Write tests\n- [x] Implement feature\n",
      );
      const result: { output?: string } = { output: "edited file" };
      await nudgeDirectWork(BUILD_CLIENT, { tool: "edit", sessionID }, result);
      assert.ok(
        result.output?.includes("PLAN PROGRESS"),
        "expected PLAN PROGRESS nudge",
      );
    } finally {
      cleanupPlanDir(sessionID);
    }
  });

  it("dolphin edit with executing plan (all done) includes PLAN_DONE_NUDGE", async () => {
    const sessionID = `test-direct-nudge-${Date.now()}-${_planNudgeCounter++}`;
    try {
      writePlanFile(
        sessionID,
        "my-plan.md",
        { status: "executing", slug: "my-plan" },
        "- [x] Task A\n- [x] Task B\n",
      );
      const result: { output?: string } = { output: "edited file" };
      await nudgeDirectWork(BUILD_CLIENT, { tool: "edit", sessionID }, result);
      assert.ok(
        result.output?.includes("PLAN COMPLETE"),
        "expected PLAN COMPLETE nudge",
      );
    } finally {
      cleanupPlanDir(sessionID);
    }
  });

  it("dolphin edit with done plan includes PLAN_RESUME_NUDGE", async () => {
    const sessionID = `test-direct-nudge-${Date.now()}-${_planNudgeCounter++}`;
    try {
      writePlanFile(
        sessionID,
        "my-plan.md",
        { status: "done", slug: "my-plan" },
        "- [x] All done\n",
      );
      const result: { output?: string } = { output: "edited file" };
      await nudgeDirectWork(BUILD_CLIENT, { tool: "edit", sessionID }, result);
      assert.ok(
        result.output?.includes("PLAN RESURRECTED"),
        "expected PLAN RESURRECTED nudge",
      );
    } finally {
      cleanupPlanDir(sessionID);
    }
  });

  it("beaver edit does not include plan nudge", async () => {
    const sessionID = `test-direct-nudge-${Date.now()}-${_planNudgeCounter++}`;
    try {
      // No plan directory needed — beaver is not dolphin so the hook
      // returns before checking plans.
      cleanupPlanDir(sessionID);
      const client = mockClient("beaver");
      const result: { output?: string } = { output: "edited file" };
      await nudgeDirectWork(client, { tool: "edit", sessionID }, result);
      assert.equal(
        result.output,
        "edited file",
        "beaver output should be unchanged",
      );
      assert.equal(
        result.output?.includes("PLAN PROGRESS"),
        false,
        "should not contain PLAN PROGRESS",
      );
      assert.equal(
        result.output?.includes("PLAN COMPLETE"),
        false,
        "should not contain PLAN COMPLETE",
      );
      assert.equal(
        result.output?.includes("PLAN RESURRECTED"),
        false,
        "should not contain PLAN RESURRECTED",
      );
    } finally {
      cleanupPlanDir(sessionID);
    }
  });

  it("dolphin grep does not include plan nudge", async () => {
    const sessionID = `test-direct-nudge-${Date.now()}-${_planNudgeCounter++}`;
    try {
      // Plan nudge only fires for edit/write, not search tools.
      cleanupPlanDir(sessionID);
      const result: { output?: string } = { output: "grep result" };
      await nudgeDirectWork(BUILD_CLIENT, { tool: "grep", sessionID }, result);
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
      cleanupPlanDir(sessionID);
    }
  });
});
