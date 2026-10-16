/**
 * JSON error detection and recovery utilities for ZooKeeper.
 *
 * Provides constants and a function to detect JSON parse errors in tool
 * call output and append a recovery reminder instructing the LLM to fix its
 * JSON syntax and retry. Uses the file-based logger for observability.
 *
 * This module has no OpenCode framework dependencies.
 *
 * @module
 */

import { applyNudge } from "./nudge.js";
import { JSON_ERROR_REMINDER, JSON_ERROR_REMINDER_MARKER } from "./prompts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
  "fetch",
  "webfetch",
  "websearch",
  "subagent",
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
 * @param input - Input containing the tool name and optional identifiers.
 * @param input.tool - Name of the tool that was executed.
 * @param input.sessionID - Optional session identifier for logging.
 * @param input.callID - Optional call identifier for logging.
 * @param output - Output object mutated in place.
 * @param output.output - Text output from the tool call.
 */
export function recoverJsonError(
  input: { tool: string; sessionID?: string; callID?: string },
  output: { output?: string },
): void {
  // Captured by the pattern guard for the injected-log fields.
  let matchedPattern: RegExp | undefined;

  applyNudge({
    hook: "json-error-nudge",
    sessionID: input.sessionID ?? "",
    callID: input.callID,
    tool: input.tool,
    output,
    gateSkip: {
      event: "recovery_skipped",
      fields: { tool: input.tool, reason: "excluded" },
    },
    rules: [
      {
        // Skip if the tool is in the exclude list.
        matches: (tool) => !JSON_ERROR_TOOL_EXCLUDES.has(tool),
        guards: [
          // Skip undefined/missing output.
          () =>
            output.output == null
              ? {
                  event: "recovery_skipped",
                  fields: { tool: input.tool, reason: "no_output" },
                }
              : null,
          // Skip if output already contains the reminder marker (dedup).
          () =>
            (output.output as string).includes(JSON_ERROR_REMINDER_MARKER)
              ? {
                  event: "recovery_skipped",
                  fields: { tool: input.tool, reason: "already_marked" },
                }
              : null,
          // Find the first matching pattern; none means no_match.
          () => {
            matchedPattern = JSON_ERROR_PATTERNS.find((pattern) =>
              pattern.test(output.output as string),
            );
            return matchedPattern
              ? null
              : {
                  event: "recovery_skipped",
                  fields: { tool: input.tool, reason: "no_match" },
                };
          },
        ],
        text: () => JSON_ERROR_REMINDER,
        event: "recovery_injected",
        fields: () => ({ tool: input.tool, pattern: matchedPattern?.source }),
      },
    ],
  });
}
