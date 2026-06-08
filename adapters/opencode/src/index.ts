/**
 * ZooKeeper — OpenCode plugin entry point.
 * Prompt injection via `config` hook + `task()` prompt validation via
 * `tool.execute.before` hook.
 *
 * Tool deny-listing is a single source of truth defined in `config.toml`,
 * compiled by `install.py` into `~/.config/opencode/opencode.json`.
 * The plugin injects prompt files at runtime via `config` hook,
 * and validates task() prompt format at runtime via `tool.execute.before` hook.
 *
 * TODO: Add Claude Code adapter (PreToolUse Python hook + CLAUDE.md).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(__dirname, "../../../core");

// ---------------------------------------------------------------------------
// Task prompt hint — appended to the `prompt` parameter description by the
// `tool.definition` hook so the LLM sees format constraints in the schema.
// ---------------------------------------------------------------------------

/**
 * Format guidance shown in the `task` tool's `prompt` parameter description.
 * The LLM sees this in the schema on every call.
 */
export const TASK_PROMPT_HINT =
  "Format: SUMMARY (1 sentence), CONTEXT (≤ 100 words — only facts subagent cannot discover: user intent, constraints, prior failures, fresh error output), ACCEPTANCE (1-2 verifiable outcomes). Max 250 words total. If CONTEXT needs > 100 words, the task is too large — split into multiple task() calls.";

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

/**
 * @param name - Agent name to locate `prompts/{name}.md`.
 * @returns Prompt content, or `undefined` if no file exists.
 */
function loadPrompt(name: string): string | undefined {
  try {
    return readFileSync(resolve(CORE_DIR, `prompts/${name}.md`), "utf-8");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

const SECTION_HEADER_RE =
  /^(\s*[-–]\s+)?\*{0,2}(SUMMARY|CONTEXT|ACCEPTANCE)\*{0,2}:\s*(.*)$/im;

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
// Forbidden pattern detection
// ---------------------------------------------------------------------------

const LINE_REF_RE = /\bline\s+\d+\b/i;
const CHINESE_LINE_REF_RE = /行\s*\d+|第\s*\d+\s*行/;
const CODE_BLOCK_RE = /```/;

/**
 * Check a CONTEXT section for patterns that are not allowed.
 *
 * Forbidden items (from build.md):
 *   - Code blocks (triple-backtick fences)
 *   - Line-number references ("line X", "行 X")
 *   - File-content transcriptions (estimated via word-count limit)
 *
 * @param context - The extracted CONTEXT section content.
 * @returns A list of human-readable error messages (empty = no issues).
 */
function checkForbiddenPatterns(context: string): string[] {
  const errors: string[] = [];

  if (CODE_BLOCK_RE.test(context)) {
    errors.push("CONTEXT contains code blocks (triple backticks)");
  }

  if (LINE_REF_RE.test(context)) {
    errors.push('CONTEXT contains line-number references ("line N")');
  }

  if (CHINESE_LINE_REF_RE.test(context)) {
    errors.push('CONTEXT contains line-number references ("行 N")');
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Public validation API
// ---------------------------------------------------------------------------

/**
 * Validate a task() prompt against the build.md specification.
 *
 * Rules checked, in order:
 * 1. All three required sections (SUMMARY, CONTEXT, ACCEPTANCE) are present.
 * 2. CONTEXT ≤ 100 words.
 * 3. Total prompt ≤ 250 words.
 * 4. CONTEXT contains no forbidden patterns (code blocks, line references).
 *
 * @param prompt - The `prompt` argument passed to the `task()` tool.
 * @returns Validation result with `valid` flag and list of error messages.
 */
export function validateTaskPrompt(prompt: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // --- 1. Extract sections ---
  const sections = extractSections(prompt);
  const required = ["SUMMARY", "CONTEXT", "ACCEPTANCE"];

  for (const section of required) {
    if (!sections[section]) {
      errors.push(`Missing required section: ${section}`);
    }
  }

  // If CONTEXT is missing we can't proceed with the rest of the checks
  if (!sections.CONTEXT) {
    return { valid: false, errors };
  }

  // --- 2. CONTEXT word count ≤ 100 ---
  const cw = wordCount(sections.CONTEXT);
  if (cw > 100) {
    errors.push(`CONTEXT too long: ${cw} words (max 100)`);
  }

  // --- 3. Total prompt word count ≤ 250 ---
  const tw = wordCount(prompt);
  if (tw > 250) {
    errors.push(`Total prompt too long: ${tw} words (max 250)`);
  }

  // --- 4. Forbidden patterns in CONTEXT ---
  errors.push(...checkForbiddenPatterns(sections.CONTEXT));

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * @param input - OpenCode plugin input (unused).
 * @returns Plugin hooks object.
 */
export async function zookeeper(input: any) {
  return {
    async config(config: any) {
      const agents = config.agent ?? {};
      for (const [name, agent] of Object.entries(agents)) {
        if (typeof agent !== "object" || agent === null) continue;

        const prompt = loadPrompt(name);
        if (prompt) (agent as any).prompt = prompt;
      }
    },

    async "tool.definition"(
      input: { toolID: string },
      output: { description: string; parameters: any },
    ) {
      if (input.toolID !== "task") return;

      const promptParam = output.parameters?.properties?.prompt;
      if (!promptParam || typeof promptParam !== "object") return;

      const existing = promptParam.description ?? "";
      promptParam.description = existing
        ? `${existing}\n\n${TASK_PROMPT_HINT}`
        : TASK_PROMPT_HINT;
    },

    async "tool.execute.before"(
      input: { tool: string; args?: Record<string, unknown> },
      _output: { args?: Record<string, unknown> },
    ) {
      if (input.tool !== "task") return;

      const promptArg = input.args?.prompt;
      if (typeof promptArg !== "string") return;

      const result = validateTaskPrompt(promptArg);
      if (!result.valid) {
        const details = result.errors.map((e) => `- ${e}`).join("\n");
        throw new Error(
          `Task prompt format error:\n${details}\n\n` +
            "Required format:\n" +
            "- SUMMARY: one sentence\n" +
            "- CONTEXT: 2-4 lines, ≤ 100 words\n" +
            "- ACCEPTANCE: one sentence\n\n" +
            "Please rewrite before delegating.",
        );
      }
    },
  };
}

export default { id: "zookeeper", server: zookeeper };
