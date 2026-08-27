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
 * 6. Maps the run outcome onto the tool's text return: an `ok` result is
 *    the subagent text verbatim; every failure variant (`timeout`,
 *    `aborted`, `error`) returns the partial text plus a short Chinese
 *    reason line.
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
import { runSubagent } from "../core/subagent/run.js";
import { log } from "../utils/logger.js";

type SubagentToolInput = {
  agent: string;
  description: string;
  prompt: string;
};

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
    case "timeout":
      return appendReason(
        result.text,
        "子 agent 运行超时，未在限定时间内完成。",
      );
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
  details: Record<string, never>;
}

/**
 * Bridge one progress snapshot into the pi streaming partial-result channel.
 *
 * Renders the snapshot into a compact one-line text (prefixed by the
 * delegation's `description` label when present) and emits it as a `text`
 * content part inside pi's partial-result shape.  The call is defensive: a
 * throwing `onUpdate` is logged and swallowed so a UI callback can never
 * break the subagent run.
 *
 * @param progress - The snapshot to stream.
 * @param sessionID - The parent session id for logging.
 * @param label - The delegation's description tag, prefixed to the line.
 * @param onUpdate - The host's streaming partial-result callback, when one
 *   is present.
 */
function emitProgressUpdate(
  progress: SubagentProgress,
  sessionID: string,
  label: string | undefined,
  onUpdate: unknown,
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
      details: {},
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
 * The driver, the host tool services, the tool baseline, and the parsed
 * per-agent denies are captured by the closure so each `execute` call is
 * self-contained.
 *
 * @param driver - The host driver that executes the subagent.
 * @param deps - The dependency surfaces the tool needs: `toolHost` for the
 *   parent session id, `subagentBaseline` for the capability baseline,
 *   `agentModes` for the declared subagent role of the target, and
 *   `agentPermissions` for the target's tool-level denies.
 * @returns The subagent tool definition.
 */
export function createSubagentTool(
  driver: SubagentDriver,
  deps: Pick<
    Deps,
    "toolHost" | "subagentBaseline" | "agentModes" | "agentPermissions"
  >,
): ToolContribution {
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

      // 6. Model inheritance: forward the parent's model (as a
      // `"provider/id"` string) when the host carried it on the execution
      // context.  The driver resolves it against the pi SDK when present;
      // a missing model falls back to the sub-session's default.
      const model =
        typeof hostCtx?.model === "string" && hostCtx.model.length > 0
          ? hostCtx.model
          : undefined;

      // 7. Stream compact progress snapshots into the host's partial-result
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
          ...(model !== undefined ? { model } : {}),
        },
        {
          signal,
          onProgress: (progress) =>
            emitProgressUpdate(
              progress,
              sessionForLog,
              input.description,
              hostCtx?.onUpdate,
            ),
        },
      );

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

      // 8. Map the outcome onto the tool text.
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
