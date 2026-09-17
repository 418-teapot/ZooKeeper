/**
 * Tests for the todo-continuation hook unit.
 *
 * Locks the descriptor shape and the `onSettled` contribution's
 * judgment-as-read contract: the handler reads the session's todos
 * through the injected source and returns the core `decide` verdict —
 * waking on a settled turn with active work, silencing on a non-settled
 * cause, an exhausted budget, an empty list, or a missing todo source.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Budget } from "../../core/continuation/decide.js";
import { CONTINUATION_PROMPT } from "../../core/continuation/index.js";
import type { Deps } from "../../core/slots.js";
import type { TodoStateStore } from "../../core/todo/store.js";
import type { TodoPhase } from "../../core/todo/types.js";
import { unit } from "./index.js";

/** A todo list with work in flight. */
const ACTIVE_PHASES: TodoPhase[] = [
  {
    name: "Implement",
    tasks: [
      { content: "Wire source", status: "in_progress" },
      { content: "Update tests", status: "pending" },
    ],
  },
];

/** A fully settled todo list (no active work). */
const DONE_PHASES: TodoPhase[] = [
  { name: "Implement", tasks: [{ content: "Ship it", status: "completed" }] },
];

/** A budget with room to spare. */
const OPEN_BUDGET: Budget = { limit: 3, used: 0 };

/**
 * Build a store-shaped fake serving the given phases on every read.
 *
 * @param phases - Phases the store hands out.
 * @returns A `TodoStateStore`-shaped object.
 */
function fakeStore(phases: TodoPhase[]): TodoStateStore {
  return {
    get: async () => phases,
    set: () => {},
    invalidate: () => {},
    serialize: <T>(fn: () => Promise<T>) => fn(),
  };
}

/** Assemble a partial deps object for unit-level tests. */
function makeDeps(partial: Record<string, unknown>): Deps {
  return {
    limits: {},
    contextConfig: {},
    client: {},
    directory: "",
    resolveAgent: () => undefined,
    ...partial,
  } as unknown as Deps;
}

/**
 * Compose the unit and run its `onSettled` handler with the given inputs.
 *
 * @param deps - Dependencies handed to `unit.create`.
 * @param cause - The settle cause.
 * @param budget - The session budget.
 * @returns The handler's decision.
 */
async function settle(
  deps: Deps,
  cause: "settled" | "awaiting-input" | "aborted" = "settled",
  budget: Budget = OPEN_BUDGET,
) {
  const composed = unit.create(deps, {
    agents: new Set(),
    skills: new Set(),
    hooks: new Set(["todo-continuation"]),
    tools: new Set(),
    commands: new Set(),
  });
  assert.equal(composed.onSettled.length, 1);
  return composed.onSettled[0].handle({
    sessionID: "s1",
    cause,
    budget,
    progress: true,
  });
}

describe("todo-continuation unit — descriptor", () => {
  it("registers under the todo-continuation hook name", () => {
    assert.equal(unit.name, "todo-continuation");
    assert.equal(unit.kind, "hook");
  });

  it("contributes only the onSettled slot", () => {
    const composed = unit.create(makeDeps({}), {
      agents: new Set(),
      skills: new Set(),
      hooks: new Set(["todo-continuation"]),
      tools: new Set(),
      commands: new Set(),
    });
    assert.deepEqual(composed.beforeExec, []);
    assert.deepEqual(composed.afterExec, []);
    assert.deepEqual(composed.transform, []);
    assert.deepEqual(composed.textComplete, []);
    assert.deepEqual(composed.toolDefinition, []);
    assert.deepEqual(composed.delegation, []);
    assert.equal(composed.onSettled.length, 1);
    assert.equal(composed.onSettled[0].name, "todoContinuation");
  });
});

describe("todo-continuation unit — onSettled judgment", () => {
  it("wakes a settled turn with active todos and budget room", async () => {
    const decision = await settle(
      makeDeps({ todoStore: fakeStore(ACTIVE_PHASES) }),
    );
    assert.equal(decision.kind, "wake");
    if (decision.kind !== "wake") return;
    assert.ok(decision.text.startsWith(CONTINUATION_PROMPT));
    assert.ok(decision.text.includes("Wire source"));
  });

  it("silences an aborted turn via the not-settled gate", async () => {
    const decision = await settle(
      makeDeps({ todoStore: fakeStore(ACTIVE_PHASES) }),
      "aborted",
    );
    assert.deepEqual(decision, { kind: "silence", reason: "not-settled" });
  });

  it("silences a settled turn with no active work", async () => {
    const decision = await settle(
      makeDeps({ todoStore: fakeStore(DONE_PHASES) }),
    );
    assert.deepEqual(decision, { kind: "silence", reason: "no-active" });
  });

  it("silences a settled turn when the budget is exhausted", async () => {
    const decision = await settle(
      makeDeps({ todoStore: fakeStore(ACTIVE_PHASES) }),
      "settled",
      { limit: 3, used: 3 },
    );
    assert.deepEqual(decision, { kind: "silence", reason: "budget-exhausted" });
  });

  it("treats a missing todo source as an empty list", async () => {
    const decision = await settle(makeDeps({}));
    assert.deepEqual(decision, { kind: "silence", reason: "empty" });
  });

  it("reads the todo list fresh on every settle", async () => {
    let calls = 0;
    const phases: TodoPhase[] = ACTIVE_PHASES;
    const store: TodoStateStore = {
      get: async () => {
        calls += 1;
        return phases;
      },
      set: () => {},
      invalidate: () => {},
      serialize: <T>(fn: () => Promise<T>) => fn(),
    };
    const deps = makeDeps({ todoStore: store });
    await settle(deps);
    await settle(deps);
    assert.equal(calls, 2, "each settle must read the source again");
  });
});
