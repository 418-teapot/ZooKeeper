/**
 * `/dcp` command handling logic (self-contained command unit).
 *
 * Provides the `/dcp context|sweep [N]|compress` handler and the
 * synthetic-message injection used to surface results to the user.
 * The client parameter is typed against `src/core/client/session.ts`
 * instead of any host SDK type, so the handler stays framework-agnostic.
 * Command-failure notification lives in `src/commands/notify.ts` and is
 * shared with the `/go` command unit.
 *
 * State comes from the new host-agnostic context core: the shared
 * process-wide session-state manager (`getContextStateManager`) supplies
 * the session state, the v1 adapter (`history`) maps the fetched
 * messages to lens messages, and the fold/measure/release layers drive
 * the report and the sweep.  Effective prune marks are projected back
 * to v1 tool call ids so the report's pruned-tool accounting keeps the
 * previous contract verbatim.
 *
 * @module
 */

import { history } from "../../adapters/opencode/history.js";
import {
  effectiveCallIds,
  foldedV1Messages,
} from "../../adapters/opencode/projection.js";
import {
  type ContextMessageEntry,
  computeContextReport,
  isMessageIgnored,
} from "../../adapters/opencode/types.js";
import type { SessionClient } from "../../core/client/session.js";
import type { ContextPruningConfig } from "../../core/config-types.js";
import {
  formatContextReport,
  formatTokens,
} from "../../core/context/context-report.js";
import { fold } from "../../core/context/fold.js";
import type { HostMessage } from "../../core/context/lens.js";
import { findLastUserOrdinal } from "../../core/context/lens.js";
import { netReclaimTokens } from "../../core/context/measure.js";
import { PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../../core/context/message-parts.js";
import {
  pendingCount,
  pendingTokens,
  reclaimedTokens,
} from "../../core/context/release.js";
import {
  getContextStateManager,
  getRuntimeFlaggedState,
  setPendingViewChange,
} from "../../core/context/runtime.js";
import {
  markKey,
  RECALL_MAX_CHARS,
  type SessionState,
} from "../../core/context/state.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One new pending mark written by the sweep selection. */
interface SweepWrite {
  /** Estimated reclaim tokens of the marked output. */
  contentTokens: number;
}

// ---------------------------------------------------------------------------
// Sweep selection
// ---------------------------------------------------------------------------

/**
 * Select tool-output regions to mark and write pending marks.
 *
 * Migrated from the previous `/dcp sweep` producer with its marks
 * semantics preserved: no-count mode marks every tool output after the
 * last non-hidden user message; numeric mode walks backward collecting
 * the N most recent tool outputs.  Positions already claimed by a mark
 * are skipped (first-write-wins).  Marks are written pending — the
 * caller arms `setPendingViewChange` so the next transform's release
 * flips them unconditionally, preserving the previous immediate-release
 * timing.
 *
 * @param state - The session state to write marks into.
 * @param view - The lens transcript of the session messages.
 * @param count - The sweep count; undefined selects the no-count mode.
 * @returns The number of marks written and their total reclaim tokens.
 */
function sweepToolRegions(
  state: SessionState,
  view: HostMessage[],
  count: number | undefined,
): SweepWrite[] {
  const writes: SweepWrite[] = [];
  const now = Date.now();

  const addMark = (ordinal: number, regionIndex: number, output: string) => {
    const key = markKey(ordinal, regionIndex);
    if (state.marks.has(key)) return;
    const contentTokens = netReclaimTokens(
      output,
      PRUNED_TOOL_OUTPUT_REPLACEMENT,
    );
    state.marks.set(key, {
      anchorOrdinal: ordinal,
      regionIndex,
      content: output.slice(0, RECALL_MAX_CHARS),
      contentTokens,
      effective: false,
      markedAt: now,
    });
    writes.push({ contentTokens });
  };

  if (count === undefined) {
    // No-count mode: mark all tool outputs after the last user message.
    const lastUserOrdinal = findLastUserOrdinal(view);
    if (lastUserOrdinal < 0) return writes;
    for (let ordinal = lastUserOrdinal + 1; ordinal < view.length; ordinal++) {
      const msg = view[ordinal];
      if (!msg?.regions) continue;
      for (
        let regionIndex = 0;
        regionIndex < msg.regions.length;
        regionIndex++
      ) {
        const region = msg.regions[regionIndex];
        if (region?.kind !== "tool-output") continue;
        addMark(ordinal, regionIndex, region.get());
      }
    }
  } else {
    // Numeric mode: walk backward until N tool outputs are collected.
    for (let ordinal = view.length - 1; ordinal >= 0; ordinal--) {
      if (writes.length >= count) break;
      const msg = view[ordinal];
      if (!msg?.regions) continue;
      for (
        let regionIndex = msg.regions.length - 1;
        regionIndex >= 0 && writes.length < count;
        regionIndex--
      ) {
        const region = msg.regions[regionIndex];
        if (region?.kind !== "tool-output") continue;
        addMark(ordinal, regionIndex, region.get());
      }
    }
  }

  return writes;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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
 * @param client - OpenCode client providing session APIs.
 * @param sessionID - The current session identifier.
 * @param args - The raw arguments string after `/dcp`.
 * @param contextConfig - Optional context pruning config (needed for
 *   the compress gate).  When absent, compress is skipped.
 * @param hasCompressTool - Whether the `compress` tool is registered in
 *   the active mode profile.  `/dcp compress` refuses to arm the trigger
 *   when the tool is not registered.
 * @throws Error when the messages API or prompt API is unavailable.
 */
export async function handleDcpCommand(
  client: SessionClient | null | undefined,
  sessionID: string,
  args: string,
  contextConfig?: ContextPruningConfig,
  hasCompressTool = false,
): Promise<void> {
  const trimmed = args.trim();

  // ── Sweep subcommand ──────────────────────────────────────────────
  if (trimmed === "sweep" || trimmed.startsWith("sweep ")) {
    await handleSweepSubcommand(client, sessionID, trimmed);
    return;
  }

  // ── Compress subcommand ──────────────────────────────────────────
  if (trimmed === "compress") {
    await handleCompressSubcommand(
      client,
      sessionID,
      contextConfig ?? { dedup: {}, purgeErrors: {} },
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
      "/dcp sweep      — 标记所有工具输出以在下一轮回收",
      "/dcp sweep N    — 标记最近 N 个工具输出",
      "/dcp compress   — 在下一轮触发模型驱动的历史压缩",
    ].join("\n");

    if (client?.session?.prompt) {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: help, ignored: true }],
        },
      });
    }
    return;
  }

  // ── Fetch messages ────────────────────────────────────────────────
  if (!client?.session?.messages) {
    throw new Error("无法获取会话消息：会话消息 API 不可用");
  }

  let rawMessages: unknown;
  try {
    const res = await client.session.messages({
      path: { id: sessionID },
    });
    rawMessages = res;
  } catch (err) {
    log(
      "context-command",
      "fetch_messages_failed",
      sessionID,
      undefined,
      "error",
      { error: String(err) },
    );
    throw new Error(
      `无法获取会话消息：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!rawMessages) {
    throw new Error("会话消息 API 返回空结果");
  }

  // Defensive: some SDKs wrap in { data: ..., error: ... }
  const rawObj = rawMessages as {
    data?: unknown;
    error?: { message?: string };
  };
  if (rawObj.error) {
    const msg = rawObj.error.message ?? String(rawObj.error);
    throw new Error(`获取会话消息失败：${msg}`);
  }
  const messages: ContextMessageEntry[] = (rawObj.data ??
    rawMessages) as ContextMessageEntry[];

  if (!Array.isArray(messages)) {
    throw new Error("会话消息格式异常：期望数组");
  }

  // ── Read state from the shared manager ────────────────────────────
  // The process-wide manager (shared with the hook and the tools) holds
  // the live in-memory state, so the tool category excludes pruned tools
  // and the unified "回收" stat line reflects the current in-process
  // cumulative values (avoids the one-turn lag of reading from disk when
  // the batch pipeline modifies state between transforms).
  const manager = getContextStateManager();
  let state: SessionState | undefined;
  let prunedCallIDs: Set<string> | undefined;
  let totalEff = 0;
  let curPendingCount = 0;
  let curPendingTokens = 0;
  try {
    state = manager.get(sessionID);
    prunedCallIDs = effectiveCallIds(messages, state);
    totalEff = reclaimedTokens(state);
    curPendingCount = pendingCount(state);
    curPendingTokens = pendingTokens(state);
  } catch {
    // Defensive: I/O failure is non-fatal — tools fully counted.
    prunedCallIDs = undefined;
  }

  // ── Compute dual-scope message counts (folded view vs storage) ──────
  let foldedCount: number | undefined;
  let storageCount: number | undefined;
  try {
    if (state) {
      const view = history(messages);
      const { items } = fold(view, state);
      const folded = foldedV1Messages(items, messages, state);
      foldedCount =
        folded?.filter((m) => !isMessageIgnored(m)).length ??
        messages.filter((m) => !isMessageIgnored(m)).length;
      storageCount = messages.filter((m) => !isMessageIgnored(m)).length;
    }
  } catch {
    // Defensive: error is non-fatal, fall back to single-count line.
  }

  const report = computeContextReport(messages, prunedCallIDs);
  const formatted = formatContextReport(report, {
    prunedTokens: totalEff,
    pendingCount: curPendingCount,
    pendingTokens: curPendingTokens,
    state,
    foldedMessageCount: foldedCount,
    storageMessageCount: storageCount,
  });

  log("context-command", "report_computed", sessionID, undefined, "info", {
    total: report.total,
    exact: report.exact,
    heuristic: report.heuristic,
    messageCount: report.messageCount,
  });

  // ── Inject as ignored message (chat-visible, LLM-invisible) ───────
  if (client?.session?.prompt) {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: formatted, ignored: true }],
        },
      });
    } catch (err) {
      log(
        "context-command",
        "prompt_inject_failed",
        sessionID,
        undefined,
        "warn",
        { error: String(err) },
      );
      // Non-fatal — the report was already computed, inform the user
      throw new Error(
        `报告已生成但注入聊天失败（不影响使用）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Sweep subcommand handler
// ---------------------------------------------------------------------------

/**
 * Parse the numeric argument from a `/dcp sweep N` command.
 *
 * @param trimmed - The full arguments string (e.g. `"sweep 5"`).
 * @returns The count, or `undefined` for no-arg (`"sweep"`).
 */
export function parseSweepCount(trimmed: string): number | undefined {
  if (trimmed === "sweep") return undefined;
  const rest = trimmed.slice(5).trim(); // after "sweep"
  const n = Number(rest);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    throw new Error("用法：/dcp sweep [N]，N 为要标记的工具输出数量（正整数）");
  }
  return n;
}

/**
 * Handle the `/dcp sweep` and `/dcp sweep N` subcommands.
 *
 * 1. Parses the count argument (optional).
 * 2. Fetches session messages and maps them to the lens transcript.
 * 3. Selects tool-output regions for marking (the previous sweep semantics).
 * 4. Writes pending marks into the shared session state, arms the
 *    pending-view-change flag (the next transform's release flips them
 *    unconditionally — the immediate-release timing the previous sweep had
 *    with effective marks), and persists once.
 * 5. Injects an ignored message reporting how many tools were marked
 *    and the estimated token reclaim.
 * 6. Returns normally — the OpenCode adapter throws the unified
 *    `COMMAND_HANDLED` sentinel afterwards to short-circuit the flow.
 *
 * @param client - OpenCode client providing session APIs.
 * @param sessionID - The current session identifier.
 * @param trimmed - The full arguments string (e.g. `"sweep"`, `"sweep 3"`).
 * @throws Error on API failures or invalid arguments.
 */
async function handleSweepSubcommand(
  client: SessionClient | null | undefined,
  sessionID: string,
  trimmed: string,
): Promise<void> {
  const count = parseSweepCount(trimmed);

  // ── Fetch messages ──────────────────────────────────────────────
  if (!client?.session?.messages) {
    throw new Error("无法获取会话消息：会话消息 API 不可用");
  }

  let rawMessages: unknown;
  try {
    const res = await client.session.messages({
      path: { id: sessionID },
    });
    rawMessages = res;
  } catch (err) {
    log(
      "context-command",
      "sweep_fetch_failed",
      sessionID,
      undefined,
      "error",
      {
        error: String(err),
      },
    );
    throw new Error(
      `无法获取会话消息：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!rawMessages) {
    throw new Error("会话消息 API 返回空结果");
  }

  const rawObj = rawMessages as {
    data?: unknown;
    error?: { message?: string };
  };
  if (rawObj.error) {
    const msg = rawObj.error.message ?? String(rawObj.error);
    throw new Error(`获取会话消息失败：${msg}`);
  }
  const messages = (rawObj.data ?? rawMessages) as ContextMessageEntry[];

  if (!Array.isArray(messages)) {
    throw new Error("会话消息格式异常：期望数组");
  }

  // ── Select regions and write pending marks ───────────────────────
  const manager = getContextStateManager();
  const state = manager.get(sessionID);
  const view = history(messages);
  const writes = sweepToolRegions(state, view, count);

  if (writes.length === 0) {
    // ── Nothing to mark ───────────────────────────────────────────
    const msg = "没有找到可标记的工具输出";
    if (client?.session?.prompt) {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: msg, ignored: true }],
        },
      });
    }
    return;
  }

  // Pending marks flip on the next transform's release.  The
  // pending-view-change flag bypasses the release gate so the marks
  // take effect in the same turn the view rolls over — the previous
  // sweep wrote immediately-effective marks, which the next prune pass
  // applied; the two behaviours coincide in timing.
  setPendingViewChange(sessionID);
  manager.save(sessionID);

  const totalEstimate = writes.reduce((sum, m) => sum + m.contentTokens, 0);

  log("context-command", "sweep_marked", sessionID, undefined, "info", {
    markedCount: writes.length,
    totalEstimatedTokens: totalEstimate,
  });

  // ── Inject result message ───────────────────────────────────────
  const reportMsg = [
    `已标记 ${writes.length} 个工具输出，预计可回收 ${formatTokens(totalEstimate)} tokens`,
    "这些工具的输出将在下一轮 LLM 调用中被替换为占位文本。",
  ].join("\n");

  if (client?.session?.prompt) {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: reportMsg, ignored: true }],
        },
      });
    } catch (err) {
      log(
        "context-command",
        "sweep_prompt_inject_failed",
        sessionID,
        undefined,
        "warn",
        { error: String(err) },
      );
      throw new Error(
        `标记已完成但通知失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return;
}

// ---------------------------------------------------------------------------
// Compress subcommand handler
// ---------------------------------------------------------------------------

/**
 * Handle the `/dcp compress` subcommand.
 *
 * The command no longer runs a mechanical compression pipeline.  It arms
 * a per-session one-shot in-memory flag (`state.pendingManualTrigger`),
 * then the NEXT transform appends a synthetic user message
 * (`zoo-manual-compress`) that drives the model to call the `compress`
 * tool — command and tool now share a single model-driven path.
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
 * transform's injection phase (context-pruning hook, Phase 6b).
 *
 * @param client - OpenCode client providing session APIs.
 * @param sessionID - The current session identifier.
 * @param contextConfig - The parsed context pruning config (needed for
 *   the compress gate).
 * @param hasCompressTool - Whether the `compress` tool is registered in
 *   the active mode profile.
 * @throws Error on API failures or invalid config.
 */
async function handleCompressSubcommand(
  client: SessionClient | null | undefined,
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
    if (client?.session?.prompt) {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: msg, ignored: true }],
        },
      });
    }
    return;
  }

  // ── Arm the one-shot manual trigger ─────────────────────────────
  // In-memory only: never persisted, never fetched.  The next transform
  // consumes the flag and injects the synthetic user command.
  const state = getRuntimeFlaggedState(sessionID);
  state.pendingManualTrigger = true;

  log("context-command", "compress_armed", sessionID, undefined, "info", {
    trigger: "pendingManualTrigger",
  });

  // ── Notification ───────────────────────────────────────────────
  const notifyMsg =
    "已标记手动压缩：将在下一轮对话自动触发。届时会注入压缩指令，由模型调用 compress 工具执行。";

  if (client?.session?.prompt) {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text", text: notifyMsg, ignored: true }],
        },
      });
    } catch (err) {
      log(
        "context-command",
        "compress_notify_failed",
        sessionID,
        undefined,
        "warn",
        { error: String(err) },
      );
      throw new Error(
        `压缩触发已标记但通知失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
