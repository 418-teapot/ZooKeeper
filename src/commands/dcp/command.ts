/**
 * `/dcp` command handling logic (self-contained command unit).
 *
 * Provides the `/dcp context|compress` handler and the
 * synthetic-message injection used to surface results to the user.
 * The host dependency is typed against the host-agnostic `ToolHost`
 * port instead of any host SDK type, so the handler stays
 * framework-agnostic: `fetchHistory` returns lens messages directly,
 * `notify` posts the ignored noReply chat message, and the report is
 * produced by the lens-based `computeContextReportLens` (placeholder
 * signal prune detection and the compaction boundary).  Command-failure
 * notification lives in `src/commands/notify.ts` and is shared with
 * the `/go` command unit.
 *
 * State comes from the plugin instance's context runtime: the command
 * reads the session state and the published round view through the same
 * runtime the hook and the tools use, and the fold/measure/release layers
 * drive the report.  Pruned tool calls are recognized by their placeholder
 * text, and storage-borne originals are overlaid with the state's effective
 * marks (`materializeEffectiveMarks`) so the report counts the
 * model-visible `input + placeholder`.  A missing or lapsed permit reads no
 * history, sends no notification and changes no state.
 *
 * @module
 */

import type { ContextPruningConfig } from "../../core/config-types.js";
import { formatContextReport } from "../../core/context/context-report.js";
import {
  computeContextReportLens,
  countFoldedMessages,
} from "../../core/context/context-report-lens.js";
import { fold } from "../../core/context/fold.js";
import type { Projection } from "../../core/context/lens.js";
import {
  materializeEffectiveMarks,
  pendingCount,
  pendingTokens,
  reclaimedTokens,
} from "../../core/context/release.js";
import type { ContextRuntime } from "../../core/context/runtime.js";
import type { WorkPermit } from "../../core/lifecycle/index.js";
import type { ToolHost } from "../../core/ports/tool-host.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Read the transcript one `/dcp` report pass runs over.
 *
 * Two sources, in priority order:
 *
 * 1. The host's own history read, when it wires one.  A host wires
 *    `fetchHistory` only when its read is provably the same source the
 *    context transform projects, so the ordinals agree — and a live read
 *    is fresher than a cached view for a usage report.
 * 2. Otherwise the round view published by the last transform (see
 *    `core/context/round-view.ts`) — the projection the model actually
 *    holds, which is the only same-source read a host without a history
 *    channel can offer.
 *
 * @param toolHost - Host tool services (optional history read / notify).
 * @param runtime - The plugin instance's context records.
 * @param sessionID - The current session identifier.
 * @returns The projection snapshot to report over.
 * @throws Error when neither source is available.
 */
async function readReportHistory(
  toolHost: ToolHost | null | undefined,
  runtime: ContextRuntime,
  sessionID: string,
): Promise<Projection> {
  if (toolHost?.fetchHistory) {
    return toolHost.fetchHistory(sessionID);
  }
  const roundView = runtime.roundView(sessionID);
  if (roundView !== undefined) {
    return roundView.projection;
  }
  throw new Error(
    "无法获取会话消息：宿主未提供历史读取，且上下文变换尚未发布当轮视图。",
  );
}

/**
 * Handle the `/dcp` command.
 *
 * - `""` or `"context"` → fetches session messages, computes a context
 *   report, and injects it as an ignored (LLM-invisible) message.
 * - `"compress"` → arms a one-shot in-memory trigger; the next transform
 *   injects a synthetic user message driving the model to call the
 *   `compress` tool.
 * - Any other argument → shows a short help listing available subcommands.
 *
 * @param runtime - The plugin instance's context records.
 * @param permit - The permit the host admitted the command under, or
 *   `undefined` when it holds none.
 * @param toolHost - Host tool services (fetchHistory / notify).
 * @param sessionID - The current session identifier.
 * @param args - The raw arguments string after `/dcp`.
 * @param contextConfig - Context pruning config (needed for the
 *   compress gate).
 * @param hasCompressTool - Whether the `compress` tool is registered in
 *   the active mode profile.  `/dcp compress` refuses to arm the trigger
 *   when the tool is not registered.
 * @throws Error when the history API is unavailable.
 */
export async function handleDcpCommand(
  runtime: ContextRuntime,
  permit: WorkPermit | undefined,
  toolHost: ToolHost | null | undefined,
  sessionID: string,
  args: string,
  contextConfig: ContextPruningConfig,
  hasCompressTool = false,
): Promise<void> {
  // A missing or lapsed permit means the session stopped or the call was
  // cancelled: do nothing at all, before any host read or notification.
  if (permit === undefined || !permit.isActive()) return;

  const trimmed = args.trim();

  // ── Compress subcommand ──────────────────────────────────────────
  if (trimmed === "compress") {
    await handleCompressSubcommand(
      runtime,
      permit,
      toolHost,
      sessionID,
      contextConfig,
      hasCompressTool,
    );
    return;
  }

  // ── Unknown subcommand → show help ────────────────────────────────
  if (trimmed !== "" && trimmed !== "context") {
    const help = [
      "━━  用法 ━━",
      "",
      "/dcp context    — 显示上下文用量与缓存命中率",
      "/dcp            — 同上（默认）",
      "/dcp compress   — 在下一轮触发模型驱动的历史压缩",
    ].join("\n");

    await toolHost?.notify(sessionID, help);
    return;
  }

  // ── Fetch messages ────────────────────────────────────────────────
  // `readReportHistory` supplies the projection this pass reports over
  // (host read when the host provably shares the transform's source,
  // otherwise the published round view); its failures propagate
  // verbatim.
  const snapshot = await readReportHistory(toolHost, runtime, sessionID);
  const view = snapshot.messages;

  // ── Read state from the runtime ──────────────────────────────────
  // The runtime (shared with the hook and the tools) holds the live
  // in-memory state, so the tool category excludes pruned tools and the
  // unified "回收" stat line reflects the current in-process cumulative
  // values (avoids the one-turn lag of reading from disk when the batch
  // pipeline modifies state between transforms).  The read runs under the
  // command's permit and changes nothing.
  let computed:
    | {
        report: ReturnType<typeof computeContextReportLens>;
        formatted: string;
      }
    | undefined;
  try {
    computed = runtime.read(permit, (state) => {
      // Dual-scope message counts: the folded view versus storage.
      const { items } = fold(snapshot, state);
      const counts = countFoldedMessages(items, view);
      // OpenCode's `fetchHistory` returns the stored original text, so
      // overlay the state's effective marks before reporting: a pruned
      // tool output then counts as `input + placeholder`, what the model
      // sees, instead of the stored original.
      const report = computeContextReportLens(
        materializeEffectiveMarks(view, state),
      );
      return {
        report,
        formatted: formatContextReport(report, {
          prunedTokens: reclaimedTokens(state),
          pendingCount: pendingCount(state),
          pendingTokens: pendingTokens(state),
          state,
          foldedMessageCount: counts.foldedMessageCount,
          storageMessageCount: counts.storageMessageCount,
        }),
      };
    });
  } catch {
    // Defensive: an unreadable store must not fail the command.
    computed = undefined;
  }
  if (computed === undefined) {
    await toolHost?.notify(
      sessionID,
      "上下文报告未生成：会话已停止或本次调用已取消，会话状态未改动。",
    );
    return;
  }

  const { report, formatted } = computed;
  log.info({
    hook: "context-command",
    event: "report_computed",
    sessionId: sessionID,
    total: report.total,
    exact: report.exact,
    heuristic: report.heuristic,
    messageCount: report.messageCount,
  });

  // ── Inject as ignored message (chat-visible, LLM-invisible) ───────
  // `notify` is best-effort by contract (never rejects, failures are
  // logged and swallowed by the host), so no try/catch here.
  await toolHost?.notify(sessionID, formatted);
}

// ---------------------------------------------------------------------------
// Compress subcommand handler
// ---------------------------------------------------------------------------

/**
 * Handle the `/dcp compress` subcommand.
 *
 * The command drives compression through the model rather than running a
 * mechanical pipeline: it arms a per-session one-shot in-memory flag
 * (`state.pendingManualTrigger`), then the NEXT transform appends a
 * synthetic user message (`zoo-manual-compress`) that makes the model
 * call the `compress` tool — command and tool share a single path.
 *
 * 1. Checks the registration gate — the `compress` tool must be listed
 *    in the active mode profile's tools and the compress section must
 *    carry both token thresholds; otherwise it refuses with a notice.
 * 2. Sets `state.pendingManualTrigger = true` on the shared state
 *    (in-memory only, never persisted — same discipline as
 *    `pendingViewChange`; loss on restart is benign).
 * 3. Sends a single ignored notification telling the user the trigger
 *    will fire on the next turn.
 *
 * No message fetch, no blocks, no plan — the flag is consumed by the
 * context-pruning transform's manual-compress injection, which appends
 * a synthetic user command on the next turn.
 *
 * @param runtime - The plugin instance's context records.
 * @param permit - The permit the host admitted the command under, or
 *   `undefined` when it holds none.
 * @param toolHost - Host tool services (notify).
 * @param sessionID - The current session identifier.
 * @param contextConfig - The parsed context pruning config (needed for
 *   the compress gate).
 * @param hasCompressTool - Whether the `compress` tool is registered in
 *   the active mode profile.
 * @throws Error on API failures or invalid config.
 */
async function handleCompressSubcommand(
  runtime: ContextRuntime,
  permit: WorkPermit,
  toolHost: ToolHost | null | undefined,
  sessionID: string,
  contextConfig: ContextPruningConfig,
  hasCompressTool: boolean,
): Promise<void> {
  // ── Registration gate ────────────────────────────────────────────
  // The compress section must be strictly parsed AND the `compress`
  // tool must be listed in the active mode profile's tools.  Absent
  // section, an invalid section (config parse dropped it), or a profile
  // that does not register the tool all refuse (the config parse already
  // warned once for bad keys).
  const compressCfg = contextConfig.compress;
  if (
    !hasCompressTool ||
    compressCfg?.protectedTokens === undefined ||
    compressCfg?.thresholdTokens === undefined
  ) {
    const msg =
      "压缩功能未启用：compress 工具未在当前 mode profile 的 tools 中注册，或 [zoo.context.compress] 段缺少 threshold_tokens / protected_tokens。";
    await toolHost?.notify(sessionID, msg);
    return;
  }

  // ── Arm the one-shot manual trigger ─────────────────────────────
  // In-memory only: never persisted, never fetched.  The flag becomes
  // committed — and the user is told so — only while the command's permit
  // stays active.  The next transform consumes the flag and injects the
  // synthetic user command.
  const armed = await runtime.commit(permit, (state) => {
    state.pendingManualTrigger = true;
    return true;
  });
  // A lapsed permit committed nothing: report nothing either.
  if (armed === undefined) return;

  log.info({
    hook: "context-command",
    event: "compress_armed",
    sessionId: sessionID,
    trigger: "pendingManualTrigger",
  });

  // ── Notification ───────────────────────────────────────────────
  const notifyMsg =
    "已标记手动压缩：将在下一轮对话自动触发。届时会注入压缩指令，由模型调用 compress 工具执行。";

  // `notify` is best-effort by contract (never rejects, failures are
  // logged and swallowed by the host), so no try/catch here.
  await toolHost?.notify(sessionID, notifyMsg);
}
