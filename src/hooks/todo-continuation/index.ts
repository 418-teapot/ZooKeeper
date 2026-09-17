/**
 * Todo-continuation hook unit — auto-continuation after a settled turn.
 *
 * When an agent's turn settles while work remains in its todo list, the
 * orchestrator should be woken to finish.  This unit owns no judgment of
 * its own: it reads the session's todos fresh through the shared
 * `TodoSource` port at settle time and delegates the entire decision to
 * the pure core `decide` function, contributing the resulting verdict on
 * the `onSettled` slot.  The host layer translates its settle event into
 * a {@link SettledInput} and delivers any wake text.
 *
 * The todo source is resolved once per composition via
 * `resolveTodoSource` (state store, then a capable host client, else
 * `null`).  With no source the read is an empty list, so `decide`
 * silences through its `"empty"` gate — the unit stays inert rather than
 * inventing work.  The unit is enabled purely by the profile hooks list
 * (fail-closed when absent).
 *
 * @module
 */

import { resolveTodoSource } from "../../core/client/todo.js";
import { decide } from "../../core/continuation/index.js";
import type { HookUnitDescriptor } from "../../core/slots.js";

/**
 * Todo-continuation hook unit descriptor.
 *
 * Resolves the todo source once and contributes one `onSettled` handler
 * that reads the session's tasks at settle time and returns the core
 * `decide` verdict.  All other slots stay empty.
 */
export const unit: HookUnitDescriptor = {
  name: "todo-continuation",
  kind: "hook",
  create(deps) {
    const source = resolveTodoSource(deps);
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [],
      transform: [],
      textComplete: [],
      toolDefinition: [],
      delegation: [],
      onSettled: [
        {
          name: "todoContinuation",
          handle: async (input) => {
            const tasks = source ? await source(input.sessionID) : [];
            return decide(tasks, input.cause, input.budget, input.progress);
          },
        },
      ],
    };
  },
};
