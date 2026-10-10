/**
 * `/debug` command handling logic (self-contained command unit).
 *
 * The command is the ONLY user entry that creates an investigation Case:
 * the raw text typed after `/debug` becomes, verbatim, the Case
 * objective, and the Case is materialized in the session workspace by
 * `zdebug case init`.  On success the command injects a model-visible
 * startup message through the host's `MessageInjector`, so the agent
 * loads the `auto-debug` skill and begins investigating in place — the
 * auto-debug strategy then keeps the loop alive on later turns (see
 * `docs/autodebug-design.md` §8.1).
 *
 * Zero flag parsing: every character of the argument string (spaces,
 * punctuation, newlines) is forwarded to the CLI unchanged, so no
 * `--verify` or other option is accepted here.  The host dependency is
 * typed against the host-agnostic `ToolHost` port and the injected
 * `zdebug` runner is the `ZdebugExec` port, so the handler stays
 * framework-agnostic and tests inject a fake instead of running the real
 * binary.
 *
 * @module
 */

import { join } from "node:path";
import type { ToolHost } from "../../core/client/tool-host.js";
import type {
  AutoDebugFs,
  MessageInjector,
  ZdebugExec,
  ZdebugExecResult,
} from "../../core/slots.js";
import { log } from "../../utils/logger.js";

/** Directory under the workspace holding the per-Case subdirectories. */
const CASE_ROOT = join(".zoo", "debug");

/** Case ids the command allocates, matched against existing directories. */
const CASE_ID_PATTERN = /^CASE-(\d+)$/;

/**
 * Upper bound on `CASE_EXISTS` retries.
 *
 * Each retry re-scans the workspace, so many rounds only happen under a
 * pathological collision storm; the cap reports a failure instead of
 * spinning forever.
 */
export const MAX_CASE_ID_ATTEMPTS = 100;

/** Deps the `/debug` handler needs from its unit factory. */
export interface DebugCommandOptions {
  /** Injected `zdebug` runner (defaults to the subprocess wrapper). */
  zdebugExec: ZdebugExec;
  /**
   * Injected read-only filesystem used to enumerate existing Case ids.
   *
   * The command derives the next id from the directory listing, so a
   * missing `.zoo/debug/` (listed as empty) starts the sequence at
   * `CASE-1`.
   */
  fs: AutoDebugFs;
  /**
   * Session workspace: the invocation cwd and, through the CLI's default
   * `<cwd>/.zoo/debug/<id>` layout, the Case location root the
   * auto-debug strategy scans.
   */
  directory: string;
  /**
   * Host user-message injector used to start the investigation turn.
   *
   * The injected text is model-visible (unlike `ToolHost.notify`), so the
   * agent begins the auto-debug loop without a further user prompt.
   * `undefined` on hosts that wire no injector — the command then reports
   * the Case was created but could not auto-start.
   */
  messageInjector: MessageInjector | undefined;
}

/**
 * Allocate the next sequential Case id for the workspace.
 *
 * Scans `<workspace>/.zoo/debug/` for `CASE-<n>` directories and returns
 * one past the highest `n`; an absent directory or no match yields
 * `CASE-1` (the injected fs lists a missing directory as empty).  The
 * `CASE-` form matches the skill vocabulary and the CLI's own
 * convention.
 *
 * @param fs - Read-only filesystem used to list the Case root.
 * @param workspace - Session workspace holding `.zoo/debug/`.
 * @returns The next `CASE-N` id.
 */
async function nextCaseId(fs: AutoDebugFs, workspace: string): Promise<string> {
  const entries = await fs.listDir(join(workspace, CASE_ROOT));
  let highest = 0;
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const match = CASE_ID_PATTERN.exec(entry.name);
    if (match === null) continue;
    const value = Number.parseInt(match[1], 10);
    if (value > highest) highest = value;
  }
  return `CASE-${highest + 1}`;
}

/**
 * Derive a human-readable Case title from the objective.
 *
 * Newlines and runs of whitespace collapse to single spaces; the title
 * is the single-lined objective in full, so nothing is discarded at
 * write time.  Any display-width limit is a rendering concern, not the
 * stored title's.
 *
 * @param objective - The raw objective text.
 * @returns The objective as a single line.
 */
function deriveTitle(objective: string): string {
  return objective.replace(/\s+/gu, " ").trim();
}

/**
 * Assemble the `case init` CLI arguments.
 *
 * `--json` selects the stable envelope used to read a business-error
 * code; `--workspace` is passed explicitly so the snapshot is pinned to
 * the session workspace even though the CLI would otherwise default it to
 * its cwd.
 */
function buildInitArgs(
  caseId: string,
  title: string,
  objective: string,
  workspace: string,
): string[] {
  return [
    "case",
    "init",
    caseId,
    "--json",
    "--title",
    title,
    "--objective",
    objective,
    "--workspace",
    workspace,
  ];
}

/** The `{"ok":false,...}` business-error envelope read from stderr. */
interface CliError {
  /** Machine error code, e.g. `"CASE_EXISTS"`. */
  code: string;
  /** Human message emitted by the CLI (English). */
  message: string;
}

/**
 * Parse the CLI's error envelope from stderr.
 *
 * @returns The code/message pair, or `null` when stderr carries no
 *   `{"ok":false,...}` payload (crash, warning-only output).
 */
function parseCliError(stderr: string): CliError | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stderr);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.ok !== false) return null;
  return {
    code: typeof record.code === "string" ? record.code : "",
    message: typeof record.message === "string" ? record.message : "",
  };
}

/** Extract a printable reason from an unknown thrown value. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create the Case, allocating the next sequential id and retrying when a
 * concurrent creation wins the race.
 *
 * A `CASE_EXISTS` business error means the id was taken between the scan
 * and the CLI call, so the id is re-scanned and the attempt repeats (up
 * to {@link MAX_CASE_ID_ATTEMPTS}); every other outcome — launch
 * failure, non-zero exit, or a different business error — throws a
 * Chinese-message `Error` at once.
 *
 * @param options - Injected runner, filesystem, and workspace.
 * @param objective - The raw objective text.
 * @returns The id the CLI accepted.
 */
async function initCase(
  options: DebugCommandOptions,
  objective: string,
): Promise<string> {
  const title = deriveTitle(objective);
  let lastDetail = "";
  for (let attempt = 0; attempt < MAX_CASE_ID_ATTEMPTS; attempt++) {
    const caseId = await nextCaseId(options.fs, options.directory);
    let result: ZdebugExecResult;
    try {
      result = await options.zdebugExec(
        buildInitArgs(caseId, title, objective, options.directory),
        options.directory,
      );
    } catch (err) {
      throw new Error(
        `无法运行 zdebug：${reasonOf(err)}。请确认 zdebug 已安装并在 PATH 中。`,
      );
    }
    if (result.exitCode === 0) return caseId;
    const cliError = parseCliError(result.stderr);
    if (cliError === null || cliError.code !== "CASE_EXISTS") {
      const detail =
        cliError === null
          ? `退出码 ${result.exitCode}`
          : `${cliError.code} — ${cliError.message}`;
      throw new Error(`创建调试 Case 失败：${detail}`);
    }
    lastDetail = `${cliError.code} — ${cliError.message}`;
  }
  throw new Error(
    `创建调试 Case 失败：连续 ${MAX_CASE_ID_ATTEMPTS} 次遇到 CASE_EXISTS` +
      `（${lastDetail}），请稍后重试。`,
  );
}

/**
 * Render the model-visible startup message for a newly created Case.
 *
 * Names the Case id and directory, repeats the objective verbatim, and
 * tells the agent to load the `auto-debug` skill and start investigating
 * immediately — so the injected user turn begins the loop.
 *
 * @param caseId - The created Case id.
 * @param objective - The raw objective text (verbatim).
 * @returns The startup message.
 */
export function buildStartupText(caseId: string, objective: string): string {
  // Display path is always forward-slashed: the zdebug layout and its
  // docs use `.zoo/debug/<id>`, and the model reads this text on every
  // platform, so Windows must not see `.zoo\\debug\\<id>`.
  const caseDir = [".zoo", "debug", caseId].join("/");
  return [
    `【调试 Case ${caseId} 已创建】目录：\`${caseDir}/\``,
    "",
    "调查目标：",
    objective,
    "",
    "请加载 `auto-debug` skill，并立即开始调查：先读取该 skill，",
    "按其纪律经 zdebug 记录假设、实验与证据，调查状态保存在磁盘上。",
  ].join("\n");
}

/**
 * Handle the `/debug` command.
 *
 * - Whitespace-only arguments → show the usage hint; no Case is created.
 * - Otherwise → create a Case whose objective is the raw argument
 *   string, then inject a model-visible startup message that loads the
 *   `auto-debug` skill so the agent starts investigating in place.
 *
 * All failures throw a Chinese-message `Error` for the unit descriptor's
 * notification wrapper; the CLI itself is never left to crash the
 * caller.  A Case that was created but whose startup injection failed is
 * reported directly (never silently swallowed) and does not rethrow —
 * the user must still learn the Case exists.
 *
 * @param toolHost - Host tool services (notify).
 * @param sessionID - The current session identifier.
 * @param args - The raw arguments string after `/debug`, passed verbatim.
 * @param options - Injected runner, workspace settings, and injector.
 * @throws Error (Chinese message) when `zdebug` cannot be launched or
 *   returns a business error.
 */
export async function handleDebugCommand(
  toolHost: ToolHost | null | undefined,
  sessionID: string,
  args: string,
  options: DebugCommandOptions,
): Promise<void> {
  const objective = args;
  if (objective.trim() === "") {
    await toolHost?.notify(
      sessionID,
      [
        "━━  用法 ━━",
        "",
        "/debug <调查目标>",
        "",
        "将调查目标原文作为 objective 创建一个调试 Case，",
        "并立即开始自主调查。",
      ].join("\n"),
    );
    return;
  }

  const caseId = await initCase(options, objective);

  if (options.messageInjector === undefined) {
    await reportInjectFailure(
      toolHost,
      sessionID,
      caseId,
      "宿主未提供消息注入能力",
    );
    return;
  }

  try {
    await options.messageInjector.inject(
      sessionID,
      buildStartupText(caseId, objective),
    );
  } catch (err) {
    log("debug-command", "inject_failed", sessionID, undefined, "warn", {
      caseId,
      error: reasonOf(err),
    });
    await reportInjectFailure(toolHost, sessionID, caseId, reasonOf(err));
    return;
  }

  await toolHost?.notify(
    sessionID,
    `已创建调试 Case ${caseId}，已请求立即开始调查。`,
  );
}

/**
 * Tell the user the Case exists but the investigation did not auto-start.
 *
 * The persisted notification alone is not a reliable channel on every
 * host: OpenCode suppresses `notify` when the session agent cannot be
 * resolved — exactly the case that also makes injection fail — so the
 * user would never see the notice.  A transient toast is therefore sent
 * as well through the optional `toast` port, which does not depend on
 * agent resolution.  Both calls are best-effort; the handler never
 * rethrows here because the Case already exists.
 *
 * @param toolHost - Host tool services (notify and optional toast).
 * @param sessionID - The current session identifier.
 * @param caseId - The created Case id.
 * @param reason - A short cause description.
 */
async function reportInjectFailure(
  toolHost: ToolHost | null | undefined,
  sessionID: string,
  caseId: string,
  reason: string,
): Promise<void> {
  const text =
    `已创建调试 Case ${caseId}，但未能自动启动调查：${reason}。` +
    "请手动加载 `auto-debug` skill 继续。";
  await toolHost?.notify(sessionID, text);
  // Fallback for hosts whose `notify` is suppressed in this situation;
  // the optional call covers hosts that wire no toast port at all.
  toolHost?.toast?.(sessionID, { source: "debug", level: "warning", text });
}
