/**
 * Auto-debug strategy: judge a stopped turn against the workspace Case.
 *
 * This is the auto-debug controller's control law.  The engine has
 * already guaranteed the turn settled and the budget is not spent, so the
 * strategy sees only the session.  It discovers the Case on disk, re-runs
 * the verification experiment through the injected ports, and returns
 * either the wake text or an explicit silence with the gate that
 * suppressed it.  Every decision is derived from disk state (the status
 * JSON and the experiment run report) — never from conversation history
 * — so the same inputs always yield the same verdict.
 *
 * Silence vocabulary, all attributable:
 *   - `no-case` / `discovery-error` — discovery failed (no `CASE-<n>`
 *     directory, or an fs read error while scanning);
 *   - `closed` — the Case is CLOSED, so the loop no longer owns it;
 *   - `no-verify` — no verification experiment (and therefore no
 *     criterion timeout) is declared, so the criterion is not
 *     materialized (no loop);
 *   - `converged` — the verification experiment exited 0;
 *   - `verify-error` — the criterion itself is broken (exit > 1, timeout,
 *     an invocation failure such as `CASE_BUSY` or a missing binary, or a
 *     malformed payload).  This is NOT a "not fixed" verdict, so it never
 *     wakes.
 *
 * @module
 */

import { basename, join } from "node:path";
import type { Decision } from "../../core/loop/index.js";
import type { AutoDebugFs, ZdebugExec } from "../../core/slots.js";
import { log } from "../../utils/logger.js";

/** Why the auto-debug strategy withheld a wake. */
export type AutoDebugSilenceReason =
  | "no-case"
  | "discovery-error"
  | "closed"
  | "no-verify"
  | "converged"
  | "verify-error";

/** The auto-debug strategy's verdict for one stopped turn. */
export type AutoDebugDecision = Decision<AutoDebugSilenceReason>;

/** The injected ports the strategy reads the world through. */
export interface AutoDebugPorts {
  /** Runner for the `zdebug` CLI. */
  zdebugExec: ZdebugExec;
  /** Read-only filesystem for Case discovery. */
  fs: AutoDebugFs;
}

/** The bound run parameters for one settle. */
export interface AutoDebugContext {
  /** Workspace root whose `<workspace>/.zoo/debug/` holds the Cases. */
  workspace: string;
  /** The session whose settle triggered this judgment (for logging). */
  sessionID: string;
}

/** The `verify` pointer resolved from the status payload. */
export interface CaseVerify {
  /** The Verification Experiment id. */
  experiment: string;
  /**
   * The criterion's declared time limit, in milliseconds (positive
   * integer).  Its presence marks the criterion as materialized; a
   * pointer without it is treated as not-yet-materialized.  The limit
   * itself is enforced by `zdebug`, which kills the process tree and
   * records a `TIMED_OUT` Attempt on breach.
   */
  timeoutMs: number;
}

/** The facts a wake text must carry: the re-run verdict and read pointer. */
export interface WakeFacts {
  /** The Case directory name, for the `summary.md` read pointer. */
  caseId: string;
  /** The Verification Experiment id. */
  experiment: string;
  /** The Attempt id appended by the re-run, or empty when unrecorded. */
  attemptId: string;
  /** The re-run Attempt's exit code (the wake fires only on 1). */
  exitCode: number;
}

/** Directory holding the per-Case subdirectories. */
const CASE_ROOT = join(".zoo", "debug");

/**
 * Case directory names the strategy binds.
 *
 * The loop's Case namespace is the `CASE-<n>` id space allocated by the
 * `/debug` command, so discovery matches the same shape and ignores any
 * other directory name.
 */
const CASE_ID_PATTERN = /^CASE-(\d+)$/;

/**
 * Fixed continuation directive for every auto-debug wake.
 *
 * Deliberately worded to avoid promising the bug is fixed: the criterion
 * is external, so the strategy only reports that it has not passed yet.
 */
export const CONTINUE_DIRECTIVE =
  "继续调查并修复，直到验证实验通过（退出码为 0）。" +
  "不要以自述判断完成：收敛由外部验证判据决定。";

/** Fixed reminder that the investigation state lives on disk. */
export const ZDEBUG_REMINDER =
  "继续经 zdebug 记录你的假设、实验与证据" +
  "（claim / experiment / evidence），调查状态保存在磁盘上，" +
  "不依赖对话记忆。";

/** A resolved Case directory, or the absence of a bindable one. */
type Discovery = { kind: "none" } | { kind: "found"; caseDir: string };

/** Whether a JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a JSON value is a positive integer. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** The canonical `verify-error` silence. */
function verifyError(): AutoDebugDecision {
  return { kind: "silence", reason: "verify-error" };
}

/**
 * Scan `<workspace>/.zoo/debug/` for the bound Case.
 *
 * Only `CASE-<n>` directories (n a positive integer) participate: the
 * loop's Case namespace is that predictable id space, so an unrelated
 * directory name is ignored rather than mistaken for a Case.  The
 * highest id wins — the newest investigation takes over the loop,
 * regardless of lifecycle — and no match binds nothing.
 */
async function discoverCase(
  fs: AutoDebugFs,
  workspace: string,
): Promise<Discovery> {
  const root = join(workspace, CASE_ROOT);
  const entries = await fs.listDir(root);
  let newest = -1;
  let caseDir: string | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const match = CASE_ID_PATTERN.exec(entry.name);
    if (match === null) continue;
    const value = Number.parseInt(match[1], 10);
    if (value <= 0) continue;
    if (value > newest) {
      newest = value;
      caseDir = join(root, entry.name);
    }
  }
  if (caseDir === null) return { kind: "none" };
  return { kind: "found", caseDir };
}

/**
 * Parse a successful `{"ok":true,"result":...}` report.
 *
 * @returns The `result` object, or `null` when the output is not a
 *   successful report.
 */
function parseReport(stdout: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.ok !== true) return null;
  return isRecord(parsed.result) ? parsed.result : null;
}

/** Resolve the `verify` pointer from a status `result`. */
function readVerify(value: unknown): CaseVerify | null {
  if (!isRecord(value)) return null;
  const experiment = value.experiment;
  if (typeof experiment !== "string") return null;
  const timeoutMs = value.timeout_ms;
  if (!isPositiveInteger(timeoutMs)) return null;
  return { experiment, timeoutMs };
}

/** The run report fields the wake text needs. */
interface VerifyRun {
  /** The Attempt id appended by the run, or empty when unrecorded. */
  attemptId: string;
  /** The Attempt's recorded exit code. */
  exitCode: number;
}

/**
 * Read the re-run's `attempt_id` and `exit_code` from its run report.
 *
 * `experiment run --json` returns the finished Attempt's metadata, which
 * already carries the Attempt id — so no post-run status re-read is
 * needed to name it in the wake text.
 *
 * @returns The run fields, or `null` when the payload is not a
 *   successful run report carrying a numeric exit code.
 */
function readRunResult(stdout: string): VerifyRun | null {
  const result = parseReport(stdout);
  if (result === null) return null;
  if (typeof result.exit_code !== "number") return null;
  return {
    attemptId: typeof result.attempt_id === "string" ? result.attempt_id : "",
    exitCode: result.exit_code,
  };
}

/**
 * Render the wake text handed to the agent.
 *
 * Four parts only: the criterion's re-run verdict (Experiment id,
 * Attempt id, exit code), a read pointer to the Case state on disk, the
 * continuation directive, and the zdebug recording reminder.  The wake
 * carries no Case snapshot — the skill already makes the agent read the
 * Case on takeover, so the only new fact worth paying tokens for is that
 * the criterion was just re-run and is still failing.
 */
export function renderWakeText(facts: WakeFacts): string {
  const summaryPath = join(CASE_ROOT, facts.caseId, "summary.md");
  const attempt = facts.attemptId === "" ? "(未记录)" : facts.attemptId;
  return [
    "【自动调试循环】验证判据重跑后仍未通过，请继续调查。",
    "",
    `判据重跑结果：实验 ${facts.experiment}、Attempt ${attempt}、退出码 ${facts.exitCode}。`,
    "",
    "## 恢复现状",
    "先运行 `zdebug case status`，再读取 " +
      `\`${summaryPath}\`，据磁盘状态恢复调查现状。`,
    "",
    "## 续写指令",
    CONTINUE_DIRECTIVE,
    "",
    "## 记录提醒",
    ZDEBUG_REMINDER,
  ].join("\n");
}

/**
 * Judge one stopped turn against the workspace Case.
 *
 * Discovery binds the newest Case (the `CASE-<n>` directory with the
 * highest n); a CLOSED Case, or one whose verify pointer carries no
 * positive-integer criterion timeout, silences.
 * Otherwise the verification experiment is re-run through the port —
 * unbounded on the TS side, since the criterion's declared `timeout_ms`
 * is enforced by `zdebug` itself — and its exit code decides: `0`
 * converges, `1` wakes, and anything else (including a thrown port error,
 * a `TIMED_OUT` run, or a `CASE_BUSY` business error) silences as
 * `verify-error`.  No retry or throttle lives here — a busy Case simply
 * waits for the next settle.
 */
export async function decide(
  ports: AutoDebugPorts,
  context: AutoDebugContext,
): Promise<AutoDebugDecision> {
  let discovery: Discovery;
  try {
    discovery = await discoverCase(ports.fs, context.workspace);
  } catch (err) {
    // An fs read failure is not "no Case": keep it attributable as its
    // own silence rather than collapsing it into the empty-workspace gate.
    // The underlying error is logged so a persistent discovery-error is
    // diagnosable, without leaking it into the user-visible verdict.
    log("auto-debug", "discovery_error", context.sessionID, undefined, "warn", {
      error: String(err),
    });
    return { kind: "silence", reason: "discovery-error" };
  }
  if (discovery.kind === "none") {
    return { kind: "silence", reason: "no-case" };
  }

  const caseDir = discovery.caseDir;
  let verify: CaseVerify;
  try {
    // The probe is a plain read, so it carries no criterion limit; like
    // the re-run below it runs unbounded — `zdebug` owns all timeouts.
    const report = await ports.zdebugExec(
      ["case", "status", "--json", "--case-dir", caseDir],
      context.workspace,
    );
    if (report.exitCode !== 0) return verifyError();
    const result = parseReport(report.stdout);
    if (result === null) return verifyError();
    if (result.lifecycle === "CLOSED") {
      return { kind: "silence", reason: "closed" };
    }
    const parsed = readVerify(result.verify);
    if (parsed === null) return { kind: "silence", reason: "no-verify" };
    verify = parsed;
  } catch (err) {
    // The probe's own failure is otherwise indistinguishable from a
    // legitimate non-zero report; log it so a persistent verify-error is
    // diagnosable.
    log(
      "auto-debug",
      "status_probe_error",
      context.sessionID,
      undefined,
      "warn",
      { error: String(err) },
    );
    return verifyError();
  }

  // The re-run is unbounded on the TS side: the criterion's declared
  // `timeout_ms` is enforced by `zdebug`, which kills the tree and
  // records a `TIMED_OUT` Attempt on breach.
  let run: VerifyRun | null;
  try {
    const report = await ports.zdebugExec(
      ["experiment", "run", verify.experiment, "--json", "--case-dir", caseDir],
      context.workspace,
    );
    if (report.exitCode !== 0) return verifyError();
    run = readRunResult(report.stdout);
  } catch (err) {
    // The re-run's own failure is otherwise indistinguishable from a
    // legitimate non-zero report; log it so a persistent verify-error is
    // diagnosable.
    log(
      "auto-debug",
      "experiment_run_error",
      context.sessionID,
      undefined,
      "warn",
      { error: String(err) },
    );
    return verifyError();
  }

  if (run === null) return verifyError();
  if (run.exitCode === 0) {
    return { kind: "silence", reason: "converged" };
  }
  if (run.exitCode === 1) {
    return {
      kind: "wake",
      text: renderWakeText({
        caseId: basename(caseDir),
        experiment: verify.experiment,
        attemptId: run.attemptId,
        exitCode: run.exitCode,
      }),
    };
  }
  return verifyError();
}
