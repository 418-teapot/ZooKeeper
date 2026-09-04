/**
 * Tests for the session → agent identity registry (`session-agent.ts`).
 *
 * Covers the four registry operations (`bind` / `resolve` / `delete` /
 * `clear`): rebind overwrites, unbound sessions resolve to `undefined`
 * (fail-closed), delete removes one entry only, clear empties the
 * store.  The behavior contract matters to every host: identity is
 * never invented for an unknown session.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionAgentRegistry } from "./session-agent.js";

describe("SessionAgentRegistry", () => {
  it("resolve returns undefined for an unbound session (fail-closed)", () => {
    const registry = new SessionAgentRegistry();
    assert.equal(registry.resolve("s-unknown"), undefined);
  });

  it("bind then resolve returns the bound agent name", () => {
    const registry = new SessionAgentRegistry();
    registry.bind("s1", "dolphin");
    assert.equal(registry.resolve("s1"), "dolphin");
  });

  it("a later bind for the same session overwrites the previous name", () => {
    const registry = new SessionAgentRegistry();
    registry.bind("s1", "dolphin");
    registry.bind("s1", "beaver");
    assert.equal(registry.resolve("s1"), "beaver");
  });

  it("delete removes only the given session's binding", () => {
    const registry = new SessionAgentRegistry();
    registry.bind("s1", "dolphin");
    registry.bind("s2", "mola");
    registry.delete("s1");
    assert.equal(registry.resolve("s1"), undefined);
    assert.equal(registry.resolve("s2"), "mola");
  });

  it("delete of an unknown session is a no-op", () => {
    const registry = new SessionAgentRegistry();
    registry.bind("s1", "dolphin");
    registry.delete("s-nope");
    assert.equal(registry.resolve("s1"), "dolphin");
  });

  it("clear drops every binding", () => {
    const registry = new SessionAgentRegistry();
    registry.bind("s1", "dolphin");
    registry.bind("s2", "beaver");
    registry.clear();
    assert.equal(registry.resolve("s1"), undefined);
    assert.equal(registry.resolve("s2"), undefined);
  });
});
