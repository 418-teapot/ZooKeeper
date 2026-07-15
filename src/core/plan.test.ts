/**
 * Tests for src/core/plan.ts — pure plan lifecycle logic.
 *
 * All filesystem operations use temporary directories under os.tmpdir()
 * to avoid polluting any real .zoo/plans directory.
 */

import { describe, expect, it } from "bun:test";
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
    expect(dir).toBe(join(base, ".zoo", "plans"));
    cleanup(base);
  });

  it("returns absolute path", () => {
    const base = tmpDir();
    const dir = plansDir(base);
    expect(dir).toInclude(".zoo/plans");
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
    expect(fm).toEqual({ status: "planning-done", slug: "my-plan" });
  });

  it("strips quotes from values", () => {
    const content = `---\nstatus: "executing"\nslug: 'test-plan'\n---\n`;
    const fm = parseFrontmatter(content);
    expect(fm).toEqual({ status: "executing", slug: "test-plan" });
  });

  it("returns null when no frontmatter exists", () => {
    const fm = parseFrontmatter("# Just a title\n");
    expect(fm).toBeNull();
  });

  it("returns empty object for empty frontmatter block", () => {
    const fm = parseFrontmatter("---\n\n---\n# Title\n");
    expect(fm).toEqual({});
  });

  it("ignores lines that do not match key: value", () => {
    const content = `---\nstatus: done\n# This is a comment\n---\n`;
    const fm = parseFrontmatter(content);
    expect(fm).toEqual({ status: "done" });
  });

  it("supports hyphenated keys", () => {
    const content = `---\nplan-status: ready\n---\n`;
    const fm = parseFrontmatter(content);
    expect(fm).toEqual({ "plan-status": "ready" });
  });
});

// ---------------------------------------------------------------------------
// findPlanByStatus
// ---------------------------------------------------------------------------

describe("findPlanByStatus", () => {
  it("returns null when plans directory does not exist", () => {
    const base = tmpDir();
    const plan = findPlanByStatus(base, "planning-done");
    expect(plan).toBeNull();
    cleanup(base);
  });

  it("returns null when baseDir is empty (no hidden cwd scan)", () => {
    // An empty baseDir must NOT fall back to process.cwd()/.zoo/plans —
    // that would be a hidden indirection breaking worktree-readiness.
    const plan = findPlanByStatus("", "planning-done");
    expect(plan).toBeNull();
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
    expect(plan).not.toBeNull();
    expect(plan?.path).toBe(planPath);
    expect(plan?.slug).toBe("my-plan");
    expect(plan?.content).toInclude("# my-plan.md");

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
    expect(plan).not.toBeNull();
    // Newest plan should be returned first.
    expect(plan?.path).toBe(newerPath);
    expect(plan?.slug).toBe("newer");

    cleanup(base);
  });

  it("returns null when no plan matches the target status", () => {
    const base = tmpDir();
    createPlanFile(base, "executing-plan.md", "executing", "exec-plan");

    const plan = findPlanByStatus(base, "planning-done");
    expect(plan).toBeNull();

    cleanup(base);
  });

  it("uses filename as slug fallback when frontmatter lacks slug", () => {
    const base = tmpDir();
    const _planPath = createPlanFile(base, "fallback-slug.md", "planning-done");

    const plan = findPlanByStatus(base, "planning-done");
    expect(plan).not.toBeNull();
    expect(plan?.slug).toBe("fallback-slug");

    cleanup(base);
  });

  it("ignores non-markdown files", () => {
    const base = tmpDir();
    const plansDirPath = join(base, ".zoo", "plans");
    mkdirSync(plansDirPath, { recursive: true });
    writeFileSync(join(plansDirPath, "readme.txt"), "not a plan");
    const planPath = createPlanFile(base, "real-plan.md", "planning-done");

    const plan = findPlanByStatus(base, "planning-done");
    expect(plan).not.toBeNull();
    expect(plan?.path).toBe(planPath);

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
    expect(plan).not.toBeNull();
    expect(plan?.path).toBe(realPath);
    expect(plan?.slug).toBe("real");

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
    expect(updated).toBe(`---\nstatus: executing\n---\n# Plan\n`);
  });

  it("replaces status with different values", () => {
    const content = `---\nstatus: draft\n---\n# Plan\n`;
    const updated = updatePlanStatus(content, "done");
    expect(updated).toBe(`---\nstatus: done\n---\n# Plan\n`);
  });

  it("does not modify other frontmatter fields", () => {
    const content = `---\nstatus: planning-done\nslug: my-plan\n---\n# Plan\n`;
    const updated = updatePlanStatus(content, "executing");
    expect(updated).toInclude("slug: my-plan");
    expect(updated).toInclude("status: executing");
  });

  it("returns unchanged content when no status line exists", () => {
    const content = `---\nslug: my-plan\n---\n# Plan\n`;
    const updated = updatePlanStatus(content, "executing");
    expect(updated).toBe(content);
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
    expect(readBack).toBe("# Test Plan\n");

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
    expect(ref).toInclude("Plan file: /workspace/.zoo/plans/my-plan.md");
  });

  it("includes instructions to read and update the plan", () => {
    const ref = buildPlanReference("/path/to/plan.md");
    expect(ref).toInclude("Read this file at the start of execution");
    expect(ref).toInclude("Update the plan's TODO checkboxes");
    expect(ref).toInclude("When all TODOs are finished, update status to done");
  });
});

// ---------------------------------------------------------------------------
// buildConfirmText
// ---------------------------------------------------------------------------

describe("buildConfirmText", () => {
  it("returns the expected confirmation text", () => {
    const text = buildConfirmText();
    expect(text).toBe("Plan handed off to dolphin.");
  });
});

// ---------------------------------------------------------------------------
// countOpenTodos / allTodosDone
// ---------------------------------------------------------------------------

describe("countOpenTodos", () => {
  it("returns 0 for empty string", () => {
    expect(countOpenTodos("")).toBe(0);
  });

  it("returns 1 for one open and one checked task", () => {
    expect(countOpenTodos("- [ ] task\n- [x] done")).toBe(1);
  });

  it("returns 0 when all tasks are checked", () => {
    expect(countOpenTodos("- [x] a\n- [x] b")).toBe(0);
  });

  it("returns 2 for multiple open tasks", () => {
    expect(countOpenTodos("- [ ] a\n- [ ] b\n- [x] c")).toBe(2);
  });
});

describe("allTodosDone", () => {
  it("returns true when all tasks are checked", () => {
    expect(allTodosDone("- [x] a\n- [x] b")).toBe(true);
  });

  it("returns false when a task is open", () => {
    expect(allTodosDone("- [ ] a\n- [x] b")).toBe(false);
  });

  it("returns true for content with no checkboxes (vacuously true)", () => {
    expect(allTodosDone("no checkboxes here")).toBe(true);
  });

  it("returns true for empty string", () => {
    expect(allTodosDone("")).toBe(true);
  });
});
