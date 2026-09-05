/**
 * Task prompt validation judge for the ZooKeeper plugin.
 *
 * Provides the prompt-format strategy contributed by the task-prompt
 * hook unit as a judge, plus the after-exec advisory nudge and the
 * tool-definition enhancement (host-neutral; applied at each host's
 * definition boundary — OpenCode's `tool.definition` event and pi's
 * registration boundary).  The actual validation logic lives in
 * `src/core/validate.ts`; this module wraps it as a pure judge for the
 * host gate.
 *
 * @module
 */

import {
  DELEGATION_FORMAT_TEXT,
  TASK_PROMPT_HINT,
} from "../../agents/parts.js";
import type { DelegationRefusal, DelegationRequest } from "../../core/gate.js";
import type { ToolDefinitionView } from "../../core/slots.js";
import {
  type ValidationLimits,
  validateTaskPrompt,
} from "../../core/validate.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Handler functions — wired by the plugin entry point
// ---------------------------------------------------------------------------

/**
 * Enhance the `subagent` tool's `prompt` argument description with
 * format guidance.  This makes the LLM aware of the required section
 * structure.
 *
 * Host-neutral: the handler operates on the tool-definition view built
 * by each host from its native definition (OpenCode's `tool.definition`
 * hook output; pi's registration-boundary tool arguments), and matches
 * the canonical tool name `"subagent"` on both hosts.
 *
 * @param view - The host-neutral tool definition view.
 */
export function enhanceTaskDefinition(view: ToolDefinitionView): void {
  if (view.name !== "subagent") return;

  const promptArg = view.args?.prompt;
  if (!promptArg || typeof promptArg !== "object") {
    log("task-prompt", "definition_skipped", "", undefined, "debug", {
      reason: "no_prompt_param",
    });
    return;
  }

  const existing = promptArg.description ?? "";
  promptArg.description = existing
    ? `${existing}\n\n${TASK_PROMPT_HINT}`
    : TASK_PROMPT_HINT;

  log("task-prompt", "definition_enhanced", "", undefined, "info", undefined);
}

/**
 * Judge a delegation request's task prompt structure.
 *
 * Returns a refusal when the prompt lacks the required sections
 * (SUMMARY / CONTEXT / ACCEPTANCE) or exceeds the configured limits;
 * `null` otherwise.  A missing prompt (the `prompt` argument was not a
 * string) skips the judgment and allows — the original before-exec
 * boundary semantics.
 *
 * @param req - The delegation request being judged.
 * @param limits - Validation limits (word count thresholds).
 * @returns The refusal, or `null` to allow (or skip).
 */
export function judgeTaskPrompt(
  req: DelegationRequest,
  limits: ValidationLimits,
): DelegationRefusal | null {
  if (req.prompt === undefined) return null;

  const result = validateTaskPrompt(req.prompt, limits);
  if (!result.valid) {
    const details = result.errors.map((e) => `- ${e}`).join("\n");
    return {
      reason:
        "Task prompt format error:\n" +
        `${details}\n\n` +
        "Required format:\n" +
        `${DELEGATION_FORMAT_TEXT}\n\n` +
        "Please rewrite before delegating.",
    };
  }

  return null;
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
