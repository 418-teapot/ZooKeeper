/**
 * Pure logic for plan lifecycle management.
 *
 * This module contains only framework-independent functions:
 * - Plan file discovery and frontmatter parsing
 * - Plan status transitions
 *
 * All functions are pure or perform only filesystem I/O — no OpenCode
 * client dependencies, no TUI interactions, no logging.
 *
 * @module
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of locating a plan file in the plans directory.
 */
export interface FoundPlan {
  /** Absolute path to the plan markdown file. */
  path: string;
  /** Full file content including frontmatter. */
  content: string;
  /** Plan slug from frontmatter or filename. */
  slug: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the plans directory under a workspace base directory.
 *
 * @param baseDir - Workspace base directory.
 * @returns Absolute path to `<baseDir>/.zoo/plans`.
 */
export function plansDir(baseDir: string): string {
  return resolve(baseDir, ".zoo", "plans");
}

/**
 * Parse YAML frontmatter from a markdown file.
 *
 * Looks for the first `---`-delimited block and extracts key-value pairs.
 * Both quoted and unquoted values are supported. Keys are word characters
 * (alphabetic, digits, hyphens); quoted keys with special characters are not
 * needed for plan frontmatter (only `status`, `slug`, etc.).
 *
 * @param content - Full file content.
 * @returns Parsed frontmatter as a flat key-value map, or `null` if no
 *   frontmatter block is found.
 */
export function parseFrontmatter(
  content: string,
): Record<string, string> | null {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const trimmedLine = line.replace(/\r$/, "");
    const kv = trimmedLine.match(/^(\w[\w-]*)\s*:\s*(.+)/);
    if (kv) {
      frontmatter[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return frontmatter;
}

// ---------------------------------------------------------------------------
// Plan discovery
// ---------------------------------------------------------------------------

/**
 * Find a plan file with the given status in the workspace's plans directory.
 *
 * Scans `<baseDir>/.zoo/plans/` for `.md` files, sorted by mtime
 * DESCENDING (newest first), and returns the first whose frontmatter
 * `status` matches the target status.
 *
 * @param baseDir - Workspace base directory.
 * @param targetStatus - The status to search for (e.g. `"planning-done"`).
 * @returns The found plan, or `null` if no matching plan exists.
 */
export function findPlanByStatus(
  baseDir: string,
  targetStatus: string,
): FoundPlan | null {
  // Guard: an empty/missing baseDir would make plansDir resolve against
  // process.cwd(), a hidden indirection that breaks worktree-readiness.
  // Treat it as "no plan directory" rather than scanning the cwd.
  if (!baseDir) return null;
  const dir = plansDir(baseDir);
  if (!existsSync(dir)) return null;

  const entries = readdirSync(dir, { encoding: "utf-8" });
  const mdFiles = entries.filter((e) => e.endsWith(".md"));

  // Pre-compute mtime for each file: one statSync per file (O(N)) instead
  // of calling statSync inside the sort comparator (O(N log N) syscalls).
  const filesWithMtime = mdFiles.map((file) => {
    const filePath = join(dir, file);
    try {
      const stat = statSync(filePath);
      return { file, mtime: stat.mtimeMs };
    } catch {
      return { file, mtime: 0 };
    }
  });

  // Sort by mtime DESCENDING (newest first).
  filesWithMtime.sort((a, b) => b.mtime - a.mtime);

  for (const { file } of filesWithMtime) {
    const filePath = join(dir, file);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      // Skip unreadable entries (e.g. a directory named foo.md, or a
      // file deleted between readdirSync and readFileSync).
      continue;
    }
    const fm = parseFrontmatter(content);
    if (fm?.status === targetStatus) {
      return {
        path: filePath,
        content,
        slug: fm.slug ?? file.replace(/\.md$/, ""),
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plan status transitions
// ---------------------------------------------------------------------------

/**
 * Update the plan's frontmatter status.
 *
 * Replaces the `status:` line in the frontmatter block. The replacement
 * is done in-memory; the caller is responsible for writing the result.
 *
 * @param content - Full plan file content.
 * @param newStatus - The new status value (e.g. `"executing"`).
 * @returns Updated content with the new status.
 */
export function updatePlanStatus(content: string, newStatus: string): string {
  return content.replace(/^status:\s*\S+/m, () => `status: ${newStatus}`);
}

/**
 * Write updated plan content back to disk.
 *
 * @param planPath - Absolute path to the plan file.
 * @param content - Updated content to write.
 */
export function writePlan(planPath: string, content: string): void {
  writeFileSync(planPath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// TODO counting
// ---------------------------------------------------------------------------

/**
 * Count open TODO checkboxes in plan file content.
 *
 * Only lines starting with `- [ ]` (markdown unchecked checkbox) are
 * counted. Lines with `- [x]` (checked), nested indentation, or other
 * patterns are ignored.
 *
 * @param content - Full plan file content.
 * @returns Number of open TODOs (0 if none or empty content).
 */
export function countOpenTodos(content: string): number {
  const matches = content.match(/^- \[ \]/gm);
  return matches ? matches.length : 0;
}

/**
 * Check whether all TODOs in a plan are done.
 *
 * Returns `true` when {@link countOpenTodos} returns 0. Content with no
 * checkboxes at all is considered "all done" (vacuously true).
 *
 * @param content - Full plan file content.
 * @returns `true` if there are zero open TODOs.
 */
export function allTodosDone(content: string): boolean {
  return countOpenTodos(content) === 0;
}

// ---------------------------------------------------------------------------
// Prompt generation
// ---------------------------------------------------------------------------

/**
 * Build the plan reference prompt for injection into a new session.
 *
 * Instead of sending the full plan content (which wastes tokens and
 * duplicates the file), this returns a concise reference with the file
 * path and instructions to read and update the plan.
 *
 * @param planPath - Absolute path to the plan file.
 * @returns Prompt text for the new session.
 */
export function buildPlanReference(planPath: string): string {
  return (
    `Plan file: ${planPath}\n\n` +
    "Read this file at the start of execution. " +
    "Update the plan's TODO checkboxes as you complete each task. " +
    "When all TODOs are finished, update status to done."
  );
}

/**
 * Build the silent confirmation text for the new session.
 *
 * This text appears in the TUI but is not processed by the LLM
 * (used with `noReply: true` and `ignored: true`).
 *
 * @returns Confirmation text.
 */
export function buildConfirmText(): string {
  return "Plan handed off to dolphin.";
}
