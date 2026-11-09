/**
 * Tests for the immutable config snapshot and its process scope.
 *
 * The snapshot is the boundary both hosts consume: it must carry the
 * parsed `CommonConfig` fields, be immutable with its nested values, and
 * be created once per configuration generation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configCapabilities } from "./capabilities.js";
import { createConfigScope, createProcessScope } from "./config-snapshot.js";

/** A zoo config carrying every parsed common section. */
const ZOO = {
  validation: { context_word_limit: 200, prompt_word_limit: 500 },
  continuation: { max_wakes: 3 },
  context: {
    active_messages: 20,
    active_tokens: 20000,
    released_percent: 10,
    dedup: { min_messages: 5, protected_tools: ["todo"] },
  },
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

/** The whole config root carrying the top-level agent table. */
const RAW = {
  agent: {
    dolphin: { mode: "primary" },
    beaver: { mode: "subagent", permission: { fetch: "deny" } },
  },
};

describe("createConfigScope — one parsed configuration generation", () => {
  it("carries the parsed CommonConfig fields", () => {
    const { snapshot } = createConfigScope(ZOO, RAW);
    assert.deepEqual(snapshot.limits, {
      contextWordLimit: 200,
      promptWordLimit: 500,
    });
    assert.deepEqual(snapshot.continuationConfig, { maxWakes: 3 });
    assert.equal(snapshot.contextConfig.activeMessages, 20);
    assert.equal(snapshot.modeProfile?.name, "poly");
    assert.deepEqual(snapshot.agentModes, {
      dolphin: "primary",
      beaver: "subagent",
    });
    assert.deepEqual(snapshot.agentPermissions, { beaver: ["fetch"] });
  });

  it("fails closed on an absent config", () => {
    const { snapshot } = createConfigScope({}, {});
    assert.equal(snapshot.modeProfile, null);
    assert.equal(snapshot.continuationConfig, undefined);
    assert.deepEqual(snapshot.agentModes, {});
  });

  it("parses a new generation per call", () => {
    const first = createConfigScope(ZOO, RAW);
    const second = createConfigScope(ZOO, RAW);
    assert.notEqual(first.snapshot, second.snapshot);
    assert.notEqual(first.snapshot.agentModes, second.snapshot.agentModes);
    assert.deepEqual(first.snapshot.limits, second.snapshot.limits);
  });

  it("feeds configCapabilities directly", () => {
    const { snapshot } = createConfigScope(ZOO, RAW);
    const capabilities = configCapabilities(snapshot);
    assert.equal(capabilities.limits, snapshot.limits);
    assert.equal(capabilities.contextConfig, snapshot.contextConfig);
    assert.equal(capabilities.agentModes, snapshot.agentModes);
    assert.equal(capabilities.agentPermissions, snapshot.agentPermissions);
  });
});

describe("createProcessScope — immutable snapshot boundary", () => {
  it("freezes the scope and every nested value", () => {
    const scope = createConfigScope(ZOO, RAW);
    const { snapshot } = scope;
    assert.equal(Object.isFrozen(scope), true);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.limits), true);
    assert.equal(Object.isFrozen(snapshot.modeProfile), true);
    assert.equal(Object.isFrozen(snapshot.modeProfile?.agents), true);
    assert.equal(Object.isFrozen(snapshot.contextConfig), true);
    assert.equal(Object.isFrozen(snapshot.contextConfig.dedup), true);
    assert.equal(
      Object.isFrozen(snapshot.contextConfig.dedup?.protectedTools),
      true,
    );
    assert.equal(Object.isFrozen(snapshot.agentModes), true);
    assert.equal(Object.isFrozen(snapshot.agentPermissions), true);
    assert.equal(Object.isFrozen(snapshot.agentPermissions.beaver), true);
  });

  it("rejects a nested mutation", () => {
    const { snapshot } = createConfigScope(ZOO, RAW);
    assert.throws(() => {
      (snapshot.modeProfile?.agents as string[]).push("mola");
    }, TypeError);
    assert.throws(() => {
      (snapshot.agentPermissions.beaver as string[]).push("bash");
    }, TypeError);
    assert.throws(() => {
      (snapshot.contextConfig.dedup as { minMessages?: number }).minMessages =
        9;
    }, TypeError);
    assert.deepEqual(snapshot.modeProfile?.agents, ["dolphin"]);
    assert.deepEqual(snapshot.agentPermissions.beaver, ["fetch"]);
  });

  it("freezes any snapshot handed to it", () => {
    const scope = createProcessScope({ nested: { names: ["a"] } });
    assert.equal(Object.isFrozen(scope.snapshot.nested.names), true);
  });
});
