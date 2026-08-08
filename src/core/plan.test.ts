/**
 * Tests for src/core/plan.ts — pure plan lifecycle logic.
 *
 * All filesystem operations use temporary directories under os.tmpdir()
 * to avoid polluting any real .zoo/plans directory.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  allTodosDone,
  buildConfirmText,
  buildPlanReference,
  countOpenTodos,
  findPlanByStatus,
  parseFrontmatter,
  plansDir,
  updatePlanStatus,
  writePlan,
} from "./plan.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let _tmpCounter = 0;

function tmpDir(): string {
  const dir = join(tmpdir(), `zoo-plan-test-${Date.now()}-${_tmpCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** Create a plan file under a baseDir's .zoo/plans/ directory. */
function createPlanFile(
  baseDir: string,
  filename: string,
  status: string,
  slug?: string,
): string {
  const dir = join(baseDir, ".zoo", "plans");
  mkdirSync(dir, { recursive: true });
  const planPath = join(dir, filename);
  writeFileSync(
    planPath,
    `---\nstatus: ${status}${slug ? `\nslug: ${slug}` : ""}\n---\n# ${filename}\n`,
  );
  return planPath;
}

// ---------------------------------------------------------------------------
// plansDir
// ---------------------------------------------------------------------------

describe("plansDir", () => {
  it("returns path under <baseDir>/.zoo/plans", () => {
    const base = tmpDir();
    const dir = plansDir(base);
    assert.strictEqual(dir, join(base, ".zoo", "plans"));
    cleanup(base);
  });

  it("returns absolute path", () => {
    const base = tmpDir();
    const dir = plansDir(base);
    assert.ok(dir.includes(".zoo/plans"));
    cleanup(base);
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  it("parses basic frontmatter", () => {
    const content = `---\nstatus: planning-done\nslug: my-plan\n---\n# Title\n`;
    const fm = parseFrontmatter(content);
    assert.deepEqual(fm, { status: "planning-done", slug: "my-plan" });
  });

  it("strips quotes from values", () => {
    const content = `---\nstatus: "executing"\nslug: 'test-plan'\n---\n`;
    const fm = parseFrontmatter(content);
    assert.deepEqual(fm, { status: "executing", slug: "test-plan" });
  });

  it("returns null when no frontmatter exists", () => {
    const fm = parseFrontmatter("# Just a title\n");
    assert.strictEqual(fm, null);
  });

  it("returns empty object for empty frontmatter block", () => {
    const fm = parseFrontmatter("---\n\n---\n# Title\n");
    assert.deepEqual(fm, {});
  });

  it("ignores lines that do not match key: value", () => {
    const content = `---\nstatus: done\n# This is a comment\n---\n`;
    const fm = parseFrontmatter(content);
    assert.deepEqual(fm, { status: "done" });
  });

  it("supports hyphenated keys", () => {
    const content = `---\nplan-status: ready\n---\n`;
    const fm = parseFrontmatter(content);
    assert.deepEqual(fm, { "plan-status": "ready" });
  });
});

// ---------------------------------------------------------------------------
// findPlanByStatus
// ---------------------------------------------------------------------------

describe("findPlanByStatus", () => {
  it("returns null when plans directory does not exist", () => {
    const base = tmpDir();
    const plan = findPlanByStatus(base, "planning-done");
    assert.strictEqual(plan, null);
    cleanup(base);
  });

  it("returns null when baseDir is empty (no hidden cwd scan)", () => {
    // An empty baseDir must NOT fall back to process.cwd()/.zoo/plans —
    // that would be a hidden indirection breaking worktree-readiness.
    const plan = findPlanByStatus("", "planning-done");
    assert.strictEqual(plan, null);
  });

  it("finds a plan with matching status", () => {
    const base = tmpDir();
    const planPath = createPlanFile(
      base,
      "my-plan.md",
      "planning-done",
      "my-plan",
    );

    const plan = findPlanByStatus(base, "planning-done");
    assert.notStrictEqual(plan, null);
    assert.strictEqual(plan?.path, planPath);
    assert.strictEqual(plan?.slug, "my-plan");
    assert.ok(plan?.content.includes("# my-plan.md"));

    cleanup(base);
  });

  it("returns the NEWEST plan when multiple match (mtime-desc)", () => {
    const base = tmpDir();
    const olderPath = createPlanFile(
      base,
      "older.md",
      "planning-done",
      "older",
    );
    const newerPath = createPlanFile(
      base,
      "newer.md",
      "planning-done",
      "newer",
    );

    // Set deterministic mtimes: older first, newer second.
    const reference = Date.now();
    utimesSync(
      olderPath,
      new Date(reference - 60000),
      new Date(reference - 60000),
    );
    utimesSync(newerPath, new Date(reference), new Date(reference));

    const plan = findPlanByStatus(base, "planning-done");
    assert.notStrictEqual(plan, null);
    // Newest plan should be returned first.
    assert.strictEqual(plan?.path, newerPath);
    assert.strictEqual(plan?.slug, "newer");

    cleanup(base);
  });

  it("returns null when no plan matches the target status", () => {
    const base = tmpDir();
    createPlanFile(base, "executing-plan.md", "executing", "exec-plan");

    const plan = findPlanByStatus(base, "planning-done");
    assert.strictEqual(plan, null);

    cleanup(base);
  });

  it("uses filename as slug fallback when frontmatter lacks slug", () => {
    const base = tmpDir();
    const _planPath = createPlanFile(base, "fallback-slug.md", "planning-done");

    const plan = findPlanByStatus(base, "planning-done");
    assert.notStrictEqual(plan, null);
    assert.strictEqual(plan?.slug, "fallback-slug");

    cleanup(base);
  });

  it("ignores non-markdown files", () => {
    const base = tmpDir();
    const plansDirPath = join(base, ".zoo", "plans");
    mkdirSync(plansDirPath, { recursive: true });
    writeFileSync(join(plansDirPath, "readme.txt"), "not a plan");
    const planPath = createPlanFile(base, "real-plan.md", "planning-done");

    const plan = findPlanByStatus(base, "planning-done");
    assert.notStrictEqual(plan, null);
    assert.strictEqual(plan?.path, planPath);

    cleanup(base);
  });

  it("skips directories named .md instead of aborting the lookup", () => {
    const base = tmpDir();
    const plansDirPath = join(base, ".zoo", "plans");
    mkdirSync(plansDirPath, { recursive: true });

    // Create a directory named "bad.md" — readdirSync includes it (ends
    // with ".md"), but readFileSync would throw. The per-file try/catch
    // inside findPlanByStatus skips this entry rather than aborting.
    mkdirSync(join(plansDirPath, "bad.md"), { recursive: true });

    // Create a real readable plan with the target status.
    const realPath = createPlanFile(base, "real.md", "planning-done", "real");

    const plan = findPlanByStatus(base, "planning-done");
    assert.notStrictEqual(plan, null);
    assert.strictEqual(plan?.path, realPath);
    assert.strictEqual(plan?.slug, "real");

    cleanup(base);
  });
});

// ---------------------------------------------------------------------------
// updatePlanStatus
// ---------------------------------------------------------------------------

describe("updatePlanStatus", () => {
  it("replaces status in frontmatter", () => {
    const content = `---\nstatus: planning-done\n---\n# Plan\n`;
    const updated = updatePlanStatus(content, "executing");
    assert.strictEqual(updated, `---\nstatus: executing\n---\n# Plan\n`);
  });

  it("replaces status with different values", () => {
    const content = `---\nstatus: draft\n---\n# Plan\n`;
    const updated = updatePlanStatus(content, "done");
    assert.strictEqual(updated, `---\nstatus: done\n---\n# Plan\n`);
  });

  it("does not modify other frontmatter fields", () => {
    const content = `---\nstatus: planning-done\nslug: my-plan\n---\n# Plan\n`;
    const updated = updatePlanStatus(content, "executing");
    assert.ok(updated.includes("slug: my-plan"));
    assert.ok(updated.includes("status: executing"));
  });

  it("returns unchanged content when no status line exists", () => {
    const content = `---\nslug: my-plan\n---\n# Plan\n`;
    const updated = updatePlanStatus(content, "executing");
    assert.strictEqual(updated, content);
  });
});

// ---------------------------------------------------------------------------
// writePlan
// ---------------------------------------------------------------------------

describe("writePlan", () => {
  it("writes content to the specified path", () => {
    const dir = tmpDir();
    const planPath = join(dir, "test-plan.md");

    writePlan(planPath, "# Test Plan\n");

    const readBack = readFileSync(planPath, "utf-8");
    assert.strictEqual(readBack, "# Test Plan\n");

    // Cleanup
    unlinkSync(planPath);
    cleanup(dir);
  });
});

// ---------------------------------------------------------------------------
// buildPlanReference
// ---------------------------------------------------------------------------

describe("buildPlanReference", () => {
  it("includes the plan file path", () => {
    const ref = buildPlanReference("/workspace/.zoo/plans/my-plan.md");
    assert.ok(ref.includes("Plan file: /workspace/.zoo/plans/my-plan.md"));
  });

  it("includes instructions to read and update the plan", () => {
    const ref = buildPlanReference("/path/to/plan.md");
    assert.ok(ref.includes("Read this file at the start of execution"));
    assert.ok(ref.includes("Update the plan's TODO checkboxes"));
    assert.ok(
      ref.includes("When all TODOs are finished, update status to done"),
    );
  });
});

// ---------------------------------------------------------------------------
// buildConfirmText
// ---------------------------------------------------------------------------

describe("buildConfirmText", () => {
  it("returns the expected confirmation text", () => {
    const text = buildConfirmText();
    assert.strictEqual(text, "Plan handed off to dolphin.");
  });
});

// ---------------------------------------------------------------------------
// countOpenTodos / allTodosDone
// ---------------------------------------------------------------------------

describe("countOpenTodos", () => {
  it("returns 0 for empty string", () => {
    assert.strictEqual(countOpenTodos(""), 0);
  });

  it("returns 1 for one open and one checked task", () => {
    assert.strictEqual(countOpenTodos("- [ ] task\n- [x] done"), 1);
  });

  it("returns 0 when all tasks are checked", () => {
    assert.strictEqual(countOpenTodos("- [x] a\n- [x] b"), 0);
  });

  it("returns 2 for multiple open tasks", () => {
    assert.strictEqual(countOpenTodos("- [ ] a\n- [ ] b\n- [x] c"), 2);
  });
});

describe("allTodosDone", () => {
  it("returns true when all tasks are checked", () => {
    assert.strictEqual(allTodosDone("- [x] a\n- [x] b"), true);
  });

  it("returns false when a task is open", () => {
    assert.strictEqual(allTodosDone("- [ ] a\n- [x] b"), false);
  });

  it("returns true for content with no checkboxes (vacuously true)", () => {
    assert.strictEqual(allTodosDone("no checkboxes here"), true);
  });

  it("returns true for empty string", () => {
    assert.strictEqual(allTodosDone(""), true);
  });
});
