/**
 * Property-based invariant tests for the todo state machine (src/core/todo).
 *
 * Uses a fixed-seed PRNG (no external dependency) to fold hundreds of random
 * op batches into the state machine and assert that the invariants hold after
 * every step, for both valid and invalid (error-discarded) batches:
 * - at most one `in_progress` task;
 * - pending work always has exactly one `in_progress` task (normalization
 *   promotes the earliest pending task);
 * - completed/abandoned tasks never resurrect;
 * - task contents are globally unique;
 * - every `blocked` task carries a non-empty, whitespace-collapsed reason;
 * - a failed batch is atomic: the state is left exactly as it was.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEntries } from "./apply.js";
import type { TodoEntry, TodoInitPhase, TodoPhase } from "./types.js";

// ---------------------------------------------------------------------------
// Deterministic PRNG and helpers
// ---------------------------------------------------------------------------

/** mulberry32: tiny fixed-seed PRNG producing [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Task content pool the generator draws from. */
const POOL = Array.from({ length: 16 }, (_, i) => `t${i}`);

/** Phase names the generator may create. */
const PHASES = ["P1", "P2"];

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)];
}

function shuffle<T>(rand: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function stateContents(state: readonly TodoPhase[]): string[] {
  return state.flatMap((phase) => phase.tasks.map((task) => task.content));
}

function hasTasks(state: readonly TodoPhase[]): boolean {
  return state.some((phase) => phase.tasks.length > 0);
}

// ---------------------------------------------------------------------------
// Entry generation
// ---------------------------------------------------------------------------

/** Weighted op pick for targeting entries. */
const OPS: ReadonlyArray<[TodoEntry["op"], number]> = [
  ["done", 0.22],
  ["start", 0.18],
  ["block", 0.16],
  ["drop", 0.12],
  ["rm", 0.1],
  ["unblock", 0.08],
  ["append", 0.08],
  ["view", 0.06],
];

function opEntry(
  rand: () => number,
  state: TodoPhase[],
  retired: ReadonlySet<string>,
): TodoEntry {
  let roll = rand();
  let op: TodoEntry["op"] = "done";
  for (const [candidate, weight] of OPS) {
    if (roll < weight) {
      op = candidate;
      break;
    }
    roll -= weight;
  }

  if (op === "append") return appendEntry(rand, state, retired);
  if (op === "view") return { op: "view" };
  if (op === "rm" && rand() < 0.15) return { op: "rm" }; // clear-all

  const content = targetContent(rand, state);

  if (op === "block") {
    const reason =
      rand() < 0.2
        ? undefined
        : pick(rand, ["waiting", "review", "  gate\n hold  "]);
    return { op, task: content, reason };
  }
  // done/drop/rm also address a whole phase: the state machine keeps that
  // target even though the tool boundary requires a single task.
  if (
    (op === "done" || op === "rm" || op === "drop") &&
    rand() < 0.25 &&
    state.length > 0
  ) {
    return { op, phase: pick(rand, state).name };
  }
  return { op, task: content };
}

/**
 * Pick a target content: usually an existing open task (progress), sometimes
 * an existing closed task, a random pool member that may not exist, or an
 * ID-shaped reference — the last three generate realistic error pressure.
 */
function targetContent(rand: () => number, state: TodoPhase[]): string {
  const existing = state.flatMap((phase) => phase.tasks);
  const open = existing.filter(
    (task) =>
      task.status === "pending" ||
      task.status === "in_progress" ||
      task.status === "blocked",
  );
  const roll = rand();
  if (open.length > 0 && roll < 0.45) return pick(rand, open).content;
  if (existing.length > 0 && roll < 0.65) return pick(rand, existing).content;
  if (roll < 0.85) return pick(rand, POOL);
  return `task-${1 + Math.floor(rand() * 5)}`;
}

function appendEntry(
  rand: () => number,
  state: TodoPhase[],
  retired: ReadonlySet<string>,
): TodoEntry {
  const used = new Set(stateContents(state));
  // Never re-add a content that was already closed in this epoch — that
  // would resurrect finished work via rm + append.
  const candidates = POOL.filter(
    (content) => !used.has(content) && !retired.has(content),
  );
  if (candidates.length === 0) return initEntry(rand);
  if (rand() < 0.1) {
    // Malformed append items exercise the structural guard; the batch is
    // rejected atomically like any other error.
    const variant = rand();
    if (variant < 0.5) {
      return {
        op: "append",
        phase: pick(rand, PHASES),
        items: 42 as unknown as string[],
      };
    }
    return {
      op: "append",
      phase: pick(rand, PHASES),
      items: ["x", 7] as unknown as string[],
    };
  }
  const items = shuffle(rand, candidates).slice(0, 1 + Math.floor(rand() * 3));
  return { op: "append", phase: pick(rand, PHASES), items };
}

/** Valid inits build distinct phases/contents; invalid ones add error pressure. */
function initEntry(rand: () => number): TodoEntry {
  const roll = rand();
  if (roll < 0.7) {
    const used = new Set<string>();
    const phaseNames = shuffle(rand, PHASES).slice(
      0,
      1 + Math.floor(rand() * 2),
    );
    const phases = phaseNames.map((name) => {
      const items = shuffle(rand, POOL)
        .filter((content) => !used.has(content))
        .slice(0, 2 + Math.floor(rand() * 3));
      for (const item of items) used.add(item);
      return { phase: name, items };
    });
    if (roll < 0.45) return { op: "init", list: phases };
    const flat = phases.flatMap((entry) => entry.items);
    return { op: "init", items: flat, phase: phases[0]?.phase };
  }
  const variant = rand();
  if (variant < 0.2) return { op: "init", items: ["x", "x"] };
  if (variant < 0.35) {
    return {
      op: "init",
      list: [
        { phase: "S", items: ["a"] },
        { phase: "S", items: ["b"] },
      ],
    };
  }
  if (variant < 0.5) return { op: "init" };
  // Malformed init list entries exercise the structural guards; the batch is
  // rejected atomically without throwing.
  if (variant < 0.6) {
    return { op: "init", list: [{ phase: "M" } as unknown as TodoInitPhase] };
  }
  if (variant < 0.7) {
    return {
      op: "init",
      list: [{ phase: 7, items: [] } as unknown as TodoInitPhase],
    };
  }
  if (variant < 0.8) {
    return {
      op: "init",
      list: [{ phase: "M", items: 42 } as unknown as TodoInitPhase],
    };
  }
  if (variant < 0.9) {
    return {
      op: "init",
      list: [{ phase: "M", items: ["x", 7] } as unknown as TodoInitPhase],
    };
  }
  return { op: "init", list: [{ phase: "M", items: ["x", "x"] }] };
}

function generateBatch(
  rand: () => number,
  state: TodoPhase[],
  retired: ReadonlySet<string>,
): TodoEntry[] {
  // Bootstrap or rescue an empty list with a valid init/append.
  if (!hasTasks(state)) {
    return [rand() < 0.5 ? initEntry(rand) : appendEntry(rand, state, retired)];
  }
  const count = rand() < 0.5 ? 1 : 1 + Math.floor(rand() * 3);
  return Array.from({ length: count }, () => opEntry(rand, state, retired));
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

function assertInvariants(
  state: readonly TodoPhase[],
  retired: ReadonlySet<string>,
  step: number,
): void {
  const tasks = state.flatMap((phase) => phase.tasks);
  const seen = new Set<string>();
  let inProgress = 0;
  let pending = 0;

  for (const task of tasks) {
    assert.ok(
      !seen.has(task.content),
      `duplicate content "${task.content}" at step ${step}`,
    );
    seen.add(task.content);

    if (retired.has(task.content)) {
      assert.ok(
        task.status === "completed" || task.status === "abandoned",
        `closed task "${task.content}" resurrected at step ${step}`,
      );
    }
    if (task.status === "blocked") {
      assert.ok(
        typeof task.blocker === "string" && task.blocker.length > 0,
        `blocked task "${task.content}" without a reason at step ${step}`,
      );
      assert.ok(
        !/\s{2,}/.test(task.blocker) && task.blocker === task.blocker.trim(),
        `blocker of "${task.content}" not whitespace-collapsed at step ${step}`,
      );
    }
    if (task.status === "in_progress") inProgress += 1;
    if (task.status === "pending") pending += 1;
  }

  assert.ok(inProgress <= 1, `multiple in_progress at step ${step}`);
  if (pending > 0) {
    assert.equal(
      inProgress,
      1,
      `pending tasks without an in_progress at step ${step}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

describe("todo property-based invariants", () => {
  it("hold across 400 random batches (fixed seed 0xc0ffee)", () => {
    const rand = mulberry32(0xc0ffee);
    let state: TodoPhase[] = [];
    // Contents that became closed in the current list epoch (reset on init).
    const retired = new Set<string>();

    for (let step = 0; step < 400; step++) {
      const batch = generateBatch(rand, state, retired);
      const preJson = JSON.stringify(state);
      const hadInit = batch.some((entry) => entry.op === "init");
      const result = applyEntries(state, batch);

      if (result.errors.length > 0) {
        // Atomicity: a failed batch leaves the state exactly as it was.
        assert.equal(
          JSON.stringify(result.phases),
          preJson,
          `state changed despite batch errors at step ${step}`,
        );
      } else {
        if (hadInit) {
          // A successful init is a whole-list restart: new epoch.
          retired.clear();
        }
        for (const task of result.phases.flatMap((phase) => phase.tasks)) {
          if (task.status === "completed" || task.status === "abandoned") {
            retired.add(task.content);
          }
        }
        state = result.phases;
      }

      assertInvariants(state, retired, step);
    }
  });
});
