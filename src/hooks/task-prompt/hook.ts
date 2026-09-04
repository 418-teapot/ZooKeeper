/**
 * Task prompt validation hook for ZooKeeper OpenCode plugin.
 *
 * Provides handler functions for enhancing the task tool definition with
 * format guidance, validating task() prompt structure before execution, and
 * appending advisory nudges to tool output. The actual validation logic lives
 * in `src/core/validate.ts`; this module wires it into OpenCode hooks.
 *
 * @module
 */

import {
  DELEGATION_FORMAT_TEXT,
  TASK_PROMPT_HINT,
} from "../../agents/parts.js";
import {
  type ValidationLimits,
  validateTaskPrompt,
} from "../../core/validate.js";
import { log } from "../../utils/logger.js";

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
  if (input.toolID !== "subagent") return;

  const promptParam = output.parameters?.properties?.prompt;
  if (!promptParam || typeof promptParam !== "object") {
    log("task-prompt", "definition_skipped", "", undefined, "debug", {
      reason: "no_prompt_param",
    });
    return;
  }

  const existing = promptParam.description ?? "";
  promptParam.description = existing
    ? `${existing}\n\n${TASK_PROMPT_HINT}`
    : TASK_PROMPT_HINT;

  log("task-prompt", "definition_enhanced", "", undefined, "info", undefined);
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
  input: { tool: string; sessionID?: string; callID?: string },
  output: { args?: Record<string, unknown> },
  limits: ValidationLimits,
): void {
  if (input.tool !== "subagent") return;

  const promptArg = output.args?.prompt;
  if (typeof promptArg !== "string") return;

  const result = validateTaskPrompt(promptArg, limits);

  if (!result.valid) {
    const details = result.errors.map((e) => `- ${e}`).join("\n");
    log(
      "task-prompt",
      "validate_failed",
      input.sessionID ?? "",
      input.callID,
      "warn",
      {
        errors: result.errors,
      },
    );
    throw new Error(
      "Task prompt format error:\n" +
        `${details}\n\n` +
        "Required format:\n" +
        `${DELEGATION_FORMAT_TEXT}\n\n` +
        "Please rewrite before delegating.",
    );
  }

  // Validation passed — log if there are warnings (include word counts regardless)
  if (result.warnings.length > 0) {
    log(
      "task-prompt",
      "validate_passed",
      input.sessionID ?? "",
      input.callID,
      "info",
      {
        warnings: result.warnings.length,
        ctx_words: result.ctx_words,
        total_words: result.total_words,
      },
    );
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
  input: {
    tool: string;
    sessionID?: string;
    callID?: string;
    args?: Record<string, unknown>;
  },
  output: { output?: string },
  limits: ValidationLimits,
): void {
  if (input.tool !== "subagent") {
    log(
      "task-prompt",
      "nudge_skipped",
      input.sessionID ?? "",
      input.callID,
      "debug",
      { reason: "not_subagent" },
    );
    return;
  }

  const promptArg = input.args?.prompt;
  if (typeof promptArg !== "string") {
    log(
      "task-prompt",
      "nudge_skipped",
      input.sessionID ?? "",
      input.callID,
      "debug",
      { reason: "no_prompt_arg" },
    );
    return;
  }

  const result = validateTaskPrompt(promptArg, limits);
  if (result.warnings.length === 0) {
    log(
      "task-prompt",
      "nudge_skipped",
      input.sessionID ?? "",
      input.callID,
      "debug",
      undefined,
    );
    return;
  }

  // Append nudges to tool output so the orchestrator LLM sees them
  const nudgeText = result.warnings.map((w) => `- ${w}`).join("\n");
  const suffix = `\n\n--- Guidance for next time ---\n${nudgeText}`;
  output.output = (output.output ?? "") + suffix;

  log(
    "task-prompt",
    "nudge_injected",
    input.sessionID ?? "",
    input.callID,
    "info",
    {
      warnings: result.warnings,
    },
  );
}
