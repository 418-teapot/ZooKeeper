/**
 * Tests for the skill-unit discovery in `src/registry.ts`.
 *
 * Covers `discoverSkillUnits` in isolation with temporary directories:
 * sorted data-only unit generation from skill subdirectories,
 * exclusion of non-directory entries, symlink-to-directory following,
 * broken-link skipping, and fail-closed empty results for a missing
 * directory or a non-directory path.  The real skills/ contents are
 * exercised by the behavior tests (`collectSkillPaths` in
 * `src/pi.test.ts`, the profile scan of the OpenCode start publisher in
 * `src/adapters/opencode/publisher.test.ts`).
 *
 * The capability declarations of every registry unit are also checked
 * here: each key appears at most once per list and in one list only.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Capabilities } from "./core/ports/index.js";
import { discoverSkillUnits, REGISTRY } from "./registry.js";
import { facts } from "./testkits/compose.js";
import { makeTmpDir } from "./testkits/tmp.js";

/** Minimal typed create() arguments; skill units ignore both. */
const DEPS: Partial<Capabilities> = {
  limits: {},
  contextConfig: {},
  directory: "/tmp/zoo",
  resolveAgent: () => undefined,
};
const ACTIVE_SET = facts();

// ---------------------------------------------------------------------------
// Temporary directory helpers
// ---------------------------------------------------------------------------

const dirs: string[] = [];

function tmpDir(): string {
  const dir = makeTmpDir("zoo-registry-test");
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

// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------

describe("REGISTRY — capability declarations", () => {
  it("declares each key at most once per unit", () => {
    for (const unit of REGISTRY) {
      assert.equal(
        new Set(unit.needs).size,
        unit.needs.length,
        `${unit.name} repeats a key in needs`,
      );
      assert.equal(
        new Set(unit.wants).size,
        unit.wants.length,
        `${unit.name} repeats a key in wants`,
      );
    }
  });

  it("declares no key as both a need and a want", () => {
    for (const unit of REGISTRY) {
      const wanted = new Set(unit.wants);

      assert.deepEqual(
        unit.needs.filter((key) => wanted.has(key)),
        [],
        `${unit.name} declares one key in both lists`,
      );
    }
  });
});
