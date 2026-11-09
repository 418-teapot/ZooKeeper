/**
 * Tests for the pi configuration generation (`createPiScope`).
 *
 * The scope is the pi host's one static configuration boundary: it
 * carries the host-independent snapshot plus the pi-only parse results
 * (ask timeout, agent colors, skill permissions, subagent models), all
 * immutable and parsed once per generation.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { createPiScope } from "./config.js";

afterEach(_resetForTesting);

/** The `zoo` section of one pi generation. */
const ZOO = {
  ask: { timeout: 1200 },
  validation: { context_word_limit: 200, prompt_word_limit: 500 },
  mode: {
    poly: {
      agents: ["dolphin"],
      skills: ["beaver-tdd"],
      hooks: [],
      tools: [],
      commands: [],
    },
  },
};

/** The config root carrying the agent tables. */
const RAW = {
  agent: {
    dolphin: {
      mode: "primary",
      color: "#66ccff",
      permission: { skill: { "wiki-*": "deny" } },
    },
    beaver: { mode: "subagent", color: "#39C5BB" },
  },
};

/** The model map the installer materialised into agents.json. */
const MODELS = { beaver: "OpenCodeGo/deepseek-v4.1-flash" };

describe("createPiScope — pi configuration generation", () => {
  it("carries the host-independent snapshot", () => {
    const { snapshot } = createPiScope({
      zooConfig: ZOO,
      rawConfig: RAW,
      subagentModels: MODELS,
    });
    assert.equal(snapshot.modeProfile?.name, "poly");
    assert.deepEqual(snapshot.limits, {
      contextWordLimit: 200,
      promptWordLimit: 500,
    });
    assert.deepEqual(snapshot.agentModes, {
      dolphin: "primary",
      beaver: "subagent",
    });
  });

  it("carries the pi-only parse results", () => {
    const { snapshot } = createPiScope({
      zooConfig: ZOO,
      rawConfig: RAW,
      subagentModels: MODELS,
    });
    assert.deepEqual(snapshot.askConfig, { timeoutSeconds: 1200 });
    assert.deepEqual(snapshot.agentColors, {
      dolphin: "#66CCFF",
      beaver: "#39C5BB",
    });
    assert.deepEqual(snapshot.skillPermissions, {
      dolphin: [{ pattern: "wiki-*", action: "deny" }],
    });
    assert.deepEqual(snapshot.subagentModels, MODELS);
  });

  it("fails closed on an absent config and an absent model map", () => {
    const { snapshot } = createPiScope({
      zooConfig: {},
      rawConfig: {},
      subagentModels: {},
    });
    assert.equal(snapshot.modeProfile, null);
    assert.equal(snapshot.askConfig, undefined);
    assert.deepEqual(snapshot.agentColors, {});
    assert.deepEqual(snapshot.skillPermissions, {});
    assert.deepEqual(snapshot.subagentModels, {});
  });

  it("freezes the snapshot including the model map", () => {
    const { snapshot } = createPiScope({
      zooConfig: ZOO,
      rawConfig: RAW,
      subagentModels: MODELS,
    });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.askConfig), true);
    assert.equal(Object.isFrozen(snapshot.agentColors), true);
    assert.equal(Object.isFrozen(snapshot.skillPermissions.dolphin), true);
    assert.equal(Object.isFrozen(snapshot.subagentModels), true);
    assert.throws(() => {
      (snapshot.subagentModels as Record<string, string>).beaver = "x/y";
    }, TypeError);
  });

  it("parses once per generation", () => {
    // An invalid section warns once per parse: two generations warn twice,
    // while the same generation never warns again no matter how many
    // instances read it.
    const invalid = { ...ZOO, ask: "not-a-table" };
    const first = createPiScope({
      zooConfig: invalid,
      rawConfig: RAW,
      subagentModels: MODELS,
    });
    const single = _getBufferForTesting().filter(
      (entry) => entry.event === "ask_config_invalid",
    );
    assert.equal(single.length, 1);
    assert.equal(first.snapshot.askConfig, undefined);

    const second = createPiScope({
      zooConfig: invalid,
      rawConfig: RAW,
      subagentModels: MODELS,
    });
    assert.equal(
      _getBufferForTesting().filter(
        (entry) => entry.event === "ask_config_invalid",
      ).length,
      2,
      "a reload parses a new generation",
    );
    assert.notEqual(first.snapshot, second.snapshot);
  });
});
