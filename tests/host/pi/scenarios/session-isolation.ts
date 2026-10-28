/**
 * Core scenario 2: A/B session isolation and resume.
 *
 * A plan created in session A must be invisible in a new session B and
 * fully readable again after switching back to A's file.  The transcript
 * snapshots prove the isolation, so a todo tool that shares state across
 * sessions cannot pass by echoing the same text everywhere.
 */

import {
  ALPHA_TASKS,
  MARKERS,
  PLAN_COMPLETE_TEXT,
  PLAN_EMPTY_TEXT,
} from "../harness/constants.js";
import {
  assertNoExternalProvider,
  assertToolInventory,
  createCompletedPlan,
  type ScenarioDefinition,
} from "../harness/scenario-runtime.js";

export const sessionIsolation: ScenarioDefinition = {
  id: "session-isolation",
  title: "A/B 会话隔离与 resume",
  risk: "会话作用域串号：新会话继承旧计划，或 resume 后计划丢失",
  async run(ctx) {
    const initial = await ctx.pi.state();
    ctx.checks.add({
      id: "session_a_started",
      title: "会话 A 建立并保存到隔离会话目录",
      status: initial.sessionId !== null && initial.sessionFile !== null,
      detail: `sessionId=${initial.sessionId} file=${initial.sessionFile}`,
      evidence: "rpc.jsonl",
    });
    await assertToolInventory(ctx, "startup");
    await createCompletedPlan(ctx);

    const stateA = await ctx.pi.state();
    const entriesA = await ctx.pi.entriesJson();
    ctx.checks.add({
      id: "plan_in_session_a",
      title: "计划创建后仍在会话 A",
      status:
        stateA.sessionId === initial.sessionId &&
        stateA.sessionFile === initial.sessionFile,
      detail: `A=${stateA.sessionId} initial=${initial.sessionId}`,
      evidence: "rpc.jsonl",
    });

    const viewA = await ctx.pi.prompt(MARKERS.view);
    const viewAText =
      viewA.assistantTexts[viewA.assistantTexts.length - 1] ?? "";
    ctx.checks.add({
      id: "a_readback",
      title: "会话 A 内 todo 工具读回 alpha 计划",
      status: viewAText.includes(PLAN_COMPLETE_TEXT),
      detail: `text=${JSON.stringify(viewAText).slice(0, 200)}`,
      evidence: "rpc.jsonl",
    });

    // ── New session B: independent id, file and plan ───────────────────
    const created = await ctx.pi.newSession();
    const stateB = await ctx.pi.state();
    ctx.checks.add({
      id: "new_session_isolated",
      title: "new_session 创建独立会话 B（id 与文件均不同）",
      status:
        created.success === true &&
        created.data?.cancelled === false &&
        stateB.sessionId !== null &&
        stateB.sessionId !== stateA.sessionId &&
        stateB.sessionFile !== stateA.sessionFile,
      detail: `cancelled=${created.data?.cancelled} B=${stateB.sessionId} A=${stateA.sessionId}`,
      evidence: "rpc.jsonl",
    });

    const viewB = await ctx.pi.prompt(MARKERS.view);
    const viewBText =
      viewB.assistantTexts[viewB.assistantTexts.length - 1] ?? "";
    const entriesB = await ctx.pi.entriesJson();
    ctx.checks.add({
      id: "b_plan_empty",
      title: "会话 B 的 todo 为空（不继承 A 的计划）",
      status:
        viewBText.includes(PLAN_EMPTY_TEXT) &&
        !viewBText.includes(PLAN_COMPLETE_TEXT),
      detail: `text=${JSON.stringify(viewBText).slice(0, 200)}`,
      evidence: "rpc.jsonl",
    });
    const hasAlpha = (json: string): boolean =>
      ALPHA_TASKS.every((task) => json.includes(task));
    ctx.checks.add({
      id: "b_transcript_isolated",
      title: "B 的 transcript 不含 alpha 任务，A 含",
      status: !hasAlpha(entriesB) && hasAlpha(entriesA),
      detail: `A=${hasAlpha(entriesA)} B=${hasAlpha(entriesB)}`,
      evidence: "rpc.jsonl",
    });

    // ── Resume A from its file ─────────────────────────────────────────
    const resumed = await ctx.pi.switchSession(stateA.sessionFile ?? "");
    const stateResumed = await ctx.pi.state();
    ctx.checks.add({
      id: "resume_session_a",
      title: "switch_session 恢复到会话 A（id 与文件一致）",
      status:
        resumed.success === true &&
        resumed.data?.cancelled === false &&
        stateResumed.sessionId === stateA.sessionId &&
        stateResumed.sessionFile === stateA.sessionFile,
      detail: `cancelled=${resumed.data?.cancelled} sessionId=${stateResumed.sessionId} file=${stateResumed.sessionFile}`,
      evidence: "rpc.jsonl",
    });

    const viewResumed = await ctx.pi.prompt(MARKERS.view);
    const viewResumedText =
      viewResumed.assistantTexts[viewResumed.assistantTexts.length - 1] ?? "";
    const entriesResumed = await ctx.pi.entriesJson();
    ctx.checks.add({
      id: "resume_readback",
      title: "恢复 A 后 todo 工具读回 alpha 计划",
      status:
        viewResumedText.includes(PLAN_COMPLETE_TEXT) &&
        hasAlpha(entriesResumed),
      detail: `text=${JSON.stringify(viewResumedText).slice(0, 200)} transcript=${hasAlpha(entriesResumed)}`,
      evidence: "rpc.jsonl",
    });

    // Both replacements re-run the extension runtime; the inventory must
    // stay deduplicated, which is the idempotency claim (pi may emit
    // session_start more than once, and that is recorded as information
    // rather than asserted).
    await assertToolInventory(ctx, "new");
    await assertToolInventory(ctx, "resume");
    const startReasons = ctx.pi
      .trace()
      .filter((record) => record.event === "session_start")
      .map((record) => record.reason);
    ctx.checks.info(
      "session_start_observation",
      "session_start 观测（重复次数是宿主行为，仅作记录）",
      `reasons=${JSON.stringify(startReasons)}；插件副作用幂等性由工具注册无重复与单次执行断言覆盖`,
    );
    assertNoExternalProvider(ctx);
  },
};
