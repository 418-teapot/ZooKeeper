/**
 * Tests for the todo-continuation hook unit.
 *
 * Locks the descriptor shape and the `onSettled` contribution's
 * judgment-as-read contract: the handler reads the session's todos
 * through the injected source and returns the todo strategy's verdict —
 * waking on an active list with progress, silencing on an empty list, no
 * active work, no progress, or a missing todo source, and that a missing
 * continuation config contributes no handler at all.  The engine-level
 * interlocks (not-settled, budget-exhausted) are covered at the core
 * layer (`src/core/loop/engine.test.ts`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Deps } from "../../core/slots.js";
import type { TodoStateStore } from "../../core/todo/store.js";
import type { TodoPhase } from "../../core/todo/types.js";
import { CONTINUATION_PROMPT } from "./decide.js";
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
    continuationConfig: { maxReminders: 3 },
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
 * @param progress - Whether the settled turn made mutating progress.
 * @returns The handler's decision.
 */
async function settle(deps: Deps, progress = true) {
  const composed = unit.create(deps, {
    agents: new Set(),
    skills: new Set(),
    hooks: new Set(["todo-continuation"]),
    tools: new Set(),
    commands: new Set(),
  });
  assert.equal(composed.onSettled.length, 1);
  return composed.onSettled[0].handle({ sessionID: "s1", progress });
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
    assert.equal(composed.onSettled[0].maxWakes, 3);
  });

  it("declares the parsed max_reminders as its wake allowance", () => {
    const composed = unit.create(
      makeDeps({ continuationConfig: { maxReminders: 5 } }),
      {
        agents: new Set(),
        skills: new Set(),
        hooks: new Set(["todo-continuation"]),
        tools: new Set(),
        commands: new Set(),
      },
    );
    assert.equal(composed.onSettled[0].maxWakes, 5);
  });

  it("contributes no settle handler without a valid config", () => {
    const composed = unit.create(makeDeps({ continuationConfig: undefined }), {
      agents: new Set(),
      skills: new Set(),
      hooks: new Set(["todo-continuation"]),
      tools: new Set(),
      commands: new Set(),
    });
    assert.deepEqual(composed.onSettled, []);
  });
});

describe("todo-continuation unit — onSettled judgment", () => {
  it("wakes an active list that made progress", async () => {
    const decision = await settle(
      makeDeps({ todoStore: fakeStore(ACTIVE_PHASES) }),
    );
    assert.equal(decision.kind, "wake");
    if (decision.kind !== "wake") return;
    assert.ok(decision.text.startsWith(CONTINUATION_PROMPT));
    assert.ok(decision.text.includes("Wire source"));
  });

  it("silences a turn that made no progress", async () => {
    const decision = await settle(
      makeDeps({ todoStore: fakeStore(ACTIVE_PHASES) }),
      false,
    );
    assert.deepEqual(decision, { kind: "silence", reason: "no-progress" });
  });

  it("silences a settled turn with no active work", async () => {
    const decision = await settle(
      makeDeps({ todoStore: fakeStore(DONE_PHASES) }),
    );
    assert.deepEqual(decision, { kind: "silence", reason: "no-active" });
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
