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
import { facts } from "../testkits/compose.js";
import type { Capabilities } from "./ports/index.js";
import {
  defineAgent,
  defineHook,
  definePromptAgent,
  defineTool,
} from "./unit.js";

/** The capability bag the factories see; the units below declare none. */
const CAPS: Partial<Capabilities> = {};

/** An empty selection-facts projection. */
const ACTIVE_SET = facts();

/** A selection with one selected tool — the facts the cases below read. */
const USES = facts({ tools: ["compress"] });

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

  it("forwards the capability slice and the uses projection to the factory", () => {
    let seenCaps: unknown;
    let seenUses: unknown;
    const unit = defineHook({
      name: "h",
      needs: ["directory"],
      uses: ["tools"],
      create: (caps, uses) => {
        seenCaps = caps;
        seenUses = uses;
        return {};
      },
    });

    unit.create({ ...CAPS, directory: "/tmp/zoo" }, USES);

    assert.deepEqual(seenCaps, { directory: "/tmp/zoo" });
    assert.deepEqual(seenUses, { tools: ["compress"] });
  });

  it("projects only the facts the unit declared in uses", () => {
    let seenUses: unknown;
    const unit = defineHook({
      name: "h",
      needs: [],
      create: (_caps, uses) => {
        seenUses = uses;
        return {};
      },
    });

    unit.create(CAPS, USES);

    assert.deepEqual(seenUses, {});
  });

  it("keeps the descriptor's declared uses list", () => {
    const unit = defineHook({
      name: "h",
      needs: [],
      uses: ["agents", "tools"],
      create: () => ({}),
    });

    assert.deepEqual(unit.uses, ["agents", "tools"]);
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

  it("contributes exactly one tool named after the unit", () => {
    const unit = defineTool({
      name: "t",
      needs: [],
      create: () => ({ description: "d", execute: async () => "ok" }),
    });

    const contributions = unit.create(CAPS, ACTIVE_SET);

    assert.equal(contributions.tools.length, 1);
    assert.equal(contributions.tools[0]?.name, "t");
  });

  it("forwards the capability slice and the uses projection to the factory", () => {
    let seenCaps: unknown;
    let seenUses: unknown;
    const unit = defineTool({
      name: "t",
      needs: ["toolHost"],
      uses: ["tools"],
      create: (caps, uses) => {
        seenCaps = caps;
        seenUses = uses;
        return { description: "d", execute: async () => "ok" };
      },
    });

    unit.create({ ...CAPS, toolHost: {} as never }, USES);

    assert.deepEqual(seenCaps, { toolHost: {} });
    assert.deepEqual(seenUses, { tools: ["compress"] });
  });
});

describe("defineAgent", () => {
  it("contributes exactly one agent named after the unit", () => {
    const unit = defineAgent({
      name: "dolphin",
      needs: [],
      create: () => ({ prompt: "PROMPT" }),
    });

    assert.deepEqual(unit.create(CAPS, ACTIVE_SET), {
      kind: "agent",
      agents: [{ name: "dolphin", prompt: "PROMPT" }],
    });
  });

  it("carries the prompt variants through to the contribution", () => {
    const variants = [{ base: "b", gpt: "g" }];
    const unit = defineAgent({
      name: "dolphin",
      needs: [],
      create: () => ({ prompt: "PROMPT", promptVariants: variants }),
    });

    assert.deepEqual(unit.create(CAPS, ACTIVE_SET).agents[0]?.promptVariants, [
      { base: "b", gpt: "g" },
    ]);
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
