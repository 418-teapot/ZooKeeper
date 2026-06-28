/**
 * Shared prompt fragments for ZooKeeper agents.
 *
 * DELEGATION_FORMAT_TEXT — the canonical delegation-format block used by
 *   orchestrator and subagents.
 * TASK_PROMPT_HINT — format guidance injected into the `task` tool's
 *   parameter description.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Delegation format — single source of truth
// ---------------------------------------------------------------------------

/**
 * Canonical delegation-format block.
 *
 * Three required sections (SUMMARY / CONTEXT / ACCEPTANCE) with placeholder
 * descriptions. Used by all agents that delegate via `task()`.
 */
export const DELEGATION_FORMAT_TEXT = `**SUMMARY:** {SUMMARY_TEXT}
**CONTEXT:** {CONTEXT_FACTS}
**ACCEPTANCE:** {ACCEPTANCE_CRITERIA}

Fill each placeholder:
- \`{SUMMARY_TEXT}\` — 1 sentence: the desired outcome.
- \`{CONTEXT_FACTS}\` — facts the subagent CANNOT easily discover (user intent, non-obvious constraints, prior failures, runtime facts, approach hints). Skip code blocks, signatures, line numbers, prescribed implementation.
- \`{ACCEPTANCE_CRITERIA}\` — 1-2 verifiable outcomes (e.g. "test X passes", "build succeeds").
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
