/**
 * Tests for the OpenCode tool-definition translation in
 * `src/compose-opencode.ts`.
 *
 * Covers the deep-copy view boundary (a contributor's in-place mutation
 * never reaches the native output before the write-back pass) and the
 * change detection that decides which fields the write-back touches.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyToolDefinitionView,
  toToolDefinitionView,
} from "./compose-opencode.js";
import type { ToolArgDefinition, ToolDefinitionView } from "./core/slots.js";

/** The view's argument map, asserted present. */
function argsOf(view: ToolDefinitionView): Record<string, ToolArgDefinition> {
  assert.ok(view.args);
  return view.args;
}

/** A raw OpenCode `tool.definition` output fixture. */
function output(): {
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    description: "Launch a subagent",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The subagent prompt" },
        agent: { type: "string", description: "目标 agent" },
      },
    },
  };
}

describe("toToolDefinitionView / applyToolDefinitionView", () => {
  it("copies argument schemas so an in-place view edit never aliases the native output", () => {
    const native = output();
    const view = toToolDefinitionView("subagent", native);

    argsOf(view).prompt.description = "enriched";

    assert.equal(
      (native.parameters.properties as any).prompt.description,
      "The subagent prompt",
      "the native schema must stay untouched before write-back",
    );
    assert.equal(argsOf(view).prompt.description, "enriched");
  });

  it("writes only the changed description back into the native output", () => {
    const native = output();
    const view = toToolDefinitionView("subagent", native);
    argsOf(view).prompt.description = "enriched";

    applyToolDefinitionView(view, native);

    assert.equal(
      (native.parameters.properties as any).prompt.description,
      "enriched",
    );
    assert.equal(
      (native.parameters.properties as any).agent.description,
      "目标 agent",
      "an untouched argument keeps its native description",
    );
  });

  it("writes a changed top-level description back", () => {
    const native = output();
    const view = toToolDefinitionView("subagent", native);
    view.description = "rewritten";

    applyToolDefinitionView(view, native);

    assert.equal(native.description, "rewritten");
  });

  it("never clears the top-level description to undefined", () => {
    const native = output();
    const view = toToolDefinitionView("subagent", native);
    view.description = undefined;

    applyToolDefinitionView(view, native);

    assert.equal(native.description, "Launch a subagent");
  });

  it("ignores arguments a contributor added to the view", () => {
    const native = output();
    const view = toToolDefinitionView("subagent", native);
    argsOf(view).added = { description: "new arg" };

    applyToolDefinitionView(view, native);

    assert.equal(
      (native.parameters.properties as any).added,
      undefined,
      "the write-back must not add native properties",
    );
  });

  it("leaves the native output untouched when nothing changed", () => {
    const native = output();
    const view = toToolDefinitionView("subagent", native);
    const before = JSON.stringify(native);

    applyToolDefinitionView(view, native);

    assert.equal(JSON.stringify(native), before);
  });
});
