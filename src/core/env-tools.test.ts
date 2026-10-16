/**
 * Tests for `detectEnvTools` / `envToolsBullets` in `src/core/env-tools.ts`.
 *
 * Detection scans a PATH string (injected for determinism) for executable
 * files, so each case builds a temporary directory holding executable and
 * non-executable stubs and points the detector at it.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTmpDir } from "../testkits/tmp.js";
import { detectEnvTools, envToolsBullets } from "./env-tools.js";

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
    const dir = makeTmpDir("zoo-env-tools");
    makeExec(dir, "rg");
    assert.equal(detectEnvTools(dir).rg, true);
  });

  it("reports rg absent when no rg exists", () => {
    const dir = makeTmpDir("zoo-env-tools");
    assert.equal(detectEnvTools(dir).rg, false);
  });

  it("reports rg absent when the rg file is not executable", () => {
    const dir = makeTmpDir("zoo-env-tools");
    makeNonExec(dir, "rg");
    assert.equal(detectEnvTools(dir).rg, false);
  });

  it("reports rg absent when rg is a directory", () => {
    // Directories carry the execute bit on POSIX; they must not count.
    const dir = makeTmpDir("zoo-env-tools");
    mkdirSync(join(dir, "rg"));
    assert.equal(detectEnvTools(dir).rg, false);
  });
});

// ---------------------------------------------------------------------------
// detectEnvTools — fd
// ---------------------------------------------------------------------------

describe("detectEnvTools — fd", () => {
  it("prefers fd over fdfind when both are executable", () => {
    const dir = makeTmpDir("zoo-env-tools");
    makeExec(dir, "fd");
    makeExec(dir, "fdfind");
    assert.equal(detectEnvTools(dir).fd, "fd");
  });

  it("reports fd when only fd is executable", () => {
    const dir = makeTmpDir("zoo-env-tools");
    makeExec(dir, "fd");
    assert.equal(detectEnvTools(dir).fd, "fd");
  });

  it("reports fdfind when only fdfind is executable", () => {
    const dir = makeTmpDir("zoo-env-tools");
    makeExec(dir, "fdfind");
    assert.equal(detectEnvTools(dir).fd, "fdfind");
  });

  it("reports null when neither is executable", () => {
    const dir = makeTmpDir("zoo-env-tools");
    makeNonExec(dir, "fd");
    makeNonExec(dir, "fdfind");
    assert.equal(detectEnvTools(dir).fd, null);
  });
});

// ---------------------------------------------------------------------------
// detectEnvTools — PATH scanning
// ---------------------------------------------------------------------------

describe("detectEnvTools — PATH scanning", () => {
  it("scans every PATH entry", () => {
    const first = makeTmpDir("zoo-env-tools-a");
    const second = makeTmpDir("zoo-env-tools-b");
    makeExec(second, "rg");
    assert.equal(detectEnvTools(`${first}:${second}`).rg, true);
  });

  it("ignores missing directories and empty entries", () => {
    const dir = makeTmpDir("zoo-env-tools");
    const missing = join(dir, "does-not-exist");
    assert.deepEqual(detectEnvTools(`${missing}::${dir}`), {
      rg: false,
      fd: null,
    });
  });

  it("reports nothing for an empty PATH", () => {
    // Guards the empty-entry filter in detectEnvTools: without it an empty
    // segment would resolve tool names against the filesystem root ("/rg").
    assert.deepEqual(detectEnvTools(""), { rg: false, fd: null });
  });
});

// ---------------------------------------------------------------------------
// envToolsBullets
// ---------------------------------------------------------------------------

describe("envToolsBullets", () => {
  it("emits two bullets when both tools exist", () => {
    assert.equal(
      envToolsBullets({ rg: true, fd: "fd" }),
      "- 搜索文本内容时使用 `rg`，**不得**使用 `grep`\n" +
        "- 查找文件时使用 `fd`，**不得**使用 `find`",
    );
  });

  it("emits only the rg bullet when fd is absent", () => {
    assert.equal(
      envToolsBullets({ rg: true, fd: null }),
      "- 搜索文本内容时使用 `rg`，**不得**使用 `grep`",
    );
  });

  it("emits only the fd bullet when rg is absent", () => {
    assert.equal(
      envToolsBullets({ rg: false, fd: "fd" }),
      "- 查找文件时使用 `fd`，**不得**使用 `find`",
    );
  });

  it("names fdfind when that is the detected command", () => {
    assert.equal(
      envToolsBullets({ rg: false, fd: "fdfind" }),
      "- 查找文件时使用 `fdfind`，**不得**使用 `find`",
    );
  });

  it("emits nothing when neither tool exists", () => {
    assert.equal(envToolsBullets({ rg: false, fd: null }), "");
  });
});
