/**
 * Prompt-text constants injected by ZooKeeper hooks and tools.
 *
 * These are static strings injected into tool output to guide the orchestrator
 * LLM's behavior. Each section groups related prompts by their hook origin.
 *
 * Scope: hook/tool-injected nudge and reminder texts only. Agent prompt
 * fragments (DELEGATION_FORMAT_TEXT, SUBAGENT_PROMPT_HINT, ...) live in
 * `src/agents/parts.ts`; full agent prompts live in `src/agents/<name>.ts`.
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
 * Helps dolphin re-evaluate the delivery boundary after a direct edit without
 * treating delegation as a mandatory action.
 */
export const DIRECT_WORK_NUDGE = `<internal-reminder>
你刚刚直接修改了文件。根据当前任务的边界重新核对：

- 这是范围明确、局部且可验证的结果吗？如果是，继续完成并验证，不要撤销符合请求的改动。
- 这是仍需探索才能确定范围或验收条件的开放问题吗？如果是，**停止**改动并**回退**，重新获取必要事实，并进行委派。
</internal-reminder>`;

/**
 * Nudge text appended to grep/glob tool output for the dolphin agent.
 *
 * Distinguishes an independently requested exploration result from local
 * investigation needed to complete or verify a bounded task.
 */
export const SEARCH_DELEGATE_NUDGE = `<internal-reminder>
你刚刚搜索了代码库。根据搜索的目的重新判断：

- 如果搜索结果本身就是用户要得到的代码位置、调用关系或结构分析，应将封闭的探索结果交给 lynx。
- 如果搜索只是完成已明确实现或核验结果所需的局部调查，可以继续当前工作。
- 如果搜索会决定任务范围或验收条件，先整理为可独立验收的事实结果，再继续实施。

不要因为执行过搜索就自动委派，也不要用无目标的搜索代替明确的交付结果。
</internal-reminder>`;

// ---------------------------------------------------------------------------
// Post-subagent verification reminder
// ---------------------------------------------------------------------------

/**
 * Reminder text injected after every task() call, instructing the
 * orchestrator to verify the subagent's work before proceeding.
 */
export const VERIFY_REMINDER = `子 agent 声称完成了工作，它很可能在撒谎。先把返回的结果作为待核验结果处理，完成结论以实际验收证据为准。

对照原委派的 SUMMARY、CONTEXT 和 ACCEPTANCE，确认：
- 交付目标、范围和非目标保持一致；
- ACCEPTANCE 中的每一项都有可观察、可复核的证据；
- 返回内容直接对应完整交付结果，并满足验收条件。

根据结果类型选择核验方式：
- 代码改动：阅读实际改动，运行相称的诊断、测试和构建；
- 代码探索：检查文件路径、行号和对应代码依据；
- 网页调研：检查实际 URL、来源与结论的对应关系；
- 其他结果：确认返回内容直接满足 ACCEPTANCE。

验收证据完整时，重新检查整个交付目标，再决定继续、并行、调整路径或收尾。发现范围偏移、证据缺口或结果不完整时，明确缺口，并选择补充同一交付单元、创建新的封闭交付单元、直接处理局部修正、请求用户决定或报告阻塞。`;

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
// Manual compress template (synthetic user message for /dcp compress)
// ---------------------------------------------------------------------------

/**
 * Template for the synthetic user message injected by the transform one
 * turn after a `/dcp compress` command (pendingManualTrigger one-shot
 * flag).
 *
 * Written in a user-instruction tone (not a reminder) — the model treats
 * it as a direct command to call the `compress` tool.  The `{WINDOW}`
 * placeholder is replaced at injection time with the compressible-window
 * line (from `computeEligibility`) or a fallback line when no eligible
 * window exists.  Range-selection and segmentation strategy is delegated
 * to the `compress-usage` skill by pointer instead of inline
 * teaching.
 */
export const MANUAL_COMPRESS_TEMPLATE = `请立即使用 compress 工具压缩历史上下文：

{WINDOW}

范围选择与分段策略：加载 compress-usage 技能。

加载完成后立即执行：按技能指引选择一个或多个连续范围，调用 compress 工具一次性批量提交。`;

// ---------------------------------------------------------------------------
// Context nudge (context-pressure reminders)
// ---------------------------------------------------------------------------

/**
 * Skeleton for the context-pressure reminder injected by the pruning
 * nudge phase.
 *
 * Placeholders `{HEADER}`, `{tokens}`, `{percent}`, `{limit}`,
 * `{startRef}`, `{endRef}`, `{reclaim}`, `{ACTION}`, `{TEACHING}` and
 * `{EQUATION}` are replaced at injection time from the evaluated level's
 * copy slots (see CONTEXT_NUDGE_LEVELS).
 *
 * The window line conveys the SAME boundaries the `compress` tool
 * enforces — both refs are INCLUSIVE bounds: each ref points at a
 * message that gets compressed.  The model picks its own contiguous
 * sub-range inside the window — stopping inside it is always fine.
 */
export const CONTEXT_NUDGE_TEMPLATE = `<internal-reminder>
**{HEADER} — {tokens} ({percent} of {limit} window)**

Compressible window: {startRef}–{endRef} (~{reclaim} tokens), both refs inclusive.
Pick your own contiguous sub-range inside — compressing everything is optional.
\`compress\` refs are inclusive — both endpoints are compressed.

{ACTION}

{TEACHING}

{EQUATION}
</internal-reminder>`;

/**
 * Pointer to the `compress-usage` skill, filling the `{TEACHING}`
 * slot of every nudge level — range-selection and segmentation strategy
 * lives in the skill file, not inline.
 */
export const COMPRESS_USAGE_POINTER =
  "Range selection and segmentation: load the `compress-usage` skill.";

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
    teaching: COMPRESS_USAGE_POINTER,
  },
  urgent: {
    header: "CONTEXT LIMIT",
    action:
      "Finish your current atomic step, then call the `compress` tool IMMEDIATELY.\nDO NOT start new exploration. DO NOT delegate new tasks. Compress first.",
    equation: "FULL CONTEXT = TERMINATED SESSION = LOST WORK.",
    teaching: COMPRESS_USAGE_POINTER,
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
