/**
 * Core scenario 3: reload idempotency.
 *
 * pi's real reload tears the extension runtime down and rebuilds it.  The
 * plugin must re-register exactly once and keep the todo state, and it must
 * survive a second reload — so this scenario reloads twice and checks the
 * tool inventory and the single execution of one todo call after each
 * reload.
 */

import { MARKERS, PLAN_COMPLETE_TEXT } from "../harness/constants.js";
import {
  assertNoExternalProvider,
  assertToolInventory,
  createCompletedPlan,
  type PromptStep,
  type ScenarioContext,
  type ScenarioDefinition,
} from "../harness/scenario-runtime.js";

/**
 * Record the reload assertions that apply to one reload.
 *
 * @param ctx - Scenario context.
 * @param label - Check id suffix (`first`, `repeated`).
 * @param reload - The reload prompt step.
 * @param view - The read-back prompt step after the reload.
 */
function assertReload(
  ctx: ScenarioContext,
  label: string,
  reload: PromptStep,
  view: PromptStep,
): void {
  ctx.checks.add({
    id: `reload_handled_${label}`,
    title: "prompt /e2e-reload 触发 pi 真实 reload",
    status:
      reload.response.success === true && reload.disposition === "handled",
    detail: `success=${reload.response.success} disposition=${reload.disposition}`,
    evidence: "rpc.jsonl",
  });
  const text = view.assistantTexts[view.assistantTexts.length - 1] ?? "";
  ctx.checks.add({
    id: `reload_readback_${label}`,
    title: "reload 后 todo 工具仍读回 alpha 计划",
    status: text.includes(PLAN_COMPLETE_TEXT),
    detail: `text=${JSON.stringify(text).slice(0, 200)}`,
    evidence: "rpc.jsonl",
  });
  const starts = view.toolStarts.filter((call) => call.tool === "todo");
  const ends = view.toolResults.filter((call) => call.tool === "todo");
  ctx.checks.add({
    id: `reload_single_execution_${label}`,
    title: "reload 后一次 view 只执行一次 todo 工具（handler 未重复）",
    status: starts.length === 1 && ends.length === 1 && !ends[0]?.isError,
    detail: `starts=${starts.length} ends=${ends.length} isError=${ends[0]?.isError}`,
    evidence: "rpc.jsonl",
  });
}

export const reloadIdempotency: ScenarioDefinition = {
  id: "reload-idempotency",
  title: "reload 与重复 session_start 的幂等性",
  risk: "reload 重建 runtime 后工具重复注册、todo 状态丢失或 handler 重复触发",
  async run(ctx) {
    await assertToolInventory(ctx, "startup");
    await createCompletedPlan(ctx);
    const before = await ctx.pi.state();
    const toolCountBefore = ctx.pi
      .trace()
      .find(
        (record) =>
          record.event === "session_start" && record.reason === "startup",
      )?.toolCount;

    assertReload(
      ctx,
      "first",
      await ctx.pi.prompt("/e2e-reload"),
      await ctx.pi.prompt(MARKERS.view),
    );
    const afterFirst = await ctx.pi.state();
    ctx.checks.add({
      id: "reload_keeps_session",
      title: "reload 不替换会话（id 与文件不变）",
      status:
        afterFirst.sessionId === before.sessionId &&
        afterFirst.sessionFile === before.sessionFile,
      detail: `before=${before.sessionId} after=${afterFirst.sessionId}`,
      evidence: "rpc.jsonl",
    });
    await assertToolInventory(ctx, "reload", {
      occurrences: 1,
      label: "reload_first",
    });
    const toolCountReload = ctx.pi
      .trace()
      .find(
        (record) =>
          record.event === "session_start" && record.reason === "reload",
      )?.toolCount;
    ctx.checks.add({
      id: "reload_tool_count_stable",
      title: "reload 前后工具总数一致（未叠加注册）",
      status:
        typeof toolCountBefore === "number" &&
        toolCountBefore === toolCountReload,
      detail: `startup=${toolCountBefore} reload=${toolCountReload}`,
      evidence: "trace.jsonl",
    });

    // Second reload: the rebuilt runtime must stay idempotent.
    assertReload(
      ctx,
      "repeated",
      await ctx.pi.prompt("/e2e-reload"),
      await ctx.pi.prompt(MARKERS.view),
    );
    await assertToolInventory(ctx, "reload", {
      occurrences: 2,
      label: "reload_repeated",
    });

    const reasons = ctx.pi
      .trace()
      .filter((record) => record.event === "session_start")
      .map((record) => record.reason);
    ctx.checks.info(
      "reload_session_start_observation",
      "reload 期间 session_start 观测（次数是宿主行为，仅作记录）",
      `reasons=${JSON.stringify(reasons)}；幂等性由工具注册无重复、工具总数稳定与单次执行覆盖`,
    );
    assertNoExternalProvider(ctx);
  },
};
