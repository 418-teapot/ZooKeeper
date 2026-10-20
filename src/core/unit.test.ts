/**
 * Tests for the `define*` unit helpers in `src/core/unit.ts`.
 *
 * The helpers are the boundary every unit registration goes through: a
 * factory names only what it contributes and the descriptor returns the
 * complete contribution set.  Each case therefore asserts the
 * descriptor's `create` output — the shape the composition engine reads —
 * rather than the factory body.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Capabilities } from "./ports/index.js";
import {
  type ActiveSet,
  defineHook,
  definePromptAgent,
  defineTool,
} from "./unit.js";

/** The capability bag the factories see; the units below declare none. */
const CAPS: Partial<Capabilities> = {};

/** An empty enablement set. */
const ACTIVE_SET: ActiveSet = {
  agents: new Set(),
  skills: new Set(),
  hooks: new Set(),
  tools: new Set(),
  commands: new Set(),
};

describe("defineHook", () => {
  it("defaults every unnamed slot to an empty array", () => {
    const unit = defineHook({ name: "h", needs: [], create: () => ({}) });

    assert.deepEqual(unit.create(CAPS, ACTIVE_SET), {
      kind: "hook",
      afterExec: [],
      transform: [],
      textComplete: [],
      toolDefinition: [],
      delegation: [],
      onSettled: [],
    });
  });

  it("keeps the named slot and leaves omitted slots empty", () => {
    const handler = { name: "x", handle: async () => {} };
    const unit = defineHook({
      name: "h",
      needs: [],
      create: () => ({ afterExec: [handler] }),
    });

    const contributions = unit.create(CAPS, ACTIVE_SET);
    assert.deepEqual(contributions.afterExec, [handler]);
    assert.deepEqual(contributions.transform, []);
    assert.deepEqual(contributions.textComplete, []);
    assert.deepEqual(contributions.toolDefinition, []);
    assert.deepEqual(contributions.delegation, []);
    assert.deepEqual(contributions.onSettled, []);
  });

  it("honours an explicitly emptied slot", () => {
    const unit = defineHook({
      name: "h",
      needs: [],
      create: () => ({ onSettled: [] }),
    });

    assert.deepEqual(unit.create(CAPS, ACTIVE_SET).onSettled, []);
  });

  it("forwards the capability slice and the active set to the factory", () => {
    let seenCaps: unknown;
    let seenActiveSet: unknown;
    const unit = defineHook({
      name: "h",
      needs: ["directory"],
      create: (caps, activeSet) => {
        seenCaps = caps;
        seenActiveSet = activeSet;
        return {};
      },
    });

    unit.create({ ...CAPS, directory: "/tmp/zoo" }, ACTIVE_SET);

    assert.deepEqual(seenCaps, { directory: "/tmp/zoo" });
    assert.equal(seenActiveSet, ACTIVE_SET);
  });

  it("keeps the descriptor's declared capability lists", () => {
    const unit = defineHook({
      name: "h",
      needs: ["directory"],
      wants: ["toolHost"],
      create: () => ({}),
    });

    assert.equal(unit.kind, "hook");
    assert.equal(unit.name, "h");
    assert.deepEqual(unit.needs, ["directory"]);
    assert.deepEqual(unit.wants, ["toolHost"]);
  });
});

describe("defineTool", () => {
  it("wraps the returned definition into a named tool contribution", () => {
    const execute = async () => "ok";
    const unit = defineTool({
      name: "t",
      needs: [],
      create: () => ({ description: "d", execute }),
    });

    assert.deepEqual(unit.create(CAPS, ACTIVE_SET), {
      kind: "tool",
      tools: [{ name: "t", description: "d", execute }],
    });
  });

  it("contributes no tools when the factory returns null", () => {
    const unit = defineTool({ name: "t", needs: [], create: () => null });

    assert.deepEqual(unit.create(CAPS, ACTIVE_SET), {
      kind: "tool",
      tools: [],
    });
  });

  it("forwards the capability slice and the active set to the factory", () => {
    let seenCaps: unknown;
    let seenActiveSet: unknown;
    const unit = defineTool({
      name: "t",
      needs: ["toolHost"],
      create: (caps, activeSet) => {
        seenCaps = caps;
        seenActiveSet = activeSet;
        return null;
      },
    });

    unit.create({ ...CAPS, toolHost: {} as never }, ACTIVE_SET);

    assert.deepEqual(seenCaps, { toolHost: {} });
    assert.equal(seenActiveSet, ACTIVE_SET);
  });
});

describe("definePromptAgent", () => {
  it("contributes the prompt under the unit's own name", () => {
    const unit = definePromptAgent("beaver", "PROMPT");

    assert.equal(unit.kind, "agent");
    assert.equal(unit.name, "beaver");
    assert.deepEqual(unit.needs, []);
    assert.deepEqual(unit.wants, []);
    assert.deepEqual(unit.create(CAPS, ACTIVE_SET), {
      kind: "agent",
      agents: [{ name: "beaver", prompt: "PROMPT" }],
    });
  });
});
