/**
 * Framework-independent ask-protocol logic.
 *
 * Pure types and functions for the `ask` tool: an agent pauses mid-run to
 * pose a question to the user and blocks until the user decides. The result
 * is one of three slots — `answered` (only a human may produce this slot),
 * `declined` (user actively refused, e.g. Esc), or `unavailable` (system-side
 * termination: timeout, abort, or no UI).
 *
 * This module has zero host dependencies — no pi/OpenCode types, no I/O, no
 * timer logic. Host adapters implement `AskFormHost` and own scheduling,
 * rendering, and timeout enforcement.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Question types
// ---------------------------------------------------------------------------

/** A single candidate answer presented alongside the question. */
export interface AskOption {
  /** Short display text; also the exact string echoed back in the answer. */
  label: string;
  /** Optional longer explanation of the candidate. */
  description?: string;
}

/** A question as authored by the agent (defaults not yet applied). */
export interface AskQuestion {
  /** The question text shown to the user. */
  question: string;
  /** Candidate set; empty or missing forces freeform answering. */
  options?: AskOption[];
  /** Multi-select mode; defaults to false (single-select). */
  multiple?: boolean;
  /** Whether the user may type a custom answer; defaults to true, forced
   * true when the candidate set is empty. */
  allowFreeform?: boolean;
}

/** A question after defaults and enforcement rules have been applied. All
 * fields are concrete — `options` is always an array (possibly empty). */
export interface NormalizedQuestion {
  question: string;
  options: AskOption[];
  multiple: boolean;
  allowFreeform: boolean;
}

/**
 * A normalized question plus a form-presentation hint.
 *
 * `recommended` is an index into `options` that a form host may render as a
 * badge / initial cursor position. It is UI-only: it never enters the
 * answer payload and the core protocol ignores it.
 */
export interface AskFormQuestion extends NormalizedQuestion {
  /** Index into `options` of the recommended candidate. */
  recommended?: number;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Outcome of an ask, one of three slots.
 *
 * The slots are structurally distinct so a host (or a model) cannot
 * accidentally forge an `answered` result: only the presenter path produces
 * it, and `declined`/`unavailable` carry no answer payload.
 */
export type AskResult =
  | {
      status: "answered";
      /** Selected option labels, or the freeform text (single element). */
      answer: string[];
      /** True when the user wrote a custom answer instead of picking. */
      wasCustom: boolean;
    }
  /** User actively refused to answer (e.g. pressed Esc). */
  | { status: "declined" }
  /** No answer could be obtained; `reason` explains the system-side cause. */
  | { status: "unavailable"; reason: "timeout" | "aborted" | "no-ui" };

// ---------------------------------------------------------------------------
// Form-host contract (implemented by host adapters)
// ---------------------------------------------------------------------------

/**
 * Presentation contract for the ask protocol.
 *
 * A host adapter mounts its form, blocks for the user's decisions, and
 * returns one result per question. Timeout, abort, and no-UI handling are
 * the adapter's responsibility — this contract only fixes the call and
 * result shapes. `custom` is the host's own component-mounting surface,
 * opaque to this layer.
 */
export interface AskFormHost {
  /**
   * Mount the form and wait for the user's decisions.
   *
   * @param opts - The {@link AskFormQuestion}s (normalized questions plus
   * the form's `recommended` hint), the host's custom-component surface, an
   * optional timeout in seconds, and an optional abort signal.
   * @returns One result per question, in question order.
   */
  present(opts: {
    questions: AskFormQuestion[];
    custom: (factory: unknown, options?: unknown) => unknown;
    timeoutSeconds?: number;
    signal?: AbortSignal;
  }): Promise<AskResult[]>;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Apply defaults and enforcement rules to an agent-authored question.
 *
 * Rules:
 *   - `options` missing → normalized to an empty array.
 *   - `multiple` missing → false (single-select).
 *   - `allowFreeform` missing → true; forced true when the candidate set
 *     is empty (a question with no options cannot forbid typing).
 *
 * @param q - Raw question as authored by the agent.
 * @returns A question with every field made concrete.
 */
export function normalizeQuestion(q: AskQuestion): NormalizedQuestion {
  const options = q.options ?? [];
  const allowFreeform = options.length === 0 ? true : (q.allowFreeform ?? true);
  return {
    question: q.question,
    options,
    multiple: q.multiple ?? false,
    allowFreeform,
  };
}

// ---------------------------------------------------------------------------
// Answer validation
// ---------------------------------------------------------------------------

/** Outcome of `validateAnswer`: a validity flag plus human-readable errors. */
export interface AnswerValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate that an ask result's `answered` slot is legal for its question.
 *
 * Checks applied only when `r.status === "answered"` — `declined` and
 * `unavailable` carry no answer to validate and are reported valid.
 *
 *   1. The answer list is non-empty with no blank entries.
 *   2. Single-select questions accept at most one answer.
 *   3. A custom answer requires `allowFreeform`.
 *   4. A non-custom answer must consist entirely of option labels.
 *
 * @param q - The normalized question the result answers.
 * @param r - The result to validate.
 * @returns `valid` flag and per-violation error messages.
 */
export function validateAnswer(
  q: NormalizedQuestion,
  r: AskResult,
): AnswerValidation {
  if (r.status !== "answered") {
    return { valid: true, errors: [] };
  }

  const errors: string[] = [];
  const { answer, wasCustom } = r;

  if (answer.length === 0) {
    errors.push("Answer is empty");
  } else if (answer.some((a) => a.trim() === "")) {
    errors.push("Answer contains a blank entry");
  }

  if (!q.multiple && answer.length > 1) {
    errors.push(
      `Expected at most 1 answer (single-select), got ${answer.length}`,
    );
  }

  if (wasCustom && !q.allowFreeform) {
    errors.push("Custom answer is not allowed for this question");
  }

  if (!wasCustom) {
    const labels = new Set(q.options.map((o) => o.label));
    for (const a of answer) {
      if (!labels.has(a)) {
        errors.push(`Answer "${a}" is not one of the provided options`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

/**
 * Render an ask result as the single-line text handed back to the model.
 *
 *   - answered, picked:   `User answered: a, b`
 *   - answered, custom:   `User wrote: <text>`
 *   - declined:           `User declined to answer`
 *   - unavailable:        `User unavailable (timeout|aborted|no-ui)`
 *
 * @param _q - The question (reserved for future context; unused today).
 * @param r - The result to format.
 * @returns One-line string for tool-result content.
 */
export function formatResultForModel(
  _q: NormalizedQuestion,
  r: AskResult,
): string {
  switch (r.status) {
    case "answered":
      return r.wasCustom
        ? `User wrote: ${r.answer.join(", ")}`
        : `User answered: ${r.answer.join(", ")}`;
    case "declined":
      return "User declined to answer";
    case "unavailable":
      return `User unavailable (${r.reason})`;
  }
}

// ---------------------------------------------------------------------------
// Fallbacks and text helpers
// ---------------------------------------------------------------------------

/**
 * Build all-unavailable results for the given questions.
 *
 * Used when no form was mounted (no UI) or nothing was reported (timeout /
 * abort), so every question receives the same system-side slot.
 *
 * @param questions - The questions, in ask order.
 * @param reason - The system-side cause for every slot.
 * @returns One `unavailable` result per question.
 */
export function fallbackResults(
  questions: NormalizedQuestion[],
  reason: "timeout" | "aborted" | "no-ui",
): AskResult[] {
  return questions.map(() => ({ status: "unavailable", reason }) as AskResult);
}

/**
 * Collapse embedded newlines / runs of blanks onto a single line.
 *
 * @param text - The text to flatten.
 * @returns The text on one line.
 */
export function toOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
