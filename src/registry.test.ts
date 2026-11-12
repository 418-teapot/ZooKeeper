/**
 * Tests for the unit registry in `src/registry.ts`.
 *
 * The registry is a static declaration now: it holds the units the
 * assembly pipeline orders, and nothing else — a skill is a selectable
 * resource the generation's skill catalog resolves, so importing this
 * module reads no directory.
 *
 * The capability declarations of every registry unit are checked here: each
 * key appears at most once per list and in one list only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REGISTRY } from "./registry.js";

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
