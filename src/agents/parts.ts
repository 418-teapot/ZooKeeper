/**
 * Shared prompt fragments for ZooKeeper agents.
 *
 * DELEGATION_FORMAT_TEXT — the canonical delegation-format block used by
 *   orchestrator and subagents.
 * SUBAGENT_PROMPT_HINT — format guidance injected into the `task` tool's
 *   parameter description.
 *
 * Scope: fragments composing agent prompts only. Hook/tool-injected nudge
 * texts live in `src/core/prompts.ts`.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Delegation format — single source of truth
// ---------------------------------------------------------------------------

/**
 * Canonical delegation-format block.
 *
 * Three required sections (SUMMARY / CONTEXT / ACCEPTANCE) with concise
 * structural guidance. Used by all agents that can delegate.
 */
export const DELEGATION_FORMAT_TEXT = `- **SUMMARY** - 用一句话说明这次委派要得到什么结果；一次只委派一个明确目标。
- **CONTEXT** - 交代接收者无法从任务本身获知、但会影响判断的事实，包括用户意图、已知发现、失败现象、范围与排除条件，以及相关约束。假设接收者看不到此前的对话：必要信息要写全，无关历史和重复内容要删掉。说明要查明什么，不要预先指定该如何实现。写到足以独立执行为止，不设长度限制，也不要为了简短省略关键事实。
- **ACCEPTANCE** - 列出 1–2 项具体、可验证的结果，以及用什么证据核验，例如文件位置、引用的代码或测试结果。标准应与 SUMMARY 对应；多处证据可以服务于同一结果；如果需要更多互不相关的结果，就拆成多次委派。
`;

// ---------------------------------------------------------------------------
// Subagent prompt hint
// ---------------------------------------------------------------------------

export const SUBAGENT_PROMPT_HINT = `Format:
${DELEGATION_FORMAT_TEXT}

Required for all delegation targets, regardless of agent type.`;

/**
 * Format guidance shown in the `task` tool's `prompt` parameter description.
 * The LLM sees this in the schema on every call.
 */
// ---------------------------------------------------------------------------
// Agent role descriptions — shared across all agents that reference them
// ---------------------------------------------------------------------------

export const LYNX_AGENT_LINE = `- **lynx** — codebase search, file discovery, signature lookups, structural analysis.`;

export const SPIDER_AGENT_LINE = `- **spider** — web research, URL fetching, API documentation lookup.`;

export const BEAVER_AGENT_LINE = `- **beaver** — code writing, editing, bug fixes, refactoring, test creation.`;

export const EAGLE_AGENT_LINE = `- **eagle** — loaded via the \`code-review\` skill. Use for code review. Always dispatch two Eagle calls in parallel for independent perspectives.`;

export const KIWI_AGENT_LINE = `- **kiwi** — loaded via the \`wiki-ingest\` skill. Use for knowledge distillation from external URLs and documents.`;

// ---------------------------------------------------------------------------
// Leaf subagent listing — shared across beaver + mola
// ---------------------------------------------------------------------------

/**
 * Shared introduction listing available leaf subagents.
 *
 * Both beaver and mola delegate to lynx (codebase) and spider (web)
 * for information gathering.  This header introduces them with their
 * one-line roles.
 */
export const DELEGATION_LEAF_AGENTS_HEADER = `Two subagents are available for information gathering via \`task()\`:

${LYNX_AGENT_LINE}
${SPIDER_AGENT_LINE}

Delegation uses the same three-section format as the dolphin orchestrator:
`;

// ---------------------------------------------------------------------------
// Delegation discipline — shared across beaver + mola
// ---------------------------------------------------------------------------

/**
 * Common delegation discipline rules.
 *
 * Three rules that apply identically to agents that delegate to leaf
 * subagents (lynx/spider) for information gathering.  Consumed by
 * beaver and mola with their own identity closing lines.
 */
export const DELEGATION_DISCIPLINE_TEXT = `Key discipline:

- **Parallelize independent searches** — dispatch lynx (codebase) and spider (web) simultaneously when both are needed.
- **One \`task()\` = one focused outcome** — split if multiple unrelated goals hide inside a single search.
- **Information gathering only** — lynx and spider return raw findings; you synthesize them into your implementation. Do not delegate implementation work or design decisions.
`;

// ---------------------------------------------------------------------------
// Leaf delegation example — shared across beaver + mola
// ---------------------------------------------------------------------------

/**
 * Filled three-section example for leaf-subagent delegation.
 *
 * Shows a concrete SUMMARY / CONTEXT / ACCEPTANCE block for a lynx
 * codebase-search task. Uses a generic scenario (error-handling audit)
 * so agents pattern-match the structure, not project-specific symbols.
 * The BAD/GOOD contrast teaches the real failure mode for leaf
 * delegation: turning a search into a consultation by front-loading
 * background the subagent never asked for.
 */
export const DELEGATION_LEAF_EXAMPLE = `Example (codebase search):

**SUMMARY:** List every function in \`src/\` that catches an exception and silently returns a default value.

**CONTEXT:** A user reported that request failures disappear without logs and callers receive apparently valid fallback values. Existing investigation suggests the failure is caused by catch blocks that return defaults such as \`null\`, \`false\`, \`[]\`, \`{}\`, \`0\`, or an empty string without logging or rethrowing. Search all source files under \`src/\`, including callbacks and anonymous functions. Include catches whose return occurs through a local helper or conditional branch when the exception can still be silently converted into a default. Exclude catch blocks that always rethrow, return an explicit error/result object, or log and intentionally recover. This is a discovery task only: identify matching code and evidence; do not recommend an error-handling design or modify files.

**ACCEPTANCE:**
1. Report every match as \`file: line\`, with the catch statement and default return statement quoted.
2. For indirect or conditional returns, briefly show why the caught exception can reach the default-return path.

> BAD — underspecified because it makes the subagent reconstruct known intent:
> **CONTEXT:** Find catch blocks that return defaults.
>
> BAD — turns a scoped search into an open-ended consultation:
> **CONTEXT:** We're improving observability across the codebase. Investigate our error-handling strategy and recommend where to add logging, rethrow exceptions, introduce error codes, or redesign fallback behavior.
>
> GOOD — self-contained but still limited to one searchable outcome`;

// ---------------------------------------------------------------------------
// Message ref no-echo instruction
// ---------------------------------------------------------------------------

/**
 * Instructs the model never to reproduce line-start `[mN] ` ref prefixes
 * in its output.
 *
 * These refs are line-number addresses injected by the render layer at
 * line start of every visible view item; the model sees them in its
 * input and could echo them back.  Reproducing them in free text is
 * never useful — they are an addressing convention, not content — so
 * "never reproduce" is safe across the whole prompt surface today.
 *
 * When a model-driven compress tool lands that accepts refs in tool
 * calls, this wording must change to allow referencing refs inside tool
 * arguments while still suppressing verbatim echo in free text.
 */
export const MSG_REF_NO_ECHO =
  "**NEVER reproduce message refs (like `[m3]`) in your output** — they are line-number prefixes injected by the runtime for context management.";
