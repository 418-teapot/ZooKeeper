/**
 * Core scenario 5: SDK sub-session lifecycle.
 *
 * The subagent tool creates a real SDK session inside the pi process.  The
 * primary evidence is public: the parent's tool result carries the child's
 * reply, the child runs its own extension runtime and its own model turn,
 * and its session id differs from the parent's.  The SDK bridge check
 * (`hasPiSdkSession`) is recorded as auxiliary white-box evidence and is
 * never the only support for an assertion.
 */

import { CHILD_REPLY, MARKERS } from "../harness/constants.js";
import {
  assertNoExternalProvider,
  type ScenarioDefinition,
  SUBAGENT_TIMEOUT_MS,
} from "../harness/scenario-runtime.js";

export const subagentSdk: ScenarioDefinition = {
  id: "subagent-sdk",
  title: "SDK 子会话的独立 runtime 与生命周期收尾",
  risk: "子会话未加载扩展、与父会话共享状态、SDK 作用域未在父工具结果前释放",
  async run(ctx) {
    const parent = await ctx.pi.state();
    const step = await ctx.pi.prompt(MARKERS.subagent, SUBAGENT_TIMEOUT_MS);
    const results = step.toolResults.filter((call) => call.tool === "subagent");
    const result = results[results.length - 1];
    ctx.checks.add({
      id: "parent_tool_result",
      title: "父会话的 subagent 结果携带子会话回复",
      status:
        result !== undefined &&
        !result.isError &&
        result.text.includes(CHILD_REPLY),
      detail: `isError=${result?.isError} text=${JSON.stringify(result?.text ?? "").slice(0, 240)}`,
      evidence: "rpc.jsonl",
    });
    const finalText = step.assistantTexts[step.assistantTexts.length - 1] ?? "";
    ctx.checks.add({
      id: "parent_final_text",
      title: "父会话最终 assistant 文本携带子会话结果",
      status: finalText.includes(CHILD_REPLY),
      detail: `text=${JSON.stringify(finalText).slice(0, 240)}`,
      evidence: "rpc.jsonl",
    });

    const trace = ctx.pi.trace();
    const parentRuntime = trace.find(
      (record) =>
        record.event === "session_start" && record.reason === "startup",
    )?.runtime;
    const childStart = trace.find(
      (record) =>
        record.event === "before_agent_start" && record.child === true,
    );
    const childRuntime = childStart?.runtime;
    const childSessionID: string | undefined = childStart?.sessionID;
    const factories = trace.filter((record) => record.event === "factory");
    ctx.checks.add({
      id: "child_runtime_independent",
      title: "子会话运行独立的扩展 runtime（factory 再次执行）",
      status:
        typeof parentRuntime === "string" &&
        typeof childRuntime === "string" &&
        childRuntime !== parentRuntime &&
        factories.some((record) => record.runtime === childRuntime),
      detail: `parentRuntime=${parentRuntime} childRuntime=${childRuntime} factories=${factories.length}`,
      evidence: "trace.jsonl",
    });
    const childProviderCalls = trace.filter(
      (record) =>
        record.event === "provider_call" && record.runtime === childRuntime,
    );
    ctx.checks.add({
      id: "child_model_turn",
      title: "子会话执行了自己的模型 turn",
      status: childProviderCalls.length >= 1,
      detail: `childProviderCalls=${childProviderCalls.length} decisions=${JSON.stringify(childProviderCalls.map((record) => record.decision))}`,
      evidence: "trace.jsonl",
    });
    ctx.checks.add({
      id: "child_session_id_differs",
      title: "子会话 sessionID 与父会话不同",
      status:
        parent.sessionId !== null &&
        typeof childSessionID === "string" &&
        parent.sessionId !== childSessionID,
      detail: `parent=${parent.sessionId} child=${childSessionID}`,
      evidence: ["rpc.jsonl", "trace.jsonl"],
    });

    // Ordering evidence from real events: the child session finished its
    // work before the parent's tool result was produced.
    const parentResult = trace.find(
      (record) => record.event === "tool_result" && record.tool === "subagent",
    );
    const childLast = trace
      .filter(
        (record) =>
          record.runtime === childRuntime &&
          record.event !== "factory" &&
          record.event !== "provider_registered" &&
          record.event !== "probe_registered",
      )
      .at(-1);
    ctx.checks.add({
      id: "child_finished_before_parent_result",
      title: "子会话活动在父工具结果之前结束（事件顺序）",
      status:
        typeof parentResult?.seq === "number" &&
        typeof childLast?.seq === "number" &&
        childLast.seq < parentResult.seq,
      detail: `childLast=${childLast?.event}@${childLast?.seq} parentToolResult@${parentResult?.seq}`,
      evidence: "trace.jsonl",
    });

    // Auxiliary white-box evidence: the SDK bridge association exists while
    // the child runs and is already released when the parent sees the result.
    ctx.checks.add({
      id: "bridge_associated_during_child_run",
      title: "（白盒辅助）子会话运行期 SDK 生命周期桥已关联",
      status: childStart?.hasPiSdkSession === true,
      detail: `child=${childSessionID} hasPiSdkSession=${childStart?.hasPiSdkSession}`,
      evidence: "trace.jsonl",
    });
    ctx.checks.add({
      id: "bridge_released_before_parent_result",
      title: "（白盒辅助）父工具结果到达时子会话作用域已 stop",
      status:
        parentResult?.childSessionID === childSessionID &&
        parentResult?.childHasPiSdkSession === false,
      detail: `childSessionID=${parentResult?.childSessionID} childHasPiSdkSession=${parentResult?.childHasPiSdkSession}`,
      evidence: "trace.jsonl",
    });

    const childStarts = trace.filter(
      (record) =>
        record.event === "session_start" && record.runtime === childRuntime,
    );
    ctx.checks.info(
      "child_session_start_observation",
      "子会话 session_start 观测（宿主行为信息，不作断言）",
      childStarts.length === 0
        ? "本次观测到宿主 pi 不为 SDK 子会话发出 session_start；ZooKeeper 在 before_agent_start 内建立会话作用域，因此子会话作用域由父侧 driver stop"
        : `子会话收到 ${childStarts.length} 次 session_start（reasons=${JSON.stringify(childStarts.map((record) => record.reason))}）`,
    );
    // The child's assistant message never reaches the parent's RPC stream,
    // so the per-message equality does not apply here.
    assertNoExternalProvider(ctx, { oneToOne: false });
  },
};
