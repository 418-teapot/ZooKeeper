/**
 * Tests for the host-neutral tool-definition enhancement helpers in
 * `src/core/tool-definition.ts`.
 *
 * Covers the deep-copy view builder, the sequential await loop over
 * contributions, and the view-vs-original change detection shared by the
 * pi registration boundary and the OpenCode `tool.definition` event.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ToolArgDefinition,
  ToolDefinitionContribution,
  ToolDefinitionView,
} from "./slots.js";
import {
  collectToolDefinitionChanges,
  createToolDefinitionView,
  runToolDefinitionContributions,
} from "./tool-definition.js";

/** The view's argument map, asserted present. */
function argsOf(view: ToolDefinitionView): Record<string, ToolArgDefinition> {
  assert.ok(view.args);
  return view.args;
}

describe("createToolDefinitionView", () => {
  it("copies each argument schema so the view never aliases the original", () => {
    const nativeArg = { type: "string", description: "original" };
    const originalArgs = { prompt: nativeArg };
    const view = createToolDefinitionView("subagent", "tool", originalArgs);

    assert.notEqual(view.args?.prompt, nativeArg);
    argsOf(view).prompt.description = "changed";
    assert.equal(nativeArg.description, "original");
  });

  it("deep-copies nested argument data so the view never aliases it", () => {
    const nativeArg = {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
      },
      enum: ["a", "b"],
    };
    const originalArgs = { questions: nativeArg };
    const view = createToolDefinitionView("ask", "tool", originalArgs);
    const copied = argsOf(view).questions as typeof nativeArg;

    // Mutate nested structures through the view.
    copied.items.properties.label.type = "number";
    copied.items.required.push("extra");
    copied.enum.push("c");

    assert.equal(nativeArg.items.properties.label.type, "string");
    assert.deepEqual(nativeArg.items.required, ["label"]);
    assert.deepEqual(nativeArg.enum, ["a", "b"]);
  });

  it("keeps the canonical name and description on the view", () => {
    const view = createToolDefinitionView("subagent", "delegate", {});
    assert.equal(view.name, "subagent");
    assert.equal(view.description, "delegate");
  });

  it("skips non-object argument schemas", () => {
    const view = createToolDefinitionView("t", "d", {
      ok: { type: "string" },
      bad: null,
      worse: 7,
    });
    assert.deepEqual(Object.keys(view.args ?? {}), ["ok"]);
  });

  it("builds an empty args map for an undefined args input", () => {
    const view = createToolDefinitionView("t", "d", undefined);
    assert.deepEqual(view.args, {});
  });
});

describe("runToolDefinitionContributions", () => {
  it("awaits each contribution before running the next", async () => {
    const order: string[] = [];
    const contributions: ToolDefinitionContribution[] = [
      {
        name: "first",
        handle: async (view) => {
          await Promise.resolve();
          order.push("first");
          view.description = "first";
        },
      },
      {
        name: "second",
        handle: (view) => {
          order.push(`second:${view.description}`);
        },
      },
    ];
    const view = createToolDefinitionView("t", "original", {});

    await runToolDefinitionContributions(view, contributions);

    assert.deepEqual(order, ["first", "second:first"]);
  });

  it("does nothing for an empty contribution list", async () => {
    const view = createToolDefinitionView("t", "original", {});
    await runToolDefinitionContributions(view, []);
    assert.equal(view.description, "original");
  });
});

describe("collectToolDefinitionChanges", () => {
  it("reports no change when the view matches the original", () => {
    const view = createToolDefinitionView("t", "d", {
      a: { description: "x" },
    });
    const changes = collectToolDefinitionChanges(view, "d", {
      a: { description: "x" },
    });

    assert.equal(changes.description, undefined);
    assert.deepEqual(changes.args, {});
  });

  it("reports a changed argument description", () => {
    const view = createToolDefinitionView("t", "d", {
      a: { description: "x" },
    });
    argsOf(view).a.description = "y";

    const changes = collectToolDefinitionChanges(view, "d", {
      a: { description: "x" },
    });

    assert.deepEqual(changes.args, { a: "y" });
  });

  it("reports a changed top-level description", () => {
    const view = createToolDefinitionView("t", "d", {});
    view.description = "new";

    const changes = collectToolDefinitionChanges(view, "d", {});

    assert.equal(changes.description, "new");
  });

  it("never clears the top-level description to undefined", () => {
    const view = createToolDefinitionView("t", "d", {});
    view.description = undefined;

    const changes = collectToolDefinitionChanges(view, "d", {});

    assert.equal(changes.description, undefined);
  });

  it("ignores arguments added to the view that were absent from the original", () => {
    const view = createToolDefinitionView("t", "d", {
      a: { description: "x" },
    });
    argsOf(view).b = { description: "added" };

    const changes = collectToolDefinitionChanges(view, "d", {
      a: { description: "x" },
    });

    assert.deepEqual(changes.args, {});
  });

  it("reports an argument whose description the contributor cleared", () => {
    const view = createToolDefinitionView("t", "d", {
      a: { description: "x" },
    });
    argsOf(view).a.description = undefined;

    const changes = collectToolDefinitionChanges(view, "d", {
      a: { description: "x" },
    });

    assert.ok("a" in changes.args);
    assert.equal(changes.args.a, undefined);
  });
});
