/**
 * Tests for src/core/skills.ts — the shared profile skill-directory scan.
 *
 * A temporary directory stands in for the real `skills/` folder, so the
 * filtering (profile-listed and directory) and the error paths (ENOENT is
 * silent, other errors log a warning without throwing) are exercised
 * without touching the repository's actual skills.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { restoreEnv, saveEnv } from "../testkits/env.js";
import { makeTmpDir } from "../testkits/tmp.js";
import { _getBufferForTesting, _resetForTesting } from "../utils/logger.js";
import { scanSkillDirectories } from "./skills.js";

/** Capture debug-level entries (the `skill_registered` hit) in the buffer. */
let origZooDebug: string | undefined;

beforeEach(() => {
  origZooDebug = saveEnv("ZOO_DEBUG");
  process.env.ZOO_DEBUG = "1";
  _resetForTesting();
});

afterEach(() => {
  restoreEnv("ZOO_DEBUG", origZooDebug);
  _resetForTesting();
});

/** Buffered entries matching the given event name. */
function events(name: string): Array<Record<string, unknown>> {
  return _getBufferForTesting().filter((entry) => entry.event === name);
}

describe("scanSkillDirectories", () => {
  it("returns only profile-listed directories", () => {
    const dir = makeTmpDir("zoo-skills");
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, "beta"));
    // Not a directory — a listed file must still be skipped.
    writeFileSync(join(dir, "gamma"), "");

    const result = scanSkillDirectories(dir, ["alpha", "beta", "gamma"]);

    assert.deepEqual(result.slice().sort(), [
      join(dir, "alpha"),
      join(dir, "beta"),
    ]);
  });

  it("skips a directory absent from the profile list", () => {
    const dir = makeTmpDir("zoo-skills");
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, "beta"));

    const result = scanSkillDirectories(dir, ["alpha"]);

    assert.deepEqual(result, [join(dir, "alpha")]);
  });

  it("returns an empty list when the profile names no skills", () => {
    const dir = makeTmpDir("zoo-skills");
    mkdirSync(join(dir, "alpha"));

    assert.deepEqual(scanSkillDirectories(dir, []), []);
  });

  it("logs skill_registered once per registered skill", () => {
    const dir = makeTmpDir("zoo-skills");
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, "beta"));

    scanSkillDirectories(dir, ["alpha", "beta"]);

    const hits = events("skill_registered");
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((entry) => entry.skill).sort(), [
      "alpha",
      "beta",
    ]);
  });

  it("returns an empty list silently when the directory is missing", () => {
    const dir = join(makeTmpDir("zoo-skills"), "does-not-exist");

    assert.deepEqual(scanSkillDirectories(dir, ["alpha"]), []);
    assert.equal(events("skill_register_error").length, 0);
  });

  it("logs a warning and returns empty on a non-ENOENT error", () => {
    // A regular file triggers ENOTDIR from readdirSync — not ENOENT.
    const dir = makeTmpDir("zoo-skills");
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "");

    assert.deepEqual(scanSkillDirectories(file, ["alpha"]), []);

    const warnings = events("skill_register_error");
    assert.equal(warnings.length, 1);
    assert.ok(String(warnings[0].error).includes("ENOTDIR"));
  });
});
