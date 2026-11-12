/**
 * Cross-entry contract: one start protocol for every real host entry.
 *
 * Three entries start a ZooKeeper runtime: the pi main entry
 * (`zookeeperPi`), the pi subagent entry (`buildPiSubagentExtension`) and
 * the OpenCode entry (`buildPlugin`).  All three run the same sequence
 * (create the owner, prepare, publish) and differ only in the
 * `RuntimeOrigin` they name, so this suite compares what the entries
 * deliver and what a failed start leaves behind.
 *
 * Boundary: the entry surfaces driven end to end, because the contract is
 * about what a host entry does, not about the phases (covered by
 * `core/runtime.test.ts`) or the registrations (covered by each adapter's
 * own suite).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { loadAgentsJson } from "./adapters/pi/agent-models.js";
import {
  createPiScope,
  loadConfig,
  type PiProcessScope,
} from "./adapters/pi/config.js";
import { piProcessState } from "./adapters/pi/process.js";
import { buildPiSubagentExtension } from "./adapters/pi/publisher.js";
import { buildPlugin } from "./opencode.js";
import { zookeeperPi } from "./pi.js";
import { POLY_RAW, POLY_ZOO, withHostConfig } from "./testkits/config.js";
import { withModeFile } from "./testkits/mode-file.js";
import { mockApi, resetPiTestState } from "./testkits/pi-wiring.js";
import { _resetForTesting } from "./utils/logger.js";

afterEach(() => {
  resetPiTestState();
  _resetForTesting();
});

// The registered card renderers read the coding-agent theme singleton.
initTheme();

/** The profile the pi main entry selects (mirrors `[zoo.mode.poly]`). */
const POLY_MODE = JSON.stringify({ mode: "poly" });

/** The scope the pi main entry builds from the real config.toml. */
function realPiScope(): PiProcessScope {
  const rawConfig = loadConfig();
  const zooConfig = rawConfig.zoo ?? {};
  return createPiScope({
    zooConfig,
    rawConfig,
    subagentModels: loadAgentsJson(),
  });
}

/** The names of the tools one recording API instance received. */
function toolNames(api: ReturnType<typeof mockApi>): string[] {
  return (api.tools as { name: string }[]).map((tool) => tool.name).sort();
}

/** A recording API instance whose command write fails. */
function failingApi(message: string): ReturnType<typeof mockApi> {
  const api = mockApi();
  return {
    ...api,
    registerCommand(): void {
      throw new Error(message);
    },
  };
}

describe("start protocol — every real entry", () => {
  it("delivers the same pi surface to the main and the subagent entry", async () => {
    // One configuration generation, two origins: the subagent entry starts
    // the same runtime protocol over the same generation, so it delivers
    // the same surface.  The origin is the only difference between them.
    const mainApi = mockApi();
    const childApi = mockApi();
    await withModeFile(POLY_MODE, async () => {
      await zookeeperPi(mainApi as any);
      await buildPiSubagentExtension(realPiScope(), {
        agent: "beaver",
        process: piProcessState(),
      })(childApi as any);
    });

    assert.deepEqual(
      Object.keys(childApi.handlers).sort(),
      Object.keys(mainApi.handlers).sort(),
      "both entries bind the same event keys",
    );
    assert.deepEqual(toolNames(childApi), toolNames(mainApi));
    assert.deepEqual(
      childApi.commands.map((command) => command.name).sort(),
      mainApi.commands.map((command) => command.name).sort(),
    );
  });

  it("rethrows the pi main entry's own start error and runs no later write", async () => {
    const api = failingApi("main write failed");

    await withModeFile(POLY_MODE, async () => {
      await assert.rejects(zookeeperPi(api as any), /main write failed/);
    });

    assert.equal(api.renderers.length, 0, "the renderer write never runs");
    assert.deepEqual(Object.keys(api.handlers), [], "no event key is bound");
  });

  it("rethrows the pi subagent entry's own start error and reports no close", async () => {
    const api = failingApi("child write failed");
    const closes: unknown[] = [];

    await assert.rejects(
      buildPiSubagentExtension(realPiScope(), {
        agent: "beaver",
        process: piProcessState(),
        onClose: (close) => closes.push(close),
      })(api as any),
      /child write failed/,
    );

    assert.equal(api.renderers.length, 0, "the renderer write never runs");
    assert.deepEqual(closes, [], "the failed start closed its own runtime");
  });

  it("rethrows the OpenCode entry's own start error before any host write", async () => {
    const input = { client: withHostConfig({}), directory: "/workspace" };

    await assert.rejects(
      buildPlugin(input, POLY_ZOO, POLY_RAW, {
        discoverSkills(): never {
          throw new Error("skill read failed");
        },
      }),
      /skill read failed/,
    );
  });
});
