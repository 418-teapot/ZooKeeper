/**
 * Tests for the capability bindings in `src/core/bindings.ts`.
 *
 * The bindings are the single source of the availability set the planner
 * reads and of the capability values the build step hands to factories.
 * The invariant under test is that the declared keys and the bound record
 * can never disagree, and that a key is never bound to `undefined`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilityBindings } from "./bindings.js";
import type { Capabilities } from "./ports/index.js";

describe("capabilityBindings — keys", () => {
  it("derives the availability keys from the supplied values", () => {
    const bindings = capabilityBindings({
      values: {
        directory: "/tmp/zoo",
        limits: {},
        resolveAgent: () => undefined,
      },
    });

    assert.deepEqual([...bindings.keys].sort(), [
      "directory",
      "limits",
      "resolveAgent",
    ]);
  });

  it("drops a value that is undefined instead of claiming the key", () => {
    const bindings = capabilityBindings({
      values: { directory: "/tmp/zoo", switchHost: undefined },
    });

    assert.deepEqual([...bindings.keys], ["directory"]);
  });

  it("is empty for empty inputs", () => {
    assert.deepEqual([...capabilityBindings({}).keys], []);
  });
});

describe("capabilityBindings — bind", () => {
  it("binds exactly the declared keys with the declared values", () => {
    const resolveAgent = () => "dolphin";
    const bindings = capabilityBindings({
      values: { directory: "/tmp/zoo", resolveAgent, limits: {} },
    });

    const bound = bindings.bind();

    assert.deepEqual(Object.keys(bound).sort(), [...bindings.keys].sort());
    assert.equal(bound.directory, "/tmp/zoo");
    assert.equal(bound.resolveAgent, resolveAgent);
  });

  it("binds a by-value handoff target", () => {
    // The `/go` handoff target is a host fact: each handoff call carries
    // its own executor, so one target serves the whole process.
    const target = {
      create: async () => ({ id: "s", agent: "a" }),
      installAgent: () => {},
      deliver: async () => {},
      focus: () => {},
    } as unknown as Capabilities["handoffTarget"];
    const bindings = capabilityBindings({ values: { handoffTarget: target } });

    assert.equal(bindings.bind().handoffTarget, target);
  });

  it("never binds an undefined value", () => {
    const bindings = capabilityBindings({
      values: { directory: "/tmp/zoo", limits: undefined },
    });

    assert.deepEqual(Object.keys(bindings.bind()), ["directory"]);
  });
});
