/**
 * Framework-independent subagent-prompt validation logic.
 *
 * Pure functions and types for validating the subagent prompt structure
 * (SUMMARY / CONTEXT / ACCEPTANCE sections), enforcing word-count limits,
 * and detecting common anti-patterns (code blocks, line references) in
 * CONTEXT.
 *
 * This module has zero framework dependencies — no logger, no OpenCode types.
 * All functions are synchronous and side-effect-free.
 *
 * @module
 */

/**
 * Regex matching section header lines: SUMMARY, CONTEXT, ACCEPTANCE.
 *
 * A header line is a section name (any letter case) at line start —
 * optionally behind a bullet (`-` / `–`) or a markdown heading prefix
 * (`#`..`######`), optionally wrapped in bold (`*`/`**`) — followed by one
 * of two separators: a colon (`:` / `：`) or a dash.
 *
 * The colon separator consumes an optional closing bold.
 *
 * The dash separator accepts whitespace before it (`**X** - content`) or not
 * (`X- content`), but always requires either whitespace or end-of-line after
 * it. A dangling dash at end of line (`**ACCEPTANCE** -`) is treated like a
 * bare title: the header is recognized and its content starts on the
 * following line. Gluing content directly to the dash (`CONTEXT-dependent`)
 * is rejected so that hyphenated prose is not mistaken for a header.
 *
 * A bare title on its own line (no separator) is a header whose content
 * starts on the following line.
 *
 * Capture groups: 1 = section name, 2 = text after the separator on the
 * header line (empty for a bare title or a dangling dash).
 */
const SECTION_HEADER_RE =
  /^\s*(?:[-–]\s+|#{1,6}\s+)?\*{0,2}(SUMMARY|CONTEXT|ACCEPTANCE)\*{0,2}(?:\s*[:：]\*{0,2}\s*|\s*[–-](?:\s+|$)|\s*$)(.*)$/im;

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
 * Split a subagent prompt into its named sections.
 *
 * Supports multiple formatting styles; section names are recognized in any
 * letter case and may sit behind a bullet, a markdown heading prefix, or bold:
 *   - `SUMMARY: ...`
 *   - `- SUMMARY: ...`
 *   - `**SUMMARY:** ...`
 *   - `- **SUMMARY:** ...`
 *   - `**SUMMARY** - ...`
 *   - `- **SUMMARY** - ...`
 *   - `ACCEPTANCE- ...` (dash without preceding whitespace)
 *   - `**SUMMARY**` / `SUMMARY` (bare title, content starts on the next line)
 *   - `**ACCEPTANCE** -` (dangling dash, content starts on the next line)
 *   - `## SUMMARY` / `acceptance:` / `CONTEXT： ...`
 *
 * The text after the separator on the header line is included as the first
 * line of the section content. For a bare title or a dangling dash (nothing
 * but the separator left on the line), content starts on the following line.
 * Subsequent lines belong to the section until the next header or
 * end-of-string.
 *
 * @param prompt - Raw subagent prompt string.
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
      currentSection = match[1].toUpperCase();
      // Everything after the separator on the same line is the first line of
      // content (empty for a bare title or a dangling dash on its own line)
      currentContent = [match[2]];
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
 * Configurable word-count limits for subagent prompt validation,
 * loaded from `config.toml` at plugin initialization.
 *
 * Each field is optional — when `undefined` the corresponding soft check
 * is skipped.
 */
export interface ValidationLimits {
  contextWordLimit?: number;
  promptWordLimit?: number;
}

/**
 * Validate a subagent prompt against the dolphin.md specification.
 *
 * Hard check (blocking):
 *   1. All three required sections (SUMMARY, CONTEXT, ACCEPTANCE) are present.
 *
 * Soft checks (advisory nudges, not blocking):
 *   2. CONTEXT ≤ `limits.contextWordLimit` words — nudge to split or condense.
 *      Skip when `contextWordLimit` is `undefined`.
 *   3. Total prompt ≤ `limits.promptWordLimit` words — nudge toward conciseness.
 *      Skip when `promptWordLimit` is `undefined`.
 *   4. CONTEXT contains code blocks or line references — nudge toward intent.
 *
 * @param prompt - The `prompt` argument passed to the `subagent` tool.
 * @param limits - Optional word-count thresholds.  Fields can be `undefined`
 *   to skip the corresponding soft check (no internal defaults).
 * @returns Validation result with `valid` flag, hard `errors`, and soft `warnings`.
 */
export function validateSubagentPrompt(
  prompt: string,
  limits?: Partial<ValidationLimits>,
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
  ctx_words: number;
  total_words: number;
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  const contextWordLimit = limits?.contextWordLimit;
  const promptWordLimit = limits?.promptWordLimit;

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
    return {
      valid: false,
      errors,
      warnings,
      ctx_words: 0,
      total_words: wordCount(prompt),
    };
  }

  // --- 2. CONTEXT word count (soft, skip when undefined) ---
  const cw = wordCount(sections.CONTEXT);
  if (contextWordLimit !== undefined && cw > contextWordLimit) {
    warnings.push(
      `CONTEXT is ${cw} words — consider splitting into multiple` +
        " task() calls if subagent struggles with this much context.",
    );
  }

  // --- 3. Total prompt word count (soft, skip when undefined) ---
  const tw = wordCount(prompt);
  if (promptWordLimit !== undefined && tw > promptWordLimit) {
    warnings.push(
      `Total prompt is ${tw} words — subagents work best with` +
        " concise task descriptions.",
    );
  }

  // --- 4. Pattern nudges in CONTEXT (soft, always on) ---
  warnings.push(...buildContextNudges(sections.CONTEXT));

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    ctx_words: cw,
    total_words: tw,
  };
}
