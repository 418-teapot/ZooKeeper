/**
 * Subagent delegation tool adapter.
 *
 * Exposes the host-agnostic subagent orchestration core
 * (`src/core/subagent/run.ts`) as a host tool so the orchestrator agent can
 * delegate a task to a subagent (e.g. beaver / lynx / spider).  The tool
 * itself is host-independent: everything host-specific — how the sub-session
 * is created, how its messages stream, how termination is wired — lives
 * behind the `SubagentDriver` supplied through `Capabilities`, exactly like the pi
 * switch surfaces.
 *
 * The unit declares `subagentDriver` as a need, so composition skips it
 * on hosts without a driver (OpenCode, which keeps its native `task`
 * tool) — the tool never registers there (fail-closed).
 *
 * The tool contains no delegation policy and no prompt-formatting policy:
 * the composed delegation gate (contributed by hook-unit judges) is
 * enforced on pi's native `tool_call` event (the adapter's `toolCall`
 * handler in `src/adapters/pi/handlers.ts`), and the
 * subagent-prompt format hint (when the subagent-prompt hook unit is enabled) is
 * appended to the `prompt` argument's description by the composed
 * `tool.definition` contributions at each host's definition boundary
 * (compose-opencode's `tool.definition` event / compose-pi's
 * `applyToolDefinitionContributions`) — none of it ever reaches this
 * file, so the tool definition here is the plain, policy-free shape.
 *
 * Each execution:
 * 1. Resolves the CALLER agent from the session the call names: the call
 *    context carries the session id, and the shared `resolveCallerAgent`
 *    port answers that session's agent.  No ambient identity is read.
 * 2. Fails closed on the TARGET role: only agents declared
 *    `mode = "subagent"` in the parsed config are valid delegation
 *    targets.  A missing modes map, a target absent from it, or a target
 *    declared with another mode returns a tool-level text explaining WHY
 *    (never throws, never runs the driver).
 * 3. Computes the TARGET agent's capability set as `baseline − deniedTools`
 *    via `computeCapabilitySet`, where the baseline is the host's full
 *    untrimmed tool list (`caps.subagentBaseline()`) and the denies come from
 *    the target's parsed `[agent.<name>].permission` tool-level denies.
 *    A missing baseline yields an empty set — permissions are never
 *    invented (fail-closed).
 * 4. Hands the run's append-only fact log to the driver so every observed
 *    fact is recorded there, patches the driver's progress reports' fields
 *    (current tool, context length, model, child session ids, session path)
 *    onto the registry run, asks the host for a card repaint per report
 *    (`call.notifyChanged`; the card body projects the run's log), and
 *    drives the lifecycle orchestration (`runSubagent`) under the call's
 *    cancellation signal.
 * 5. Resolves the sub-session model (strict mode): `caps.subagentModels`
 *    (agents.json, whose mapped values are `"provider/model"` strings) is
 *    the SOLE source.  A missing entry for the target
 *    fails closed with an actionable Chinese error and never runs the
 *    driver — there is no inheritance from the parent model and no
 *    default fallback.
 * 6. Maps the run outcome onto the tool's text return: an `ok` result is
 *    the subagent text verbatim; every failure variant (`aborted`,
 *    `error`) returns the partial text plus a short Chinese reason line.
 *
 * @module
 */

import { computeCapabilitySet } from "../core/permissions/capability.js";
import type { Capabilities } from "../core/ports/index.js";
import type {
  SubagentDriver,
  SubagentResult,
} from "../core/subagent/driver.js";
import type { UpdateRunPatch } from "../core/subagent/registry.js";
import { finishRun, startRun, updateRun } from "../core/subagent/registry.js";
import { runSubagent } from "../core/subagent/run.js";
import {
  defineTool,
  type ToolCallContext,
  type ToolDefinition,
  type ToolResult,
} from "../core/unit.js";
import { log } from "../utils/logger.js";

type SubagentToolInput = {
  agent: string;
  description: string;
  prompt: string;
};

/**
 * Monotonic counter for synthetic run ids.
 *
 * A run without a forwarded tool-call id (OpenCode, test invocations that
 * omit `call.callID`) is tracked under a synthetic id derived from the
 * caller/agent plus this counter, so consecutive delegations in the same
 * process never collide (the previous scheme stamped `Date.now()`, which two
 * delegations in the same millisecond could collide on, and carried a
 * non-ASCII arrow).
 */
let syntheticRunSeq = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate the raw tool arguments into a `{ agent, description, prompt }`
 * input.
 *
 * @param args - The raw tool arguments.
 * @returns The validated input.
 * @throws A loud Chinese error when the arguments are not an object or
 *   `agent` / `description` / `prompt` are not non-empty strings.
 */
function validateSubagentArgs(args: unknown): SubagentToolInput {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(
      "subagent 工具参数格式错误：请提供包含 agent、description 与 prompt 三个字符串参数的对象后重试。",
    );
  }
  const input = args as Record<string, unknown>;
  const agent = input.agent;
  if (typeof agent !== "string" || agent.length === 0) {
    throw new Error(
      "subagent 工具参数错误：agent 必须是目标子 agent 名称字符串后重试。",
    );
  }
  const description = input.description;
  if (typeof description !== "string" || description.length === 0) {
    throw new Error(
      "subagent 工具参数错误：description 必须是任务的短标签字符串后重试。",
    );
  }
  const prompt = input.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error(
      "subagent 工具参数错误：prompt 必须是委派任务的完整提示词字符串后重试。",
    );
  }
  return { agent, description, prompt };
}

/**
 * Append a short Chinese reason line to a partial subagent text.
 *
 * A result with no partial text returns just the reason line, so the model
 * always learns why the run failed.
 *
 * @param text - The partial assistant text produced before the outcome.
 * @param reason - The short reason line for the failure variant.
 * @returns The combined tool text.
 */
function appendReason(text: string, reason: string): string {
  if (text.length === 0) return reason;
  return `${text}\n\n${reason}`;
}

/**
 * Map a `SubagentResult` onto the tool's text return.
 *
 * `ok` passes the subagent text through verbatim; every failure variant
 * returns the partial text plus a short Chinese reason line.
 *
 * @param result - The run outcome.
 * @returns The tool text.
 */
function formatSubagentResult(result: SubagentResult): string {
  switch (result.kind) {
    case "ok":
      return result.text;
    case "aborted":
      return appendReason(result.text, "子 agent 运行被中止。");
    case "error":
      return appendReason(
        result.text,
        `子 agent 运行出错：${result.errorMessage}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the subagent delegation tool.
 *
 * The driver, the host tool services, the tool baseline and the parsed
 * per-agent denies are captured by the closure so each `execute` call is
 * self-contained.
 *
 * @param driver - The host driver that executes the subagent.
 * @param caps - The capability surfaces the tool needs: `resolveCallerAgent`
 *   for the calling session's agent, `subagentBaseline` for the capability
 *   baseline, `agentModes` for the declared subagent role of the target,
 *   and `agentPermissions` for the target's tool-level denies.
 * @returns The subagent tool definition.
 */
export function createSubagentTool(
  driver: SubagentDriver,
  caps: Pick<Capabilities, "resolveCallerAgent"> &
    Partial<
      Pick<
        Capabilities,
        | "subagentBaseline"
        | "agentModes"
        | "agentPermissions"
        | "subagentModels"
        | "onSubagentRunChange"
      >
    >,
): ToolDefinition {
  // Nudge the parent session's fleet widget after every registry mutation
  // (the pi entry point wires this to that session's widget refresh).
  const notifyRunChange = (parentSession: string): void => {
    caps.onSubagentRunChange?.(parentSession);
  };
  return {
    description:
      "将任务委派给一个专用的子 agent 执行。子 agent 使用全新上下文，不会继承当前会话，需要在 prompt 中提供完整的背景、目标、约束和验收标准。该工具会同步等待子 agent 完成，并返回其最终回复。",
    args: {
      agent: {
        type: "string",
        description: "用于执行该任务的专用子 agent 类型或名称。",
      },
      description: {
        type: "string",
        description: "展示给用户的任务短标签，建议使用 3-5 个词。",
      },
      prompt: {
        type: "string",
        description: `交由子 agent 执行的完整任务说明。`,
      },
    },
    required: ["agent", "description", "prompt"],
    async execute(args, call: ToolCallContext): Promise<ToolResult> {
      const input = validateSubagentArgs(args);

      // 1. Resolve the CALLER agent from the session this call names.  An
      // unresolved agent fails closed with an explanatory text.  The session
      // id is the run's parent session and every log line's attribution, so
      // it is read exactly once from the call context.
      const sessionID = call.sessionID;
      const caller = await caps.resolveCallerAgent(sessionID);
      if (caller === undefined) {
        return {
          text: "无法确定调用者身份：未配置主 agent，无法委派子 agent。",
        };
      }

      // 2. Target-role guard — only agents declared `mode = "subagent"`
      // in the parsed config are valid delegation targets.  A missing
      // modes map, a target absent from it, or a target declared with
      // another mode (e.g. a primary) fails closed with an explanatory
      // text (never throws, never runs the driver).  The valid target
      // set comes from the parsed config only — no hardcoded agent list.
      const targetMode = caps.agentModes?.[input.agent];
      if (targetMode !== "subagent") {
        log.warn({
          hook: "subagent-tool",
          event: "target_role_blocked",
          sessionId: sessionID,
          caller,
          target: input.agent,
          reason: "not-a-subagent",
        });
        return {
          text: `"${input.agent}" 不是可委派的子 agent：仅在配置中声明 mode = "subagent" 的 agent 才能作为委派目标。`,
        };
      }

      // 3. Capability set for the TARGET agent: `baseline − deniedTools`.
      // A missing baseline yields an empty set (fail-closed — permissions
      // are never invented).
      const deniedTools = caps.agentPermissions?.[input.agent] ?? [];
      const tools = computeCapabilitySet({
        baseline: caps.subagentBaseline?.(),
        deniedTools,
      });

      // 4. The cancellation signal of this call.
      const signal = call.signal;

      // 5. Model resolution for the sub-session (strict mode): the target's
      //    `[agent.<name>].model` from agents.json (`caps.subagentModels`,
      //    materialised by the installer as a `{provider, model}` pair whose
      //    mapped value is the concatenated `"provider/model"` string — the
      //    TS runtime never resolves `{env:}` tokens itself) is the SOLE
      //    model source.  A missing agents.json (empty map), or an agent
      //    absent from it, fails closed with an actionable Chinese error and
      //    never runs the driver — there is no inheritance and no default
      //    fallback.
      const configuredModel = caps.subagentModels?.[input.agent];
      if (typeof configuredModel !== "string" || configuredModel.length === 0) {
        log.warn({
          hook: "subagent-tool",
          event: "model_missing",
          sessionId: sessionID,
          caller,
          target: input.agent,
        });
        return {
          text: `"${input.agent}" 未配置子 agent 模型：仅从 ~/.pi/agent/agents.json 读取模型配置，未找到该 agent 的 provider/model 条目（文件缺失、JSON 非法或该 agent 未配置 provider/model 均会导致此错误）。请运行 \`uv run python install.py\` 重新生成 agents.json 后重试。`,
        };
      }
      const model = configuredModel;

      // 6. Registry write — the host forwards its tool-call id on the call
      // context, and it doubles as the run id in the process-level run
      // registry (the fleet widget's source of truth).  A run without one
      // (OpenCode, test invocations) is tracked with a synthetic id derived
      // from the caller/agent plus a module-level monotonic counter, so
      // consecutive delegations never collide (a `Date.now()` stamp could
      // collide within one millisecond).
      const runId =
        call.callID ?? `${caller}-${input.agent}-${++syntheticRunSeq}`;
      const run = startRun({
        id: runId,
        agent: input.agent,
        parentSession: sessionID,
        label: input.description,
      });
      notifyRunChange(sessionID);

      // 7. Drive the delegation through the orchestration core.  The run's
      // progress reports are patched onto the registry run (see the
      // onProgress handler below) while the driver appends the full facts
      // to this run's log — the durable record views project from.
      const result = await runSubagent(
        driver,
        {
          agent: input.agent,
          prompt: input.prompt,
          tools,
          parentSession: sessionID,
          // Strict mode: the agents.json model is always present (the
          // missing-entry guard above never lets the run reach the driver
          // without one).
          model,
        },
        {
          signal,
          log: run.log,
          onProgress: (progress) => {
            // Patch the running run's progress fields — the current tool
            // (including the driver's explicit "tool finished" clear), the
            // context length the driver reads from the latest usage fact,
            // the model, the child session id (so the fleet widget can
            // rebuild the parent/child tree), and the sub-session path.
            //
            // The context length comes from the report rather than from
            // `deriveCounters(run.log.facts())`: rescanning the whole fact log
            // for every progress report is O(n) per report and O(n²) over a
            // run, while the driver has already read each usage figure as it
            // appended the fact.  Fields an absent report omits are left
            // untouched.
            const patch: UpdateRunPatch = {};
            if (progress.currentTool !== undefined) {
              patch.currentTool = progress.currentTool;
            }
            if (
              progress.tokens !== undefined &&
              progress.tokens !== run.tokens
            ) {
              patch.tokens = progress.tokens;
            }
            if (progress.model !== undefined) patch.model = progress.model;
            if (progress.childSession !== undefined) {
              patch.childSession = progress.childSession;
            }
            if (progress.sessionPath !== undefined) {
              // The sub-session file exists from the first progress report
              // (the driver carries its path once the session manager is
              // created), so the running run holds it for enter-inspect
              // mid-run — not only on the terminal finish.
              patch.sessionPath = progress.sessionPath;
            }
            if (Object.keys(patch).length > 0) {
              updateRun(runId, patch);
              notifyRunChange(sessionID);
            }

            // Repaint the host's live card on every report.  The card body
            // projects the run's log, so the request carries no payload and
            // never streams text; a host without a live card omits it.
            call.notifyChanged?.();
          },
        },
      );

      // 8. Finish the registry run (terminal state, immutable thereafter).
      //    The session path (when any) was already patched onto the run via
      //    `updateRun` on the first progress report, so finish only sets
      //    the terminal status and outcome fields.
      finishRun(runId, {
        status:
          result.kind === "ok"
            ? "done"
            : result.kind === "error"
              ? "error"
              : "aborted",
        ...(result.kind === "error" ? { error: result.errorMessage } : {}),
      });
      notifyRunChange(sessionID);

      log.info({
        hook: "subagent-tool",
        event: "subagent_done",
        sessionId: sessionID,
        agent: input.agent,
        description: input.description,
        kind: result.kind,
        tools: tools.length,
      });

      // 9. Map the outcome onto the tool text.
      return { text: formatSubagentResult(result) };
    },
  };
}

/**
 * Subagent delegation tool unit descriptor.
 *
 * The tool contribution carries the subagent delegation adapter; the unit
 * declares `subagentDriver` as a need, so composition skips the unit on
 * hosts without one (OpenCode) — zero tools are contributed (fail-closed).
 */
export const unit = defineTool({
  name: "subagent",
  needs: ["subagentDriver", "resolveCallerAgent"],
  wants: [
    "subagentBaseline",
    "agentModes",
    "agentPermissions",
    "subagentModels",
    "onSubagentRunChange",
  ],
  create(caps) {
    return createSubagentTool(caps.subagentDriver, caps);
  },
});
