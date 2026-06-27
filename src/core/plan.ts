/**
 * Pure logic for plan lifecycle management.
 *
 * This module contains only framework-independent functions:
 * - Plan file discovery and frontmatter parsing
 * - Plan status transitions
 * - Plan path rewriting for tool interception
 *
 * All functions are pure or perform only filesystem I/O — no OpenCode
 * client dependencies, no TUI interactions, no logging.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
 * Resolve the plans directory for a given session ID.
 *
 * @param sessionID - The current session identifier.
 * @param baseDir - Base directory for plans (defaults to home directory).
 * @returns Absolute path to `<baseDir>/.zoo/plans/<sessionID>`.
 */
export function plansDir(sessionID: string, baseDir?: string): string {
  return resolve(baseDir ?? homedir(), ".zoo", "plans", sessionID);
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
 * Find a plan file with the given status in the session's plans directory.
 *
 * Scans `~/.zoo/plans/<sessionID>/` for `.md` files and returns the first
 * whose frontmatter `status` matches the target status.
 *
 * @param sessionID - The current session identifier.
 * @param targetStatus - The status to search for (e.g. `"planning-done"`).
 * @returns The found plan, or `null` if no matching plan exists.
 */
export function findPlanByStatus(
  sessionID: string,
  targetStatus: string,
  baseDir?: string,
): FoundPlan | null {
  const dir = plansDir(sessionID, baseDir);
  if (!existsSync(dir)) return null;

  const entries = readdirSync(dir, { encoding: "utf-8" });
  const mdFiles = entries.filter((e) => e.endsWith(".md"));

  for (const file of mdFiles) {
    const filePath = join(dir, file);
    const content = readFileSync(filePath, "utf-8");
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
// Path rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite plan file paths to include the session ID subdirectory.
 *
 * When `edit` or `write` tools target a path directly under
 * `~/.zoo/plans/<name>.md` (no subdirectory), this function inserts
 * the session ID: `~/.zoo/plans/<name>.md` →
 * `~/.zoo/plans/<sessionID>/<name>.md`.
 *
 * mola writes to `~/.zoo/plans/<file>.md` without knowing the session
 * ID; this hook transparently redirects writes to the correct per-session
 * subdirectory. Paths that already contain a subdirectory (the relative
 * part includes `/`) are left untouched.
 *
 * @param tool - The tool name (`"edit"` or `"write"`).
 * @param args - The tool call arguments (mutated in place).
 *   Assumes `filePath` as the path key — this is OpenCode's standard
 *   argument name for edit/write tools.
 * @param sessionID - The current session identifier.
 */
export function rewritePlanPath(
  tool: string,
  args: Record<string, unknown> | undefined,
  sessionID: string,
): void {
  if (tool !== "edit" && tool !== "write") return;
  if (!args) return;

  const rawPath = args.filePath;
  if (typeof rawPath !== "string") return;

  const plansRoot = resolve(homedir(), ".zoo", "plans");

  // Resolve tilde expansion so path comparison works correctly.
  const resolved = resolve(rawPath.replace(/^~/, homedir()));

  // Only rewrite if the target is under the plans root.
  if (!resolved.startsWith(`${plansRoot}/`)) return;

  // Already inside a session subdirectory? Skip.
  const relative = resolved.slice(plansRoot.length + 1);
  if (relative.includes("/")) return;

  const rewritten = join(plansRoot, sessionID, relative);
  args.filePath = rewritten;
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
