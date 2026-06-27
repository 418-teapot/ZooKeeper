/**
 * Tests for src/core/checks.ts — plan progress and todo progress check
 * functions.
 *
 * Filesystem operations use the real ~/.zoo/plans/ directory and clean up
 * afterwards, following the same pattern as the post-task-nudge hook tests.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkPlanProgress, checkTodoProgress } from "./checks.js";
import type { TinyClient } from "./todo.js";

// ---------------------------------------------------------------------------
// Counters for unique session IDs
// ---------------------------------------------------------------------------

let _counter = 0;

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// checkPlanProgress
// ---------------------------------------------------------------------------

describe("checkPlanProgress", () => {
  it("returns null when no plan directory exists", () => {
    const sessionID = `test-checks-${Date.now()}-${_counter++}`;
    const result = checkPlanProgress(sessionID);
    assert.equal(result, null);
  });

  it("returns PLAN PROGRESS nudge for executing plan with open TODOs", () => {
    const sessionID = `test-checks-${Date.now()}-${_counter++}`;
    try {
      writePlanFile(
        sessionID,
        "my-plan.md",
        { status: "executing", slug: "my-plan" },
        "- [ ] Write tests\n- [x] Implement feature\n",
      );
      const result = checkPlanProgress(sessionID);
      assert.ok(result !== null, "expected non-null result");
      assert.ok(
        result?.includes("PLAN PROGRESS"),
        "expected PLAN PROGRESS in result",
      );
    } finally {
      cleanupPlanDir(sessionID);
    }
  });

  it("returns PLAN COMPLETE nudge for executing plan with all TODOs done", () => {
    const sessionID = `test-checks-${Date.now()}-${_counter++}`;
    try {
      writePlanFile(
        sessionID,
        "my-plan.md",
        { status: "executing", slug: "my-plan" },
        "- [x] Task A\n- [x] Task B\n",
      );
      const result = checkPlanProgress(sessionID);
      assert.ok(result !== null, "expected non-null result");
      assert.ok(
        result?.includes("PLAN COMPLETE"),
        "expected PLAN COMPLETE in result",
      );
    } finally {
      cleanupPlanDir(sessionID);
    }
  });

  it("returns PLAN RESURRECTED nudge for done plan", () => {
    const sessionID = `test-checks-${Date.now()}-${_counter++}`;
    try {
      writePlanFile(
        sessionID,
        "my-plan.md",
        { status: "done", slug: "my-plan" },
        "- [x] All done\n",
      );
      const result = checkPlanProgress(sessionID);
      assert.ok(result !== null, "expected non-null result");
      assert.ok(
        result?.includes("PLAN RESURRECTED"),
        "expected PLAN RESURRECTED in result",
      );
    } finally {
      cleanupPlanDir(sessionID);
    }
  });

  it("returns null when filesystem read fails (directory named plan.md)", () => {
    const sessionID = `test-checks-${Date.now()}-${_counter++}`;
    const dir = join(homedir(), ".zoo", "plans", sessionID);
    try {
      mkdirSync(dir, { recursive: true });
      // Create a *directory* named plan.md — readdirSync includes it
      // (it ends with ".md"), but readFileSync on a directory throws,
      // triggering the catch block.
      mkdirSync(join(dir, "plan.md"));
      const result = checkPlanProgress(sessionID);
      assert.equal(result, null);
    } finally {
      cleanupPlanDir(sessionID);
    }
  });
});

// ---------------------------------------------------------------------------
// checkTodoProgress
// ---------------------------------------------------------------------------

describe("checkTodoProgress", () => {
  it("returns null when client is null", async () => {
    const result = await checkTodoProgress(null, "test-session");
    assert.equal(result, null);
  });

  it("returns TODO UPDATE REQUIRED fallback when client API fails", async () => {
    const failingClient: TinyClient = {
      session: {
        todo: async () => {
          throw new Error("API failure");
        },
      },
    };
    const result = await checkTodoProgress(failingClient, "test-session");
    assert.ok(result !== null, "expected non-null result");
    assert.ok(
      result?.includes("TODO UPDATE REQUIRED"),
      "expected TODO_PROGRESS_NUDGE fallback containing TODO UPDATE REQUIRED",
    );
  });
});
