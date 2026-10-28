/**
 * Core scenario: the real `context` event runs through the production
 * pruning pipeline and its folded view is what the model request carries.
 *
 * The observable boundary is the request the deterministic provider
 * receives: the pipeline's `[mN] ` line refs, the `[Block bN · K 条]` label
 * and the model-written summary body are read back from it, and the covered
 * originals must be gone from the same request.  No probe-only marker can
 * satisfy these checks — the tags are user text that the pipeline either
 * folds away or keeps repeating.
 *
 * The fold itself is created by the real `compress` tool, so the block the
 * assertions see was written by the shipped tool through the round view the
 * transform published.
 */

import {
  CONTEXT_BLOCK_ID,
  CONTEXT_BLOCK_LABEL,
  CONTEXT_BLOCK_MESSAGES,
  CONTEXT_COMPRESS_PROMPT,
  CONTEXT_SUMMARY_TAG,
  CONTEXT_TARGET_TAGS,
} from "../harness/constants.js";
import {
  assertNoExternalProvider,
  providerRequests,
  refsAreDense,
  type ScenarioDefinition,
  taggedIndices,
  viewHeaders,
  viewRefs,
} from "../harness/scenario-runtime.js";
import { primeContextHistory } from "./context-history.js";

export const contextPipeline: ScenarioDefinition = {
  id: "context-pipeline",
  title: "真实 context 事件经生产剪枝流水线折叠模型输入",
  risk: "宿主 context 事件未接线到生产剪枝流水线，或折叠结果没有进入真实模型请求",
  async run(ctx) {
    await primeContextHistory(ctx);
    const compressStep = await ctx.pi.prompt(CONTEXT_COMPRESS_PROMPT);
    const requests = providerRequests(ctx.pi);
    const baselineAt = requests.findIndex(
      (request) => request.decision === "tool:compress",
    );
    const baseline = baselineAt < 0 ? undefined : requests[baselineAt];

    ctx.checks.add({
      id: "numbered_view",
      title: "生产剪枝流水线在真实模型请求上编号了整轮视图",
      status: baseline !== undefined && refsAreDense(baseline.view),
      detail:
        baseline === undefined
          ? "未观察到发起 compress 的模型请求"
          : `messages=${baseline.view.length} refs=${JSON.stringify(viewRefs(baseline.view))}`,
      evidence: "trace.jsonl",
    });

    const taggedBefore =
      baseline === undefined
        ? CONTEXT_TARGET_TAGS.map(() => [] as number[])
        : CONTEXT_TARGET_TAGS.map((tag) => taggedIndices(baseline.view, tag));
    ctx.checks.add({
      id: "targets_before_fold",
      title: "压缩前的模型请求完整包含两条目标原文（各占一条独立消息）",
      status:
        taggedBefore.every((hits) => hits.length === 1) &&
        taggedBefore[0]?.[0] !== taggedBefore[1]?.[0] &&
        baseline !== undefined &&
        viewHeaders(baseline.view).length === 0,
      detail:
        baseline === undefined
          ? "未观察到发起 compress 的模型请求"
          : `hits=${JSON.stringify(taggedBefore)} headers=${JSON.stringify(viewHeaders(baseline.view))}`,
      evidence: "trace.jsonl",
    });

    const compressResults = compressStep.toolResults.filter(
      (call) => call.tool === "compress",
    );
    const compressResult = compressResults[0];
    ctx.checks.add({
      id: "compress_created_block",
      title: "真实 compress 工具调用成功并创建目标压缩块",
      status:
        compressResults.length === 1 &&
        compressResult?.isError === false &&
        (compressResult?.text ?? "").includes(`压缩块 ${CONTEXT_BLOCK_ID}`) &&
        (compressResult?.text ?? "").includes(
          `${CONTEXT_BLOCK_MESSAGES} 条消息`,
        ),
      detail: `results=${compressResults.length} error=${JSON.stringify(compressResults.map((call) => call.isError))} text=${JSON.stringify(compressResult?.text ?? "")}`,
      evidence: ["rpc.jsonl", "trace.jsonl"],
    });

    const foldRequest = requests[baselineAt + 1];
    const headers =
      foldRequest === undefined ? [] : viewHeaders(foldRequest.view);
    const foldedHits =
      foldRequest === undefined
        ? CONTEXT_TARGET_TAGS.map(() => [] as number[])
        : CONTEXT_TARGET_TAGS.map((tag) =>
            taggedIndices(foldRequest.view, tag),
          );
    const summaryAt =
      foldRequest === undefined
        ? []
        : foldRequest.view.filter(
            (message) => message.header === CONTEXT_BLOCK_LABEL,
          );
    // The compress call itself adds the assistant tool call and its result;
    // the covered messages then collapse into one summary message.
    const expectedMessages =
      baseline === undefined
        ? -1
        : baseline.view.length + 2 - CONTEXT_BLOCK_MESSAGES + 1;
    ctx.checks.add({
      id: "fold_in_model_input",
      title: "折叠后的模型请求携带块标签与模型摘要正文",
      status:
        headers.length === 1 &&
        headers[0] === CONTEXT_BLOCK_LABEL &&
        summaryAt.length === 1 &&
        summaryAt[0]?.tags?.includes(CONTEXT_SUMMARY_TAG) === true &&
        foldRequest !== undefined &&
        foldRequest.view.length === expectedMessages,
      detail:
        foldRequest === undefined
          ? "未观察到折叠后的模型请求"
          : `headers=${JSON.stringify(headers)} summaryTags=${JSON.stringify(summaryAt[0]?.tags ?? [])} messages=${baseline?.view.length}→${foldRequest.view.length} expected=${expectedMessages}`,
      evidence: "trace.jsonl",
    });

    ctx.checks.add({
      id: "covered_originals_absent",
      title: "被覆盖原文不再作为独立消息出现在模型输入",
      status:
        foldRequest !== undefined &&
        foldedHits.every((hits) => hits.length === 0) &&
        refsAreDense(foldRequest.view),
      detail:
        foldRequest === undefined
          ? "未观察到折叠后的模型请求"
          : `hits=${JSON.stringify(foldedHits)} refs=${JSON.stringify(viewRefs(foldRequest.view))}`,
      evidence: "trace.jsonl",
    });

    assertNoExternalProvider(ctx);
  },
};
