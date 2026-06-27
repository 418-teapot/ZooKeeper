/**
 * Tests for src/core/plan.ts — pure plan lifecycle logic.
 *
 * All filesystem operations use temporary directories under os.tmpdir()
 * to avoid polluting the real ~/.zoo/plans/.
 */

import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConfirmText,
  buildPlanReference,
  findPlanByStatus,
  parseFrontmatter,
  plansDir,
  rewritePlanPath,
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

// ---------------------------------------------------------------------------
// plansDir
// ---------------------------------------------------------------------------

describe("plansDir", () => {
  it("returns path under ~/.zoo/plans/<sessionID>", () => {
    const dir = plansDir("sess-123");
    expect(dir).toEndWith(".zoo/plans/sess-123");
    expect(dir).toInclude("sess-123");
  });

  it("accepts custom baseDir", () => {
    const base = tmpDir();
    const dir = plansDir("sess-456", base);
    expect(dir).toBe(join(base, ".zoo", "plans", "sess-456"));
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
    const plan = findPlanByStatus(
      "nonexistent-session-xyz",
      "planning-done",
      base,
    );
    expect(plan).toBeNull();
    cleanup(base);
  });

  it("finds a plan with matching status", () => {
    const base = tmpDir();
    const sessionID = `test-${Date.now()}`;
    const dir = plansDir(sessionID, base);
    mkdirSync(dir, { recursive: true });

    const planPath = join(dir, "my-plan.md");
    writeFileSync(
      planPath,
      `---\nstatus: planning-done\nslug: my-plan\n---\n# My Plan\n`,
    );

    const plan = findPlanByStatus(sessionID, "planning-done", base);
    expect(plan).not.toBeNull();
    expect(plan?.path).toBe(planPath);
    expect(plan?.slug).toBe("my-plan");
    expect(plan?.content).toInclude("# My Plan");

    cleanup(base);
  });

  it("returns null when no plan matches the target status", () => {
    const base = tmpDir();
    const sessionID = `test-${Date.now()}`;
    const dir = plansDir(sessionID, base);
    mkdirSync(dir, { recursive: true });

    const planPath = join(dir, "executing-plan.md");
    writeFileSync(
      planPath,
      `---\nstatus: executing\nslug: exec-plan\n---\n# Exec\n`,
    );

    const plan = findPlanByStatus(sessionID, "planning-done", base);
    expect(plan).toBeNull();

    cleanup(base);
  });

  it("uses filename as slug fallback when frontmatter lacks slug", () => {
    const base = tmpDir();
    const sessionID = `test-${Date.now()}`;
    const dir = plansDir(sessionID, base);
    mkdirSync(dir, { recursive: true });

    const planPath = join(dir, "fallback-slug.md");
    writeFileSync(planPath, `---\nstatus: planning-done\n---\n# No Slug\n`);

    const plan = findPlanByStatus(sessionID, "planning-done", base);
    expect(plan).not.toBeNull();
    expect(plan?.slug).toBe("fallback-slug");

    cleanup(base);
  });

  it("ignores non-markdown files", () => {
    const base = tmpDir();
    const sessionID = `test-${Date.now()}`;
    const dir = plansDir(sessionID, base);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, "readme.txt"), "not a plan");
    const planPath = join(dir, "real-plan.md");
    writeFileSync(planPath, `---\nstatus: planning-done\n---\n# Real Plan\n`);

    const plan = findPlanByStatus(sessionID, "planning-done", base);
    expect(plan).not.toBeNull();
    expect(plan?.path).toBe(planPath);

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
// rewritePlanPath
// ---------------------------------------------------------------------------

describe("rewritePlanPath", () => {
  it("skips non-edit/write tools", () => {
    const args: Record<string, unknown> = { filePath: "~/.zoo/plans/test.md" };
    rewritePlanPath("bash", args, "sess-123");
    expect(args.filePath).toBe("~/.zoo/plans/test.md");
  });

  it("skips when args is undefined", () => {
    // Should not throw
    rewritePlanPath("edit", undefined, "sess-123");
  });

  it("skips when filePath is not a string", () => {
    const args: Record<string, unknown> = { filePath: 123 };
    rewritePlanPath("edit", args, "sess-123");
    expect(args.filePath).toBe(123);
  });

  it("skips paths outside plans root", () => {
    const args: Record<string, unknown> = { filePath: "/tmp/other.md" };
    rewritePlanPath("edit", args, "sess-123");
    expect(args.filePath).toBe("/tmp/other.md");
  });

  it("skips paths already inside a session subdirectory", () => {
    const args: Record<string, unknown> = {
      filePath: "~/.zoo/plans/sess-123/test.md",
    };
    rewritePlanPath("edit", args, "sess-456");
    expect(args.filePath).toBe("~/.zoo/plans/sess-123/test.md");
  });

  it("rewrites path directly under plans root", () => {
    const args: Record<string, unknown> = {
      filePath: "~/.zoo/plans/test.md",
    };
    rewritePlanPath("edit", args, "sess-123");
    expect(args.filePath).toEndWith(".zoo/plans/sess-123/test.md");
  });

  it("handles write tool the same as edit", () => {
    const args: Record<string, unknown> = {
      filePath: "~/.zoo/plans/another.md",
    };
    rewritePlanPath("write", args, "sess-abc");
    expect(args.filePath).toEndWith(".zoo/plans/sess-abc/another.md");
  });

  it("expands tilde to home directory", () => {
    const args: Record<string, unknown> = {
      filePath: "~/.zoo/plans/plan.md",
    };
    rewritePlanPath("edit", args, "sess-789");
    expect(args.filePath).not.toStartWith("~");
    expect(args.filePath).toEndWith(".zoo/plans/sess-789/plan.md");
  });
});

// ---------------------------------------------------------------------------
// buildPlanReference
// ---------------------------------------------------------------------------

describe("buildPlanReference", () => {
  it("includes the plan file path", () => {
    const ref = buildPlanReference("/home/user/.zoo/plans/sess-123/plan.md");
    expect(ref).toInclude("Plan file: /home/user/.zoo/plans/sess-123/plan.md");
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
