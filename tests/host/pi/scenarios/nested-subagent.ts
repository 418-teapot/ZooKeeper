/**
 * Core scenario 11: nested SDK delegations keep the config tool permissions.
 *
 * One real pi process drives two delegation levels: the main session
 * delegates to beaver, and beaver's own sub-session runtime delegates to
 * spider.  Two independent faces are asserted per level:
 *
 * - the registered directory, which the probe reads with `getAllTools`;
 * - the tool declarations of the model request, which the deterministic
 *   provider records (pi folds the active tool set into the transcript), so
 *   the check reads the face the model was actually offered.
 *
 * The permissions are the repository's own config.toml entries: beaver
 * denies `fetch`, spider denies `edit`, `bash` and `subagent`.  A correct
 * chain therefore shows beaver's request without `fetch` while its
 * directory keeps it, and spider's request with `fetch` while its directory
 * keeps the tools it denies.
 */

import type { CheckInput } from "../harness/checks.js";
import {
  MARKERS,
  NEST_LEVEL2_TAG,
  NESTED_CHILD_REPLY,
} from "../harness/constants.js";
import {
  type ScenarioDefinition,
  SUBAGENT_TIMEOUT_MS,
  type TraceRecord,
} from "../harness/scenario-runtime.js";

/** Tag the spider prompt carries, identifying its model requests. */
const SPIDER_PROMPT_TAG = "E2E-CHILD spider";

/** Tools beaver denies in config.toml. */
const BEAVER_DENIES = ["fetch"] as const;

/** Tools spider denies in config.toml. */
const SPIDER_DENIES = ["edit", "bash", "subagent"] as const;

/** Read a string field of a trace record. */
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Whether a trace record's transcript mentions a tag.
 *
 * @param record - The trace record.
 * @param tag - Tag the prompt or message text carries.
 * @returns True when the record mentions the tag.
 */
function mentions(record: TraceRecord, tag: string): boolean {
  return (
    JSON.stringify(record.view ?? []).includes(tag) ||
    (typeof record.prompt === "string" && record.prompt.includes(tag))
  );
}

/**
 * The model requests of one session.
 *
 * @param trace - Trace records of the run.
 * @param tag - Tag the session's prompt carries.
 * @returns The matching provider calls, in trace order.
 */
function requestsCarrying(trace: TraceRecord[], tag: string): TraceRecord[] {
  return trace.filter(
    (record) => record.event === "provider_call" && mentions(record, tag),
  );
}

/**
 * The registered tool directory one child runtime reported.
 *
 * @param trace - Trace records of the run.
 * @param tag - Tag the child's prompt carries.
 * @returns The `before_agent_start` record, or undefined.
 */
function directoryCarrying(
  trace: TraceRecord[],
  tag: string,
): TraceRecord | undefined {
  return trace.find(
    (record) =>
      record.event === "before_agent_start" &&
      record.child === true &&
      mentions(record, tag),
  );
}

/**
 * Build one request-face check of a session.
 *
 * A turn that follows a tool result is a model request too, so every request
 * the session produced must declare the same permission face: one later turn
 * that widens it fails the check as loudly as the first one.
 *
 * @param input - The check identity, the session's requests in trace order,
 *   and the face rule every request must meet.
 * @returns The check to record.
 */
function requestFaceCheck(input: {
  id: string;
  title: string;
  requests: TraceRecord[];
  accepts: (declared: string[]) => boolean;
}): CheckInput {
  const faces = input.requests.map((record) => strings(record.tools));
  // Report each face once: a session whose turns agree shows one entry, and
  // one that drifted shows both.
  const distinct = faces.filter(
    (face, index) =>
      faces.findIndex((other) => other.join(",") === face.join(",")) === index,
  );
  return {
    id: input.id,
    title: input.title,
    status: faces.length > 0 && faces.every((face) => input.accepts(face)),
    detail: `requests=${faces.length} faces=${JSON.stringify(distinct)}`,
    evidence: "trace.jsonl",
  };
}

export const nestedSubagent: ScenarioDefinition = {
  id: "nested-subagent",
  title: "两级 SDK 嵌套委派按各自 config 权限裁剪活动工具",
  risk: "子会话沿用宿主默认工具集或把上一层的禁用项传给下一层，注册目录与活动集混为一谈",
  async run(ctx) {
    await ctx.pi.state();
    const step = await ctx.pi.prompt(MARKERS.nested, SUBAGENT_TIMEOUT_MS);
    const trace = ctx.pi.trace();

    // Both levels ran: each subagent call produced its own result, and the
    // inner one belongs to beaver's runtime, not to the parent's RPC stream.
    const subagentResults = trace.filter(
      (record) => record.event === "tool_result" && record.tool === "subagent",
    );
    ctx.checks.add({
      id: "both_levels_returned",
      title: "两级 subagent 调用都成功返回",
      status:
        subagentResults.length === 2 &&
        subagentResults.every((result) => result.isError !== true),
      detail: `results=${subagentResults.length} errors=${subagentResults.filter((result) => result.isError === true).length}`,
      evidence: "trace.jsonl",
    });

    const finalText = step.assistantTexts[step.assistantTexts.length - 1] ?? "";
    ctx.checks.add({
      id: "parent_final_text",
      title: "主会话最终文本携带第二层子会话的回复",
      status: finalText.includes(NESTED_CHILD_REPLY),
      detail: `text=${JSON.stringify(finalText).slice(0, 240)}`,
      evidence: "rpc.jsonl",
    });

    const delegated = trace
      .filter(
        (record) => record.event === "tool_call" && record.tool === "subagent",
      )
      .map((record) => (typeof record.agent === "string" ? record.agent : ""));
    ctx.checks.add({
      id: "delegation_chain",
      title: "委派链是主会话 → beaver → spider",
      status: delegated.includes("beaver") && delegated.includes("spider"),
      detail: `agents=${JSON.stringify(delegated)}`,
      evidence: "trace.jsonl",
    });

    // The model requests each level produced, with the tool declarations pi
    // folded into the transcript.
    ctx.checks.add(
      requestFaceCheck({
        id: "main_request_face",
        title: "主会话的每个模型请求都声明了 fetch 与 subagent",
        requests: requestsCarrying(trace, MARKERS.nested),
        accepts: (declared) =>
          declared.includes("fetch") && declared.includes("subagent"),
      }),
    );
    ctx.checks.add(
      requestFaceCheck({
        id: "beaver_request_face",
        title:
          "beaver 的每个模型请求都未声明自身 deny 的 fetch，仍声明 subagent",
        requests: requestsCarrying(trace, NEST_LEVEL2_TAG),
        accepts: (declared) =>
          BEAVER_DENIES.every((tool) => !declared.includes(tool)) &&
          declared.includes("subagent"),
      }),
    );
    ctx.checks.add(
      requestFaceCheck({
        id: "spider_request_face",
        title: "spider 的每个模型请求都声明了 fetch，且不含自身 deny 的工具",
        requests: requestsCarrying(trace, SPIDER_PROMPT_TAG),
        accepts: (declared) =>
          declared.includes("fetch") &&
          SPIDER_DENIES.every((tool) => !declared.includes(tool)),
      }),
    );

    // The registered directory of each child runtime keeps every tool the
    // config denies for that agent: the trim only writes the active set.
    const beaverRegistered = strings(
      directoryCarrying(trace, NEST_LEVEL2_TAG)?.toolNames,
    );
    ctx.checks.add({
      id: "beaver_registered_directory",
      title: "beaver 子会话的注册目录仍含自身 deny 的 fetch",
      status: BEAVER_DENIES.every((tool) => beaverRegistered.includes(tool)),
      detail: `registered=${JSON.stringify(beaverRegistered)}`,
      evidence: "trace.jsonl",
    });
    const spiderRegistered = strings(
      directoryCarrying(trace, SPIDER_PROMPT_TAG)?.toolNames,
    );
    ctx.checks.add({
      id: "spider_registered_directory",
      title: "spider 子会话的注册目录仍含自身 deny 的 edit/bash/subagent",
      status: SPIDER_DENIES.every((tool) => spiderRegistered.includes(tool)),
      detail: `registered=${JSON.stringify(spiderRegistered)}`,
      evidence: "trace.jsonl",
    });
  },
};
