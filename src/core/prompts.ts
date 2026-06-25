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
// Task prompt hint
// ---------------------------------------------------------------------------

/**
 * Format guidance shown in the `task` tool's `prompt` parameter description.
 * The LLM sees this in the schema on every call.
 */
export const TASK_PROMPT_HINT = `Format:
**SUMMARY:** 1 sentence — desired outcome.
**CONTEXT:** facts subagent cannot discover (target file path, user intent, constraints, prior failure conclusions).
**ACCEPTANCE:** 1-2 verifiable outcomes.
Required for all delegation targets, regardless of agent type. Keep CONTEXT focused on WHAT and WHY, not HOW — subagents read files and decide implementation themselves.`;

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
export const TODO_GENERAL =
  "**TODO UPDATE REQUIRED — DO THIS NOW**\n" +
  "\n" +
  "A subagent just completed work. Before proceeding, mark finished items as\n" +
  "`completed` and set the next item to `in_progress`.\n" +
  "UNMARKED = UNTRACKED = LOST PROGRESS.";

/**
 * Nudge text injected when exactly 1 task remains `in_progress` and
 * 0 tasks are `pending`, reminding the orchestrator to close it out.
 */
export const TODO_FINAL_ACTIVE =
  "**TODO UPDATE REQUIRED — LAST TASK STILL in_progress**\n" +
  "\n" +
  "1 task remains `in_progress`, 0 `pending`. A subagent just finished work.\n" +
  "Mark it `completed` now, or move unfinished items back to `pending`.\n" +
  "STALE STATUS = INVISIBLE WORK = FORGOTTEN WORK.";

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
