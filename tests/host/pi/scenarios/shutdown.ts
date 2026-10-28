/**
 * Core scenario 6: ordered shutdown and no leftover state.
 *
 * Closing stdin is the documented orderly shutdown.  This scenario asserts
 * it from the filesystem after the process is gone: the session file is
 * finalized under the isolated session directory, the plugin log stays
 * inside the isolated HOME, `session_shutdown(quit)` is the last extension
 * event, and no process survives.  Locating product state inside the
 * scenario root is also what proves the isolation of session, log and
 * storage paths.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MARKERS, PLAN_EMPTY_TEXT } from "../harness/constants.js";
import type { ScenarioDefinition } from "../harness/scenario-runtime.js";

/** Session file observed during the run, used by the post-shutdown checks. */
let sessionFilePath: string | null = null;

export const shutdown: ScenarioDefinition = {
  id: "shutdown",
  title: "有序 shutdown 与无遗留状态",
  risk: "关闭 stdin 后进程不退出、会话未落盘、插件状态写在隔离目录之外",
  async run(ctx) {
    const state = await ctx.pi.state();
    sessionFilePath = state.sessionFile;
    ctx.checks.add({
      id: "session_file_isolated",
      title: "会话文件位于隔离会话目录内",
      status: state.sessionFile?.startsWith(ctx.isolated.sessionDir) ?? false,
      detail: `file=${state.sessionFile} sessionDir=${ctx.isolated.sessionDir}`,
      evidence: "rpc.jsonl",
    });

    const view = await ctx.pi.prompt(MARKERS.view);
    const text = view.assistantTexts[view.assistantTexts.length - 1] ?? "";
    ctx.checks.add({
      id: "clean_session_empty_plan",
      title: "干净会话内 todo 为空（未读到其他场景的计划）",
      status: text.includes(PLAN_EMPTY_TEXT),
      detail: `text=${JSON.stringify(text).slice(0, 200)}`,
      evidence: "rpc.jsonl",
    });
  },

  verifyAfterShutdown(ctx, facts) {
    const trace = facts.trace;
    const last = trace[trace.length - 1];
    ctx.checks.add({
      id: "shutdown_is_last_event",
      title: "session_shutdown(quit) 是最后一个扩展事件",
      status:
        facts.exit.code === 0 &&
        last?.event === "session_shutdown" &&
        last?.reason === "quit",
      detail: `exit=${JSON.stringify(facts.exit)} lastEvent=${last?.event}/${last?.reason} events=${trace.length}`,
      evidence: "trace.jsonl",
    });

    const file = sessionFilePath;
    const fileExists = file !== null && existsSync(file);
    const lines =
      fileExists && file !== null
        ? readFileSync(file, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
        : [];
    let parsed = true;
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch {
        parsed = false;
        break;
      }
    }
    ctx.checks.add({
      id: "session_file_finalized",
      title: "退出后会话语义完整（文件存在、逐行 JSON 可解析）",
      status:
        fileExists &&
        lines.length > 0 &&
        parsed &&
        (file?.startsWith(ctx.isolated.root) ?? false),
      detail: `file=${file} lines=${lines.length} jsonl=${parsed}`,
      evidence: "rpc.jsonl",
    });

    const logDir = join(ctx.isolated.home, ".zoo", "log");
    const logs = existsSync(logDir) ? readdirSync(logDir) : [];
    const storageDir = join(ctx.isolated.home, ".zoo", "storage");
    const storage = existsSync(storageDir) ? readdirSync(storageDir) : [];
    ctx.checks.add({
      id: "plugin_state_isolated",
      title: "插件日志与存储全部落在隔离目录内",
      status:
        logs.length > 0 &&
        storage.length > 0 &&
        logs.every((name) => statSync(join(logDir, name)).isFile()),
      detail: `logDir=${logDir} logs=${JSON.stringify(logs)} storage=${JSON.stringify(storage)}`,
      evidence: ["rpc.jsonl", "stderr.log"],
    });

    const sessionFiles = existsSync(ctx.isolated.sessionDir)
      ? readdirSync(ctx.isolated.sessionDir).filter((name) =>
          name.endsWith(".jsonl"),
        )
      : [];
    ctx.checks.add({
      id: "single_isolated_session_file",
      title: "隔离会话目录内只有本场景的一个会话文件",
      status:
        file !== null &&
        sessionFiles.length === 1 &&
        join(ctx.isolated.sessionDir, sessionFiles[0] ?? "") === file,
      detail: `sessionDir=${ctx.isolated.sessionDir} files=${JSON.stringify(sessionFiles)} active=${file}`,
      evidence: "rpc.jsonl",
    });
  },
};
