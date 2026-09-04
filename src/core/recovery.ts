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

import { log } from "../utils/logger.js";
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
  // Skip if tool is in exclude list
  if (JSON_ERROR_TOOL_EXCLUDES.has(input.tool.toLowerCase())) {
    log(
      "json-error-nudge",
      "recovery_skipped",
      input.sessionID ?? "",
      input.callID,
      "debug",
      {
        tool: input.tool,
        reason: "excluded",
      },
    );
    return;
  }

  // Skip undefined/missing output
  if (output.output == null) {
    log(
      "json-error-nudge",
      "recovery_skipped",
      input.sessionID ?? "",
      input.callID,
      "debug",
      {
        tool: input.tool,
        reason: "no_output",
      },
    );
    return;
  }

  // Skip if output already contains the reminder marker (dedup)
  if (output.output.includes(JSON_ERROR_REMINDER_MARKER)) {
    log(
      "json-error-nudge",
      "recovery_skipped",
      input.sessionID ?? "",
      input.callID,
      "debug",
      {
        tool: input.tool,
        reason: "already_marked",
      },
    );
    return;
  }

  // Check each pattern
  for (const pattern of JSON_ERROR_PATTERNS) {
    if (pattern.test(output.output)) {
      output.output += `\n${JSON_ERROR_REMINDER}`;
      log(
        "json-error-nudge",
        "recovery_injected",
        input.sessionID ?? "",
        input.callID,
        "info",
        {
          tool: input.tool,
          pattern: pattern.source,
        },
      );
      return;
    }
  }

  log(
    "json-error-nudge",
    "recovery_skipped",
    input.sessionID ?? "",
    input.callID,
    "debug",
    {
      tool: input.tool,
      reason: "no_match",
    },
  );
}
