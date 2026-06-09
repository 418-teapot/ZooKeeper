/**
 * ZooKeeper — OpenCode plugin entry point.
 * Prompt injection via `config` hook + `task()` prompt validation via
 * `tool.execute.before` hook + advisory nudges via `tool.execute.after`.
 *
 * Tool deny-listing is a single source of truth defined in `config.toml`,
 * compiled by `install.py` into `~/.config/opencode/opencode.json`.
 * The plugin injects prompt files at runtime via `config` hook,
 * validates task() prompt structure via `tool.execute.before`,
 * and appends soft guidance nudges via `tool.execute.after`.
 *
 * TODO: Add Claude Code adapter (PreToolUse Python hook + CLAUDE.md).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverJsonError } from "./hooks/json-error-recovery";

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
  "Format: SUMMARY (1 sentence — desired outcome) | CONTEXT (facts subagent cannot discover: target file path, user intent, constraints, prior failure conclusions) | ACCEPTANCE (1-2 verifiable outcomes). Keep CONTEXT focused on WHAT and WHY, not HOW — subagents read files and decide implementation themselves.";

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
// Nudge pattern detection — advisory, not blocking
// ---------------------------------------------------------------------------

const LINE_REF_RE = /\bline\s+\d+\b/i;
const CHINESE_LINE_REF_RE = /行\s*\d+|第\s*\d+\s*行/;
const CODE_BLOCK_RE = /```/;

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
      "CONTEXT contains code blocks — subagents can read files themselves, consider describing the intent instead.",
    );
  }

  if (LINE_REF_RE.test(context) || CHINESE_LINE_REF_RE.test(context)) {
    nudges.push(
      "CONTEXT contains line references — lines change; let subagents locate the exact code.",
    );
  }

  return nudges;
}

// ---------------------------------------------------------------------------
// Public validation API
// ---------------------------------------------------------------------------

/**
 * Configurable word-count limits for task prompt validation,
 * loaded from `core/config.json` at plugin initialization.
 */
export interface ValidationLimits {
  contextWordLimit: number;
  promptWordLimit: number;
}

/**
 * Load validation limits from `core/config.json`.
 *
 * Called once at plugin initialization. Throws on any misconfiguration:
 * missing file, invalid JSON, or missing fields.
 *
 * @returns A `ValidationLimits` object with both thresholds.
 * @throws Error if config.json is missing or malformed.
 */
export function loadValidationConfig(): ValidationLimits {
  let raw: string;
  try {
    raw = readFileSync(resolve(CORE_DIR, "config.json"), "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read core/config.json: ${(err as Error).message}. ` +
        "Run `python3 install.py` to generate it from config.toml.",
    );
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `core/config.json contains invalid JSON: ${(err as Error).message}. ` +
        "Run `python3 install.py` to regenerate it.",
    );
  }

  const missing: string[] = [];
  if (typeof config.context_word_limit !== "number")
    missing.push("context_word_limit");
  if (typeof config.prompt_word_limit !== "number")
    missing.push("prompt_word_limit");
  if (missing.length > 0) {
    throw new Error(
      `core/config.json is missing required fields: ${missing.join(", ")}. ` +
        "Re-run `python3 install.py` to regenerate it from config.toml.",
    );
  }
  return {
    contextWordLimit: config.context_word_limit as number,
    promptWordLimit: config.prompt_word_limit as number,
  };
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
      `CONTEXT is ${cw} words — consider splitting into multiple task() calls if subagent struggles with this much context.`,
    );
  }

  // --- 3. Total prompt word count (soft) ---
  const tw = wordCount(prompt);
  if (tw > promptWordLimit) {
    warnings.push(
      `Total prompt is ${tw} words — subagents work best with concise task descriptions.`,
    );
  }

  // --- 4. Pattern nudges in CONTEXT (soft) ---
  warnings.push(...buildContextNudges(sections.CONTEXT));

  return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * @param input - OpenCode plugin input (unused).
 * @returns Plugin hooks object.
 */
export async function zookeeper(input: any) {
  const limits = loadValidationConfig();

  /**
   * Append advisory prompt nudges to task tool output.
   *
   * Extracts the prompt from the output args, validates it, and appends any
   * soft warnings (context too long, code blocks, line references) as
   * guidance for the orchestrator LLM.
   *
   * @param i - Hook input.
   * @param o - Hook output object mutated in place.
   */
  function nudgeTaskOutput(
    i: { tool: string; sessionID: string; callID: string },
    o: { args?: Record<string, unknown>; output?: string },
  ): void {
    if (i.tool !== "task") return;

    const promptArg = o.args?.prompt;
    if (typeof promptArg !== "string") return;

    const result = validateTaskPrompt(promptArg, limits);
    if (result.warnings.length === 0) return;

    // Append nudges to tool output so the orchestrator LLM sees them
    const nudgeText = result.warnings.map((w) => `- ${w}`).join("\n");
    const suffix = `\n\n--- Guidance for next time ---\n${nudgeText}`;
    o.output = (o.output ?? "") + suffix;
  }

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
      input: { tool: string; sessionID: string; callID: string },
      output: { args?: Record<string, unknown> },
    ) {
      if (input.tool !== "task") return;

      const promptArg = output.args?.prompt;
      if (typeof promptArg !== "string") return;

      const result = validateTaskPrompt(promptArg, limits);
      // Hard check: missing sections → throw (blocking)
      if (!result.valid) {
        const details = result.errors.map((e) => `- ${e}`).join("\n");
        throw new Error(
          `Task prompt format error:\n${details}\n\n` +
            "Required format:\n" +
            "- SUMMARY: one sentence — desired outcome\n" +
            "- CONTEXT: facts subagent cannot discover\n" +
            "- ACCEPTANCE: 1-2 verifiable outcomes\n\n" +
            "Please rewrite before delegating.",
        );
      }
      // Soft warnings are handled by tool.execute.after hook
    },

    async "tool.execute.after"(
      input: { tool: string; sessionID: string; callID: string },
      output: { args?: Record<string, unknown>; output?: string },
    ) {
      const handlers = [nudgeTaskOutput, recoverJsonError];
      for (const handler of handlers) {
        try {
          handler(input, output);
        } catch {
          // Swallow per-handler errors so one failure does not
          // prevent other handlers from running.
        }
      }
    },
  };
}

export default { id: "zookeeper", server: zookeeper };
