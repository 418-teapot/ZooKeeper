/**
 * Tests for the skill-unit discovery in `src/registry.ts`.
 *
 * Covers `discoverSkillUnits` in isolation with temporary directories:
 * sorted data-only unit generation from skill subdirectories,
 * exclusion of non-directory entries, symlink-to-directory following,
 * broken-link skipping, and fail-closed empty results for a missing
 * directory or a non-directory path.  The real core/skills/ contents are
 * exercised by the behavior tests (`registerSkills` in
 * `src/index.test.ts`, `collectSkillPaths` in `src/pi.test.ts`).
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ActiveSet, Deps } from "./core/slots.js";
import { discoverSkillUnits } from "./registry.js";

/** Minimal typed create() arguments; skill units ignore both. */
const DEPS: Deps = {
  limits: {},
  contextConfig: {},
  client: {},
  directory: "/tmp/zoo",
  resolveAgent: () => undefined,
};
const ACTIVE_SET: ActiveSet = {
  agents: new Set(),
  skills: new Set(),
  hooks: new Set(),
  tools: new Set(),
  commands: new Set(),
};

// ---------------------------------------------------------------------------
// Temporary directory helpers
// ---------------------------------------------------------------------------

let _counter = 0;
const dirs: string[] = [];

function tmpDir(): string {
  const dir = join(tmpdir(), `zoo-registry-test-${Date.now()}-${_counter++}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

// ---------------------------------------------------------------------------
// discoverSkillUnits
// ---------------------------------------------------------------------------

describe("discoverSkillUnits", () => {
  it("generates sorted, data-only units from the skill subdirectories", () => {
    const dir = tmpDir();
    // Created out of order to prove the returned units come back sorted.
    mkdirSync(join(dir, "zebra"));
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, "mike"));

    const units = discoverSkillUnits(dir);

    assert.deepEqual(
      units.map((u) => u.name),
      ["alpha", "mike", "zebra"],
    );
    for (const unit of units) {
      assert.equal(unit.kind, "skill");
      assert.deepEqual(unit.create(DEPS, ACTIVE_SET), {
        kind: "skill",
        skills: [{ name: unit.name }],
      });
    }
  });

  it("excludes non-directory entries (plain files)", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "a-real-skill"));
    writeFileSync(join(dir, "not-a-skill.txt"), "plain file", "utf-8");

    const units = discoverSkillUnits(dir);

    assert.deepEqual(
      units.map((u) => u.name),
      ["a-real-skill"],
    );
  });

  it("follows a symbolic link that points to a real directory", () => {
    const dir = tmpDir();
    const target = join(tmpDir(), "target-skill-dir");
    mkdirSync(target);
    symlinkSync(target, join(dir, "linked-skill"), "dir");

    const units = discoverSkillUnits(dir);

    assert.deepEqual(
      units.map((u) => u.name),
      ["linked-skill"],
    );
    for (const unit of units) {
      assert.equal(unit.kind, "skill");
      assert.deepEqual(unit.create(DEPS, ACTIVE_SET), {
        kind: "skill",
        skills: [{ name: unit.name }],
      });
    }
  });

  it("skips a broken symbolic link and keeps the other entries", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "real-skill"));
    symlinkSync(join(dir, "no-such-target"), join(dir, "dangling-link"), "dir");

    const units = discoverSkillUnits(dir);

    assert.deepEqual(
      units.map((u) => u.name),
      ["real-skill"],
    );
  });

  it("returns an empty list when the directory does not exist", () => {
    const units = discoverSkillUnits(join(tmpDir(), "missing"));
    assert.deepEqual(units, []);
  });

  it("returns an empty list when the path is not a directory", () => {
    const dir = tmpDir();
    const file = join(dir, "file.txt");
    writeFileSync(file, "x", "utf-8");

    assert.deepEqual(discoverSkillUnits(file), []);
  });
});
