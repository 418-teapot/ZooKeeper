/**
 * Subagent delegation tool adapter.
 *
 * Exposes the host-agnostic subagent orchestration core
 * (`src/core/subagent/run.ts`) as a host tool so the orchestrator agent can
 * delegate a task to a subagent (e.g. beaver / lynx / spider).  The tool
 * itself is host-independent: everything host-specific — how the sub-session
 * is created, how its messages stream, how termination is wired — lives
 * behind the `SubagentDriver` supplied through `Deps`, exactly like the pi
 * switch surfaces.
 *
 * The unit contributes the `subagent` tool ONLY when a driver is present in
 * deps.  A host without a driver (OpenCode, which keeps its native `task`
 * tool) gets zero tools — the tool never registers there (fail-closed).
 *
 * Each execution:
 * 1. Resolves the CALLER identity through the identity core
 *    (`resolveIdentity` — the active primary outside a sub-session scope, a
 *    bound subagent identity inside one).
 * 2. Judges the delegation against the static allowlist
 *    (`isDelegationAllowed`); a blocked delegation returns a tool-level
 *    text explaining WHY (never throws, never runs the driver).
 * 3. Fails closed on the TARGET role: only agents declared
 *    `mode = "subagent"` in the parsed config are valid delegation
 *    targets.  A missing modes map, a target absent from it, or a target
 *    declared with another mode returns a tool-level text explaining WHY
 *    (never throws, never runs the driver).
 * 4. Computes the TARGET agent's capability set as `baseline − deniedTools`
 *    via `computeCapabilitySet`, where the baseline is the host's full
 *    untrimmed tool list (`deps.subagentBaseline`) and the denies come from
 *    the target's parsed `[agent.<name>].permission` tool-level denies.
 *    A missing baseline yields an empty set — permissions are never
 *    invented (fail-closed).
 * 5. Streams compact progress snapshots into the host's partial-result
 *    channel when one is present (pi's `onUpdate`), and drives the
 *    lifecycle orchestration (`runSubagent`), forwarding the parent abort
 *    signal when the tool context carries one.
 * 6. Resolves the sub-session model (strict mode): `deps.subagentModels`
 *    (agents.json, whose mapped values are `"provider/model"` strings) is
 *    the SOLE source.  A missing entry for the target
 *    fails closed with an actionable Chinese error and never runs the
 *    driver — there is no inheritance from the parent model and no
 *    default fallback.
 * 7. Maps the run outcome onto the tool's text return: an `ok` result is
 *    the subagent text verbatim; every failure variant (`aborted`,
 *    `error`) returns the partial text plus a short Chinese reason line.
 *
 * @module
 */

import { isDelegationAllowed } from "../core/delegation.js";
import { computeCapabilitySet } from "../core/permissions/capability.js";
import type {
  Deps,
  ToolContribution,
  ToolUnitDescriptor,
} from "../core/slots.js";
import type {
  SubagentDriver,
  SubagentProgress,
  SubagentResult,
} from "../core/subagent/driver.js";
import { resolveIdentity } from "../core/subagent/identity.js";
import {
  formatProgressLine,
  SNAPSHOT_OUTPUT_CAP,
} from "../core/subagent/progress.js";
import { finishRun, startRun, updateRun } from "../core/subagent/registry.js";
import { runSubagent } from "../core/subagent/run.js";
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
 * omit `hostCtx.callId`) is tracked under a synthetic id derived from the
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

/**
 * A pi `onUpdate` partial result, structurally matching pi's
 * `AgentToolResult` (`content` parts plus an arbitrary `details`).
 */
interface PiPartialResult {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentProgress;
}

/**
 * Bridge one progress snapshot into the pi streaming partial-result channel.
 *
 * Renders the snapshot into a compact one-line text (prefixed by the
 * delegation's `description` label when present) as a `text` content part,
 * and carries the FULL structured progress in `details` so the pi TUI card
 * renderer can draw the live transcript (spinner / current tool / recent
 * output / stats).  The run's registry id (the pi tool-call id) is stamped
 * onto the snapshot's `runId` so the transcript card can look up this run's
 * nested children in the run registry.  The call is defensive: a throwing
 * `onUpdate` is logged and swallowed so a UI callback can never break the
 * subagent run.
 *
 * @param progress - The snapshot to stream.
 * @param sessionID - The parent session id for logging.
 * @param label - The delegation's description tag, prefixed to the line.
 * @param onUpdate - The host's streaming partial-result callback, when one
 *   is present.
 * @param runId - The run's registry id (the pi tool-call id), stamped onto
 *   the streamed details.
 */
function emitProgressUpdate(
  progress: SubagentProgress,
  sessionID: string,
  label: string | undefined,
  onUpdate: unknown,
  runId: string | undefined,
): void {
  if (typeof onUpdate !== "function") return;
  try {
    const partial: PiPartialResult = {
      content: [
        {
          type: "text",
          text: formatProgressLine(progress, SNAPSHOT_OUTPUT_CAP, label),
        },
      ],
      details: runId !== undefined ? { ...progress, runId } : progress,
    };
    (onUpdate as (partial: PiPartialResult) => void)(partial);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      "subagent-tool",
      "progress_update_failed",
      sessionID,
      undefined,
      "warn",
      {
        error: message,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the subagent delegation tool.
 *
 * The driver, the host tool services, the tool baseline, the parsed
 * per-agent denies, and the optional transcript-card renderer are captured
 * by the closure so each `execute` call is self-contained.  When a renderer
 * is present (pi) the tool contribution carries `renderCall` / `renderResult`
 * so pi's TUI draws the live transcript card; without one (OpenCode) the
 * tool stays text-only.
 *
 * @param driver - The host driver that executes the subagent.
 * @param deps - The dependency surfaces the tool needs: `toolHost` for the
 *   parent session id, `subagentBaseline` for the capability baseline,
 *   `agentModes` for the declared subagent role of the target,
 *   `agentPermissions` for the target's tool-level denies, and
 *   `subagentRenderer` for the optional pi TUI card renderer.
 * @returns The subagent tool definition.
 */
export function createSubagentTool(
  driver: SubagentDriver,
  deps: Pick<
    Deps,
    | "toolHost"
    | "subagentBaseline"
    | "agentModes"
    | "agentPermissions"
    | "subagentRenderer"
    | "subagentModels"
    | "onSubagentRunChange"
  >,
): ToolContribution {
  const renderer = deps.subagentRenderer;
  // Nudge the host's fleet widget after every registry mutation (the pi
  // entry point wires this to the widget's refresh).
  const notifyRunChange = (): void => {
    deps.onSubagentRunChange?.();
  };
  return {
    name: "subagent",
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
        description: "交由子 agent 执行的完整任务说明。",
      },
    },
    required: ["agent", "description", "prompt"],
    // Attach the pi TUI renderers only when the host supplied one.  A
    // missing renderer (OpenCode) keeps the tool text-only.
    ...(renderer !== undefined
      ? {
          renderCall: renderer.renderCall,
          renderResult: renderer.renderResult,
        }
      : {}),
    async execute(args, toolCtx, hostCtx) {
      const input = validateSubagentArgs(args);

      // 1. Resolve the CALLER identity: the active primary outside a
      // sub-session scope, a bound subagent identity inside one.  An
      // unresolvable caller fails closed with an explanatory text.
      const identity = resolveIdentity();
      if (!identity) {
        return "无法确定调用者身份：未配置主 agent，无法委派子 agent。";
      }
      const caller = identity.name;

      // 2. Allowlist judgment — a blocked delegation returns the reason as
      // the tool text (never throws, never runs the driver).
      const verdict = isDelegationAllowed(caller, input.agent);
      if (!verdict.allowed) {
        const sessionID = deps.toolHost?.resolveSessionId(toolCtx) ?? "";
        log(
          "subagent-tool",
          "delegation_blocked",
          sessionID,
          undefined,
          "warn",
          {
            caller,
            target: input.agent,
          },
        );
        return verdict.reason ?? "委派被拒绝。";
      }

      // 3. Target-role guard — only agents declared `mode = "subagent"`
      // in the parsed config are valid delegation targets.  A missing
      // modes map, a target absent from it, or a target declared with
      // another mode (e.g. a primary) fails closed with an explanatory
      // text (never throws, never runs the driver).  The valid target
      // set comes from the parsed config only — no hardcoded agent list.
      const targetMode = deps.agentModes?.[input.agent];
      if (targetMode !== "subagent") {
        const sessionID = deps.toolHost?.resolveSessionId(toolCtx) ?? "";
        log(
          "subagent-tool",
          "delegation_blocked",
          sessionID,
          undefined,
          "warn",
          {
            caller,
            target: input.agent,
            reason: "not-a-subagent",
          },
        );
        return `"${input.agent}" 不是可委派的子 agent：仅在配置中声明 mode = "subagent" 的 agent 才能作为委派目标。`;
      }

      // 4. Capability set for the TARGET agent: `baseline − deniedTools`.
      // A missing baseline yields an empty set (fail-closed — permissions
      // are never invented).
      const deniedTools = deps.agentPermissions?.[input.agent] ?? [];
      const tools = computeCapabilitySet({
        baseline: deps.subagentBaseline,
        deniedTools,
      });

      // 5. Parent session id (for session lineage) and the abort signal.
      // The signal is taken from the host-forwarded execution context
      // (the pi bridge forwards the real tool signal there) when present,
      // falling back to the tool context's own `abort` field; otherwise a
      // fresh never-aborting signal is used (the driver owns the real
      // termination wiring).
      const sessionID = deps.toolHost?.resolveSessionId(toolCtx);
      const parentSession =
        typeof sessionID === "string" && sessionID.length > 0
          ? sessionID
          : undefined;
      const hostSignal = hostCtx?.signal;
      const toolCtxSignal = (toolCtx as { abort?: unknown } | undefined)?.abort;
      const signal =
        hostSignal instanceof AbortSignal
          ? hostSignal
          : toolCtxSignal instanceof AbortSignal
            ? toolCtxSignal
            : new AbortController().signal;

      // 6. Model resolution for the sub-session (strict mode): the target's
      //    `[agent.<name>].model` from agents.json (`deps.subagentModels`,
      //    materialised by the installer as a `{provider, model}` pair whose
      //    mapped value is the concatenated `"provider/model"` string — the
      //    TS runtime never resolves `{env:}` tokens itself) is the SOLE
      //    model source.  A missing agents.json (empty map), or an agent
      //    absent from it, fails closed with an actionable Chinese error and
      //    never runs the driver — there is no inheritance and no default
      //    fallback.
      const configuredModel = deps.subagentModels?.[input.agent];
      if (typeof configuredModel !== "string" || configuredModel.length === 0) {
        const sessionID = deps.toolHost?.resolveSessionId(toolCtx) ?? "";
        log("subagent-tool", "model_missing", sessionID, undefined, "warn", {
          caller,
          target: input.agent,
        });
        return `"${input.agent}" 未配置子 agent 模型：仅从 ~/.pi/agent/agents.json 读取模型配置，未找到该 agent 的 provider/model 条目（文件缺失、JSON 非法或该 agent 未配置 provider/model 均会导致此错误）。请运行 \`uv run python install.py\` 重新生成 agents.json 后重试。`;
      }
      const model = configuredModel;

      // 7. Registry write — the pi bridge forwards the tool-call id via
      // `hostCtx.callId`, which doubles as the run id in the process-level
      // run registry (the fleet widget's source of truth).  A run without a
      // forwarded call id (OpenCode, test invocations that omit hostCtx) is
      // tracked with a synthetic id derived from the caller/agent plus a
      // module-level monotonic counter so consecutive delegations never
      // collide (the previous scheme stamped `Date.now()`, which two
      // delegations in the same millisecond could collide on, and carried a
      // non-ASCII arrow).
      const runId =
        hostCtx?.callId ?? `${caller}-${input.agent}-${++syntheticRunSeq}`;
      const runStarted =
        typeof parentSession === "string" && parentSession.length > 0;
      if (runStarted) {
        startRun({
          id: runId,
          agent: input.agent,
          parentSession,
          label: input.description,
        });
        notifyRunChange();
      }

      // 8. Stream compact progress snapshots into the host's partial-result
      // channel when one is present (pi's `onUpdate`).  Each snapshot is
      // rendered to a single capped line; a throwing callback is logged and
      // swallowed so live observability can never break the run.  When
      // `onUpdate` is absent (OpenCode, tests without it) progress is a
      // no-op and the run proceeds unchanged.
      const sessionForLog = parentSession ?? "";

      const result = await runSubagent(
        driver,
        {
          agent: input.agent,
          prompt: input.prompt,
          tools,
          parentSession,
          // Strict mode: the agents.json model is always present (the
          // missing-entry guard above never lets the run reach the driver
          // without one).
          model,
        },
        {
          signal,
          onProgress: (progress) => {
            // Patch the running run's progress fields from the snapshot
            // (current tool, tokens, model) and report the child session
            // id once the driver materialises it, so the fleet widget can
            // rebuild the parent/child tree.
            if (runStarted) {
              const patch: {
                currentTool?: string;
                tokens?: number;
                model?: string;
                childSession?: string;
                sessionPath?: string;
              } = {};
              if (progress.currentTool !== undefined) {
                patch.currentTool = progress.currentTool;
              }
              if (progress.tokens !== undefined) patch.tokens = progress.tokens;
              if (progress.model !== undefined) patch.model = progress.model;
              if (progress.childSession !== undefined) {
                patch.childSession = progress.childSession;
              }
              if (progress.sessionPath !== undefined) {
                // The sub-session file exists from the first progress
                // snapshot (the driver reports it once the session manager
                // is created), so the running run carries it for
                // enter-inspect mid-run — not only on the terminal finish.
                patch.sessionPath = progress.sessionPath;
              }
              if (Object.keys(patch).length > 0) {
                updateRun(runId, patch);
                notifyRunChange();
              }
            }
            emitProgressUpdate(
              progress,
              sessionForLog,
              input.description,
              hostCtx?.onUpdate,
              runId,
            );
          },
        },
      );

      // 9. Finish the registry run (terminal state, immutable thereafter).
      //    The session path (when any) was already patched onto the run via
      //    `updateRun` on the first progress snapshot, so finish only sets
      //    the terminal status and outcome fields.
      if (runStarted) {
        finishRun(runId, {
          status:
            result.kind === "ok"
              ? "done"
              : result.kind === "error"
                ? "error"
                : "aborted",
          ...(result.kind === "error" ? { error: result.errorMessage } : {}),
        });
        notifyRunChange();
      }

      log(
        "subagent-tool",
        "subagent_done",
        parentSession ?? "",
        undefined,
        "info",
        {
          agent: input.agent,
          description: input.description,
          kind: result.kind,
          tools: tools.length,
        },
      );

      // 10. Map the outcome onto the tool text.
      return formatSubagentResult(result);
    },
  };
}

/**
 * Subagent delegation tool unit descriptor.
 *
 * The tool contribution carries the subagent delegation adapter; the unit
 * contributes it ONLY when a host driver is present in deps — without one
 * (OpenCode) zero tools are contributed (fail-closed).
 */
export const unit: ToolUnitDescriptor = {
  name: "subagent",
  kind: "tool",
  create(deps) {
    const driver = deps.subagentDriver;
    if (!driver) {
      // No host driver (OpenCode) — contribute no tools so the `subagent`
      // tool never registers there; OpenCode keeps its native `task` tool.
      return { kind: "tool", tools: [] };
    }
    return {
      kind: "tool",
      tools: [createSubagentTool(driver, deps)],
    };
  },
};
