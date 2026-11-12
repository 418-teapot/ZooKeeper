/**
 * Tests for src/core/skills.ts — the generation skill catalog.
 *
 * The boundary is the two pure steps a generation runs once: `discoverSkills`
 * reads a directory into an immutable snapshot, and `selectSkills` picks the
 * profile names out of it.  A temporary directory stands in for the real
 * `skills/` folder, so every expectation is an independent literal path.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { makeTmpDir } from "../testkits/tmp.js";
import type { SkillPermissionRule } from "./permissions/skill-permissions.js";
import {
  discoverSkills,
  filterSkillEntries,
  type SkillEntry,
  selectSkills,
} from "./skills.js";

const dirs: string[] = [];

/** A temporary skills directory, removed after the test. */
function skillsDir(): string {
  const dir = makeTmpDir("zoo-skills-test");
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe("discoverSkills", () => {
  it("reports every subdirectory as an entry, sorted by name", () => {
    const dir = skillsDir();
    // Created out of order to prove the snapshot order is deterministic.
    mkdirSync(join(dir, "zebra"));
    mkdirSync(join(dir, "alpha"));
    mkdirSync(join(dir, "mike"));

    assert.deepEqual(discoverSkills(dir), {
      entries: [
        { name: "alpha", path: join(dir, "alpha") },
        { name: "mike", path: join(dir, "mike") },
        { name: "zebra", path: join(dir, "zebra") },
      ],
      invalid: [],
      error: null,
    });
  });

  it("accepts a directory without SKILL.md", () => {
    const dir = skillsDir();
    mkdirSync(join(dir, "empty-dir"));

    assert.deepEqual(discoverSkills(dir).entries, [
      { name: "empty-dir", path: join(dir, "empty-dir") },
    ]);
  });

  it("accepts a symbolic link to a directory", () => {
    const dir = skillsDir();
    const target = join(skillsDir(), "target");
    mkdirSync(target);
    symlinkSync(target, join(dir, "linked"), "dir");

    assert.deepEqual(discoverSkills(dir).entries, [
      { name: "linked", path: join(dir, "linked") },
    ]);
  });

  it("reports plain files and broken links as invalid, keeping the rest", () => {
    const dir = skillsDir();
    mkdirSync(join(dir, "real-skill"));
    writeFileSync(join(dir, "notes.txt"), "x", "utf-8");
    symlinkSync(join(dir, "no-such-target"), join(dir, "dangling"), "dir");

    const snapshot = discoverSkills(dir);

    assert.deepEqual(snapshot.entries, [
      { name: "real-skill", path: join(dir, "real-skill") },
    ]);
    assert.deepEqual(snapshot.invalid, ["dangling", "notes.txt"]);
    assert.equal(snapshot.error, null);
  });

  it("reports a root read failure instead of throwing", () => {
    const dir = skillsDir();
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x", "utf-8");

    const snapshot = discoverSkills(file);

    assert.deepEqual(snapshot.entries, []);
    assert.deepEqual(snapshot.invalid, []);
    assert.ok(snapshot.error?.includes("ENOTDIR"));
  });

  it("reports a missing directory as a root read failure", () => {
    const snapshot = discoverSkills(join(skillsDir(), "missing"));

    assert.deepEqual(snapshot.entries, []);
    assert.ok(snapshot.error?.includes("ENOENT"));
  });
});

describe("selectSkills", () => {
  /** A snapshot with two usable skills and one invalid entry. */
  function snapshot() {
    return {
      entries: [
        { name: "alpha", path: "/skills/alpha" },
        { name: "beta", path: "/skills/beta" },
      ],
      invalid: ["broken"],
      error: null,
    };
  }

  it("selects the profile names in profile order", () => {
    const selection = selectSkills(snapshot(), ["beta", "alpha"]);

    assert.deepEqual(selection.selected, [
      { name: "beta", path: "/skills/beta" },
      { name: "alpha", path: "/skills/alpha" },
    ]);
    assert.deepEqual(selection.missing, []);
    assert.deepEqual(selection.invalid, []);
  });

  it("skips an absent name and reports it as missing", () => {
    const selection = selectSkills(snapshot(), ["alpha", "ghost"]);

    assert.deepEqual(selection.selected, [
      { name: "alpha", path: "/skills/alpha" },
    ]);
    assert.deepEqual(selection.missing, ["ghost"]);
    assert.deepEqual(selection.invalid, []);
  });

  it("reports an unusable entry as invalid, not missing", () => {
    const selection = selectSkills(snapshot(), ["broken", "ghost"]);

    assert.deepEqual(selection.selected, []);
    assert.deepEqual(selection.invalid, ["broken"]);
    assert.deepEqual(selection.missing, ["ghost"]);
  });

  it("selects a name the profile lists twice once", () => {
    const selection = selectSkills(snapshot(), ["alpha", "alpha"]);

    assert.deepEqual(selection.selected, [
      { name: "alpha", path: "/skills/alpha" },
    ]);
  });

  it("selects nothing when the profile names no skills", () => {
    assert.deepEqual(selectSkills(snapshot(), []), {
      selected: [],
      missing: [],
      invalid: [],
    });
  });
});

describe("filterSkillEntries", () => {
  const ENTRIES: SkillEntry[] = [
    { name: "wiki-query", path: "/skills/wiki-query" },
    { name: "beaver-tdd", path: "/skills/beaver-tdd" },
  ];
  const RULES: SkillPermissionRule[] = [
    { pattern: "*", action: "deny" },
    { pattern: "wiki-query", action: "allow" },
  ];

  it("passes every entry through without rules", () => {
    assert.deepEqual(filterSkillEntries(ENTRIES, undefined), ENTRIES);
  });

  it("keeps the entries the rules allow", () => {
    assert.deepEqual(filterSkillEntries(ENTRIES, RULES), [ENTRIES[0]]);
  });
});
