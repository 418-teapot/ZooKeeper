/**
 * Tests for the `/debug` command unit (src/commands/debug/).
 *
 * Covers the objective-passthrough contract (raw arguments verbatim into
 * `--objective`), the empty-arguments usage hint, the unavailable-binary
 * and CLI business-error paths, and the unit descriptor shape.  The
 * `zdebug` runner is a fake `ZdebugExec` that records every invocation —
 * no real binary runs — and the host is a `ToolHost` mock that records
 * notifications and toasts.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ToastPayload, ToolHost } from "../../core/client/tool-host.js";
import type {
  AutoDebugDirEntry,
  AutoDebugFs,
  CommandUnitDescriptor,
  MessageInjector,
  ZdebugExec,
  ZdebugExecResult,
} from "../../core/slots.js";
import { _resetForTesting } from "../../utils/logger.js";
import {
  buildStartupText,
  handleDebugCommand,
  MAX_CASE_ID_ATTEMPTS,
} from "./command.js";
import { unit } from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The session workspace the descriptor tests inject. */
const WORKSPACE = "/workspace/zoo";

/** Case root the handler scans under {@link WORKSPACE}. */
const DEBUG_ROOT = `${WORKSPACE}/.zoo/debug`;

/**
 * Build a fake read-only filesystem listing `names` under the Case root.
 *
 * The returned `entries` array is the live backing store, so a test can
 * push a directory to simulate a concurrent `/debug` winning the id.
 */
function makeFakeFs(names: string[] = []): {
  fs: AutoDebugFs;
  entries: AutoDebugDirEntry[];
} {
  const entries: AutoDebugDirEntry[] = names.map((name) => ({
    name,
    isDirectory: true,
  }));
  return {
    entries,
    fs: {
      listDir: async (path) => (path === DEBUG_ROOT ? entries : []),
    },
  };
}

/** Derive the expected title the handler should compute. */
function expectedTitle(objective: string): string {
  return objective.replace(/\s+/gu, " ").trim();
}

/** One recorded fake invocation. */
interface FakeCall {
  args: readonly string[];
  cwd: string;
}

/**
 * Build a fake `ZdebugExec` that records calls and resolves with `result`
 * (or rejects with `error`).
 */
function makeFakeExec(options: { result?: ZdebugExecResult; error?: Error }): {
  exec: ZdebugExec;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const exec: ZdebugExec = async (args, cwd) => {
    calls.push({ args, cwd });
    if (options.error) throw options.error;
    return options.result ?? { stdout: "", stderr: "", exitCode: 0 };
  };
  return { exec, calls };
}

/**
 * Build a mock tool host that records notifications and toasts.
 *
 * Pass `{ withToast: false }` to model a host that wires no toast port.
 */
function makeToolHost(options: { withToast?: boolean } = {}): {
  toolHost: ToolHost;
  notifyCalls: Array<{ sessionID: string; text: string }>;
  toastCalls: Array<{ sessionID: string; toast: ToastPayload }>;
} {
  const notifyCalls: Array<{ sessionID: string; text: string }> = [];
  const toastCalls: Array<{ sessionID: string; toast: ToastPayload }> = [];
  const toolHost: ToolHost = {
    resolveSessionId: () => undefined,
    notify: async (sessionID, text) => {
      notifyCalls.push({ sessionID, text });
    },
  };
  if (options.withToast !== false) {
    toolHost.toast = (sessionID, toast) => {
      toastCalls.push({ sessionID, toast });
    };
  }
  return { toolHost, notifyCalls, toastCalls };
}

/**
 * Build a fake message injector that records injections and optionally
 * rejects with `error`.
 */
function makeInjector(options: { error?: Error } = {}): {
  injector: MessageInjector;
  calls: Array<{ sessionID: string; text: string }>;
} {
  const calls: Array<{ sessionID: string; text: string }> = [];
  return {
    calls,
    injector: {
      inject: async (sessionID, text) => {
        calls.push({ sessionID, text });
        if (options.error) throw options.error;
      },
    },
  };
}

/** Build a `create`-compatible Deps/ActiveSet pair for the debug unit. */
function makeDeps(
  overrides: Partial<Parameters<CommandUnitDescriptor["create"]>[0]> = {},
): Parameters<CommandUnitDescriptor["create"]>[0] {
  return {
    limits: {},
    contextConfig: {},
    client: {},
    directory: WORKSPACE,
    resolveAgent: () => undefined,
    ...overrides,
  };
}

function makeActiveSet(): Parameters<CommandUnitDescriptor["create"]>[1] {
  return {
    agents: new Set(),
    skills: new Set(),
    hooks: new Set(),
    tools: new Set(),
    commands: new Set(),
  };
}

/**
 * Run the contributed `/debug` command through the unit descriptor.
 *
 * @returns The mock host notifications recorded during the run.
 */
async function runCommand(
  args: string,
  exec: ZdebugExec,
  toolHost: ToolHost,
  fs: AutoDebugFs = makeFakeFs().fs,
  injector: MessageInjector = makeInjector().injector,
): Promise<void> {
  const contributions = unit.create(
    makeDeps({
      zdebugExec: exec,
      toolHost,
      autoDebugFs: fs,
      messageInjector: injector,
    }),
    makeActiveSet(),
  );
  assert.equal(contributions.kind, "command");
  assert.equal(contributions.commands.length, 1);
  await contributions.commands[0].handle({
    command: "debug",
    sessionID: "sess-debug",
    arguments: args,
  });
}

afterEach(() => {
  _resetForTesting();
});

// ---------------------------------------------------------------------------
// Unit descriptor shape
// ---------------------------------------------------------------------------

describe("/debug unit descriptor", () => {
  it("declares a single debug command unit", () => {
    assert.equal(unit.name, "debug");
    assert.equal(unit.kind, "command");
    const contributions = unit.create(makeDeps(), makeActiveSet());
    assert.equal(contributions.kind, "command");
    assert.equal(contributions.commands.length, 1);
    assert.equal(contributions.commands[0].name, "debug");
    assert.ok(contributions.commands[0].description.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Objective passthrough
// ---------------------------------------------------------------------------

describe("/debug objective passthrough", () => {
  it("forwards the raw arguments verbatim as --objective", async () => {
    const objective =
      '修复  登录 失败：用户 "A" 无法登录 (timeout?)，见 #42 & 日志\t行尾  ';
    const { exec, calls } = makeFakeExec({});
    const { toolHost } = makeToolHost();

    await runCommand(objective, exec, toolHost);

    assert.equal(calls.length, 1);
    const args = calls[0].args;
    const objectiveIndex = args.indexOf("--objective");
    assert.ok(objectiveIndex >= 0, "expected a --objective flag");
    // Element-by-element: every argument matches the expected array, and
    // the objective element is byte-identical to the raw input.
    assert.equal(args[objectiveIndex + 1], objective);
    const caseId = args[args.indexOf("case") + 2];
    assert.equal(caseId, "CASE-1");
    assert.deepEqual(
      [...args],
      [
        "case",
        "init",
        caseId,
        "--json",
        "--title",
        expectedTitle(objective),
        "--objective",
        objective,
        "--workspace",
        "/workspace/zoo",
      ],
    );
    assert.equal(calls[0].cwd, WORKSPACE);
  });

  it("passes a long objective to the title without truncation", async () => {
    const objective = `调查${"很长".repeat(40)}的目标`;
    const { exec, calls } = makeFakeExec({});
    const { toolHost } = makeToolHost();

    await runCommand(objective, exec, toolHost);

    const args = calls[0].args;
    const title = args[args.indexOf("--title") + 1];
    assert.equal(title, expectedTitle(objective));
    assert.equal(args[args.indexOf("--objective") + 1], objective);
  });

  it("notifies the new Case id and injects the startup message on success", async () => {
    const { exec, calls } = makeFakeExec({
      result: { stdout: '{"ok":true,"result":{}}', stderr: "", exitCode: 0 },
    });
    const { toolHost, notifyCalls } = makeToolHost();
    const { injector, calls: injectCalls } = makeInjector();

    await runCommand("调查登录失败", exec, toolHost, undefined, injector);

    const caseId = calls[0].args[calls[0].args.indexOf("case") + 2];
    assert.equal(notifyCalls.length, 1);
    assert.ok(notifyCalls[0].text.includes(caseId));
    assert.ok(notifyCalls[0].text.includes("已创建调试 Case"));
    // The injector received the model-visible startup message: Case id,
    // Case directory, objective verbatim, and the skill instruction.
    assert.equal(injectCalls.length, 1);
    assert.equal(injectCalls[0].sessionID, "sess-debug");
    assert.equal(injectCalls[0].text, buildStartupText(caseId, "调查登录失败"));
    assert.ok(injectCalls[0].text.includes(caseId));
    assert.ok(injectCalls[0].text.includes(".zoo/debug/"));
    assert.ok(injectCalls[0].text.includes("调查登录失败"));
    assert.ok(injectCalls[0].text.includes("auto-debug"));
  });

  it("reports the created Case when the injector is missing", async () => {
    const { exec } = makeFakeExec({});
    const { toolHost, notifyCalls } = makeToolHost();

    // Bare handler with no injector wired (a host that provides none).
    await handleDebugCommand(toolHost, "sess-debug", "调查目标", {
      zdebugExec: exec,
      fs: makeFakeFs().fs,
      directory: WORKSPACE,
      messageInjector: undefined,
    });

    assert.equal(notifyCalls.length, 1);
    assert.ok(notifyCalls[0].text.includes("已创建调试 Case"));
    assert.ok(notifyCalls[0].text.includes("未能自动启动"));
  });

  it("reports the created Case when injection fails", async () => {
    const { exec } = makeFakeExec({});
    const { toolHost, notifyCalls } = makeToolHost();
    const { injector, calls: injectCalls } = makeInjector({
      error: new Error("promptAsync rejected"),
    });

    await runCommand("调查登录失败", exec, toolHost, undefined, injector);

    assert.equal(injectCalls.length, 1);
    // The Case exists, so the failure notice names it and tells the user
    // to load the skill manually; the handler does not rethrow.
    assert.equal(notifyCalls.length, 1);
    assert.ok(notifyCalls[0].text.includes("已创建调试 Case"));
    assert.ok(notifyCalls[0].text.includes("未能自动启动"));
    assert.ok(notifyCalls[0].text.includes("promptAsync rejected"));
    assert.ok(notifyCalls[0].text.includes("auto-debug"));
    assert.ok(!notifyCalls[0].text.includes("已请求立即开始调查"));
  });

  it("toasts the inject failure as a fallback to the notification", async () => {
    const { exec } = makeFakeExec({});
    const { toolHost, notifyCalls, toastCalls } = makeToolHost();
    const { injector } = makeInjector({
      error: new Error("promptAsync rejected"),
    });

    await runCommand("调查登录失败", exec, toolHost, undefined, injector);

    // The persisted notification is not enough on hosts that suppress
    // it in this exact situation, so a toast carries the same message.
    assert.equal(notifyCalls.length, 1);
    assert.equal(toastCalls.length, 1);
    assert.equal(toastCalls[0].sessionID, "sess-debug");
    assert.equal(toastCalls[0].toast.source, "debug");
    assert.equal(toastCalls[0].toast.level, "warning");
    assert.ok(toastCalls[0].toast.text.includes("CASE-1"));
    assert.ok(toastCalls[0].toast.text.includes("未能自动启动"));
    assert.equal(toastCalls[0].toast.text, notifyCalls[0].text);
  });

  it("toasts the failure when no injector is wired", async () => {
    const { exec } = makeFakeExec({});
    const { toolHost, toastCalls } = makeToolHost();

    await handleDebugCommand(toolHost, "sess-debug", "调查目标", {
      zdebugExec: exec,
      fs: makeFakeFs().fs,
      directory: WORKSPACE,
      messageInjector: undefined,
    });

    assert.equal(toastCalls.length, 1);
    assert.equal(toastCalls[0].toast.source, "debug");
    assert.equal(toastCalls[0].toast.level, "warning");
    assert.ok(toastCalls[0].toast.text.includes("未能自动启动"));
  });

  it("does not throw when the host has no toast surface", async () => {
    const { exec } = makeFakeExec({});
    const { toolHost, notifyCalls, toastCalls } = makeToolHost({
      withToast: false,
    });
    const { injector } = makeInjector({
      error: new Error("promptAsync rejected"),
    });

    await assert.doesNotReject(() =>
      runCommand("调查登录失败", exec, toolHost, undefined, injector),
    );

    assert.equal(notifyCalls.length, 1);
    assert.equal(toastCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Startup text display path
// ---------------------------------------------------------------------------

describe("/debug startup text path", () => {
  it("renders the Case directory with forward slashes", () => {
    // The zdebug layout and its docs use `/`; the model must see the
    // same on every platform (no `.zoo\\debug\\CASE-1`).
    const text = buildStartupText("CASE-7", "调查目标");
    assert.ok(text.includes(".zoo/debug/CASE-7/"));
    assert.ok(!text.includes("\\"));
  });
});

// ---------------------------------------------------------------------------
// Empty arguments
// ---------------------------------------------------------------------------

describe("/debug empty arguments", () => {
  it("shows a usage hint and creates no Case", async () => {
    for (const args of ["", "   ", "\n\t "]) {
      const { exec, calls } = makeFakeExec({});
      const { toolHost, notifyCalls } = makeToolHost();

      await runCommand(args, exec, toolHost);

      assert.equal(calls.length, 0, "must not invoke zdebug");
      assert.equal(notifyCalls.length, 1);
      assert.ok(notifyCalls[0].text.includes("用法"));
    }
  });
});

// ---------------------------------------------------------------------------
// Sequential id allocation
// ---------------------------------------------------------------------------

describe("/debug sequential case ids", () => {
  /** Read the Case id the handler placed on one invocation. */
  function caseIdOf(args: readonly string[]): string {
    return args[args.indexOf("case") + 2];
  }

  it("starts at CASE-1 when the workspace has no Case", async () => {
    const { fs } = makeFakeFs([]);
    const { exec, calls } = makeFakeExec({});
    const { toolHost } = makeToolHost();

    await runCommand("新目标", exec, toolHost, fs);

    assert.equal(caseIdOf(calls[0].args), "CASE-1");
  });

  it("continues past the highest existing CASE-n", async () => {
    // Non-Case entries are ignored and the gap at CASE-2 is not reused.
    const { fs } = makeFakeFs(["CASE-1", "CASE-3", "not-a-case", "CASE-x"]);
    const { exec, calls } = makeFakeExec({});
    const { toolHost } = makeToolHost();

    await runCommand("新目标", exec, toolHost, fs);

    assert.equal(caseIdOf(calls[0].args), "CASE-4");
  });

  it("rescans and retries when a concurrent Case claims the id", async () => {
    const { fs, entries } = makeFakeFs(["CASE-1", "CASE-3"]);
    const { toolHost } = makeToolHost();
    const calls: FakeCall[] = [];
    let first = true;
    const exec: ZdebugExec = async (args, cwd) => {
      calls.push({ args, cwd });
      if (first) {
        first = false;
        // The concurrent `/debug` that won CASE-4 leaves it on disk.
        entries.push({ name: "CASE-4", isDirectory: true });
        return {
          stdout: "",
          stderr:
            '{"code":"CASE_EXISTS","details":{},"message":"taken","ok":false}',
          exitCode: 2,
        };
      }
      return { stdout: '{"ok":true,"result":{}}', stderr: "", exitCode: 0 };
    };

    await runCommand("新目标", exec, toolHost, fs);

    assert.equal(calls.length, 2);
    assert.equal(caseIdOf(calls[0].args), "CASE-4");
    assert.equal(caseIdOf(calls[1].args), "CASE-5");
  });

  it("fails after the retry cap instead of spinning", async () => {
    const { fs } = makeFakeFs(["CASE-1"]);
    const { exec, calls } = makeFakeExec({
      result: {
        stdout: "",
        stderr:
          '{"code":"CASE_EXISTS","details":{},"message":"taken","ok":false}',
        exitCode: 2,
      },
    });
    const { toolHost, notifyCalls } = makeToolHost();

    await runCommand("新目标", exec, toolHost, fs);

    assert.equal(calls.length, MAX_CASE_ID_ATTEMPTS);
    assert.equal(notifyCalls.length, 1);
    assert.ok(notifyCalls[0].text.includes("创建调试 Case 失败"));
    assert.ok(!notifyCalls[0].text.includes("已创建调试 Case"));
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe("/debug failure paths", () => {
  it("reports a Chinese error when the binary is unavailable", async () => {
    const { exec, calls } = makeFakeExec({
      error: new Error("spawn zdebug ENOENT"),
    });
    const { toolHost, notifyCalls } = makeToolHost();

    // The unit handler swallows the failure (no unhandled rejection).
    await runCommand("调查登录失败", exec, toolHost);

    assert.equal(calls.length, 1);
    assert.equal(notifyCalls.length, 1);
    assert.ok(notifyCalls[0].text.includes("zdebug"));
    assert.ok(notifyCalls[0].text.includes("无法运行"));
    assert.ok(!notifyCalls[0].text.includes("已创建调试 Case"));
  });

  it("reports a Chinese error on a non-retryable CLI business error", async () => {
    const { exec, calls } = makeFakeExec({
      result: {
        stdout: "",
        stderr:
          '{"code":"INVALID_ID","details":{},"message":"bad id","ok":false}',
        exitCode: 2,
      },
    });
    const { toolHost, notifyCalls } = makeToolHost();

    await runCommand("调查登录失败", exec, toolHost);

    // A non-CASE_EXISTS business error is surfaced as-is, without retry.
    assert.equal(calls.length, 1);
    assert.equal(notifyCalls.length, 1);
    assert.ok(notifyCalls[0].text.includes("创建调试 Case 失败"));
    assert.ok(notifyCalls[0].text.includes("INVALID_ID"));
    assert.ok(!notifyCalls[0].text.includes("已创建调试 Case"));
  });

  it("falls back to the exit code when stderr is not an envelope", async () => {
    const { exec } = makeFakeExec({
      result: { stdout: "", stderr: "segfault", exitCode: 7 },
    });
    const { toolHost, notifyCalls } = makeToolHost();

    await runCommand("调查登录失败", exec, toolHost);

    assert.equal(notifyCalls.length, 1);
    assert.ok(notifyCalls[0].text.includes("退出码 7"));
  });

  it("throws a Chinese error from the bare handler", async () => {
    const { exec } = makeFakeExec({ error: new Error("ENOENT") });
    await assert.rejects(
      () =>
        handleDebugCommand(makeToolHost().toolHost, "sess", "目标", {
          zdebugExec: exec,
          fs: makeFakeFs().fs,
          directory: WORKSPACE,
          messageInjector: undefined,
        }),
      /无法运行 zdebug/,
    );
  });

  it("does not impose a launch timeout on the CLI", async () => {
    const { exec } = makeFakeExec({});
    const { toolHost } = makeToolHost();

    await runCommand("目标", exec, toolHost);
    assert.equal(exec.length, 2, "the port takes only args and cwd");
  });
});
