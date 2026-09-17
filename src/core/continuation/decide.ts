/**
 * Auto-continuation decision — a pure function over todo task views.
 *
 * When an agent's turn settles while work remains in its todo list, the
 * orchestrator should wake the agent and press it to finish.  This module
 * owns the entire judgment: it inspects the flattened task list, the
 * reason the turn ended, the session's reminder budget, and whether the
 * settled turn actually made mutating progress, and returns either a
 * reminder to deliver or an explicit silence with the gate that
 * suppressed it.  Host layers only translate their events into these
 * inputs and deliver the resulting text.
 *
 * The function is total and side-effect free: the same inputs always
 * produce the same output, there is no module state, and no host, file
 * system, or process API is touched.  Budget bookkeeping (counting a
 * reminder as used, resetting progress) belongs to the host; this module
 * only reads the current budget.
 *
 * @module
 */

import type { TodoItemView } from "../todo/types.js";
import { isActiveTodoStatus } from "../todo/types.js";

/** Why the agent's turn ended. */
export type StopCause = "settled" | "awaiting-input" | "aborted";

/**
 * One tool call observed in a settled turn.
 *
 * `name` is the bare tool name as the host reports it; the host fills
 * `agent` ONLY on its delegation tool call and leaves it absent
 * otherwise. Core treats a present `agent` as delegation — the names
 * themselves are host vocabulary and never appear here.
 */
export interface TurnToolCall {
  /** Bare tool name (host vocabulary). */
  name: string;
  /** Delegated agent name, set only by the host's delegation tool. */
  agent?: string;
}

/**
 * Host-supplied vocabulary used to classify a settled turn's calls.
 *
 * Core stays name-agnostic: each host declares which of its tool names
 * mutate (prove execution) and how to tell whether a delegated agent may
 * mutate. Nothing about a host's naming lives in this module.
 */
export interface WorkVocabulary {
  /** Tool names whose invocation counts as direct mutating work. */
  mutatingTools: readonly string[];
  /** Whether a delegated agent name is an executor (may mutate). */
  isExecutorAgent: (agent: string) => boolean;
}

/** Reminder budget for one session: how many wakes are allowed, and used. */
export interface Budget {
  /** Maximum number of continuation reminders for the session. */
  limit: number;
  /** Reminders already consumed for the session. */
  used: number;
}

/** Why a continuation reminder was withheld. */
export type SilenceReason =
  | "not-settled"
  | "empty"
  | "no-active"
  | "no-progress"
  | "budget-exhausted";

/** The outcome of a continuation judgment. */
export type Decision =
  | { kind: "wake"; text: string }
  | { kind: "silence"; reason: SilenceReason };

/**
 * Fixed directive prepended to every continuation reminder.
 *
 * The wording is deliberately adversarial: it anticipates the model
 * claiming the work is done and pushes it to re-verify rather than
 * silently accept the claim.
 */
export const CONTINUATION_PROMPT =
  "Incomplete tasks remain in your todo list. " +
  "Continue working on the next pending task.\n" +
  "- Proceed without asking for permission\n" +
  "- Mark each task complete when finished\n" +
  "- Do not stop until all tasks are done\n" +
  "- If you believe all work is already complete, the system is " +
  "questioning your completion claim. Critically re-examine each todo " +
  "item from a skeptical perspective, verify the work was actually done " +
  "correctly, and update the todo list accordingly.";

function isRemaining(status: TodoItemView["status"]): boolean {
  return status !== "completed" && status !== "abandoned";
}

/**
 * Render the continuation reminder for an unfinished todo list.
 *
 * The text is the fixed `CONTINUATION_PROMPT` followed by a compact status
 * summary and the list of tasks that are neither completed nor abandoned
 * (blocked tasks are still reported, since they remain unresolved).
 *
 * @param tasks - The task views to summarize.
 * @returns The reminder text.
 */
function renderContinuation(tasks: readonly TodoItemView[]): string {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const remaining = tasks.filter((task) => isRemaining(task.status));

  const lines = [
    CONTINUATION_PROMPT,
    "",
    `[Status: ${completed}/${tasks.length} completed, ` +
      `${remaining.length} remaining]`,
    "Remaining tasks:",
    ...remaining.map((task) => `- [${task.status}] ${task.content}`),
  ];
  return lines.join("\n");
}

/**
 * Normalize a settled turn's tool calls into the mutating actions it
 * performed.
 *
 * Only real execution counts: a turn that merely reads, discusses, or
 * updates its todo list has not advanced the work. A direct call counts
 * when its name is one the host declares as mutating. A call carrying a
 * delegated agent (the host sets `agent` only on its delegation tool)
 * counts only when that agent is an executor — the host derives that from
 * the agent's permission deny list (an agent denied `edit` is read-only).
 * A missing or unknown agent does NOT count, biasing toward silence, and
 * a tool the host does not declare (e.g. its todo tool) never counts.
 *
 * @param calls - Tool calls observed in the settled turn, in order.
 * @param vocab - The host's tool vocabulary (mutating names + executor
 *   predicate).
 * @returns The counted action names in call order (duplicates preserved).
 */
export function resolveWorkActions(
  calls: readonly TurnToolCall[],
  vocab: WorkVocabulary,
): string[] {
  const actions: string[] = [];
  for (const call of calls) {
    if (vocab.mutatingTools.includes(call.name)) {
      actions.push(call.name);
    } else if (call.agent !== undefined && vocab.isExecutorAgent(call.agent)) {
      actions.push(call.name);
    }
  }
  return actions;
}

// --- Turn-handback detection -------------------------------------------
// Ported and extended from oh-my-pi's `isAwaitingUserAnswer`.  The
// heuristic answers "is the last line of the assistant turn addressed at
// the user, awaiting a reply?" so the continuation wake can be suppressed
// when the turn is a genuine handback rather than a stall.  The bias is
// toward suppression: a false positive only silences one continuation
// wake (cheap), whereas a false negative talks over a question the user
// still has to answer.  This is why the Chinese cue patterns are
// deliberately broad and why a statement that merely opens with a
// confirmation word is accepted as a hit (e.g. "确认订单已创建。" is caught
// even though it is a report, not a solicitation).

/** Markdown list/quote/heading prefix stripped before cue matching. */
const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;

/** Explicit question/answer label prefix, e.g. `Q1:`. */
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;

/** Leading English interrogative marking a user-directed question. */
const QUESTION_PROMPT_RE =
  /^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;

/** English second-person pronoun marking a user-directed line. */
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;

/**
 * Any non-ASCII character in a `?`/`？`-terminated line marks genuine
 * prose — CJK, Japanese, Korean, accented Latin — so such a line is
 * treated as a real question even without the English word gates.
 */
const NON_ASCII_TEXT_RE = /[^\p{ASCII}]/u;

/** English response-solicitation cues (ported from oh-my-pi). */
const ENGLISH_RESPONSE_CUE_RE =
  /^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise)\b|^(?:please\s+)?answer\b|^(?:please\s+)?(?:let\s+me\s+know|tell\s+me)\b/i;

/**
 * Chinese response-solicitation cues, extended beyond oh-my-pi's
 * English-only, line-start-anchored regex. Chinese approvals frequently
 * lack a question mark, so line-end tags and conditional handbacks are
 * matched anywhere in the line.
 */
const CHINESE_RESPONSE_CUE_RE =
  /^(?:请(?:你|您)?)?(?:确认|批准|审阅|过目|定夺|同意|选择|答复|回复)|(?:可以吗|行吗|好吗|要不要|如何|怎么看|怎么样|是否可以|可行吗|方便吗|有问题吗)$|(?:确认|批准|同意)后|的话.{0,8}(?:说一声|讲一声|告诉我)|说一声/;

/** A line reduced to its prompt text plus whether a label was stripped. */
interface PromptLine {
  text: string;
  hadPromptLabel: boolean;
}

/** Strip markdown and question-label prefixes from a line. */
function promptLine(line: string): PromptLine {
  const withoutMarkdownPrefix = line
    .trim()
    .replace(MARKDOWN_PROMPT_PREFIX_RE, "")
    .trim();
  const withoutPromptLabel = withoutMarkdownPrefix
    .replace(PROMPT_LABEL_RE, "")
    .trim();
  return {
    text: withoutPromptLabel,
    hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
  };
}

/** Whether a line ends in a user-directed question mark. */
function isQuestionLine(line: string): boolean {
  const candidate = promptLine(line);
  if (!/[?？]\s*$/.test(candidate.text)) return false;
  return (
    candidate.hadPromptLabel ||
    QUESTION_PROMPT_RE.test(candidate.text) ||
    USER_DIRECTED_PROMPT_RE.test(candidate.text) ||
    NON_ASCII_TEXT_RE.test(candidate.text)
  );
}

/** Whether a punctuation-stripped line carries a response cue. */
function isResponseCueLine(line: string): boolean {
  const candidate = promptLine(line)
    .text.replace(/[.!?。！？]+$/, "")
    .trim();
  return (
    ENGLISH_RESPONSE_CUE_RE.test(candidate) ||
    CHINESE_RESPONSE_CUE_RE.test(candidate)
  );
}

/** The last non-empty trimmed line of a multi-line text, if any. */
function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line !== "") return line;
  }
  return undefined;
}

/**
 * Whether the assistant turn ended by handing the conversation back to the
 * user (a question or a response cue on its last non-empty line).
 *
 * Only the last non-empty line is inspected: a question buried mid-turn is
 * part of the work, not a handback. Empty text is never awaiting. The
 * detection is intentionally broad (see the suppression-bias note above)
 * — a false positive merely skips one continuation wake.
 *
 * @param finalText - The settled assistant turn's full text.
 * @returns `true` when the last non-empty line solicits a user reply.
 */
export function isAwaitingUserAnswer(finalText: string): boolean {
  const lastLine = lastNonEmptyLine(finalText);
  if (lastLine === undefined) return false;
  return isQuestionLine(lastLine) || isResponseCueLine(lastLine);
}

/**
 * Decide whether to wake the agent to continue its unfinished todos.
 *
 * Gates short-circuit in a fixed order, each producing a distinct silence
 * reason:
 * 1. the turn did not settle (`"not-settled"`);
 * 2. the todo list is empty (`"empty"`);
 * 3. no task is active — pending or in-progress (`"no-active"`); a list of
 *    only completed, abandoned, and/or blocked tasks does not warrant a
 *    wake;
 * 4. the settled turn made no mutating progress (`"no-progress"`); a turn
 *    that only read, discussed, updated its todo list, or delegated to a
 *    read-only agent has not advanced the work and may be handing the turn
 *    back;
 * 5. the session budget is spent (`"budget-exhausted"`).
 *
 * Otherwise the agent is woken with a rendered reminder.
 *
 * @param tasks - Flattened task views for the current todo list.
 * @param cause - Why the agent's turn ended.
 * @param budget - The session's reminder budget.
 * @param progress - Whether the settled turn performed mutating work.
 * @returns The wake decision with its text, or silence with its reason.
 */
export function decide(
  tasks: readonly TodoItemView[],
  cause: StopCause,
  budget: Budget,
  progress: boolean,
): Decision {
  if (cause !== "settled") {
    return { kind: "silence", reason: "not-settled" };
  }
  if (tasks.length === 0) {
    return { kind: "silence", reason: "empty" };
  }
  if (!tasks.some((task) => isActiveTodoStatus(task.status))) {
    return { kind: "silence", reason: "no-active" };
  }
  if (!progress) {
    return { kind: "silence", reason: "no-progress" };
  }
  if (budget.used >= budget.limit) {
    return { kind: "silence", reason: "budget-exhausted" };
  }
  return { kind: "wake", text: renderContinuation(tasks) };
}
