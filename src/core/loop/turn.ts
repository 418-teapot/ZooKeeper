/**
 * Settled-turn facts shared by the loop engine and its strategies.
 *
 * These helpers describe a turn that stopped: why it ended, which of its
 * tool calls count as real mutating work, and whether its final line
 * hands the conversation back to the user.  They are total and
 * side-effect free — the same inputs always produce the same output, no
 * module state is touched, and no host, file system, or process API is
 * used.  Tool-name vocabulary stays host-owned: each host declares which
 * of its names mutate and how to tell whether a delegated agent may
 * mutate, so core never hardcodes a tool name.
 *
 * @module
 */

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
// the user, awaiting a reply?" so a strategy can suppress its wake when
// the turn is a genuine handback rather than a stall.  The bias is
// toward suppression: a false positive only silences one loop
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
 * — a false positive merely skips one loop wake.
 *
 * @param finalText - The settled assistant turn's full text.
 * @returns `true` when the last non-empty line solicits a user reply.
 */
export function isAwaitingUserAnswer(finalText: string): boolean {
  const lastLine = lastNonEmptyLine(finalText);
  if (lastLine === undefined) return false;
  return isQuestionLine(lastLine) || isResponseCueLine(lastLine);
}
