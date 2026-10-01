/**
 * Tests for the auto-debug strategy (`decide.ts`).
 *
 * Locks the discovery gates (`no-case` / `discovery-error` / `closed` /
 * `no-verify`) — the newest `CASE-<n>` directory wins and non-matching
 * names are ignored — the convergence branch on
 * the verification experiment's
 * `exit_code` (0 / 1 / >1), the `verify-error` silences for a thrown
 * port, a timeout, and a non-zero CLI exit (e.g. `CASE_BUSY`), and the
 * wake-text contract (the re-run verdict, the read pointer, the
 * continuation directive, the recording reminder, and determinism).  All
 * ports and the filesystem are injected fakes — no real binary or disk is
 * touched.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type {
  AutoDebugDirEntry,
  AutoDebugFs,
  ZdebugExec,
  ZdebugExecResult,
} from "../../core/slots.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import {
  type AutoDebugContext,
  type AutoDebugPorts,
  decide,
  renderWakeText,
  type WakeFacts,
} from "./decide.js";

const WORKSPACE = "/ws";
const DEBUG_ROOT = join(WORKSPACE, ".zoo", "debug");

/** The criterion time limit the fake status payload declares. */
const VERIFY_TIMEOUT_MS = 12_000;

/** A successful `{"ok":true,"result":...}` report as a process result. */
function ok(result: unknown): ZdebugExecResult {
  return {
    stdout: JSON.stringify({ ok: true, result }),
    stderr: "",
    exitCode: 0,
  };
}

/** Build a fake filesystem from a directory table. */
function fakeFs(tree: {
  dirs?: Record<string, AutoDebugDirEntry[]>;
}): AutoDebugFs {
  return {
    listDir: async (path) => tree.dirs?.[path] ?? [],
  };
}

/**
 * Build a workspace with the given Case directory names.
 *
 * @param entries - Case directory names as object keys.
 * @returns The fake filesystem and the resolved Case directories.
 */
function workspace(entries: Record<string, unknown>): {
  fs: AutoDebugFs;
  caseDirs: string[];
} {
  const dirs: Record<string, AutoDebugDirEntry[]> = { [DEBUG_ROOT]: [] };
  const caseDirs: string[] = [];
  for (const name of Object.keys(entries)) {
    const dirPath = join(DEBUG_ROOT, name);
    caseDirs.push(dirPath);
    dirs[DEBUG_ROOT].push({ name, isDirectory: true });
    dirs[dirPath] = [
      { name: "case.jsonl", isDirectory: false },
      { name: "summary.md", isDirectory: false },
    ];
  }
  return { fs: fakeFs({ dirs }), caseDirs };
}

/** A discovery-complete OPEN Case status payload. */
function openStatus(overrides: Record<string, unknown> = {}): unknown {
  return {
    case_id: "CASE-1",
    lifecycle: "OPEN",
    objective: "支付并发测试间歇失败",
    verify: {
      experiment: "EX-001",
      command: "pytest tests/test_payment.py",
      timeout_ms: VERIFY_TIMEOUT_MS,
    },
    claims: {
      "CL-001": { id: "CL-001", assessment: "open", statement: "连接池复用" },
      "CL-002": { id: "CL-002", assessment: "supported", statement: "锁竞争" },
      "CL-003": { id: "CL-003", assessment: "open", statement: "超时配置" },
    },
    deliverables: {
      "DL-001": {
        id: "DL-001",
        criteria: {
          "CR-001": {
            id: "CR-001",
            description: "复现失败",
            disposition: null,
          },
          "CR-002": {
            id: "CR-002",
            description: "根因定位",
            disposition: "satisfied",
          },
        },
      },
    },
    experiments: {
      "EX-001": {
        id: "EX-001",
        attempts: [
          {
            attempt_id: "AT-001",
            status: "completed",
            exit_code: 1,
            finished_at: "2026-09-25T00:00:00Z",
          },
        ],
      },
    },
    ...overrides,
  };
}

/** A recording `zdebug` fake keyed on the subcommand. */
function execFake(options: {
  status?: unknown;
  statusByDir?: Record<string, unknown>;
  statusResult?: ZdebugExecResult;
  statusThrows?: unknown;
  runResult?: ZdebugExecResult;
  runThrows?: unknown;
}): {
  exec: ZdebugExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: ZdebugExec = async (args, _cwd) => {
    calls.push([...args]);
    if (args[0] === "case" && args[1] === "status") {
      if (options.statusThrows !== undefined) throw options.statusThrows;
      if (options.statusResult !== undefined) return options.statusResult;
      const dirIndex = args.indexOf("--case-dir");
      const caseDir = dirIndex >= 0 ? args[dirIndex + 1] : "";
      const status =
        options.statusByDir?.[caseDir] ?? options.status ?? openStatus();
      return ok(status);
    }
    if (args[0] === "experiment" && args[1] === "run") {
      if (options.runThrows !== undefined) throw options.runThrows;
      return options.runResult ?? ok({ exit_code: 1 });
    }
    throw new Error(`unexpected zdebug args: ${args.join(" ")}`);
  };
  return { exec, calls };
}

const CONTEXT: AutoDebugContext = {
  workspace: WORKSPACE,
  sessionID: "sess-decide",
};

/** Bundle an fs and an exec into the strategy's ports. */
function ports(fs: AutoDebugFs, exec: ZdebugExec): AutoDebugPorts {
  return { zdebugExec: exec, fs };
}

describe("decide — discovery gates", () => {
  it("silences no-case when the workspace has no Case", async () => {
    const { fs } = workspace({});
    const { exec } = execFake({});
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "no-case",
    });
  });

  it("binds the highest-numbered Case when several exist", async () => {
    const { fs } = workspace({ "CASE-1": {}, "CASE-2": {} });
    const { exec, calls } = execFake({
      statusByDir: {
        [join(DEBUG_ROOT, "CASE-1")]: openStatus(),
        [join(DEBUG_ROOT, "CASE-2")]: openStatus(),
      },
      runResult: ok({ exit_code: 0 }),
    });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "converged",
    });
    const status = calls.find((call) => call[1] === "status");
    assert.equal(status?.[status.length - 1], join(DEBUG_ROOT, "CASE-2"));
    const run = calls.find((call) => call[1] === "run");
    assert.equal(run?.[run.length - 1], join(DEBUG_ROOT, "CASE-2"));
  });

  it("silences no-case when only non-matching directory names exist", async () => {
    const { fs } = workspace({ foo: {}, "not-a-case": {}, "CASE-0": {} });
    const { exec, calls } = execFake({});
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "no-case",
    });
    assert.equal(calls.length, 0);
  });

  it("ignores a non-matching directory beside a Case", async () => {
    const { fs } = workspace({ foo: {}, "CASE-3": {} });
    const { exec, calls } = execFake({ runResult: ok({ exit_code: 0 }) });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "converged",
    });
    const status = calls.find((call) => call[1] === "status");
    assert.equal(status?.[status.length - 1], join(DEBUG_ROOT, "CASE-3"));
  });

  it("silences closed when the highest-numbered Case is CLOSED", async () => {
    const { fs } = workspace({ "CASE-1": {}, "CASE-2": {} });
    const { exec, calls } = execFake({
      statusByDir: {
        [join(DEBUG_ROOT, "CASE-1")]: openStatus(),
        [join(DEBUG_ROOT, "CASE-2")]: openStatus({ lifecycle: "CLOSED" }),
      },
    });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "closed",
    });
    assert.ok(
      calls.every((call) => !call.includes(join(DEBUG_ROOT, "CASE-1"))),
    );
  });

  it("silences no-verify when the highest-numbered Case declares none", async () => {
    const { fs } = workspace({ "CASE-1": {}, "CASE-2": {} });
    const { exec } = execFake({
      statusByDir: {
        [join(DEBUG_ROOT, "CASE-1")]: openStatus(),
        [join(DEBUG_ROOT, "CASE-2")]: openStatus({ verify: null }),
      },
    });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "no-verify",
    });
  });

  it("silences closed when the Case is CLOSED", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec } = execFake({
      status: openStatus({ lifecycle: "CLOSED" }),
    });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "closed",
    });
  });

  it("silences no-verify when no verification experiment is declared", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec } = execFake({ status: openStatus({ verify: null }) });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "no-verify",
    });
  });

  it("silences no-verify when the criterion timeout is absent", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec, calls } = execFake({
      status: openStatus({
        verify: { experiment: "EX-001", command: "pytest" },
      }),
    });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "no-verify",
    });
    assert.ok(calls.every((call) => call[0] !== "experiment"));
  });

  it("silences no-verify when the criterion timeout is not a positive integer", async () => {
    for (const timeout_ms of [0, -1, 1.5, "60000"]) {
      const { fs } = workspace({ "CASE-1": {} });
      const { exec, calls } = execFake({
        status: openStatus({
          verify: { experiment: "EX-001", command: "pytest", timeout_ms },
        }),
      });
      assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
        kind: "silence",
        reason: "no-verify",
      });
      assert.ok(calls.every((call) => call[0] !== "experiment"));
    }
  });

  it("does not run the experiment for any discovery silence", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec, calls } = execFake({
      status: openStatus({ lifecycle: "CLOSED" }),
    });
    await decide(ports(fs, exec), CONTEXT);
    assert.ok(calls.every((call) => call[0] !== "experiment"));
  });

  it("silences discovery-error when the fs scan throws", async () => {
    const throwingFs: AutoDebugFs = {
      listDir: async () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const { exec } = execFake({});
    assert.deepEqual(await decide(ports(throwingFs, exec), CONTEXT), {
      kind: "silence",
      reason: "discovery-error",
    });
  });

  it("distinguishes discovery-error from an empty workspace", async () => {
    const { fs } = workspace({});
    const { exec } = execFake({});
    const empty = await decide(ports(fs, exec), CONTEXT);
    assert.deepEqual(empty, { kind: "silence", reason: "no-case" });
    const throwingFs: AutoDebugFs = {
      listDir: async () => {
        throw new Error("EIO");
      },
    };
    const failed = await decide(ports(throwingFs, exec), CONTEXT);
    assert.deepEqual(failed, { kind: "silence", reason: "discovery-error" });
    assert.notDeepEqual(failed, empty);
  });
});

describe("decide — convergence branches", () => {
  it("converges when the verification experiment exits 0", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec } = execFake({ runResult: ok({ exit_code: 0 }) });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "converged",
    });
  });

  it("wakes when the verification experiment exits 1", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec } = execFake({ runResult: ok({ exit_code: 1 }) });
    const decision = await decide(ports(fs, exec), CONTEXT);
    assert.equal(decision.kind, "wake");
  });

  it("silences verify-error when the verification experiment exits >1", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec } = execFake({ runResult: ok({ exit_code: 2 }) });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "verify-error",
    });
  });

  it("silences verify-error when the port throws (binary missing)", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec } = execFake({ runThrows: new Error("spawn zdebug ENOENT") });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "verify-error",
    });
  });

  it("silences verify-error when the status probe rejects", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec } = execFake({
      statusThrows: new Error("spawn zdebug ENOENT"),
    });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "verify-error",
    });
  });

  it("silences verify-error when zdebug exits non-zero (CASE_BUSY)", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec } = execFake({
      runResult: {
        stdout: "",
        stderr: JSON.stringify({ ok: false, code: "CASE_BUSY" }),
        exitCode: 2,
      },
    });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "verify-error",
    });
  });

  it("silences verify-error when the status call fails", async () => {
    const { fs, caseDirs } = workspace({ "CASE-1": {} });
    const { exec } = execFake({
      statusResult: { stdout: "", stderr: "boom", exitCode: 2 },
    });
    assert.deepEqual(await decide(ports(fs, exec), CONTEXT), {
      kind: "silence",
      reason: "verify-error",
    });
    assert.ok(caseDirs.length === 1);
  });

  it("re-runs the pointed experiment with the Case directory located", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec, calls } = execFake({ runResult: ok({ exit_code: 0 }) });
    await decide(ports(fs, exec), CONTEXT);
    const run = calls.find((call) => call[1] === "run");
    assert.deepEqual(run, [
      "experiment",
      "run",
      "EX-001",
      "--json",
      "--case-dir",
      join(DEBUG_ROOT, "CASE-1"),
    ]);
  });

  it("leaves each zdebug call unbounded (zdebug owns the limit)", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec, calls } = execFake({
      runResult: ok({ exit_code: 1 }),
    });
    await decide(ports(fs, exec), CONTEXT);
    assert.ok(calls.length >= 2, "status probe and re-run both ran");
    assert.equal(exec.length, 2, "the port takes only args and cwd");
  });
});

describe("decide — wake text", () => {
  const facts = (overrides: Partial<WakeFacts> = {}): WakeFacts => ({
    caseId: "CASE-1",
    experiment: "EX-001",
    attemptId: "EX-001-A001",
    exitCode: 1,
    ...overrides,
  });

  it("renders the four parts of the wake", () => {
    const text = renderWakeText(facts());
    assert.ok(text.includes("判据重跑结果"), "verdict line");
    assert.ok(text.includes("实验 EX-001"), "experiment id");
    assert.ok(text.includes("Attempt EX-001-A001"), "attempt id");
    assert.ok(text.includes("退出码 1"), "exit code");
    assert.ok(
      text.includes("`zdebug case status`"),
      "read pointer: status command",
    );
    assert.ok(
      text.includes(".zoo/debug/CASE-1/summary.md"),
      "read pointer: summary path",
    );
    assert.ok(text.includes("## 续写指令"), "continue directive");
    assert.ok(text.includes("## 记录提醒"), "zdebug reminder");
  });

  it("injects no Case snapshot", () => {
    const text = renderWakeText(facts());
    assert.ok(!text.includes("支付并发测试间歇失败"), "no objective");
    assert.ok(!text.includes("## 验证判据"), "no verify section");
    assert.ok(!text.includes("## Claim 评估分布"), "no claim distribution");
    assert.ok(!text.includes("## 未结清 criterion"), "no open criterion");
    assert.ok(!text.includes("## Case 摘要"), "no summary tail");
  });

  it("marks an unrecorded attempt id instead of leaving it blank", () => {
    const text = renderWakeText(facts({ attemptId: "" }));
    assert.ok(text.includes("Attempt (未记录)"));
  });

  it("is deterministic for identical input", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const makeExec = () => execFake({ runResult: ok({ exit_code: 1 }) }).exec;
    const first = await decide(ports(fs, makeExec()), CONTEXT);
    const second = await decide(ports(fs, makeExec()), CONTEXT);
    assert.deepEqual(first, second);
  });

  it("carries the re-run verdict through a real wake decision", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec } = execFake({
      runResult: ok({ exit_code: 1, attempt_id: "EX-001-A002" }),
    });
    const decision = await decide(ports(fs, exec), CONTEXT);
    assert.equal(decision.kind, "wake");
    if (decision.kind !== "wake") return;
    assert.ok(decision.text.includes("实验 EX-001"), "experiment id");
    assert.ok(decision.text.includes("Attempt EX-001-A002"), "run attempt id");
    assert.ok(decision.text.includes("退出码 1"), "exit code");
    assert.ok(
      decision.text.includes(".zoo/debug/CASE-1/summary.md"),
      "summary read pointer",
    );
  });

  it("names the attempt from the run payload without re-reading status", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec, calls } = execFake({
      runResult: ok({ exit_code: 1, attempt_id: "EX-001-A009" }),
    });
    const decision = await decide(ports(fs, exec), CONTEXT);
    assert.equal(decision.kind, "wake");
    if (decision.kind !== "wake") return;
    assert.ok(decision.text.includes("Attempt EX-001-A009"));
    const statusCalls = calls.filter(
      (call) => call[0] === "case" && call[1] === "status",
    );
    assert.equal(statusCalls.length, 1, "status read exactly once");
  });
});

describe("decide — error attribution logging", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it("logs the fs error behind discovery-error", async () => {
    const throwingFs: AutoDebugFs = {
      listDir: async () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const { exec } = execFake({});
    await decide(ports(throwingFs, exec), CONTEXT);
    const entry = _getBufferForTesting().find(
      (e) => e.event === "discovery_error",
    );
    assert.ok(entry, "the underlying fs error is logged");
    assert.equal(entry?.level, "warn");
    assert.equal(entry?.sessionId, CONTEXT.sessionID);
    assert.ok(String(entry?.error).includes("EACCES"));
  });

  it("logs the probe error behind verify-error", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec } = execFake({
      statusThrows: new Error("spawn zdebug ENOENT"),
    });
    await decide(ports(fs, exec), CONTEXT);
    const entry = _getBufferForTesting().find(
      (e) => e.event === "status_probe_error",
    );
    assert.ok(entry, "the probe error is logged");
    assert.equal(entry?.level, "warn");
    assert.ok(String(entry?.error).includes("ENOENT"));
  });

  it("logs the re-run error behind verify-error", async () => {
    const { fs } = workspace({ "CASE-1": {} });
    const { exec } = execFake({ runThrows: new Error("spawn zdebug ENOENT") });
    await decide(ports(fs, exec), CONTEXT);
    const entry = _getBufferForTesting().find(
      (e) => e.event === "experiment_run_error",
    );
    assert.ok(entry, "the re-run error is logged");
    assert.equal(entry?.level, "warn");
    assert.ok(String(entry?.error).includes("ENOENT"));
  });
});
