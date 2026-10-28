/**
 * Constants shared by the scenario driver and the harness extension.
 *
 * Product-facing strings (`PLAN_COMPLETE_TEXT`, `PLAN_EMPTY_TEXT`) are
 * copied from the tool output the scenarios expect, so an assertion can
 * never be satisfied by recomputing it the way the product does.  The
 * markers are the harness's own protocol with the deterministic provider.
 */

/** Prompts that drive the deterministic provider. */
export const MARKERS = {
  /** Create the alpha plan and complete every task in one run. */
  todo: "E2E-TODO: 创建 alpha 计划并逐项完成",
  /** Read the active plan back. */
  view: "E2E-VIEW: 读回当前计划",
  /** Delegate to the lynx subagent. */
  subagent: "E2E-SUBAGENT: 委派给 lynx",
} as const;

/** Phase name of the alpha plan. */
export const ALPHA_PHASE = "alpha";

/** Task contents of the alpha plan. */
export const ALPHA_TASKS = ["alpha-step-1", "alpha-step-2", "alpha-step-3"];

/** Tag the child model echoes back, proving the reply came from the child. */
export const CHILD_TAG = "run1";

/** Text the child session produces. */
export const CHILD_REPLY = `CHILD-OK:${CHILD_TAG}`;

/** Product output of `todo view` when the plan is fully completed. */
export const PLAN_COMPLETE_TEXT = "Overall: 3/3 done, 0 open.";

/** Product output of `todo view` when no plan exists. */
export const PLAN_EMPTY_TEXT = "Todo list is empty.";

/** Tools the extension must register for the scenarios to be meaningful. */
export const REQUIRED_TOOLS = ["todo", "subagent"] as const;

/** Session replacement reasons pi reports through `session_start`. */
export const SESSION_START_REASONS = [
  "startup",
  "reload",
  "new",
  "resume",
  "fork",
] as const;

/** Tool calls the alpha plan performs, in order. */
export const PLAN_OPS = ["init", "done", "done", "done", "view"] as const;

// ---------------------------------------------------------------------------
// Context-pipeline / compression-tools scenario protocol
// ---------------------------------------------------------------------------

/** First user turn of the context scenarios (anchored, never compressed). */
export const CONTEXT_ANCHOR_PROMPT = "E2E-CTX-ANCHOR: 上下文基线开场";

/** Prompt prefix of a compressible target segment (`-1`, `-2`). */
export const CONTEXT_TARGET_PROMPT = "E2E-CTX-TARGET";

/**
 * Unique tags inside the target segments.  The assertions search the model
 * request for them, so "covered" means the real pipeline removed the text,
 * not that the harness stopped asking for it.
 */
export const CONTEXT_TARGET_TAGS = ["CTX-TARGET-1", "CTX-TARGET-2"] as const;

/** Prompt prefix of a history filler turn (` 1`, ` 2`, ...). */
export const CONTEXT_FILL_PROMPT = "E2E-CTX-FILL";

/** Filler turns pushed after the targets to leave the protection window. */
export const CONTEXT_FILL_TURNS = 13;

/**
 * CJK filler characters per target / filler message.  The estimator counts
 * CJK at 1.5 characters per token, so this is about 2000 tokens per message:
 * the target range clears `threshold_tokens` (2000) and the filler tail
 * clears the `protected_tokens` budget (20000).
 */
export const CONTEXT_SEGMENT_CHARS = 3000;

/** Prompt that makes the model call the real `compress` tool. */
export const CONTEXT_COMPRESS_PROMPT = "E2E-CTX-COMPRESS: 压缩两条目标指令";

/** Prompt that makes the model call the real `decompress` tool. */
export const CONTEXT_DECOMPRESS_PROMPT = "E2E-CTX-DECOMPRESS: 恢复刚压缩的块";

/** Title the model writes for the block the target range becomes. */
export const CONTEXT_BLOCK_TITLE = "目标段：两条指令与回复";

/** Sentinel the model writes into the summary body. */
export const CONTEXT_SUMMARY_TAG = "TARGET-SUMMARY-BODY";

/** Summary body the model writes; the folded view must carry it verbatim. */
export const CONTEXT_SUMMARY_BODY = `${CONTEXT_SUMMARY_TAG}: 两条目标指令及其回复已折叠为摘要。`;

/** Id of the block the target range becomes (first block of the session). */
export const CONTEXT_BLOCK_ID = "b1";

/** Messages the target range covers: two prompts, each with its reply. */
export const CONTEXT_BLOCK_MESSAGES = 4;

/**
 * Block label the folded view must carry, in the product's own format
 * (`[Block bN · K 条] 标题`, K = covered message count).
 */
export const CONTEXT_BLOCK_LABEL = `[Block ${CONTEXT_BLOCK_ID} · ${CONTEXT_BLOCK_MESSAGES} 条] ${CONTEXT_BLOCK_TITLE}`;

/**
 * Tags the deterministic provider reports per received message.  The summary
 * body is a tag too, so a check can prove the folded message carries the
 * model-written summary and not only the block label.
 */
export const VIEW_TAGS = [...CONTEXT_TARGET_TAGS, CONTEXT_SUMMARY_TAG] as const;
