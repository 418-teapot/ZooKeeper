/**
 * Core scenario 1: extension loading, tool registration and the full todo
 * tool round trip.
 *
 * Highest-risk surface first: if the repository extension does not load or
 * registers no tools, every later scenario would be meaningless.  The
 * assertions use public evidence only (RPC records and the real tool
 * output), plus the trace for the registration inventory.
 */

import { MODEL_REF } from "../harness/isolation.js";
import {
  assertToolInventory,
  contentText,
  createCompletedPlan,
  type ScenarioDefinition,
} from "../harness/scenario-runtime.js";

export const startupTodo: ScenarioDefinition = {
  id: "startup-todo",
  title: "扩展加载、工具注册与 Todo 工具完整回环",
  risk: "扩展未加载、工具未注册、todo 工具回环中断或最终文本投影错误",
  async run(ctx) {
    const state = await ctx.pi.state();
    ctx.checks.add({
      id: "startup_state",
      title: "RPC 启动后进入会话并选中确定性模型",
      status:
        state.sessionId !== null &&
        state.sessionFile !== null &&
        state.model === MODEL_REF,
      detail: `model=${state.model} sessionId=${state.sessionId} file=${state.sessionFile}`,
      evidence: "rpc.jsonl",
    });

    const factories = ctx.pi
      .trace()
      .filter((record) => record.event === "factory");
    ctx.checks.add({
      id: "extension_factory",
      title: "仓库 src/pi.ts 扩展 factory 真实执行",
      status: factories.length >= 1,
      detail: `factories=${factories.length} cwd=${JSON.stringify(factories.map((record) => record.cwd))}`,
      evidence: "trace.jsonl",
    });

    await assertToolInventory(ctx, "startup");
    await createCompletedPlan(ctx);

    const startIds = ctx.pi.records
      .filter((record) => record.type === "tool_execution_start")
      .map((record) => String(record.toolCallId));
    const endIds = ctx.pi.records
      .filter((record) => record.type === "tool_execution_end")
      .map((record) => String(record.toolCallId));
    ctx.checks.add({
      id: "tool_calls_deduplicated",
      title: "每个工具调用只执行一次（无重复 handler）",
      status:
        startIds.length === 5 &&
        new Set(startIds).size === startIds.length &&
        endIds.length === startIds.length &&
        endIds.every((id) => startIds.includes(id)),
      detail: `starts=${JSON.stringify(startIds)} ends=${JSON.stringify(endIds)}`,
      evidence: "rpc.jsonl",
    });

    const assistantCount = ctx.pi.records.filter(
      (record) =>
        record.type === "message_end" && record.message?.role === "assistant",
    ).length;
    const providerCalls = ctx.pi
      .trace()
      .filter((record) => record.event === "provider_call");
    const foreign = providerCalls.filter(
      (record) => record.model !== MODEL_REF,
    );
    const lastText = contentText(
      ctx.pi.records
        .filter(
          (record) =>
            record.type === "message_end" &&
            record.message?.role === "assistant",
        )
        .at(-1)?.message?.content,
    );
    ctx.checks.add({
      id: "no_external_provider",
      title: "每次模型响应都来自进程内确定性 provider（无外部调用）",
      status:
        providerCalls.length > 0 &&
        providerCalls.length === assistantCount &&
        foreign.length === 0 &&
        lastText.length > 0,
      detail: `providerCalls=${providerCalls.length} assistantMessages=${assistantCount} foreign=${foreign.length}`,
      evidence: "trace.jsonl",
    });
  },
};
