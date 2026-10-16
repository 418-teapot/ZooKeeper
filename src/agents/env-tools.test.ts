/**
 * Tests for `src/agents/env-tools.ts`.
 *
 * Detection scans a PATH string (injected for determinism) for executable
 * files, so each case builds a temporary directory holding executable and
 * non-executable stubs and points the detector at it.  The prompt-rule
 * builders are asserted against known literals so the expectations never
 * recompute the way the code does.  A final suite checks that every agent
 * prompt actually embeds the built rules, so a dropped interpolation fails.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ActiveSet } from "../core/slots.js";
import { makeTmpDir } from "../testkits/tmp.js";
import { BEAVER_PROMPT } from "./beaver.js";
import { buildDolphinPrompt } from "./dolphin.js";
import { EAGLE_PROMPT } from "./eagle.js";
import { detectEnvTools, ENV_TOOLS, envToolsRules } from "./env-tools.js";
import { KIWI_PROMPT } from "./kiwi.js";
import { LYNX_PROMPT } from "./lynx.js";
import { buildMolaPrompt } from "./mola.js";
import { SPIDER_PROMPT } from "./spider.js";

/** Temporary directories created by this suite, removed by `afterEach`. */
const tmpDirs: string[] = [];

/**
 * Create a unique temporary directory and remember it for cleanup.
 *
 * The caller owns cleanup (see `testkits/tmp.ts`); recording each directory
 * here lets the single `afterEach` below remove them all.
 *
 * @param prefix - Directory-name prefix; defaults to `zoo-env-tools`.
 * @returns The absolute path of the created directory.
 */
function tmpDir(prefix = "zoo-env-tools"): string {
  const dir = makeTmpDir(prefix);
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs.length = 0;
});

/** Create an executable (0755) stub file in `dir`. */
function makeExec(dir: string, name: string): void {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
}

/** Create a non-executable (0644) stub file in `dir`. */
function makeNonExec(dir: string, name: string): void {
  const path = join(dir, name);
  writeFileSync(path, "");
  chmodSync(path, 0o644);
}

// ---------------------------------------------------------------------------
// detectEnvTools — rg
// ---------------------------------------------------------------------------

describe("detectEnvTools — rg", () => {
  it("reports rg present when an executable rg is on PATH", () => {
    const dir = tmpDir("zoo-env-tools");
    makeExec(dir, "rg");
    assert.equal(detectEnvTools(dir).rg, true);
  });

  it("reports rg absent when no rg exists", () => {
    const dir = tmpDir("zoo-env-tools");
    assert.equal(detectEnvTools(dir).rg, false);
  });

  it("reports rg absent when the rg file is not executable", () => {
    const dir = tmpDir("zoo-env-tools");
    makeNonExec(dir, "rg");
    assert.equal(detectEnvTools(dir).rg, false);
  });

  it("reports rg absent when rg is a directory", () => {
    // Directories carry the execute bit on POSIX; they must not count.
    const dir = tmpDir("zoo-env-tools");
    mkdirSync(join(dir, "rg"));
    assert.equal(detectEnvTools(dir).rg, false);
  });
});

// ---------------------------------------------------------------------------
// detectEnvTools — fd
// ---------------------------------------------------------------------------

describe("detectEnvTools — fd", () => {
  it("prefers fd over fdfind when both are executable", () => {
    const dir = tmpDir("zoo-env-tools");
    makeExec(dir, "fd");
    makeExec(dir, "fdfind");
    assert.equal(detectEnvTools(dir).fd, "fd");
  });

  it("reports fd when only fd is executable", () => {
    const dir = tmpDir("zoo-env-tools");
    makeExec(dir, "fd");
    assert.equal(detectEnvTools(dir).fd, "fd");
  });

  it("reports fdfind when only fdfind is executable", () => {
    const dir = tmpDir("zoo-env-tools");
    makeExec(dir, "fdfind");
    assert.equal(detectEnvTools(dir).fd, "fdfind");
  });

  it("reports null when neither is executable", () => {
    const dir = tmpDir("zoo-env-tools");
    makeNonExec(dir, "fd");
    makeNonExec(dir, "fdfind");
    assert.equal(detectEnvTools(dir).fd, null);
  });

  it("reports null when fd is a directory", () => {
    const dir = tmpDir("zoo-env-tools");
    mkdirSync(join(dir, "fd"));
    assert.equal(detectEnvTools(dir).fd, null);
  });
});

// ---------------------------------------------------------------------------
// detectEnvTools — PATH scanning
// ---------------------------------------------------------------------------

describe("detectEnvTools — PATH scanning", () => {
  it("scans every PATH entry", () => {
    const first = tmpDir("zoo-env-tools-a");
    const second = tmpDir("zoo-env-tools-b");
    makeExec(second, "rg");
    assert.equal(detectEnvTools(`${first}:${second}`).rg, true);
  });

  it("ignores missing directories and empty entries", () => {
    const dir = tmpDir("zoo-env-tools");
    const missing = join(dir, "does-not-exist");
    assert.deepEqual(detectEnvTools(`${missing}::${dir}`), {
      rg: false,
      fd: null,
    });
  });

  it("reports nothing for an empty PATH", () => {
    // Guards the empty-entry filter: without it an empty segment would
    // resolve tool names against the filesystem root ("/rg").
    assert.deepEqual(detectEnvTools(""), { rg: false, fd: null });
  });
});

// ---------------------------------------------------------------------------
// ENV_TOOLS
// ---------------------------------------------------------------------------

describe("ENV_TOOLS", () => {
  it("matches a fresh detection against the live process PATH", () => {
    assert.deepEqual(ENV_TOOLS, detectEnvTools());
  });
});

// ---------------------------------------------------------------------------
// envToolsRules
// ---------------------------------------------------------------------------

describe("envToolsRules", () => {
  it("defaults to the machine-level ENV_TOOLS constant", () => {
    assert.equal(envToolsRules(), envToolsRules(ENV_TOOLS));
  });

  it("emits two bullets, without a trailing newline, when both tools exist", () => {
    assert.equal(
      envToolsRules({ rg: true, fd: "fd" }),
      "- 搜索文本内容时使用 `rg`，**不得**使用 `grep`\n" +
        "- 查找文件时使用 `fd`，**不得**使用 `find`",
    );
  });

  it("emits only the rg bullet when fd is absent", () => {
    assert.equal(
      envToolsRules({ rg: true, fd: null }),
      "- 搜索文本内容时使用 `rg`，**不得**使用 `grep`",
    );
  });

  it("emits only the fd bullet when rg is absent", () => {
    assert.equal(
      envToolsRules({ rg: false, fd: "fd" }),
      "- 查找文件时使用 `fd`，**不得**使用 `find`",
    );
  });

  it("names fdfind when that is the detected command", () => {
    assert.equal(
      envToolsRules({ rg: false, fd: "fdfind" }),
      "- 查找文件时使用 `fdfind`，**不得**使用 `find`",
    );
  });

  it("returns an empty string when nothing applies", () => {
    assert.equal(envToolsRules({ rg: false, fd: null }), "");
  });
});

// ---------------------------------------------------------------------------
// Agent prompt wiring
// ---------------------------------------------------------------------------

describe("agent prompt wiring", () => {
  // Each template interpolates `envToolsRules()` once at module load, so the
  // expected text is exactly that call's output.  A host without the tools
  // yields `""`, which carries nothing to assert, hence the skip below.  A
  // host that has them fails this suite as soon as one template drops its
  // interpolation.
  const rules = envToolsRules();

  /** Poly set: every leaf agent present, so dolphin's poly variant is used. */
  const POLY_SET: ActiveSet = {
    agents: new Set([
      "dolphin",
      "mola",
      "beaver",
      "lynx",
      "spider",
      "eagle",
      "kiwi",
    ]),
    skills: new Set(),
    hooks: new Set(),
    tools: new Set(),
    commands: new Set(),
  };

  /** Mono set: no leaf agents, so dolphin's mono variant is used. */
  const MONO_SET: ActiveSet = {
    ...POLY_SET,
    agents: new Set(["dolphin", "mola"]),
  };

  const prompts: Array<[string, string]> = [
    ["beaver", BEAVER_PROMPT],
    ["mola", buildMolaPrompt(POLY_SET)],
    ["eagle", EAGLE_PROMPT],
    ["kiwi", KIWI_PROMPT],
    ["spider", SPIDER_PROMPT],
    ["lynx", LYNX_PROMPT],
    ["dolphin (poly)", buildDolphinPrompt(POLY_SET)],
    ["dolphin (mono)", buildDolphinPrompt(MONO_SET)],
  ];

  for (const [name, prompt] of prompts) {
    it(`${name} prompt embeds the env-tools rules`, {
      skip: rules === "",
    }, () => {
      assert.ok(
        prompt.includes(rules),
        `${name} prompt must embed the env-tools rules`,
      );
    });
  }
});
