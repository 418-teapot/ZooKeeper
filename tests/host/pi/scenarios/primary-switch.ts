/**
 * Core scenario 9: primary switch through the real host.
 *
 * Typing a `/<agent>` command replaces the pi session: the fresh runtime's
 * bind-time events already resolve the target primary, and the previous
 * session shuts down.  The checks prove the replacement happened, the new
 * session's injected prompt belongs to the target, and switching back
 * restores the first primary — all resolved from explicit session state by
 * the real host.
 */

import { SESSION_START_REASONS } from "../harness/constants.js";
import {
  assertNoExternalProvider,
  type ScenarioDefinition,
  type TraceRecord,
} from "../harness/scenario-runtime.js";

/** Marker line of every composed agent prompt. */
const ROLE_MARKER = "你是";

/**
 * The `before_agent_start` record of one session.
 *
 * @param trace - Trace records of the run.
 * @param sessionID - Session id to read.
 * @returns The last record of that session, or undefined.
 */
function promptRecord(
  trace: readonly TraceRecord[],
  sessionID: string | null,
): TraceRecord | undefined {
  return trace.findLast(
    (record) =>
      record.event === "before_agent_start" &&
      record.sessionID === sessionID &&
      record.child !== true,
  );
}

export const primarySwitch: ScenarioDefinition = {
  id: "primary-switch",
  title: "真实宿主下的 /<agent> 主会话切换",
  risk: "切换后的新会话仍解析旧主 agent（提示词、工具与身份未重新绑定）",
  async run(ctx) {
    const initial = await ctx.pi.state();
    const initialID = initial.sessionId;
    const startup = ctx.pi
      .trace()
      .find(
        (record) =>
          record.event === "session_start" && record.reason === "startup",
      );
    const firstRuntime = startup?.runtime;

    // A plain turn on the starting session: the probe records the system
    // prompt ZooKeeper injected for it.
    await ctx.pi.prompt("E2E-SWITCH: 记录切换前的身份");
    const before = promptRecord(ctx.pi.trace(), initialID);
    ctx.checks.add({
      id: "switch_before_primary",
      title: "切换前的会话注入 dolphin 的提示词",
      status:
        typeof before?.systemPrompt === "string" &&
        before.systemPrompt.includes(`${ROLE_MARKER} dolphin`),
      detail: `systemPrompt=${JSON.stringify(before?.systemPrompt ?? "").slice(0, 200)}`,
      evidence: "trace.jsonl",
    });

    // `/mola` is pi's real command path: the handler replaces the session.
    const switched = await ctx.pi.prompt("/mola");
    const afterSwitch = await ctx.pi.state();
    ctx.checks.add({
      id: "switch_command_handled",
      title: "prompt /mola 触发主 agent 切换命令",
      status:
        switched.response.success === true &&
        switched.disposition === "handled",
      detail: `success=${switched.response.success} disposition=${switched.disposition}`,
      evidence: "rpc.jsonl",
    });
    const trace = ctx.pi.trace();
    const newStart = trace.findLast(
      (record) => record.event === "session_start" && record.reason === "new",
    );
    ctx.checks.add({
      id: "switch_replaced_session",
      title: "切换替换了会话：新会话 id、新扩展 runtime",
      status:
        afterSwitch.sessionId !== null &&
        afterSwitch.sessionId !== initialID &&
        SESSION_START_REASONS.includes(
          (newStart?.reason ??
            "startup") as (typeof SESSION_START_REASONS)[number],
        ) &&
        typeof newStart?.runtime === "string" &&
        newStart.runtime !== firstRuntime,
      detail: `initial=${initialID} current=${afterSwitch.sessionId} reason=${newStart?.reason} runtime=${newStart?.runtime}`,
      evidence: "trace.jsonl",
    });

    // The replacement session's own turn: its prompt must be mola's, which
    // proves the switch target reached the new runtime's bind-time handlers.
    await ctx.pi.prompt("E2E-SWITCH: 记录切换后的身份");
    const after = promptRecord(ctx.pi.trace(), afterSwitch.sessionId);
    ctx.checks.add({
      id: "switch_target_primary",
      title: "切换后的会话注入 mola 的提示词",
      status:
        typeof after?.systemPrompt === "string" &&
        after.systemPrompt.includes(`${ROLE_MARKER} mola`) &&
        !after.systemPrompt.includes(`${ROLE_MARKER} dolphin`),
      detail: `systemPrompt=${JSON.stringify(after?.systemPrompt ?? "").slice(0, 200)}`,
      evidence: "trace.jsonl",
    });

    // Switching back restores the first primary in yet another session.
    await ctx.pi.prompt("/dolphin");
    const back = await ctx.pi.state();
    await ctx.pi.prompt("E2E-SWITCH: 记录切回后的身份");
    const backRecord = promptRecord(ctx.pi.trace(), back.sessionId);
    ctx.checks.add({
      id: "switch_back_primary",
      title: "切回 dolphin 后又注入 dolphin 的提示词",
      status:
        back.sessionId !== null &&
        back.sessionId !== afterSwitch.sessionId &&
        typeof backRecord?.systemPrompt === "string" &&
        backRecord.systemPrompt.includes(`${ROLE_MARKER} dolphin`),
      detail: `session=${back.sessionId} systemPrompt=${JSON.stringify(backRecord?.systemPrompt ?? "").slice(0, 200)}`,
      evidence: "trace.jsonl",
    });

    assertNoExternalProvider(ctx);
  },
};
