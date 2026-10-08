/**
 * plan-testkit — fixtures for the flat `<baseDir>/.zoo/plans/` layout.
 *
 * Plan files live in a single flat directory in the workspace-relative
 * plan model. Tests that create or clean up plan files go through these
 * helpers so the layout is maintained in one place.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "./tmp.js";

/** A plan file and the base directory that owns its `.zoo/plans/`. */
export interface PlanFixture {
  planPath: string;
  baseDir: string;
}

/**
 * Write a plan file under a baseDir's `.zoo/plans/` (flat layout).
 *
 * @param baseDir - Workspace base directory.
 * @param filename - File name inside `.zoo/plans/`.
 * @param frontmatter - Frontmatter key/value pairs, in insertion order.
 * @param body - Markdown body written below the frontmatter.
 * @returns The absolute path of the written plan file.
 */
export function writePlanFile(
  baseDir: string,
  filename: string,
  frontmatter: Record<string, string>,
  body: string,
): string {
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const content = `---\n${fmLines}\n---\n\n${body}`;
  const dir = join(baseDir, ".zoo", "plans");
  mkdirSync(dir, { recursive: true });
  const planPath = join(dir, filename);
  writeFileSync(planPath, content, "utf-8");
  return planPath;
}

/**
 * Create a fresh temporary base directory holding a `test-plan.md` plan.
 *
 * @param status - Plan frontmatter `status` value.
 * @returns The plan path and the base directory that owns it.
 */
export function createPlanFile(status: string): PlanFixture {
  const baseDir = makeTmpDir("zoo-plan-fixture");
  const planPath = writePlanFile(
    baseDir,
    "test-plan.md",
    { status, slug: "test-plan" },
    "# Test Plan",
  );
  return { planPath, baseDir };
}

/**
 * Remove a plan file (or tree) at the given path.
 *
 * @param planPath - Path to remove.
 */
export function cleanupPlan(planPath: string): void {
  try {
    rmSync(planPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Remove a baseDir's `.zoo/plans/` directory recursively.
 *
 * @param baseDir - Workspace base directory.
 */
export function cleanupPlanDir(baseDir: string): void {
  try {
    rmSync(join(baseDir, ".zoo", "plans"), {
      recursive: true,
      force: true,
    });
  } catch {
    // ignore
  }
}
