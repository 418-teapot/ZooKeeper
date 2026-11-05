/**
 * Core scenario 10: ask-tool visibility on a real host without a dialog.
 *
 * `pi --mode rpc` owns no terminal dialog, so the session yields no question
 * channel: the ask tool stays registered but must never be declared to the
 * model.  The probe records both faces of the runtime — every registered
 * tool and the active set — and the checks read them from one real turn:
 * `ask` is registered, the active set is non-empty and holds a known
 * ZooKeeper tool, and `ask` is absent from it.  The non-empty precondition
 * is what keeps an unreadable active set from passing as "ask hidden".
 */

import {
  REQUIRED_TOOLS,
  TOOL_VISIBILITY_PROMPT,
} from "../harness/constants.js";
import {
  type ScenarioDefinition,
  waitForTrace,
} from "../harness/scenario-runtime.js";

/** Tool the model must not be offered when the session cannot ask. */
const ASK_TOOL = "ask";

export const askVisibility: ScenarioDefinition = {
  id: "ask-visibility",
  title: "真实 RPC 宿主下 ask 工具已注册但不激活",
  risk: "无提问通道的宿主把 ask 暴露给模型，或工具可见性集合读取失败被误判为已隐藏",
  async run(ctx) {
    // One real turn: the probe reads the runtime state after ZooKeeper's own
    // `before_agent_start` handler applied this session's active tool set.
    await ctx.pi.prompt(TOOL_VISIBILITY_PROMPT);
    const turn = await waitForTrace(
      ctx.pi,
      (record) =>
        record.event === "before_agent_start" &&
        record.child !== true &&
        typeof record.prompt === "string" &&
        record.prompt.includes(TOOL_VISIBILITY_PROMPT),
    );
    const registered: string[] = Array.isArray(turn?.toolNames)
      ? turn.toolNames
      : [];
    const active: string[] = Array.isArray(turn?.activeToolNames)
      ? turn.activeToolNames
      : [];

    ctx.checks.add({
      id: "ask_registered",
      title: "真实宿主注册了 ask 工具（getAllTools 视图）",
      status: turn !== undefined && registered.includes(ASK_TOOL),
      detail:
        turn === undefined
          ? "未观察到本轮 before_agent_start"
          : `toolCount=${registered.length} askRegistered=${registered.includes(ASK_TOOL)}`,
      evidence: "trace.jsonl",
    });

    ctx.checks.add({
      id: "ask_inactive",
      title: "RPC 无提问通道：ask 不在模型可见的工具集内",
      status:
        active.length > 0 &&
        REQUIRED_TOOLS.every((tool) => active.includes(tool)) &&
        active.every((tool) => registered.includes(tool)) &&
        !active.includes(ASK_TOOL),
      detail: `active=${JSON.stringify(active)} askActive=${active.includes(ASK_TOOL)}`,
      evidence: "trace.jsonl",
    });
  },
};
