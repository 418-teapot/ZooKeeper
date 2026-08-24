/**
 * Tests for the reply-strip hook unit (`src/hooks/reply-strip/`).
 *
 * Covers the contributed text-finalization handler (exact leading
 * `[mN] ` echo removal, stacked prefixes, clean-text passthrough, and
 * the `reply_ref_stripped` warn log) and the profile gating of the
 * unit through `composeProfile` against the real registry (enabled
 * profile → one handler, disabled / null profile → none).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { composeProfile } from "../../core/compose.js";
import type { ModeProfile } from "../../core/config-types.js";
import type { Deps, TextCompleteOutput } from "../../core/slots.js";
import { REGISTRY } from "../../registry.js";
import { _getBufferForTesting, _resetForTesting } from "../../utils/logger.js";
import { unit } from "./index.js";

afterEach(() => {
  _resetForTesting();
});

const DEPS: Deps = {
  limits: {},
  contextConfig: {},
  client: {},
  directory: "/tmp/zoo",
  sessionAgentMap: new Map(),
};

const ACTIVE_SET = {
  agents: new Set<string>(),
  skills: new Set<string>(),
  hooks: new Set(["reply-strip"]),
  tools: new Set<string>(),
  commands: new Set<string>(),
};

/** A minimal mode profile listing exactly the given hook units. */
function hookProfile(hooks: string[]): ModeProfile {
  return {
    name: "test",
    agents: [],
    skills: [],
    hooks,
    tools: [],
    commands: [],
  };
}

const HANDLER_INPUT = { sessionID: "s", messageID: "m", partID: "p" };

// ---------------------------------------------------------------------------
// Handler contribution
// ---------------------------------------------------------------------------

describe("reply-strip unit — handler contribution", () => {
  it("contributes one textComplete handler and nothing to the other slots", () => {
    const contributions = unit.create(DEPS, ACTIVE_SET);
    assert.equal(contributions.kind, "hook");
    assert.equal(contributions.beforeExec.length, 0);
    assert.equal(contributions.afterExec.length, 0);
    assert.equal(contributions.transform.length, 0);
    assert.equal(contributions.toolDefinition.length, 0);
    assert.equal(contributions.textComplete.length, 1);
    assert.equal(contributions.textComplete[0].name, "replyStrip");
  });

  it("strips an exact leading [mN] prefix from output.text", () => {
    const handler = unit.create(DEPS, ACTIVE_SET).textComplete[0];
    const output: TextCompleteOutput = { text: "[m3] hello world" };
    handler.handle(HANDLER_INPUT, output);
    assert.equal(output.text, "hello world");
  });

  it("strips stacked exact prefixes", () => {
    const handler = unit.create(DEPS, ACTIVE_SET).textComplete[0];
    const output: TextCompleteOutput = { text: "[m3] [m5] body" };
    handler.handle(HANDLER_INPUT, output);
    assert.equal(output.text, "body");
  });

  it("leaves clean text unchanged", () => {
    const handler = unit.create(DEPS, ACTIVE_SET).textComplete[0];
    const output: TextCompleteOutput = { text: "plain reply" };
    handler.handle(HANDLER_INPUT, output);
    assert.equal(output.text, "plain reply");
    assert.equal(_getBufferForTesting().length, 0);
  });

  it("logs reply_ref_stripped (warn) with the fragment when stripping", () => {
    const handler = unit.create(DEPS, ACTIVE_SET).textComplete[0];
    const output: TextCompleteOutput = { text: "[m3] [m5] hello world" };
    handler.handle(HANDLER_INPUT, output);

    const events = _getBufferForTesting().filter(
      (e) => e.event === "reply_ref_stripped",
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].hook, "reply-strip");
    assert.equal(events[0].level, "warn");
    assert.equal(events[0].sessionId, "s");
    assert.equal(events[0].fragment, "[m3] [m5] hello world");
  });
});

// ---------------------------------------------------------------------------
// Profile gating
// ---------------------------------------------------------------------------

describe("reply-strip unit — profile gating", () => {
  it("enabled profile contributes exactly one textComplete handler", () => {
    const result = composeProfile(hookProfile(["reply-strip"]), REGISTRY, DEPS);
    assert.equal(result.textComplete.length, 1);
    assert.equal(result.textComplete[0].name, "replyStrip");
  });

  it("profile without reply-strip contributes no textComplete handler", () => {
    const result = composeProfile(
      hookProfile(["context-pruning"]),
      REGISTRY,
      DEPS,
    );
    assert.equal(result.textComplete.length, 0);
  });

  it("null profile contributes no textComplete handler", () => {
    const result = composeProfile(null, REGISTRY, DEPS);
    assert.equal(result.textComplete.length, 0);
  });
});
