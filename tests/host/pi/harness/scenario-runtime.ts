/**
 * Scenario runtime: one fresh pi process and one fresh temporary root per
 * scenario, with shutdown and leftover-process assertions that every
 * scenario shares.
 *
 * The runner owns the process lifecycle so a scenario body cannot leak one:
 * the child is started before the body runs and is always closed in
 * `finally`, its exit and descendant state are recorded as checks, and the
 * temporary root survives only when the scenario failed (or `--keep`).
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CheckSink, type ScenarioReport } from "./checks.js";
import {
  MARKERS,
  PLAN_COMPLETE_TEXT,
  PLAN_OPS,
  REQUIRED_TOOLS,
} from "./constants.js";
import {
  buildChildEnv,
  createIsolatedRoot,
  type IsolatedRoot,
  MODEL_ID,
  MODEL_REF,
  PROVIDER_ID,
} from "./isolation.js";
import { descendantPids, isAlive, waitForGone } from "./process.js";
import { RpcClient, type RpcExit, type RpcRecord } from "./rpc-client.js";

/** Last-resort deadline for one prompt run. */
export const RUN_TIMEOUT_MS = 240_000;

/** Deadline for the subagent run, which starts a second session. */
export const SUBAGENT_TIMEOUT_MS = 600_000;

/** Deadline for the orderly shutdown after stdin is closed. */
const CLOSE_TIMEOUT_MS = 120_000;

/** One trace record written by the harness extension. */
export interface TraceRecord {
  ts?: string;
  pid?: number;
  loadId?: string;
  seq?: number;
  event?: string;
  [key: string]: any;
}

/** Tool execution recorded by the RPC stream. */
export interface ToolExecution {
  tool: string;
  toolCallId: string | undefined;
  isError: boolean;
  text: string;
  args: Record<string, any>;
}

/** Result of one prompt step. */
export interface PromptStep {
  response: RpcRecord;
  disposition: string | null;
  records: RpcRecord[];
  assistantTexts: string[];
  toolStarts: ToolExecution[];
  toolResults: ToolExecution[];
}

/** Session identity from `get_state`. */
export interface SessionState {
  sessionId: string | null;
  sessionFile: string | null;
  model: string | null;
  messageCount: number;
}

/**
 * One message of a model request, as the deterministic provider received it.
 *
 * `ref` and `header` are written by the production pruning pipeline (the
 * `[mN] ` line prefix and the `[Block bN · K 条]` label), and `tags` names
 * which harness sentinel strings survived into the message text.
 */
export interface ViewMessageRecord {
  /** Position in the request. */
  i: number;
  /** Message role. */
  role: string;
  /** Injected line ref, when the message was addressed this round. */
  ref?: string;
  /** Block label, when the message is a folded summary. */
  header?: string;
  /** Harness sentinels found in the text. */
  tags?: string[];
}

/** One model request recorded by the deterministic provider. */
export interface ProviderRequest {
  /** Trace sequence number of the record. */
  seq: number;
  /** `tool:<name>` or `text`. */
  decision: string;
  /** Messages the model received, in request order. */
  view: ViewMessageRecord[];
}

/**
 * Model requests the provider recorded, in order.
 *
 * The deterministic provider writes one record per request carrying the
 * messages it received, so this is the model-input boundary the context
 * scenarios assert on.
 *
 * @param session - Running pi session.
 * @returns The recorded requests.
 */
export function providerRequests(session: PiSession): ProviderRequest[] {
  return session
    .trace()
    .filter((record) => record.event === "provider_call")
    .map((record) => ({
      seq: typeof record.seq === "number" ? record.seq : 0,
      decision: String(record.decision ?? ""),
      view: Array.isArray(record.view)
        ? (record.view as ViewMessageRecord[])
        : [],
    }));
}

/**
 * Line refs of the conversation messages of a request, in view order.
 *
 * @param view - Messages of one request.
 * @returns The refs, `null` for a message the round left unaddressed.
 */
export function viewRefs(
  view: readonly ViewMessageRecord[],
): (string | null)[] {
  return view
    .filter((message) => message.role !== "system")
    .map((message) => message.ref ?? null);
}

/**
 * Whether a request numbered every fold unit densely from `m1`.
 *
 * A unit that spans two messages (a tool call and its result) carries its
 * ref on one member only, so unaddressed members are skipped before the
 * density check.
 *
 * @param view - Messages of one request.
 * @returns True when the distinct refs are `m1..mN` without gaps.
 */
export function refsAreDense(view: readonly ViewMessageRecord[]): boolean {
  const refs = viewRefs(view).filter((ref): ref is string => ref !== null);
  return refs.length > 0 && refs.every((ref, index) => ref === `m${index + 1}`);
}

/**
 * Indices of the messages carrying a harness sentinel.
 *
 * @param view - Messages of one request.
 * @param tag - Sentinel to look for.
 * @returns Request indices of the matching messages.
 */
export function taggedIndices(
  view: readonly ViewMessageRecord[],
  tag: string,
): number[] {
  return view
    .filter((message) => message.tags?.includes(tag) === true)
    .map((message) => message.i);
}

/**
 * Block labels a request carries (`[Block bN · K 条] title`).
 *
 * @param view - Messages of one request.
 * @returns The labels, in view order.
 */
export function viewHeaders(view: readonly ViewMessageRecord[]): string[] {
  return view
    .map((message) => message.header)
    .filter((header): header is string => typeof header === "string");
}

/** A scenario the suite can run on its own. */
export interface ScenarioDefinition {
  id: string;
  title: string;
  /** Risk this scenario covers (printed in the report). */
  risk: string;
  run(ctx: ScenarioContext): Promise<void>;
  /**
   * Optional assertions that need the process to be gone (ordered shutdown,
   * finalized session file).  Called after the runner closed the process.
   */
  verifyAfterShutdown?(
    ctx: ScenarioContext,
    facts: { exit: RpcExit; trace: TraceRecord[] },
  ): void;
}

/** What a scenario body receives. */
export interface ScenarioContext {
  checks: CheckSink;
  isolated: IsolatedRoot;
  pi: PiSession;
}

/** Plain text of a message content value. */
export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) =>
      part !== null &&
      typeof part === "object" &&
      (part as { type?: string }).type === "text"
        ? ((part as { text?: string }).text ?? "")
        : "",
    )
    .join("");
}

/** Read a JSONL file into records (a missing file yields `[]`). */
export function readJsonl(path: string): TraceRecord[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as TraceRecord);
  } catch {
    return [];
  }
}

/**
 * One pi RPC process plus the helpers a scenario needs.
 */
export class PiSession {
  readonly client: RpcClient;
  readonly isolated: IsolatedRoot;

  /**
   * @param isolated - The scenario root the process runs in.
   * @param binary - Host pi executable resolved from PATH.
   */
  constructor(isolated: IsolatedRoot, binary: string) {
    this.isolated = isolated;
    this.client = new RpcClient({
      label: isolated.scenario,
      binary,
      args: [
        "--mode",
        "rpc",
        "--offline",
        "--no-approve",
        "--no-mcp",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--provider",
        PROVIDER_ID,
        "--model",
        MODEL_ID,
      ],
      cwd: isolated.workDir,
      env: buildChildEnv(process.env, isolated, {
        ZOO_E2E_TRACE: isolated.tracePath,
      }),
      recordsPath: join(isolated.artifactsDir, "rpc.jsonl"),
      stderrPath: join(isolated.artifactsDir, "stderr.log"),
      defaultTimeoutMs: RUN_TIMEOUT_MS,
    });
  }

  /** Spawn the process. */
  start(): this {
    this.client.start();
    return this;
  }

  /** Every record received so far. */
  get records(): RpcRecord[] {
    return this.client.records;
  }

  /** Process id, once started. */
  get pid(): number | undefined {
    return this.client.pid;
  }

  /** Trace records written by the extension so far. */
  trace(): TraceRecord[] {
    return readJsonl(this.isolated.tracePath);
  }

  /**
   * Send one command and await its response.
   *
   * @param command - Command payload.
   * @param timeoutMs - Response deadline.
   * @returns The response record.
   */
  send(command: Record<string, unknown>, timeoutMs = RUN_TIMEOUT_MS) {
    return this.client.send(command, timeoutMs);
  }

  /** Current session state. */
  async state(): Promise<SessionState> {
    const response = await this.send({ type: "get_state" });
    const data = (response.data ?? {}) as Record<string, any>;
    return {
      sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      sessionFile:
        typeof data.sessionFile === "string" ? data.sessionFile : null,
      model:
        data.model === undefined
          ? null
          : `${data.model.provider}/${data.model.id}`,
      messageCount:
        typeof data.messageCount === "number" ? data.messageCount : 0,
    };
  }

  /**
   * Send a prompt and wait until pi settles again.
   *
   * A `handled` disposition means an extension consumed the prompt (a slash
   * command), so no run starts and no settle is awaited.
   *
   * @param message - Prompt text.
   * @param timeoutMs - Deadline for the run.
   * @returns The step records and their analysis.
   */
  async prompt(
    message: string,
    timeoutMs = RUN_TIMEOUT_MS,
  ): Promise<PromptStep> {
    const mark = this.client.mark();
    const response = await this.send({ type: "prompt", message }, timeoutMs);
    const disposition: string | null = response.data?.disposition ?? null;
    if (response.success === true && disposition !== "handled") {
      await this.client.waitFor((record) => record.type === "agent_settled", {
        label: `agent_settled after ${message}`,
        timeoutMs,
        fromIndex: mark,
      });
    }
    return analyze(response, disposition, this.client.since(mark));
  }

  /** JSON of the active session's entries. */
  async entriesJson(): Promise<string> {
    const response = await this.send({ type: "get_entries" });
    if (response.success !== true) return "";
    return JSON.stringify(response.data?.entries ?? []);
  }

  /** Create a new (empty) session. */
  newSession() {
    return this.send({ type: "new_session" });
  }

  /** Switch to a stored session file. */
  switchSession(sessionPath: string) {
    return this.send({ type: "switch_session", sessionPath });
  }

  /** Fork from one stored user message. */
  fork(entryId: string) {
    return this.send({ type: "fork", entryId });
  }

  /** Messages the active session can fork from. */
  async forkMessages(): Promise<{ entryId: string; text: string }[]> {
    const response = await this.send({ type: "get_fork_messages" });
    const messages = response.data?.messages;
    return Array.isArray(messages)
      ? (messages as { entryId: string; text: string }[])
      : [];
  }

  /** Close stdin and wait for pi to exit. */
  close() {
    return this.client.close({ timeoutMs: CLOSE_TIMEOUT_MS });
  }
}

/** Analyze the records of one prompt step. */
function analyze(
  response: RpcRecord,
  disposition: string | null,
  records: RpcRecord[],
): PromptStep {
  const argumentsById = new Map<string, Record<string, any>>();
  for (const record of records) {
    if (
      record.type === "tool_execution_start" &&
      typeof record.toolCallId === "string"
    ) {
      argumentsById.set(record.toolCallId, record.args ?? {});
    }
  }
  const assistantTexts = records
    .filter(
      (record) =>
        record.type === "message_end" && record.message?.role === "assistant",
    )
    .map((record) => contentText(record.message?.content));
  const toolStarts: ToolExecution[] = records
    .filter((record) => record.type === "tool_execution_start")
    .map((record) => ({
      tool: String(record.toolName ?? ""),
      toolCallId:
        typeof record.toolCallId === "string" ? record.toolCallId : undefined,
      isError: false,
      text: "",
      args: (record.args ?? {}) as Record<string, any>,
    }));
  const toolResults: ToolExecution[] = records
    .filter((record) => record.type === "tool_execution_end")
    .map((record) => ({
      tool: String(record.toolName ?? ""),
      toolCallId:
        typeof record.toolCallId === "string" ? record.toolCallId : undefined,
      isError: record.isError === true,
      text: contentText(record.result?.content),
      args: (argumentsById.get(String(record.toolCallId)) ?? {}) as Record<
        string,
        any
      >,
    }));
  return {
    response,
    disposition,
    records,
    assistantTexts,
    toolStarts,
    toolResults,
  };
}

/**
 * Wait for a trace record to appear.
 *
 * The extension writes its trace asynchronously from the harness's point of
 * view (the process emits `session_start` independently of the RPC
 * commands), so a check that reads the trace right after spawn would race.
 * This waits for the last matching record instead of sampling once.
 *
 * @param session - Running pi session.
 * @param predicate - Match test.
 * @param options - Maximum wait and the number of occurrences to await.
 * @returns The last matching record, or `undefined` on timeout.
 */
export async function waitForTrace(
  session: PiSession,
  predicate: (record: TraceRecord) => boolean,
  options: { timeoutMs?: number; occurrences?: number } = {},
): Promise<TraceRecord | undefined> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const wanted = options.occurrences ?? 1;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hits = session.trace().filter(predicate);
    if (hits.length >= wanted) return hits[hits.length - 1];
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Assert the tool inventory after one session_start reason: every required
 * tool present exactly once.  A duplicated `session_start` must not
 * duplicate registrations, so the idempotency claim is checked here rather
 * than the event count.
 *
 * @param ctx - Scenario context.
 * @param reason - Session start reason to inspect.
 * @param options - `occurrences` waits for a repeated reason (second
 *   reload); `label` keeps the check id unique across those repeats.
 */
export async function assertToolInventory(
  ctx: ScenarioContext,
  reason: string,
  options: { occurrences?: number; label?: string } = {},
): Promise<void> {
  const label = options.label ?? reason;
  const last = await waitForTrace(
    ctx.pi,
    (record) => record.event === "session_start" && record.reason === reason,
    { occurrences: options.occurrences ?? 1 },
  );
  const tracked: string[] = Array.isArray(last?.trackedTools)
    ? last.trackedTools
    : [];
  const duplicates: string[] = Array.isArray(last?.duplicateTools)
    ? last.duplicateTools
    : [];
  ctx.checks.add({
    id: `tools_registered_${label}`,
    title: `session_start(${reason}) 后工具注册完整且无重复`,
    status:
      last !== undefined &&
      REQUIRED_TOOLS.every((tool) => tracked.includes(tool)) &&
      duplicates.length === 0,
    detail:
      last === undefined
        ? `未观察到 session_start(${reason})`
        : `toolCount=${last.toolCount} tracked=${JSON.stringify(tracked)} duplicates=${JSON.stringify(duplicates)}`,
    evidence: "trace.jsonl",
  });
}

/**
 * Create the alpha plan and complete every task in one run.
 *
 * @param ctx - Scenario context.
 */
export async function createCompletedPlan(ctx: ScenarioContext): Promise<void> {
  const step = await ctx.pi.prompt(MARKERS.todo);
  const ops = step.toolStarts
    .filter((call) => call.tool === "todo")
    .map((call) => call.args.op);
  const results = step.toolResults.filter((call) => call.tool === "todo");
  const view = results[results.length - 1];
  const finalText = step.assistantTexts[step.assistantTexts.length - 1] ?? "";
  ctx.checks.add({
    id: "plan_created",
    title: "真实 todo 工具完成 init→done×3→view 且无错误",
    status:
      JSON.stringify(ops) === JSON.stringify(PLAN_OPS) &&
      results.length === PLAN_OPS.length &&
      results.every((call) => !call.isError),
    detail: `ops=${JSON.stringify(ops)} results=${results.length} errors=${results.filter((call) => call.isError).length}`,
    evidence: "rpc.jsonl",
  });
  ctx.checks.add({
    id: "plan_completed",
    title: "todo view 回读全部完成（3/3 done, 0 open）",
    status: view?.text.includes(PLAN_COMPLETE_TEXT) ?? false,
    detail: `view=${JSON.stringify(view?.text ?? "").slice(0, 200)}`,
    evidence: "rpc.jsonl",
  });
  ctx.checks.add({
    id: "plan_final_text",
    title: "同一 run 的最终 assistant 文本回显已完成计划",
    status: finalText.includes(PLAN_COMPLETE_TEXT),
    detail: `text=${JSON.stringify(finalText).slice(0, 240)}`,
    evidence: "rpc.jsonl",
  });
}

/**
 * Assert every model response came from the in-process deterministic
 * provider: no foreign model, and one provider call per assistant message
 * unless the scenario runs a child session (whose messages never reach the
 * parent's RPC stream).
 *
 * @param ctx - Scenario context.
 * @param options - `oneToOne: false` relaxes the per-message equality.
 */
export function assertNoExternalProvider(
  ctx: ScenarioContext,
  options: { oneToOne?: boolean } = {},
): void {
  const oneToOne = options.oneToOne ?? true;
  const assistantCount = ctx.pi.records.filter(
    (record) =>
      record.type === "message_end" && record.message?.role === "assistant",
  ).length;
  const providerCalls = ctx.pi
    .trace()
    .filter((record) => record.event === "provider_call");
  const foreign = providerCalls.filter((record) => record.model !== MODEL_REF);
  ctx.checks.add({
    id: "no_external_provider",
    title: "每次模型响应都来自进程内确定性 provider（无外部调用）",
    status:
      providerCalls.length > 0 &&
      (oneToOne ? providerCalls.length === assistantCount : true) &&
      providerCalls.length >= assistantCount &&
      foreign.length === 0,
    detail: `providerCalls=${providerCalls.length} assistantMessages=${assistantCount} oneToOne=${oneToOne} foreign=${JSON.stringify(foreign.map((record) => record.model))}`,
    evidence: "trace.jsonl",
  });
}

/**
 * Run one scenario with its own process, root and cleanup assertions.
 *
 * @param definition - Scenario to run.
 * @param options - Suite options (repo root, host binary, retention).
 * @returns The scenario report.
 */
export async function runScenario(
  definition: ScenarioDefinition,
  options: {
    repoRoot: string;
    piBinary: string;
    baseDir: string;
    keep: boolean;
  },
): Promise<ScenarioReport> {
  const startedAt = Date.now();
  const checks = new CheckSink(definition.id);
  const isolated = createIsolatedRoot({
    repoRoot: options.repoRoot,
    scenario: definition.id,
    baseDir: options.baseDir,
  });
  const session = new PiSession(isolated, options.piBinary);
  let error: string | undefined;
  const pid = (() => {
    try {
      session.start();
      return session.pid;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      return undefined;
    }
  })();
  checks.info(
    "host_environment",
    "场景运行在隔离目录并使用确定性模型",
    `pid=${pid ?? "none"} root=${isolated.root} home=${isolated.home} model=${MODEL_REF} session_dir=${isolated.sessionDir}`,
  );
  try {
    if (error === undefined) {
      await definition.run({ checks, isolated, pi: session });
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    checks.add({
      id: "unexpected_error",
      title: "场景无异常中断",
      status: false,
      detail: error,
      evidence: ["rpc.jsonl", "stderr.log", "trace.jsonl"],
    });
  } finally {
    const descendants = pid === undefined ? null : descendantPids(pid);
    const exit = await session.close();
    const alive = (descendants ?? []).filter((child) => isAlive(child));
    const gone = pid === undefined ? true : await waitForGone(pid, 5_000);
    const trace = session.trace();
    const shutdowns = trace.filter(
      (record) => record.event === "session_shutdown",
    );
    checks.add({
      id: "process_exit",
      title: "关闭 stdin 后 pi 进程以 0 退出",
      status: exit.code === 0 && gone,
      detail: `exit=${JSON.stringify(exit)} reaped=${gone} pid=${pid ?? "none"}`,
      evidence: ["rpc.jsonl", "stderr.log"],
    });
    checks.add({
      id: "ordered_shutdown",
      title: "退出前触发 session_shutdown(reason=quit)",
      status: shutdowns.some((record) => record.reason === "quit"),
      detail:
        shutdowns.length === 0
          ? "未观察到 session_shutdown"
          : `reasons=${JSON.stringify(shutdowns.map((record) => record.reason))}`,
      evidence: "trace.jsonl",
    });
    checks.add({
      id: "no_leftover_processes",
      title: "场景结束后没有遗留子进程",
      status: descendants === null ? "info" : alive.length === 0,
      detail:
        descendants === null
          ? "本机没有 /proc，无法枚举子进程；已核验 pi 进程本身退出"
          : `spawned=${JSON.stringify(descendants)} alive=${JSON.stringify(alive)}`,
      evidence: "rpc.jsonl",
    });
    if (definition.verifyAfterShutdown !== undefined) {
      try {
        definition.verifyAfterShutdown(
          { checks, isolated, pi: session },
          {
            exit,
            trace,
          },
        );
      } catch (caught) {
        checks.add({
          id: "post_shutdown_assertion_error",
          title: "退出后断言未抛异常",
          status: false,
          detail: caught instanceof Error ? caught.message : String(caught),
          evidence: "trace.jsonl",
        });
      }
    }
  }
  const durationMs = Date.now() - startedAt;
  const failed = checks.failed;
  const retain = failed || options.keep;
  if (!retain) rmSync(isolated.root, { recursive: true, force: true });
  return {
    id: definition.id,
    title: definition.title,
    risk: definition.risk,
    durationMs,
    status: failed ? "fail" : "pass",
    artifactsDir: retain ? isolated.root : null,
    checks: checks.checks,
    ...(error === undefined ? {} : { error }),
  };
}
