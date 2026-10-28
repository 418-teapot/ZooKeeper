/**
 * Core scenario 4: fork transcript and todo inheritance.
 *
 * A fork continues from a stored user message, so the plan is not restored
 * from plugin state but rebuilt from the inherited transcript.  The
 * transcript snapshot is therefore the primary evidence: it must contain
 * the alpha tasks with their completed status.
 */

import {
  ALPHA_TASKS,
  MARKERS,
  PLAN_COMPLETE_TEXT,
} from "../harness/constants.js";
import {
  assertNoExternalProvider,
  assertToolInventory,
  createCompletedPlan,
  type ScenarioDefinition,
} from "../harness/scenario-runtime.js";

export const forkInheritance: ScenarioDefinition = {
  id: "fork-inheritance",
  title: "fork 的 transcript 与 Todo 继承",
  risk: "fork 后 transcript 继承不完整，或 todo 状态无法从继承的 transcript 重建",
  async run(ctx) {
    await assertToolInventory(ctx, "startup");
    await createCompletedPlan(ctx);
    const stateA = await ctx.pi.state();
    const entriesA = await ctx.pi.entriesJson();

    // Add a second user message after the plan, then fork from it: a fork
    // continues from the turn *before* the chosen message, so this is what
    // makes the inherited transcript carry the plan's tool calls/results.
    const viewA = await ctx.pi.prompt(MARKERS.view);
    const viewAText =
      viewA.assistantTexts[viewA.assistantTexts.length - 1] ?? "";
    ctx.checks.add({
      id: "a_readback_before_fork",
      title: "fork 前会话 A 读回 alpha 计划",
      status: viewAText.includes(PLAN_COMPLETE_TEXT),
      detail: `text=${JSON.stringify(viewAText).slice(0, 200)}`,
      evidence: "rpc.jsonl",
    });

    const forkable = await ctx.pi.forkMessages();
    const target = forkable[forkable.length - 1];
    ctx.checks.add({
      id: "fork_messages_available",
      title: "会话 A 存在可 fork 的用户消息",
      status:
        forkable.length > 0 &&
        typeof target?.entryId === "string" &&
        target.entryId.length > 0,
      detail: `forkable=${forkable.length} last=${JSON.stringify(target?.text ?? "").slice(0, 80)}`,
      evidence: "rpc.jsonl",
    });

    const forked = await ctx.pi.fork(target?.entryId ?? "");
    const stateFork = await ctx.pi.state();
    ctx.checks.add({
      id: "fork_created",
      title: "fork 产生新会话（id 与文件不同于 A）",
      status:
        forked.success === true &&
        forked.data?.cancelled === false &&
        stateFork.sessionId !== null &&
        stateFork.sessionId !== stateA.sessionId &&
        stateFork.sessionFile !== stateA.sessionFile,
      detail: `cancelled=${forked.data?.cancelled} fork=${stateFork.sessionId} A=${stateA.sessionId}`,
      evidence: "rpc.jsonl",
    });

    const viewFork = await ctx.pi.prompt(MARKERS.view);
    const viewForkText =
      viewFork.assistantTexts[viewFork.assistantTexts.length - 1] ?? "";
    ctx.checks.add({
      id: "fork_readback",
      title: "fork 后 todo 工具读回 alpha 计划",
      status: viewForkText.includes(PLAN_COMPLETE_TEXT),
      detail: `text=${JSON.stringify(viewForkText).slice(0, 200)}`,
      evidence: "rpc.jsonl",
    });

    const entriesFork = await ctx.pi.entriesJson();
    const hasAlpha = (json: string): boolean =>
      ALPHA_TASKS.every((task) => json.includes(task));
    ctx.checks.add({
      id: "fork_transcript_inherited",
      title: "fork 的 transcript 继承 alpha 任务与 completed 状态",
      status:
        hasAlpha(entriesA) &&
        hasAlpha(entriesFork) &&
        entriesFork.includes('"status":"completed"'),
      detail: `tasks=${JSON.stringify(ALPHA_TASKS)} A=${hasAlpha(entriesA)} fork=${hasAlpha(entriesFork)} completed=${entriesFork.includes('"status":"completed"')}`,
      evidence: "rpc.jsonl",
    });

    await assertToolInventory(ctx, "fork");
    assertNoExternalProvider(ctx);
  },
};
