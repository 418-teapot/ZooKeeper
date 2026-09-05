/**
 * Tests for `composeGate` in `src/core/gate.ts`.
 *
 * Covers the pure judge composition: judge execution order, first-refusal
 * wins (later judges never run), allow-through (all judges pass), and the
 * empty-chain composition (`null`, i.e. allow — the fail-open strategy
 * state for a profile that enables no delegation judges).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DelegationJudgeContribution, DelegationRequest } from "./gate.js";
import { composeGate } from "./gate.js";

/** A judge that refuses exactly when `target` equals the given name. */
function targetJudge(
  name: string,
  reason = `refused-${name}`,
): DelegationJudgeContribution {
  return {
    name: `judge-${name}`,
    judge(req: DelegationRequest) {
      return req.target === name ? { reason } : null;
    },
  };
}

describe("composeGate", () => {
  it("composes an empty judge chain to null (allow)", () => {
    assert.equal(composeGate([]), null);
  });

  it("allows when every judge passes", () => {
    const gate = composeGate([targetJudge("lynx"), targetJudge("spider")]);
    assert.ok(gate !== null, "non-empty chain composes to a gate");
    assert.equal(
      gate?.({ caller: "beaver", target: "mola", prompt: "x" }),
      null,
    );
  });

  it("runs judges in order and returns the first refusal", () => {
    const seen: string[] = [];
    const gate = composeGate([
      {
        name: "first",
        judge(req) {
          seen.push("first");
          return req.target === "a" ? { reason: "refused-a" } : null;
        },
      },
      {
        name: "second",
        judge(req) {
          seen.push("second");
          return req.target === "b" ? { reason: "refused-b" } : null;
        },
      },
    ]);
    assert.ok(gate !== null);

    const refusal = gate?.({ caller: "beaver", target: "b", prompt: "x" });
    assert.deepEqual(seen, ["first", "second"]);
    assert.deepEqual(refusal, { judge: "second", reason: "refused-b" });
  });

  it("stops at the first refusal — later judges never run", () => {
    const seen: string[] = [];
    const gate = composeGate([
      {
        name: "first",
        judge(req) {
          seen.push("first");
          return req.target === "a" ? { reason: "refused-a" } : null;
        },
      },
      {
        name: "second",
        judge(req) {
          seen.push("second");
          return req.target === "a" ? { reason: "refused-second" } : null;
        },
      },
    ]);
    assert.ok(gate !== null);

    const refusal = gate?.({ caller: "mola", target: "a", prompt: "x" });
    assert.deepEqual(seen, ["first"]);
    assert.deepEqual(refusal, { judge: "first", reason: "refused-a" });
  });

  it("is a pure function of the request — missing fields flow through", () => {
    const gate = composeGate([targetJudge("kiwi")]);
    assert.ok(gate !== null);
    // A missing prompt does not stop the delegation judge: each judge
    // skips only the judgment it depends on, and the request's other
    // fields still flow through.
    assert.deepEqual(
      gate?.({ caller: "beaver", target: "kiwi", prompt: undefined }),
      { judge: "judge-kiwi", reason: "refused-kiwi" },
    );
    // And a missing caller does not stop the prompt judge at the gate
    // level — the decision is a pure function of the request fields.
    const promptGate = composeGate([
      {
        name: "prompt",
        judge(req) {
          return req.prompt === "bad" ? { reason: "bad-prompt" } : null;
        },
      },
    ]);
    assert.ok(promptGate !== null);
    assert.deepEqual(
      promptGate?.({
        caller: undefined,
        target: "beaver",
        prompt: "bad",
      }),
      { judge: "prompt", reason: "bad-prompt" },
    );
  });
});
