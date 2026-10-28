/**
 * Core scenario: the real `compress` and `decompress` tools round trip
 * through one live session, and the restore is visible in the next model
 * request.
 *
 * The model decides both calls itself (the deterministic provider reads the
 * block label out of the request it receives), so the tool arguments are the
 * ones a real model would produce.  The checks read the RPC tool execution
 * stream and the request the provider received — the block label before the
 * restore, the two original messages after it — and never the pipeline's
 * internal state.
 */

import {
  CONTEXT_BLOCK_ID,
  CONTEXT_BLOCK_LABEL,
  CONTEXT_BLOCK_MESSAGES,
  CONTEXT_COMPRESS_PROMPT,
  CONTEXT_DECOMPRESS_PROMPT,
  CONTEXT_TARGET_TAGS,
} from "../harness/constants.js";
import {
  assertNoExternalProvider,
  providerRequests,
  refsAreDense,
  type ScenarioDefinition,
  type ToolExecution,
  taggedIndices,
  viewHeaders,
} from "../harness/scenario-runtime.js";
import { primeContextHistory } from "./context-history.js";

/**
 * Collect one tool's executions in a step.
 *
 * @param step - Prompt step to inspect.
 * @param tool - Tool name.
 * @returns The starts, the results, and whether exactly one call ran cleanly.
 */
function toolExecutions(
  step: { toolStarts: ToolExecution[]; toolResults: ToolExecution[] },
  tool: string,
): { starts: ToolExecution[]; results: ToolExecution[]; ok: boolean } {
  const starts = step.toolStarts.filter((call) => call.tool === tool);
  const results = step.toolResults.filter((call) => call.tool === tool);
  const ok =
    starts.length === 1 &&
    results.length === 1 &&
    starts[0]?.toolCallId !== undefined &&
    starts[0].toolCallId === results[0]?.toolCallId &&
    results[0]?.isError === false;
  return { starts, results, ok };
}

export const compressionTools: ScenarioDefinition = {
  id: "compression-tools",
  title: "真实 compress→decompress 工具往返与原文恢复",
  risk: "压缩/解压工具未接通真实宿主，或恢复效果没有进入下一轮模型输入",
  async run(ctx) {
    await primeContextHistory(ctx);

    const compressStep = await ctx.pi.prompt(CONTEXT_COMPRESS_PROMPT);
    const compress = toolExecutions(compressStep, "compress");
    const compressTraceCalls = ctx.pi
      .trace()
      .filter(
        (record) => record.event === "tool_call" && record.tool === "compress",
      );
    ctx.checks.add({
      id: "compress_executed_once",
      title: "真实 compress 工具调用只执行一次且无错误",
      status: compress.ok && compressTraceCalls.length === 1,
      detail: `starts=${JSON.stringify(compress.starts.map((call) => call.toolCallId))} results=${JSON.stringify(compress.results.map((call) => call.toolCallId))} traceCalls=${compressTraceCalls.length}`,
      evidence: ["rpc.jsonl", "trace.jsonl"],
    });

    const compressText = compress.results[0]?.text ?? "";
    ctx.checks.add({
      id: "compress_result_contract",
      title: "compress 结果按契约报告块编号与压缩消息数",
      status:
        compressText.includes(`压缩块 ${CONTEXT_BLOCK_ID}`) &&
        compressText.includes(`${CONTEXT_BLOCK_MESSAGES} 条消息`) &&
        compressText.includes("约回收"),
      detail: `text=${JSON.stringify(compressText)}`,
      evidence: "rpc.jsonl",
    });

    const entries = await ctx.pi.entriesJson();
    ctx.checks.add({
      id: "compress_notice_persisted",
      title: "压缩通知写入会话条目，用户可见",
      status: entries.includes(
        `上下文压缩：已压缩 ${CONTEXT_BLOCK_MESSAGES} 条消息为压缩块 ${CONTEXT_BLOCK_ID}`,
      ),
      detail: `noticeFound=${entries.includes("上下文压缩：")} entries=${entries.length}chars`,
      evidence: "rpc.jsonl",
    });

    const decompressStep = await ctx.pi.prompt(CONTEXT_DECOMPRESS_PROMPT);
    const requests = providerRequests(ctx.pi);
    const decompressAt = requests.findIndex(
      (request) => request.decision === "tool:decompress",
    );
    const blockRequest = requests[decompressAt];
    ctx.checks.add({
      id: "block_visible_before_restore",
      title: "恢复前的模型请求以块标签替代被压缩原文",
      status:
        blockRequest !== undefined &&
        viewHeaders(blockRequest.view).length === 1 &&
        viewHeaders(blockRequest.view)[0] === CONTEXT_BLOCK_LABEL &&
        CONTEXT_TARGET_TAGS.every(
          (tag) => taggedIndices(blockRequest.view, tag).length === 0,
        ),
      detail:
        blockRequest === undefined
          ? "未观察到发起 decompress 的模型请求"
          : `headers=${JSON.stringify(viewHeaders(blockRequest.view))} hits=${JSON.stringify(CONTEXT_TARGET_TAGS.map((tag) => taggedIndices(blockRequest.view, tag)))}`,
      evidence: "trace.jsonl",
    });
    const decompress = toolExecutions(decompressStep, "decompress");
    ctx.checks.add({
      id: "decompress_executed_once",
      title: "真实 decompress 工具按观察到的块编号执行一次且无错误",
      status:
        decompress.ok &&
        decompress.starts[0]?.args.blockId === CONTEXT_BLOCK_ID,
      detail: `starts=${JSON.stringify(decompress.starts.map((call) => call.args.blockId))} results=${JSON.stringify(decompress.results.map((call) => call.toolCallId))}`,
      evidence: ["rpc.jsonl", "trace.jsonl"],
    });

    const decompressText = decompress.results[0]?.text ?? "";
    ctx.checks.add({
      id: "decompress_result_contract",
      title: "decompress 结果按契约报告恢复消息数与下一轮生效",
      status:
        decompressText.includes(
          `已恢复压缩块 ${CONTEXT_BLOCK_ID} 的 ${CONTEXT_BLOCK_MESSAGES} 条原始消息`,
        ) && decompressText.includes("下一轮上下文生效"),
      detail: `text=${JSON.stringify(decompressText)}`,
      evidence: "rpc.jsonl",
    });

    const restoreRequest = requests[decompressAt + 1];
    const restoreHits =
      restoreRequest === undefined
        ? CONTEXT_TARGET_TAGS.map(() => [] as number[])
        : CONTEXT_TARGET_TAGS.map((tag) =>
            taggedIndices(restoreRequest.view, tag),
          );
    ctx.checks.add({
      id: "restore_in_model_input",
      title: "恢复后的模型请求重新带上两条原文且不再有块标签",
      status:
        restoreRequest !== undefined &&
        restoreHits.every((hits) => hits.length === 1) &&
        restoreHits[0]?.[0] !== restoreHits[1]?.[0] &&
        viewHeaders(restoreRequest.view).length === 0 &&
        refsAreDense(restoreRequest.view),
      detail:
        restoreRequest === undefined
          ? "未观察到恢复后的模型请求"
          : `hits=${JSON.stringify(restoreHits)} headers=${JSON.stringify(viewHeaders(restoreRequest.view))} messages=${restoreRequest.view.length}`,
      evidence: "trace.jsonl",
    });

    assertNoExternalProvider(ctx);
  },
};
