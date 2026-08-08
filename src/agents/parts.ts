/**
 * Shared prompt fragments for ZooKeeper agents.
 *
 * DELEGATION_FORMAT_TEXT — the canonical delegation-format block used by
 *   orchestrator and subagents.
 * TASK_PROMPT_HINT — format guidance injected into the `task` tool's
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
 * structural guidance. Used by all agents that delegate via `task()`.
 */
export const DELEGATION_FORMAT_TEXT = `- **SUMMARY** - 1 sentence describing the single desired outcome.
- **CONTEXT** - all facts needed to understand and correctly execute the focused task. Assume the subagent has no access to prior conversation. Include user intent, non-obvious semantics, failure mechanism, relevant prior discoveries, constraints, and worktree state. Do not require the subagent to reconstruct known context from the repository. EXCLUDE all irrelevant history, instructions, code blocks, line numbers and signatures that prescribe implementation.
- **ACCEPTANCE** - 1-2 concrete, verifiable outcomes with the evidence required for completion (e.g. "test X passes", "build succeeds"). This limit controls task scope, not CONTEXT detail; split the task if it requires more independent outcomes.
`;

// ---------------------------------------------------------------------------
// Task prompt hint
// ---------------------------------------------------------------------------

export const TASK_PROMPT_HINT = `Format:
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
 * Instructs the model never to reproduce `<zoo-msg-id>` tags in its output.
 *
 * These refs are write-only metadata injected by the runtime's context-pruning
 * pipeline.  No tool consumes them yet, so "never reproduce" is safe today.
 *
 * When a model-driven compress tool lands that accepts refs in tool calls,
 * this wording must change to allow referencing refs inside tool arguments
 * while still suppressing verbatim echo in free text.
 */
export const MSG_REF_NO_ECHO =
  "**NEVER reproduce message refs (like `<zoo-msg-id>m0001</zoo-msg-id>`) in your output** — they are metadata injected by the runtime for context management.";
