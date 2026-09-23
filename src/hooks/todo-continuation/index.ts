/**
 * Todo-continuation hook unit — auto-continuation after a settled turn.
 *
 * When an agent's turn settles while work remains in its todo list, the
 * orchestrator should be woken to finish.  This unit is the todo
 * strategy: it reads the session's todos fresh through the shared
 * `TodoSource` port at settle time and delegates the judgment to the pure
 * {@link decide} control law, contributing the resulting verdict on the
 * `onSettled` slot.  The engine has already filtered non-settled turns, so
 * the handler sees only the session and the observed progress fact.
 *
 * The unit owns its own budget: it reads the parsed `[zoo.continuation]`
 * config through `deps` and declares the reminder allowance as its
 * contribution's `maxWakes`.  With no valid config it contributes NO
 * settle handler at all (fail-closed at the contribution level), so the
 * engine never consults it and the host registers no settle events.
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
import type { HookUnitDescriptor } from "../../core/slots.js";
import { decide } from "./decide.js";

/**
 * Todo-continuation hook unit descriptor.
 *
 * Resolves the todo source once and contributes one `onSettled` handler
 * that reads the session's tasks at settle time and returns the todo
 * strategy's verdict.  All other slots stay empty.  Without a valid
 * `[zoo.continuation].max_reminders` the `onSettled` slot stays empty too.
 */
export const unit: HookUnitDescriptor = {
  name: "todo-continuation",
  kind: "hook",
  create(deps) {
    const maxWakes = deps.continuationConfig?.maxReminders;
    if (maxWakes === undefined) {
      return {
        kind: "hook",
        beforeExec: [],
        afterExec: [],
        transform: [],
        textComplete: [],
        toolDefinition: [],
        delegation: [],
        onSettled: [],
      };
    }
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
          maxWakes,
          handle: async (input) => {
            const tasks = source ? await source(input.sessionID) : [];
            return decide(tasks, input.progress);
          },
        },
      ],
    };
  },
};
