/**
 * Tests for the OpenCode start publisher (`./publisher.ts`).
 *
 * The boundary is the start itself: the runtime owner exists before the
 * first fallible step, `prepare` computes the whole publication without
 * touching the host, the published hooks are the ones the plugin delivers,
 * and a failing preparation closes the runtime it created.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createConfigScope } from "../../core/config-snapshot.js";
import { MAIN_ORIGIN, startRuntime } from "../../core/runtime.js";
import { buildPlugin } from "../../opencode.js";
import {
  POLY_RAW,
  POLY_ZOO,
  polyHostConfig,
  withHostConfig,
} from "../../testkits/config.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { openCodeProcessState } from "./process.js";
import { createOpenCodeRuntime } from "./publisher.js";

afterEach(() => {
  _resetForTesting();
});

/** The plugin input of one test instance. */
function hostInput(): { client: Record<string, any>; directory: string } {
  return { client: withHostConfig({}), directory: "/workspace" };
}

/** The `plugin_init` entries of the log buffer. */
function initEntries(): Array<Record<string, unknown>> {
  return _getBufferForTesting().filter(
    (entry) => entry.event === "plugin_init",
  );
}

/** The runtime owner of the poly fixture profile. */
function polyRuntime(
  overrides?: Parameters<typeof createOpenCodeRuntime>[0]["overrides"],
) {
  return createOpenCodeRuntime({
    process: openCodeProcessState(),
    scope: createConfigScope(POLY_ZOO, POLY_RAW),
    pluginInput: hostInput(),
    ...(overrides === undefined ? {} : { overrides }),
  });
}

describe("createOpenCodeRuntime — prepare", () => {
  /** The complete publication keys of the tool-only fixture profile. */
  const PUBLICATION_KEYS = [
    "config",
    "dispose",
    "event",
    "experimental.chat.system.transform",
    "tool",
  ];

  it("delivers the complete hook set without running the config hook", async () => {
    const owner = polyRuntime();

    const publication = await owner.publisher.publish(
      await owner.publisher.prepare(),
    );

    // The tool-only profile contributes the profile tools plus the
    // always-on infrastructure hooks and the teardown.  The host entry
    // delivers exactly this publication.
    assert.deepEqual(Object.keys(publication).sort(), PUBLICATION_KEYS);
    assert.deepEqual(
      Object.keys(await buildPlugin(hostInput(), POLY_ZOO, POLY_RAW)).sort(),
      PUBLICATION_KEYS,
      "the entry delivers the publisher's publication",
    );
    assert.equal(typeof publication.config, "function");
    assert.equal(
      initEntries().length,
      0,
      "the config hook must not run before the host calls it",
    );

    // The host's config stage is still the one that writes.
    await publication.config(polyHostConfig());
    assert.equal(initEntries().length, 1, "the config hook writes once");
  });

  it("keeps the prepared hooks free of host writes", async () => {
    const owner = polyRuntime();

    const prepared = await owner.publisher.prepare();

    assert.deepEqual(Object.keys(prepared.hooks).sort(), [
      "config",
      "event",
      "experimental.chat.system.transform",
      "tool",
    ]);
    assert.equal(initEntries().length, 0, "prepare runs no config stage");
  });

  it("fails before any config write when the injected scan throws", async () => {
    const owner = polyRuntime({
      scanSkills(): string[] {
        throw new Error("skill scan failed");
      },
    });

    await assert.rejects(owner.publisher.prepare(), /skill scan failed/);
    assert.equal(
      initEntries().length,
      0,
      "no config stage may run when the scan fails",
    );
  });
});

describe("createOpenCodeRuntime — the runtime owner", () => {
  it("hands the publication the runtime's own close handle", async () => {
    const owner = polyRuntime();

    const handle = await startRuntime({
      scope: createConfigScope(POLY_ZOO, POLY_RAW),
      origin: MAIN_ORIGIN,
      createRuntime: () => owner,
    });

    assert.deepEqual(handle.origin, { kind: "main" });
    assert.equal(
      handle.publication.dispose,
      handle.stop,
      "the host's dispose is the runtime's close handle",
    );
    assert.deepEqual(await handle.stop(), { errors: [] });
    assert.deepEqual(await handle.stop(), { errors: [] }, "the close repeats");
  });

  it("closes the runtime when the injected scan fails", async () => {
    const owner = polyRuntime({
      scanSkills(): string[] {
        throw new Error("skill scan failed");
      },
    });

    await assert.rejects(
      startRuntime({
        scope: createConfigScope(POLY_ZOO, POLY_RAW),
        origin: MAIN_ORIGIN,
        createRuntime: () => owner,
      }),
      /skill scan failed/,
    );

    assert.equal(
      initEntries().length,
      0,
      "no config stage may run when the scan fails",
    );
    // The failed start closed the runtime: its scope is terminal, so a
    // second start on the same owner cannot resurrect it.
    await assert.rejects(owner.publisher.prepare(), /已停止/);
  });
});
