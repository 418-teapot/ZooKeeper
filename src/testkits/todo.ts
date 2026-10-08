/**
 * Test builders for todo phases.
 *
 * The todo suites all construct `TodoPhase` fixtures from `[content, status]`
 * pairs; this builder keeps that shape in one place.  The per-suite `apply` /
 * `statusOf` helpers stay local — they depend on each suite's own subject.
 *
 * @module
 */

import type { TodoPhase, TodoStatus } from "../core/todo/types.js";

/** Build a phase object from `[content, status]` pairs. */
export function phase(
  name: string,
  ...tasks: Array<[string, TodoStatus]>
): TodoPhase {
  return {
    name,
    tasks: tasks.map(([content, status]) => ({ content, status })),
  };
}
