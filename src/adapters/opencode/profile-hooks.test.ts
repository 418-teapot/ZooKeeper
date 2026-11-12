/**
 * Tests for the OpenCode profile-driven hooks.
 *
 * Covers the event keys the fragment exposes, the `tool.definition`
 * translation (the deep-copy view boundary and the change detection that
 * decides which fields the write-back touches), the per-handler isolation
 * of `tool.execute.after`, the isolated transform and text-completion
 * runners, and the slash-command short circuit.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Capabilities } from "../../core/ports/index.js";
import type {
  AfterExecContribution,
  TextCompleteOutput,
  ToolArgDefinition,
  ToolDefinitionView,
  TransformOutput,
} from "../../core/unit.js";
import {
  composedResult,
  readySelection,
} from "../../testkits/contributions.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { assembleProfileHooks, COMMAND_HANDLED } from "./profile-hooks.js";

/** Minimal deps: only `limits`/`resolveCallerAgent` are read. */
const DEPS: Partial<Capabilities> = {
  limits: {},
  resolveAgent: () => undefined,
};

afterEach(() => {
  _resetForTesting();
});

/**
 * Assemble the hooks fragment under test.
 *
 * @param overrides - The composition slots to fill.
 * @returns The hooks fragment.
 */
function hooksFor(
  overrides: Parameters<typeof composedResult>[0] = {},
): Record<string, any> {
  return assembleProfileHooks(
    composedResult(overrides),
    DEPS,
    readySelection(),
    [],
  );
}

/** Count the buffered `handler_crashed` entries. */
function crashedEntries(): Array<Record<string, unknown>> {
  return _getBufferForTesting().filter(
    (entry) => entry.event === "handler_crashed",
  );
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

// ---------------------------------------------------------------------------
// Event keys
// ---------------------------------------------------------------------------

describe("assembleProfileHooks — event keys", () => {
  it("always carries the config hook and no contribution hook", () => {
    assert.deepEqual(Object.keys(hooksFor()), ["config"]);
  });

  it("adds the tool surface only when a tool is enabled", () => {
    const hooks = hooksFor({
      tools: {
        compress: {
          name: "compress",
          description: "compress",
          execute: async () => ({ text: "" }),
        },
      },
    });

    assert.deepEqual(Object.keys(hooks), ["config", "tool"]);
  });

  it("adds every contribution hook whose array is non-empty", () => {
    const hooks = hooksFor({
      transform: [{ name: "t", handle: () => {} }],
      textComplete: [{ name: "x", handle: () => {} }],
      toolDefinition: [{ name: "d", handle: () => {} }],
      afterExec: [{ name: "a", handle: () => {} }],
      gate: () => null,
      commands: {
        go: { name: "go", description: "go", handle: async () => {} },
      },
    });

    assert.deepEqual(Object.keys(hooks), [
      "config",
      "experimental.chat.messages.transform",
      "experimental.text.complete",
      "tool.definition",
      "tool.execute.before",
      "tool.execute.after",
      "command.execute.before",
    ]);
  });
});

// ---------------------------------------------------------------------------
// tool.definition
// ---------------------------------------------------------------------------

describe("tool.definition", () => {
  it("maps the host's task tool onto the canonical subagent name", async () => {
    let seen: string | undefined;
    const hooks = hooksFor({
      toolDefinition: [
        {
          name: "record",
          handle: (view: ToolDefinitionView) => {
            seen = view.name;
          },
        },
      ],
    });

    await hooks["tool.definition"]({ toolID: "task" }, output());

    assert.equal(seen, "subagent");
  });

  it("copies argument schemas so an in-place view edit never aliases the native output", async () => {
    const native = output();
    let nativeDuringRun: unknown;
    const hooks = hooksFor({
      toolDefinition: [
        {
          name: "enrich",
          handle: (view: ToolDefinitionView) => {
            const args = view.args as Record<string, ToolArgDefinition>;
            args.prompt.description = "enriched";
            nativeDuringRun = (native.parameters.properties as any).prompt
              .description;
          },
        },
      ],
    });

    await hooks["tool.definition"]({ toolID: "subagent" }, native);

    assert.equal(
      nativeDuringRun,
      "The subagent prompt",
      "the native schema must stay untouched before write-back",
    );
    assert.equal(
      (native.parameters.properties as any).prompt.description,
      "enriched",
    );
  });

  it("writes only the changed description back into the native output", async () => {
    const native = output();
    const hooks = hooksFor({
      toolDefinition: [
        {
          name: "enrich",
          handle: (view: ToolDefinitionView) => {
            (
              view.args as Record<string, ToolArgDefinition>
            ).prompt.description = "enriched";
          },
        },
      ],
    });

    await hooks["tool.definition"]({ toolID: "subagent" }, native);

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

  it("writes a changed top-level description back", async () => {
    const native = output();
    const hooks = hooksFor({
      toolDefinition: [
        {
          name: "rewrite",
          handle: (view: ToolDefinitionView) => {
            view.description = "rewritten";
          },
        },
      ],
    });

    await hooks["tool.definition"]({ toolID: "subagent" }, native);

    assert.equal(native.description, "rewritten");
  });

  it("never clears the top-level description to undefined", async () => {
    const native = output();
    const hooks = hooksFor({
      toolDefinition: [
        {
          name: "clear",
          handle: (view: ToolDefinitionView) => {
            view.description = undefined;
          },
        },
      ],
    });

    await hooks["tool.definition"]({ toolID: "subagent" }, native);

    assert.equal(native.description, "Launch a subagent");
  });

  it("ignores arguments a contributor added to the view", async () => {
    const native = output();
    const hooks = hooksFor({
      toolDefinition: [
        {
          name: "add",
          handle: (view: ToolDefinitionView) => {
            (view.args as Record<string, ToolArgDefinition>).added = {
              description: "new arg",
            };
          },
        },
      ],
    });

    await hooks["tool.definition"]({ toolID: "subagent" }, native);

    assert.equal(
      (native.parameters.properties as any).added,
      undefined,
      "the write-back must not add native properties",
    );
  });

  it("leaves the native output untouched when nothing changed", async () => {
    const native = output();
    const before = JSON.stringify(native);
    const hooks = hooksFor({
      toolDefinition: [{ name: "noop", handle: () => {} }],
    });

    await hooks["tool.definition"]({ toolID: "subagent" }, native);

    assert.equal(JSON.stringify(native), before);
  });
});

// ---------------------------------------------------------------------------
// tool.execute.after
// ---------------------------------------------------------------------------

describe("tool.execute.after", () => {
  it("runs the handlers in order and normalizes the tool name", async () => {
    const order: string[] = [];
    const seen: string[] = [];
    const handlers: AfterExecContribution[] = [
      {
        name: "first",
        handle: async (input, out) => {
          order.push("first");
          seen.push(input.tool);
          out.output = "first-result";
        },
      },
      {
        name: "second",
        handle: () => {
          order.push("second");
        },
      },
    ];
    const hooks = hooksFor({ afterExec: handlers });
    const after: { output?: string } = {};

    await hooks["tool.execute.after"](
      { tool: "task", sessionID: "s", callID: "c" },
      after,
    );

    assert.deepEqual(order, ["first", "second"]);
    assert.deepEqual(seen, ["subagent"]);
    assert.equal(after.output, "first-result");
  });

  it("isolates a crashing handler and runs later ones", async () => {
    const hooks = hooksFor({
      afterExec: [
        {
          name: "boom",
          handle: () => {
            throw new Error("after boom");
          },
        },
        {
          name: "ok",
          handle: (_input, out) => {
            out.output = "survived";
          },
        },
      ],
    });
    const after: { output?: string } = {};

    await hooks["tool.execute.after"](
      { tool: "task", sessionID: "s", callID: "c" },
      after,
    );

    assert.equal(after.output, "survived");
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "boom");
    assert.equal(crashed[0].sessionId, "s");
    assert.equal(crashed[0].callId, "c");
  });
});

// ---------------------------------------------------------------------------
// transform / text.complete isolation
// ---------------------------------------------------------------------------

describe("transform / text.complete isolation", () => {
  it("isolates a crashing messages.transform contribution and runs later ones", async () => {
    let captured: TransformOutput | undefined;
    const hooks = hooksFor({
      transform: [
        {
          name: "boom",
          handle: () => {
            throw new Error("transform boom");
          },
        },
        {
          name: "capture",
          handle: (out) => {
            captured = out;
          },
        },
      ],
    });
    const messages: TransformOutput = {
      messages: [{ info: { sessionID: "sess-1" }, parts: [] }],
    };

    await hooks["experimental.chat.messages.transform"]({}, messages);

    assert.ok(captured, "later contribution must still run");
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "boom");
    assert.equal(crashed[0].sessionId, "sess-1");
    assert.equal(crashed[0].callId, undefined);
    assert.equal(crashed[0].error, "Error: transform boom");
  });

  it("falls back to an empty session id when the message list is empty", async () => {
    const hooks = hooksFor({
      transform: [
        {
          name: "boom",
          handle: () => {
            throw new Error("transform boom");
          },
        },
      ],
    });

    await hooks["experimental.chat.messages.transform"]({}, { messages: [] });

    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].sessionId, "");
  });

  it("isolates a crashing text.complete contribution and runs later ones", async () => {
    const hooks = hooksFor({
      textComplete: [
        {
          name: "boom",
          handle: () => {
            throw new Error("text boom");
          },
        },
        {
          name: "capture",
          handle: (_input, out) => {
            out.text = `${out.text}!`;
          },
        },
      ],
    });
    const text: TextCompleteOutput = { text: "hi" };

    await hooks["experimental.text.complete"](
      { sessionID: "s1", messageID: "m1", partID: "p1" },
      text,
    );

    assert.equal(text.text, "hi!");
    const crashed = crashedEntries();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].handler, "boom");
    assert.equal(crashed[0].sessionId, "s1");
    assert.equal(crashed[0].callId, "p1");
    assert.equal(crashed[0].error, "Error: text boom");
  });
});

// ---------------------------------------------------------------------------
// command.execute.before
// ---------------------------------------------------------------------------

describe("command.execute.before", () => {
  it("short-circuits a registered command with the shared sentinel", async () => {
    let handled = 0;
    const hooks = hooksFor({
      commands: {
        go: {
          name: "go",
          description: "go",
          handle: async () => {
            handled += 1;
          },
        },
      },
    });

    await assert.rejects(
      hooks["command.execute.before"]({
        command: "go",
        sessionID: "s",
        arguments: "",
      }),
      (err: unknown) => err === COMMAND_HANDLED,
    );
    assert.equal(handled, 1);
  });

  it("passes an unregistered command through untouched", async () => {
    const hooks = hooksFor({
      commands: {
        go: { name: "go", description: "go", handle: async () => {} },
      },
    });

    await hooks["command.execute.before"]({
      command: "other",
      sessionID: "s",
      arguments: "",
    });
  });
});
