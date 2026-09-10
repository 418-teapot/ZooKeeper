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
import { _getBufferForTesting } from "../utils/logger.js";
import { checkPlanProgress, checkTodoProgress } from "./checks.js";
import type { TodoSource } from "./client/todo.js";
import type { TodoItemView } from "./todo/types.js";

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

/** A TodoSource that always resolves the given items. */
function sourceWith(items: TodoItemView[]): TodoSource {
  return async () => items;
}

describe("checkTodoProgress", () => {
  it("returns TODO_PROGRESS_NUDGE when active work remains", async () => {
    const result = await checkTodoProgress(
      sourceWith([
        { content: "Task A", status: "in_progress" },
        { content: "Task B", status: "pending" },
      ]),
      "test-session",
    );
    assert.ok(result !== null, "expected non-null result");
    assert.ok(
      result?.includes("TODO UPDATE REQUIRED"),
      "expected TODO_PROGRESS_NUDGE containing TODO UPDATE REQUIRED",
    );
  });

  it("returns TODO_DONE_NUDGE for one in_progress task and no pending", async () => {
    const result = await checkTodoProgress(
      sourceWith([{ content: "Task A", status: "in_progress" }]),
      "test-session",
    );
    assert.ok(
      result?.includes("last task still in_progress"),
      "expected TODO_DONE_NUDGE text",
    );
  });

  it("returns TODO_RESUME_NUDGE when no item is active", async () => {
    const result = await checkTodoProgress(
      sourceWith([
        { content: "Task A", status: "completed" },
        { content: "Task B", status: "abandoned" },
        { content: "Task C", status: "blocked" },
      ]),
      "test-session",
    );
    assert.ok(
      result?.includes("TODO LIST DONE"),
      "expected TODO_RESUME_NUDGE text",
    );
  });

  it("returns null for an empty list", async () => {
    const result = await checkTodoProgress(sourceWith([]), "test-session");
    assert.equal(result, null);
  });

  it("returns null and logs a warning when the source rejects", async () => {
    const sessionID = `test-checks-${Date.now()}-${_counter++}`;
    const failingSource: TodoSource = async () => {
      throw new Error("read failure");
    };
    const result = await checkTodoProgress(failingSource, sessionID);
    assert.equal(
      result,
      null,
      "expected no nudge when the list cannot be read",
    );
    const failed = _getBufferForTesting().filter(
      (e) =>
        e.hook === "checks" &&
        e.event === "todo_check_failed" &&
        e.sessionId === sessionID,
    );
    assert.equal(failed.length, 1, "expected one todo_check_failed log entry");
  });
});
