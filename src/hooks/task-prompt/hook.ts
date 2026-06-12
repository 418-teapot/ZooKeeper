/**
 * Task prompt validation hook for ZooKeeper OpenCode plugin.
 *
 * Validates task() prompt structure (SUMMARY / CONTEXT / ACCEPTANCE sections),
 * enforces word-count limits, and detects common anti-patterns (code blocks,
 * line references) in CONTEXT. Also provides handler functions for enhancing
 * the task tool definition and appending advisory nudges to tool output.
 *
 * @module
 */

import { debug } from "../utils/logger.js";

/**
 * Format guidance shown in the `task` tool's `prompt` parameter description.
 * The LLM sees this in the schema on every call.
 */
export const TASK_PROMPT_HINT =
  "Format: SUMMARY (1 sentence — desired outcome)" +
  " | CONTEXT (facts subagent cannot discover:" +
  " target file path, user intent, constraints," +
  " prior failure conclusions)" +
  " | ACCEPTANCE (1-2 verifiable outcomes)." +
  " Required for all delegation targets," +
  " regardless of agent type." +
  " Keep CONTEXT focused on WHAT and WHY," +
  " not HOW — subagents read files and decide" +
  " implementation themselves.";

/** Regex matching section headers: SUMMARY, CONTEXT, ACCEPTANCE. */
const SECTION_HEADER_RE =
  /^(\s*[-–]\s+)?\*{0,2}(SUMMARY|CONTEXT|ACCEPTANCE)\*{0,2}:\s*(.*)$/im;

/** Regex matching English line references like "line 42". */
const LINE_REF_RE = /\bline\s+\d+\b/i;

/** Regex matching Chinese line references like "行 42" or "第 42 行". */
const CHINESE_LINE_REF_RE = /行\s*\d+|第\s*\d+\s*行/;

/** Regex matching triple-backtick code blocks. */
const CODE_BLOCK_RE = /```/;

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

/**
 * Split a task prompt into its named sections.
 *
 * Supports multiple formatting styles:
 *   - `SUMMARY: ...`
 *   - `- SUMMARY: ...`
 *   - `**SUMMARY:** ...`
 *   - `- **SUMMARY:** ...`
 *
 * The text after the colon on the header line is included as the first line of
 * the section content. Subsequent lines belong to the section until the next
 * header or end-of-string.
 *
 * @param prompt - Raw task prompt string.
 * @returns A map of section name → content (trimmed). Missing sections are
 *   absent from the map.
 */
function extractSections(prompt: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = prompt.split("\n");

  let currentSection: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const match = line.match(SECTION_HEADER_RE);
    if (match) {
      // Persist previous section
      if (currentSection) {
        sections[currentSection] = currentContent.join("\n").trim();
      }
      currentSection = match[2].toUpperCase();
      // Everything after the colon on the same line is the first line of content
      currentContent = [match[3]];
    } else {
      currentContent.push(line);
    }
  }

  // Don't forget the last section
  if (currentSection) {
    sections[currentSection] = currentContent.join("\n").trim();
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Word count
// ---------------------------------------------------------------------------

/**
 * @param text - Arbitrary text.
 * @returns Number of whitespace-separated tokens (words).
 */
function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Nudge pattern detection — advisory, not blocking
// ---------------------------------------------------------------------------

/**
 * Check a CONTEXT section for patterns worth nudging about.
 *
 * These are advisory suggestions, not hard rules. They help the orchestrator
 * write better prompts over time without blocking execution.
 *
 * @param context - The extracted CONTEXT section content.
 * @returns A list of advisory nudge messages (empty = no issues).
 */
function buildContextNudges(context: string): string[] {
  const nudges: string[] = [];

  if (CODE_BLOCK_RE.test(context)) {
    nudges.push(
      "CONTEXT contains code blocks — subagents can read files" +
        " themselves, consider describing the intent instead.",
    );
  }

  if (LINE_REF_RE.test(context) || CHINESE_LINE_REF_RE.test(context)) {
    nudges.push(
      "CONTEXT contains line references — lines change;" +
        " let subagents locate the exact code.",
    );
  }

  return nudges;
}

// ---------------------------------------------------------------------------
// Public validation API
// ---------------------------------------------------------------------------

/**
 * Configurable word-count limits for task prompt validation,
 * loaded from `config.toml` at plugin initialization.
 */
export interface ValidationLimits {
  contextWordLimit: number;
  promptWordLimit: number;
}

/**
 * Validate a task() prompt against the build.md specification.
 *
 * Hard check (blocking):
 *   1. All three required sections (SUMMARY, CONTEXT, ACCEPTANCE) are present.
 *
 * Soft checks (advisory nudges, not blocking):
 *   2. CONTEXT ≤ `limits.contextWordLimit` words — nudge to split or condense.
 *   3. Total prompt ≤ `limits.promptWordLimit` words — nudge toward conciseness.
 *   4. CONTEXT contains code blocks or line references — nudge toward intent.
 *
 * @param prompt - The `prompt` argument passed to the `task()` tool.
 * @param limits - Optional thresholds; defaults to 100 (context) and 250 (total).
 * @returns Validation result with `valid` flag, hard `errors`, and soft `warnings`.
 */
export function validateTaskPrompt(
  prompt: string,
  limits?: Partial<ValidationLimits>,
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  const contextWordLimit = limits?.contextWordLimit ?? 100;
  const promptWordLimit = limits?.promptWordLimit ?? 250;

  // --- 1. Extract sections (hard check) ---
  const sections = extractSections(prompt);
  const required = ["SUMMARY", "CONTEXT", "ACCEPTANCE"];

  for (const section of required) {
    if (!sections[section]) {
      errors.push(`Missing required section: ${section}`);
    }
  }

  // If CONTEXT is missing we can't proceed with soft checks
  if (!sections.CONTEXT) {
    return { valid: false, errors, warnings };
  }

  // --- 2. CONTEXT word count (soft) ---
  const cw = wordCount(sections.CONTEXT);
  if (cw > contextWordLimit) {
    warnings.push(
      `CONTEXT is ${cw} words — consider splitting into multiple` +
        " task() calls if subagent struggles with this much context.",
    );
  }

  // --- 3. Total prompt word count (soft) ---
  const tw = wordCount(prompt);
  if (tw > promptWordLimit) {
    warnings.push(
      `Total prompt is ${tw} words — subagents work best with` +
        " concise task descriptions.",
    );
  }

  // --- 4. Pattern nudges in CONTEXT (soft) ---
  warnings.push(...buildContextNudges(sections.CONTEXT));

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Handler functions — wired by the plugin entry point
// ---------------------------------------------------------------------------

/**
 * Enhance the `task` tool's `prompt` parameter description with format
 * guidance. This makes the LLM aware of the required section structure.
 *
 * @param input - Hook input containing the tool ID.
 * @param input.toolID - Identifier of the tool being defined.
 * @param output - Hook output object mutated in place.
 * @param output.description - Tool description.
 * @param output.parameters - JSON Schema parameters object.
 */
export function enhanceTaskDefinition(
  input: { toolID: string },
  output: { description: string; parameters: any },
): void {
  if (input.toolID !== "task") return;

  const promptParam = output.parameters?.properties?.prompt;
  if (!promptParam || typeof promptParam !== "object") return;

  const existing = promptParam.description ?? "";
  promptParam.description = existing
    ? `${existing}\n\n${TASK_PROMPT_HINT}`
    : TASK_PROMPT_HINT;
}

/**
 * Validate a task prompt before execution. Throws a blocking error if the
 * prompt is missing required sections (SUMMARY, CONTEXT, ACCEPTANCE).
 *
 * @param input - Hook input containing the tool name.
 * @param input.tool - Name of the tool being executed.
 * @param output - Hook output object with execution arguments.
 * @param output.args - Tool call arguments.
 * @param limits - Validation limits (word count thresholds).
 * @throws Error if the prompt lacks required sections.
 */
export function validateBeforeExec(
  input: { tool: string },
  output: { args?: Record<string, unknown> },
  limits: ValidationLimits,
): void {
  if (input.tool !== "task") return;

  const promptArg = output.args?.prompt;
  if (typeof promptArg !== "string") return;

  const result = validateTaskPrompt(promptArg, limits);

  if (!result.valid) {
    const details = result.errors.map((e) => `- ${e}`).join("\n");
    debug("task-prompt-validate", {
      valid: false,
      errors: result.errors.length,
    });
    throw new Error(
      "Task prompt format error:\n" +
        `${details}\n\n` +
        "Required format:\n" +
        "- SUMMARY: one sentence — desired outcome\n" +
        "- CONTEXT: facts subagent cannot discover\n" +
        "- ACCEPTANCE: 1-2 verifiable outcomes\n\n" +
        "Please rewrite before delegating.",
    );
  }

  // Validation passed — log if there are warnings
  if (result.warnings.length > 0) {
    debug("task-prompt-validate", {
      valid: true,
      warnings: result.warnings.length,
    });
  }
}

/**
 * Append advisory prompt nudges to task tool output.
 *
 * Extracts the prompt from the input args, validates it, and appends any
 * soft warnings (context too long, code blocks, line references) as
 * guidance for the orchestrator LLM.
 *
 * @param input - Hook input containing the tool name and execution args.
 * @param input.tool - Name of the tool that was executed.
 * @param input.args - Tool call arguments (may contain the prompt).
 * @param output - Hook output object mutated in place.
 * @param output.output - Text output from the tool call.
 * @param limits - Validation limits (word count thresholds).
 */
export function nudgeTaskOutput(
  input: { tool: string; args?: Record<string, unknown> },
  output: { output?: string },
  limits: ValidationLimits,
): void {
  if (input.tool !== "task") return;

  const promptArg = input.args?.prompt;
  if (typeof promptArg !== "string") return;

  const result = validateTaskPrompt(promptArg, limits);
  if (result.warnings.length === 0) return;

  // Append nudges to tool output so the orchestrator LLM sees them
  const nudgeText = result.warnings.map((w) => `- ${w}`).join("\n");
  const suffix = `\n\n--- Guidance for next time ---\n${nudgeText}`;
  output.output = (output.output ?? "") + suffix;

  debug("task-prompt-nudge", {
    warnings: result.warnings.length,
  });
}
