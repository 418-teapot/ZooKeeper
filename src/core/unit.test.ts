/**
 * Tests for the `define*` unit helpers in `src/core/unit.ts`.
 *
 * The helpers are the boundary every unit registration goes through: a
 * factory names only what it contributes and the descriptor returns the
 * complete contribution set.  Each case therefore asserts the
 * descriptor's `create` output — the shape the composition engine reads —
 * rather than the factory body.
 *
 * The `UnitCaps` and `define*` cases are compile-time contracts: their
 * `@ts-expect-error` directives are the assertions, so `tsc --noEmit`
 * fails when a declaration becomes more permissive than stated.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { facts } from "../testkits/compose.js";
import type { Capabilities } from "./ports/index.js";
import type { TodoSource } from "./todo/source.js";
import {
  defineAgent,
  defineCommand,
  defineHook,
  definePromptAgent,
  defineTool,
  type UnitCaps,
} from "./unit.js";

/** The capability bag the factories see; the units below declare none. */
const CAPS: Partial<Capabilities> = {};

/** An empty selection-facts projection. */
const ACTIVE_SET = facts();

/** A selection with one selected tool — the facts the cases below read. */
const USES = facts({ tools: ["compress"] });

/** A read-only todo source passed into the capability cases below. */
const TODO_SOURCE: TodoSource = async () => [];

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
    const execute = async () => ({ text: "ok" });
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
      create: () => ({
        description: "d",
        execute: async () => ({ text: "ok" }),
      }),
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
        return { description: "d", execute: async () => ({ text: "ok" }) };
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

// ---------------------------------------------------------------------------
// Compile-time capability contracts
// ---------------------------------------------------------------------------

describe("UnitCaps", () => {
  it("makes every needs key required", () => {
    // The annotation is the assertion: the slice that omits the declared
    // need must not compile, and the slice that carries it must.
    const withoutNeed = (): UnitCaps<["directory"], []> =>
      // @ts-expect-error - a declared need is a required property.
      ({});
    const withNeed = (): UnitCaps<["directory"], []> => ({
      directory: "/tmp/zoo",
    });

    assert.equal(typeof withoutNeed, "function");
    assert.deepEqual(withNeed(), { directory: "/tmp/zoo" });
  });

  it("leaves every wants key optional", () => {
    const withoutWant: UnitCaps<[], ["toolHost"]> = {};
    // A `wants` key stays absent even though the catalog requires the
    // field.
    const withoutWantPort: UnitCaps<[], ["todoSource"]> = {};

    assert.deepEqual(withoutWant, {});
    assert.deepEqual(withoutWantPort, {});
  });

  it("excludes a capability key the unit did not declare", () => {
    const withUndeclaredPort = (): UnitCaps<["directory"], []> => ({
      directory: "/tmp/zoo",
      // @ts-expect-error - the slice carries only the declared keys.
      toolHost: {},
    });

    assert.equal(typeof withUndeclaredPort, "function");
  });
});

describe("define* — needs declaration", () => {
  it("types a needed catalog key as present in the factory slice", () => {
    const unit = defineHook({
      name: "probe",
      needs: ["todoSource"],
      create: (caps) => {
        // The assignment is the assertion: `undefined` does not fit here.
        const source: TodoSource = caps.todoSource;
        return {
          afterExec: [
            {
              name: "probe",
              handle: () => {
                source("s");
              },
            },
          ],
        };
      },
    });

    const contributions = unit.create({ todoSource: TODO_SOURCE }, ACTIVE_SET);

    assert.equal(contributions.afterExec.length, 1);
  });

  it("rejects a definition that omits needs", () => {
    // Every helper requires the list; each directive below is the assertion.
    const definitions = [
      () =>
        // @ts-expect-error - needs is required.
        defineAgent({ name: "a", create: () => ({ prompt: "p" }) }),
      () =>
        // @ts-expect-error - needs is required.
        defineHook({ name: "h", create: () => ({}) }),
      () =>
        // @ts-expect-error - needs is required.
        defineTool({
          name: "t",
          create: () => ({
            description: "d",
            execute: async () => ({ text: "ok" }),
          }),
        }),
      () =>
        // @ts-expect-error - needs is required.
        defineCommand({
          name: "c",
          create: () => ({ kind: "command", commands: [] }),
        }),
    ];

    // One thunk per helper: all four must stay covered.
    assert.equal(definitions.length, 4);
  });
});

describe("capability ports — consumer surface", () => {
  it("exposes only the run operations the subagent tool writes", () => {
    // The factory body never runs: the directives are the assertion, so a
    // port that widened back to the whole registry fails `tsc --noEmit`.
    const consume = (runs: Capabilities["runs"]): void => {
      runs.start({ id: "run-1", agent: "lynx", parentSession: "s1" });
      runs.update("run-1", { currentTool: "read" });
      runs.finish("run-1", { status: "done" });
      // @ts-expect-error - creating a scope is assembly work, not a
      // consumer operation.
      runs.createScope();
    };

    assert.equal(typeof consume, "function");
  });

  it("exposes only the todo-store operations the todo tool calls", () => {
    const consume = (store: Capabilities["todoStore"]): void => {
      void store.serialize(async () => {
        const phases = await store.get("s1");
        store.set("s1", phases);
      });
      // @ts-expect-error - cache invalidation belongs to the host adapter.
      store.invalidate("s1");
    };

    assert.equal(typeof consume, "function");
  });
});
