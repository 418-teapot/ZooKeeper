/**
 * Core scenario: the subagent run timeout cancels a real sub-session.
 *
 * One real pi process delegates to a sub-session that calls a tool holding
 * the run open.  The run budget of the scenario's isolated config copy
 * elapses first, the abort reaches the tool, the child settles, and the
 * parent's tool result reports the timeout while the parent session keeps
 * working.
 *
 * The hanging tool releases itself far later than the budget, so a run that
 * ends at that deadline (or never reports the timeout text) proves the
 * budget did not take effect.  Only the cooperative cancellation path is
 * claimed: the tool honors the abort signal, which every pi tool shares.
 */

import {
  HANG_ESCAPE_MS,
  MARKERS,
  SUBAGENT_TIMEOUT_SECONDS,
  SUBAGENT_TIMEOUT_TEXT,
} from "../harness/constants.js";
import {
  assertNoExternalProvider,
  type ScenarioDefinition,
} from "../harness/scenario-runtime.js";

/** Upper bound of the run, below the hanging tool's own release deadline. */
const ELAPSED_UPPER_MS = HANG_ESCAPE_MS - 3_000;

/** Deadline of one prompt RPC, above the configured budget and the abort. */
const PROMPT_TIMEOUT_MS = 30_000;

export const subagentTimeout: ScenarioDefinition = {
  id: "subagent-timeout",
  title: "子 agent 运行超时中止真实子会话并由父会话继续",
  risk: "运行预算失效、超时后父会话卡死，或收尾不等子会话取消就返回",
  isolatedZoo: { subagentTimeoutSeconds: SUBAGENT_TIMEOUT_SECONDS },
  async run(ctx) {
    await ctx.pi.state();
    const startedAt = Date.now();
    const step = await ctx.pi.prompt(
      MARKERS.subagentTimeout,
      PROMPT_TIMEOUT_MS,
    );
    const elapsed = Date.now() - startedAt;

    const result = step.toolResults
      .filter((call) => call.tool === "subagent")
      .at(-1);
    ctx.checks.add({
      id: "parent_prompt_returned",
      title: "父会话的 prompt 正常返回，subagent 工具结果携带超时说明",
      status:
        step.response.success === true &&
        result !== undefined &&
        result.text.includes(SUBAGENT_TIMEOUT_TEXT),
      detail: `success=${step.response.success} isError=${result?.isError} text=${JSON.stringify(result?.text ?? "").slice(0, 240)}`,
      evidence: "rpc.jsonl",
    });

    ctx.checks.add({
      id: "elapsed_in_budget_window",
      title: "运行在配置预算后结束，且远早于挂起工具的兜底自解",
      status:
        elapsed >= SUBAGENT_TIMEOUT_SECONDS * 1000 &&
        elapsed < ELAPSED_UPPER_MS,
      detail: `elapsed=${elapsed}ms lower=${SUBAGENT_TIMEOUT_SECONDS * 1000}ms upper=${ELAPSED_UPPER_MS}ms`,
      evidence: ["rpc.jsonl", "trace.jsonl"],
    });

    const trace = ctx.pi.trace();
    const started = trace.find((record) => record.event === "e2e_hang_started");
    const aborted = trace.find((record) => record.event === "e2e_hang_aborted");
    const escaped = trace.find((record) => record.event === "e2e_hang_escape");
    const childRuntime = started?.runtime;
    const hangRequest = trace.find(
      (record) =>
        record.event === "provider_call" &&
        record.decision === "tool:e2e-hang" &&
        record.runtime === childRuntime,
    );
    ctx.checks.add({
      id: "child_entered_hang_tool",
      title: "真实子会话声明并进入 e2e-hang 工具",
      status:
        hangRequest !== undefined &&
        started !== undefined &&
        typeof childRuntime === "string" &&
        started.child === true,
      detail: `decision=${hangRequest?.decision} runtime=${String(childRuntime)} startedAt=${started?.seq}`,
      evidence: "trace.jsonl",
    });

    const childSettle = trace.find(
      (record) =>
        record.event === "agent_settled" &&
        record.runtime === childRuntime &&
        record.aborted === true,
    );
    // Trace sequence numbers are the ordering evidence: they are written by
    // one process, in emission order.
    const seq = (record: { seq?: number } | undefined): number =>
      typeof record?.seq === "number" ? record.seq : Number.NaN;
    ctx.checks.add({
      id: "hang_tool_aborted",
      title: "挂起工具收到 abort 后结束，子会话以 aborted 收尾且未触发兜底",
      status:
        aborted !== undefined &&
        escaped === undefined &&
        childSettle !== undefined &&
        seq(aborted) > seq(started) &&
        seq(childSettle) > seq(aborted),
      detail: `started=${seq(started)} aborted=${seq(aborted)} escaped=${seq(escaped)} childSettle=${seq(childSettle)}`,
      evidence: "trace.jsonl",
    });

    // The parent's tool result is produced by the delegation, so the child's
    // final settle must precede it.
    const parentResult = trace.find(
      (record) => record.event === "tool_result" && record.tool === "subagent",
    );
    ctx.checks.add({
      id: "child_settled_before_parent_result",
      title: "子会话收尾早于父会话的 subagent 工具结果（事件顺序）",
      status:
        childSettle !== undefined &&
        parentResult !== undefined &&
        seq(childSettle) < seq(parentResult),
      detail: `childSettle=${seq(childSettle)} parentResult=${seq(parentResult)}`,
      evidence: "trace.jsonl",
    });

    const next = await ctx.pi.prompt(MARKERS.view);
    const nextText = next.assistantTexts[next.assistantTexts.length - 1] ?? "";
    ctx.checks.add({
      id: "parent_usable_after_timeout",
      title: "超时后父会话能再次完成一轮普通 prompt",
      status: next.response.success === true && nextText.includes("VIEW:"),
      detail: `success=${next.response.success} text=${JSON.stringify(nextText).slice(0, 200)}`,
      evidence: "rpc.jsonl",
    });

    // The child's messages never reach the parent's RPC stream.
    assertNoExternalProvider(ctx, { oneToOne: false });
  },
};
