/**
 * All prompt-text constants used by ZooKeeper hooks.
 *
 * These are static strings injected into tool output to guide the orchestrator
 * LLM's behavior. Each section groups related prompts by their hook origin.
 *
 * Constants are framework-independent text only — no imports, no types,
 * no logic.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Direct-work nudge (edit/write tool output)
// ---------------------------------------------------------------------------

/**
 * Full nudge text appended to edit/write tool output.
 *
 * Reminds the orchestrator that direct editing violates protocol and should
 * be delegated via `task()`.
 */
export const DIRECT_WORK_NUDGE = `<internal-reminder>
**DELEGATION REQUIRED** — You just edited a source file directly.

Did you ACTUALLY need to be the one doing that?

- Documentation, design docs, research reports, prompts → **fine, this is your job.** Continue.
- Tiny verification fix during subagent review → fine, continue.
- Anything else → **you violated Contract R1.**
  Revert the change and delegate it via \`task()\`.

**Dolphin does not implement. Dolphin orchestrates.**
</internal-reminder>`;

/**
 * Nudge text appended to grep/glob tool output for the dolphin agent.
 *
 * Distinguishes between codebase discovery (delegate to the lynx agent)
 * and simple verification (fine to proceed).
 */
export const SEARCH_DELEGATE_NUDGE = `<internal-reminder>
**POTENTIAL DELEGATION OPPORTUNITY** — You just searched the codebase.

- **Codebase discovery** (finding files, searching across multiple files, exploring structure) → delegate to the \`lynx\` agent via \`task()\`.
- **Verification** (confirming a change in a specific file, checking if a pattern exists in a known file) → fine, continue.
</internal-reminder>`;

// ---------------------------------------------------------------------------
// Post-task verification reminder
// ---------------------------------------------------------------------------

/**
 * Reminder text injected after every task() call, instructing the
 * orchestrator to verify the subagent's work before proceeding.
 */
export const VERIFY_REMINDER =
  "**THE SUBAGENT JUST CLAIMED THIS TASK IS DONE. THEY ARE PROBABLY LYING.**\n" +
  "\n" +
  'Subagents say "done" when code has errors, tests pass trivially, logic is wrong,\n' +
  "or they quietly added features nobody asked for. This happens EVERY TIME.\n" +
  "Assume the work is broken until YOU prove otherwise.\n" +
  "\n" +
  "**PHASE 1: READ THE CODE FIRST (before running anything)**\n" +
  "\n" +
  "1. See exactly which files changed. Any file outside expected scope = scope creep.\n" +
  "2. `Read` EVERY changed file - no exceptions, no skimming.\n" +
  "3. For EACH file, critically ask:\n" +
  "   - Does this code ACTUALLY do what the task required?\n" +
  "   - Any stubs, TODOs, placeholders, hardcoded values?\n" +
  "   - Logic errors? Trace the happy path AND the error path in your head.\n" +
  "   - Scope creep? Did the subagent touch things or add features NOT in the task spec?\n" +
  "4. Cross-check every claim:\n" +
  '   - Said "Updated X" - READ X. Actually updated, or just superficially touched?\n' +
  '   - Said "Added tests" - READ the tests. Do they test REAL behavior or just `expect(true).toBe(true)`?\n' +
  '   - Said "Follows patterns" - OPEN a reference file. Does it ACTUALLY match?\n' +
  "\n" +
  "**If you cannot explain what every changed line does, you have NOT reviewed it.**\n" +
  "\n" +
  "**PHASE 2: RUN AUTOMATED CHECKS (targeted, then broad)**\n" +
  "\n" +
  "1. `lsp_diagnostics` on EACH changed file - ZERO new errors\n" +
  "2. Run tests for changed modules FIRST, then full suite\n" +
  "3. Build/typecheck - exit 0\n" +
  "\n" +
  "If Phase 1 found issues but Phase 2 passes: Phase 2 is WRONG. The code has bugs that tests don't cover. Fix the code.\n" +
  "\n" +
  "**PHASE 3: GATE DECISION - Should you proceed to the next task?**\n" +
  "\n" +
  "Answer honestly:\n" +
  "1. Can I explain what EVERY changed line does? (If no - back to Phase 1)\n" +
  "2. Did I SEE it work with my own eyes? (If user-facing and no - run it yourself)\n" +
  "3. Am I confident nothing existing is broken? (If no - run broader tests)\n" +
  "\n" +
  'ALL three must be YES. "Probably" = NO. "I think so" = NO. Investigate until CERTAIN.\n' +
  "\n" +
  "- **All 3 YES** - Proceed: mark task complete, move to next.\n" +
  "- **Any NO** - Reject: resume with `task_id`, fix the specific issue.\n" +
  '- **Unsure** - Reject: "unsure" = "no". Investigate until you have a definitive answer.\n' +
  "\n" +
  "**DO NOT proceed to the next task until all 3 phases are complete and the gate passes.";

// ---------------------------------------------------------------------------
// Todo-update nudges
// ---------------------------------------------------------------------------

/**
 * Nudge text injected when there are multiple in-progress or pending
 * items, reminding the orchestrator to update the todo list.
 */
export const TODO_PROGRESS_NUDGE = `<internal-reminder>
**TODO UPDATE REQUIRED** — a subagent just completed work.

Before proceeding, mark finished items as \`completed\` and set the next item to \`in_progress\`.
UNMARKED TODO = UNTRACKED WORK = LOST PROGRESS.
</internal-reminder>`;

/**
 * Nudge text injected when exactly 1 task remains `in_progress` and
 * 0 tasks are `pending`, reminding the orchestrator to close it out.
 */
export const TODO_DONE_NUDGE = `<internal-reminder>
**TODO UPDATE REQUIRED** — last task still in_progress.

1 task remains \`in_progress\`, 0 \`pending\`. Mark it \`completed\` or move unfinished items back to \`pending\`.
UNCLOSED LIST = STALE STATUS = LOST PROGRESS.
</internal-reminder>`;

/**
 * Nudge text injected when all todos are completed or cancelled but work
 * is still happening (analogous to PLAN_RESUME_NUDGE for plan).
 */
export const TODO_RESUME_NUDGE = `<internal-reminder>
**TODO LIST DONE** — all items completed or cancelled.

If work continues, add new items and set one to \`in_progress\`.
CLEARED LIST = BROKEN TRACKING = LOST PROGRESS.
</internal-reminder>`;

// ---------------------------------------------------------------------------
// Plan progress nudges
// ---------------------------------------------------------------------------

/**
 * Nudge text shown when an executing plan has unchecked TODOs.
 * `{slug}`, `{done}`, `{total}` are replaced at injection time.
 */
export const PLAN_PROGRESS_NUDGE = `<internal-reminder>
**PLAN PROGRESS — {slug}** ({done}/{total} TODOs completed)

Open \`{path}\` and check off completed TODOs.

UNMARKED TODO = UNTRACKED WORK = LOST PROGRESS.
</internal-reminder>`;

/**
 * Nudge text shown when all TODOs are checked off but plan status is still "executing".
 * `{slug}` is replaced at injection time.
 */
export const PLAN_DONE_NUDGE = `<internal-reminder>
**PLAN COMPLETE — {slug}** All TODOs are checked off but the plan status is still "executing".

Open \`{path}\` — mark status as "done" or add new TODOs.

UNCLOSED PLAN = STALE STATUS = LOST PROGRESS.
</internal-reminder>`;

/**
 * Nudge text shown when the plan status is "done" but code edits are still happening.
 * `{slug}` is replaced at injection time.
 */
export const PLAN_RESUME_NUDGE = `<internal-reminder>
**PLAN RESURRECTED — {slug}** This plan is marked "done" but you are still editing files.

Open \`{path}\` — revert status to "executing" or add new TODOs.

RESURRECTED PLAN = BROKEN TRACKING = LOST PROGRESS.
</internal-reminder>`;

// ---------------------------------------------------------------------------
// Context nudge (context-pressure reminders)
// ---------------------------------------------------------------------------

/**
 * Skeleton for the context-pressure reminder injected by the pruning
 * nudge phase.
 *
 * Placeholders `{HEADER}`, `{tokens}`, `{percent}`, `{limit}`,
 * `{startRef}`, `{endRef}`, `{reclaim}`, `{ACTION}` and `{EQUATION}`
 * are replaced at injection time from the evaluated level's copy slots
 * (see CONTEXT_NUDGE_LEVELS).
 *
 * The window line conveys the SAME boundaries the `compress` tool
 * enforces — both refs are INCLUSIVE bounds and the model picks its own
 * contiguous sub-range inside them.  `compress`'s `toRef` is exclusive,
 * so a message is included only when the ref after it is passed —
 * stopping inside the window is always fine.
 */
export const CONTEXT_NUDGE_TEMPLATE = `<internal-reminder>
**{HEADER} — {tokens} ({percent} of {limit} window)**

Compressible window: {startRef}–{endRef} (~{reclaim} tokens), both refs inclusive.
Pick your own contiguous sub-range inside — compressing everything is optional.
\`compress\` \`toRef\` is exclusive — pass the ref after a message to include it.

{ACTION}

{EQUATION}
</internal-reminder>`;

/**
 * Level-specific copy slots filled into CONTEXT_NUDGE_TEMPLATE at
 * injection time, keyed by the nudge level returned by the decision
 * layer (`"gentle" | "urgent"`).
 */
export const CONTEXT_NUDGE_LEVELS = {
  gentle: {
    header: "CONTEXT GROWING",
    action:
      "At your next natural pause, compress a closed range with the `compress` tool. Timing is your call.",
    equation: "UNCOMPRESSED HISTORY = GROWING CONTEXT = SHRINKING HEADROOM.",
  },
  urgent: {
    header: "CONTEXT LIMIT",
    action:
      "Finish your current atomic step, then call the `compress` tool IMMEDIATELY.\nDO NOT start new exploration. DO NOT delegate new tasks. Compress first.",
    equation: "FULL CONTEXT = TERMINATED SESSION = LOST WORK.",
  },
};

// ---------------------------------------------------------------------------
// JSON error recovery
// ---------------------------------------------------------------------------

/**
 * Marker string prefixed to the JSON error reminder.
 * Used for deduplication — if output already contains this marker, skip.
 *
 * NOTE: Must be defined before JSON_ERROR_REMINDER which references it.
 */
export const JSON_ERROR_REMINDER_MARKER =
  "[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]";

/**
 * Full reminder text appended to tool output when a JSON parse error is
 * detected.
 */
export const JSON_ERROR_REMINDER = `${JSON_ERROR_REMINDER_MARKER}

You sent invalid JSON arguments. The system could not parse your tool call.
STOP and do this NOW:

1. LOOK at the error message above to see what was expected vs what you sent.
2. CORRECT your JSON syntax (missing braces, unescaped quotes, trailing commas, etc).
3. RETRY the tool call with valid JSON.

DO NOT repeat the exact same invalid call.`;
