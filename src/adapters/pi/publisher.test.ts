/**
 * Tests for the pi start publisher (`src/adapters/pi/publisher.ts`).
 *
 * The boundary is the start itself, not the individual registrations: the
 * suite pins that the runtime owner exists before the first fallible step,
 * that every fallible step runs before pi's first write, that a failure in
 * either phase closes the runtime it created, and that a successful start
 * hands the close handle to the caller instead of the publication.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  MAIN_ORIGIN,
  type RuntimeOrigin,
  startRuntime,
} from "../../core/runtime.js";
import type { ToolContribution } from "../../core/unit.js";
import {
  MODES_RAW,
  mockApi,
  POLY_ZOO,
  piScope,
  resetPiTestState,
} from "../../testkits/pi-wiring.js";
import { createPiProcessState } from "./process.js";
import { createPiRuntime } from "./publisher.js";

afterEach(resetPiTestState);

// The registered card renderers read the coding-agent theme singleton.
initTheme();

/**
 * Start one pi runtime through the production owner factory.
 *
 * @param origin - The origin of the runtime under test.
 * @param api - The recording pi API stand-in.
 * @param overrides - Optional host options and test seams.
 * @returns The runtime handle.
 */
function start(
  origin: RuntimeOrigin,
  api: ReturnType<typeof mockApi>,
  overrides?: Parameters<typeof createPiRuntime>[0]["overrides"],
) {
  return startRuntime({
    scope: piScope(POLY_ZOO, MODES_RAW),
    origin,
    createRuntime: ({ scope, origin: runtimeOrigin }) =>
      createPiRuntime({
        process: createPiProcessState(),
        scope,
        origin: runtimeOrigin,
        pi: api as any,
        ...(overrides === undefined ? {} : { overrides }),
      }),
  });
}

describe("createPiRuntime — prepare", () => {
  it("makes no pi host call", async () => {
    // The full poly profile registers two tools, three commands and the
    // notice renderer, so an empty recording after prepare proves the
    // preparation phase never wrote to pi.
    const api = mockApi();
    const owner = createPiRuntime({
      process: createPiProcessState(),
      scope: piScope(POLY_ZOO, MODES_RAW),
      origin: MAIN_ORIGIN,
      pi: api as any,
    });

    const prepared = await owner.publisher.prepare();

    assert.equal(api.tools.length, 0, "prepare registers no tool");
    assert.equal(api.commands.length, 0, "prepare registers no command");
    assert.equal(api.renderers.length, 0, "prepare registers no renderer");
    assert.deepEqual(
      Object.keys(api.handlers),
      [],
      "prepare binds no event key",
    );
    assert.deepEqual(
      prepared.tools.map((tool) => tool.name),
      ["compress", "decompress"],
      "the prepared start holds the tools",
    );
    assert.deepEqual(
      prepared.commands.map((command) => command.name),
      ["go", "dolphin", "mola"],
      "the prepared start holds the commands",
    );
  });

  it("rejects without any host write when a tool.definition enhancer rejects", async () => {
    const api = mockApi();
    const owner = createPiRuntime({
      process: createPiProcessState(),
      scope: piScope(POLY_ZOO, MODES_RAW),
      origin: MAIN_ORIGIN,
      pi: api as any,
      overrides: {
        async applyToolDefinitions(): Promise<
          Record<string, ToolContribution>
        > {
          throw new Error("enhancer rejected");
        },
      },
    });

    await assert.rejects(owner.publisher.prepare(), /enhancer rejected/);
    assert.equal(api.tools.length, 0, "no tool is registered");
    assert.equal(api.commands.length, 0, "no command is registered");
    assert.equal(api.renderers.length, 0, "no renderer is registered");
    assert.deepEqual(Object.keys(api.handlers), [], "no event key is bound");
  });
});

describe("createPiRuntime — publish", () => {
  it("wires every prepared surface", async () => {
    const api = mockApi();
    const handle = await start(MAIN_ORIGIN, api);

    assert.deepEqual(
      (api.tools as { name: string }[]).map((tool) => tool.name).sort(),
      ["compress", "decompress"],
    );
    assert.deepEqual(api.commands.map((command) => command.name).sort(), [
      "dolphin",
      "go",
      "mola",
    ]);
    assert.deepEqual(
      api.renderers.map((entry) => entry.customType),
      ["zoo-notice"],
    );
    assert.equal(typeof api.handlers.session_start, "function");
    assert.equal(typeof api.handlers.tool_call, "function");
    assert.equal(
      "stop" in handle.publication,
      false,
      "the close handle belongs to the runtime, not the publication",
    );
    assert.deepEqual(handle.origin, { kind: "main" });
  });

  it("propagates a failing write and runs no later write", async () => {
    const api = mockApi();
    const failing = {
      ...api,
      registerCommand(): void {
        throw new Error("command write failed");
      },
    };
    const owner = createPiRuntime({
      process: createPiProcessState(),
      scope: piScope(POLY_ZOO, MODES_RAW),
      origin: MAIN_ORIGIN,
      pi: failing as any,
    });

    await assert.rejects(async () => {
      owner.publisher.publish(await owner.publisher.prepare());
    }, /command write failed/);
    assert.equal(api.tools.length, 2, "the accepted writes are not undone");
    assert.equal(api.renderers.length, 0, "the renderer write never runs");
    assert.deepEqual(Object.keys(api.handlers), [], "no event key is bound");
  });
});

describe("createPiRuntime — the runtime owner", () => {
  it("exists before the first fallible step and closes on demand", async () => {
    const api = mockApi();
    const owner = createPiRuntime({
      process: createPiProcessState(),
      scope: piScope(POLY_ZOO, MODES_RAW),
      origin: MAIN_ORIGIN,
      pi: api as any,
    });

    assert.equal(typeof owner.publisher.prepare, "function");
    assert.equal(typeof owner.stop, "function");
    assert.equal(api.tools.length, 0, "building the owner writes nothing");

    const first = await owner.stop();
    assert.deepEqual(first, { errors: [] });
    assert.deepEqual(await owner.stop(), first, "the close is idempotent");
  });

  it("hands the owner's close handle to the started runtime", async () => {
    const api = mockApi();
    const owner = createPiRuntime({
      process: createPiProcessState(),
      scope: piScope(POLY_ZOO, MODES_RAW),
      origin: { kind: "subagent", agent: "beaver" },
      pi: api as any,
    });

    const handle = await startRuntime({
      scope: piScope(POLY_ZOO, MODES_RAW),
      origin: { kind: "subagent", agent: "beaver" },
      createRuntime: () => owner,
    });

    assert.equal(handle.stop, owner.stop, "the handle stops the owner");
    assert.deepEqual(handle.origin, { kind: "subagent", agent: "beaver" });
    assert.deepEqual(await handle.stop(), { errors: [] });
  });

  it("closes the runtime when the enhancer fails", async () => {
    const api = mockApi();
    const owner = createPiRuntime({
      process: createPiProcessState(),
      scope: piScope(POLY_ZOO, MODES_RAW),
      origin: MAIN_ORIGIN,
      pi: api as any,
      overrides: {
        async applyToolDefinitions(): Promise<
          Record<string, ToolContribution>
        > {
          throw new Error("enhancer rejected");
        },
      },
    });

    await assert.rejects(
      startRuntime({
        scope: piScope(POLY_ZOO, MODES_RAW),
        origin: MAIN_ORIGIN,
        createRuntime: () => owner,
      }),
      /enhancer rejected/,
    );

    assert.equal(api.tools.length, 0, "no tool is registered");
    assert.deepEqual(Object.keys(api.handlers), [], "no event key is bound");
    // The failed start closed the runtime: its scope is terminal, so a
    // second start on the same owner cannot resurrect it.
    await assert.rejects(
      owner.publisher.prepare(),
      /pi 扩展生命周期作用域已停止/,
    );
  });

  it("closes the runtime when a host write fails", async () => {
    const api = mockApi();
    const failing = {
      ...api,
      registerCommand(): void {
        throw new Error("command write failed");
      },
    };
    const owner = createPiRuntime({
      process: createPiProcessState(),
      scope: piScope(POLY_ZOO, MODES_RAW),
      origin: MAIN_ORIGIN,
      pi: failing as any,
    });

    await assert.rejects(
      startRuntime({
        scope: piScope(POLY_ZOO, MODES_RAW),
        origin: MAIN_ORIGIN,
        createRuntime: () => owner,
      }),
      /command write failed/,
    );

    assert.equal(api.renderers.length, 0, "the renderer write never runs");
    await assert.rejects(
      owner.publisher.prepare(),
      /pi 扩展生命周期作用域已停止/,
    );
  });
});
