/**
 * Tests for src/core/checks.ts — plan progress and todo progress check
 * functions.
 *
 * Filesystem operations use temporary directories under os.tmpdir() and
 * clean up afterwards, following the same pattern as the plan.test.ts tests.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkPlanProgress, checkTodoProgress } from "./checks.js";
import type { TinyClient } from "./client/todo.js";

// ---------------------------------------------------------------------------
// Counters for unique session IDs
// ---------------------------------------------------------------------------

let _counter = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  const dir = join(tmpdir(), `zoo-checks-test-${Date.now()}-${_counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a plan file under a baseDir's .zoo/plans/ (flat, no sessionID
 * subdirectory).
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

// ---------------------------------------------------------------------------
// checkPlanProgress
// ---------------------------------------------------------------------------

describe("checkPlanProgress", () => {
  it("returns null when no plan directory exists", () => {
    const sessionID = `test-checks-${Date.now()}-${_counter++}`;
    const baseDir = tmpDir();
    const result = checkPlanProgress(sessionID, baseDir);
    assert.equal(result, null);
    cleanupPlanDir(baseDir);
  });

  it("returns PLAN PROGRESS nudge for executing plan with open TODOs", () => {
    const sessionID = `test-checks-${Date.now()}-${_counter++}`;
    const baseDir = tmpDir();
    try {
      writePlanFile(
        baseDir,
        "my-plan.md",
        { status: "executing", slug: "my-plan" },
        "- [ ] Write tests\n- [x] Implement feature\n",
      );
      const result = checkPlanProgress(sessionID, baseDir);
      assert.ok(result !== null, "expected non-null result");
      assert.ok(
        result?.includes("PLAN PROGRESS"),
        "expected PLAN PROGRESS in result",
      );
    } finally {
      cleanupPlanDir(baseDir);
    }
  });

  it("returns PLAN COMPLETE nudge for executing plan with all TODOs done", () => {
    const sessionID = `test-checks-${Date.now()}-${_counter++}`;
    const baseDir = tmpDir();
    try {
      writePlanFile(
        baseDir,
        "my-plan.md",
        { status: "executing", slug: "my-plan" },
        "- [x] Task A\n- [x] Task B\n",
      );
      const result = checkPlanProgress(sessionID, baseDir);
      assert.ok(result !== null, "expected non-null result");
      assert.ok(
        result?.includes("PLAN COMPLETE"),
        "expected PLAN COMPLETE in result",
      );
    } finally {
      cleanupPlanDir(baseDir);
    }
  });

  it("returns PLAN RESURRECTED nudge for done plan", () => {
    const sessionID = `test-checks-${Date.now()}-${_counter++}`;
    const baseDir = tmpDir();
    try {
      writePlanFile(
        baseDir,
        "my-plan.md",
        { status: "done", slug: "my-plan" },
        "- [x] All done\n",
      );
      const result = checkPlanProgress(sessionID, baseDir);
      assert.ok(result !== null, "expected non-null result");
      assert.ok(
        result?.includes("PLAN RESURRECTED"),
        "expected PLAN RESURRECTED in result",
      );
    } finally {
      cleanupPlanDir(baseDir);
    }
  });

  it("returns null when filesystem read fails (directory named plan.md)", () => {
    const sessionID = `test-checks-${Date.now()}-${_counter++}`;
    const baseDir = tmpDir();
    const dir = join(baseDir, ".zoo", "plans");
    try {
      mkdirSync(dir, { recursive: true });
      // Create a *directory* named plan.md — readdirSync includes it
      // (it ends with ".md"), but readFileSync on a directory throws,
      // triggering the catch block.
      mkdirSync(join(dir, "plan.md"));
      const result = checkPlanProgress(sessionID, baseDir);
      assert.equal(result, null);
    } finally {
      cleanupPlanDir(baseDir);
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
