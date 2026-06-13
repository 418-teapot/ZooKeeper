/**
 * JSON error recovery hook for ZooKeeper OpenCode plugin.
 *
 * Detects JSON parse errors in tool call output and appends a reminder
 * instructing the LLM to fix its JSON syntax and retry.
 *
 * @module
 */

import { debug } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Marker string prefixed to the JSON error reminder.
 * Used for deduplication — if output already contains this marker, skip.
 */
export const JSON_ERROR_REMINDER_MARKER =
  "[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]";

/**
 * Full reminder text appended to tool output when a JSON parse error is
 * detected.
 */
export const JSON_ERROR_REMINDER = `${JSON_ERROR_REMINDER_MARKER}

You sent invalid JSON arguments. The system could not parse your tool call.
STOP and do this NOW:

1. LOOK at the error message above to see what was expected vs what you sent.
2. CORRECT your JSON syntax (missing braces, unescaped quotes, trailing commas, etc).
3. RETRY the tool call with valid JSON.

DO NOT repeat the exact same invalid call.`;

/**
 * List of tool names excluded from JSON error recovery.
 * These tools may legitimately produce JSON-like output or contain "JSON"
 * in returned text.
 */
export const JSON_ERROR_TOOL_EXCLUDE_LIST = [
  "bash",
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "task",
  "skill",
];

/**
 * Set of excluded tool names (lowercased) for O(1) lookup.
 */
export const JSON_ERROR_TOOL_EXCLUDES: Set<string> = new Set(
  JSON_ERROR_TOOL_EXCLUDE_LIST.map((n) => n.toLowerCase()),
);

/**
 * Regex patterns that detect JSON parse errors in tool output.
 */
export const JSON_ERROR_PATTERNS: RegExp[] = [
  /json parse error/i,
  /failed to parse json/i,
  /invalid json/i,
  /malformed json/i,
  /unexpected end of json input/i,
  /syntaxerror:\s*unexpected token.*json/i,
  /json[^\n]*expected '\}'/i,
  /json[^\n]*unexpected eof/i,
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Check tool output for JSON parse errors and append a recovery reminder.
 *
 * Skips excluded tools, non-string output, and output that already contains
 * the reminder marker. If any JSON error pattern matches, the reminder is
 * appended to the output in place.
 *
 * @param input - Input containing the tool name.
 * @param input.tool - Name of the tool that was executed.
 * @param output - Output object mutated in place.
 * @param output.output - Text output from the tool call.
 */
export function recoverJsonError(
  input: { tool: string },
  output: { output?: string },
): void {
  // Skip if tool is in exclude list
  if (JSON_ERROR_TOOL_EXCLUDES.has(input.tool.toLowerCase())) return;

  // Skip undefined/missing output
  if (output.output == null) return;

  // Skip if output already contains the reminder marker (dedup)
  if (output.output.includes(JSON_ERROR_REMINDER_MARKER)) return;

  // Check each pattern
  for (const pattern of JSON_ERROR_PATTERNS) {
    if (pattern.test(output.output)) {
      output.output += `\n${JSON_ERROR_REMINDER}`;
      debug("json-error-nudge", {
        tool: input.tool,
        pattern: pattern.source,
      });
      return;
    }
  }
}
