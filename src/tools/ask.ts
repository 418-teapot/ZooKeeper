/**
 * Ask tool — the pi-only multi-question form the agent can pose to the user.
 *
 * The tool is a thin host adapter over the framework-independent ask
 * protocol (`src/core/ask.ts`): it parses the model's questions through the
 * core normalizer, mounts the pi dialog (`src/adapters/pi/tui/ask-dialog.ts`)
 * for the whole form, then maps the per-question results back onto the tool
 * result —
 * `content` as one line per question (question text + the core's
 * `formatResultForModel` rendering) and `details` as the structured
 * `{question, result}` pairs.
 *
 * Result policy: all three outcome slots (answered / declined / unavailable)
 * are ordinary tool results — the tool never throws and never flags
 * `isError` for a user decision or a host that cannot draw the form.  Only
 * malformed arguments raise (the loud Chinese guidance the other tools use).
 * Model-supplied texts are stripped of terminal control sequences on the way
 * in.  Scheduling is `sequential`: two concurrent forms would fight for the
 * same keyboard.
 *
 * The unit is pi-only: without a pi host surface in deps (`piSwitchHost`)
 * it contributes zero tools, so OpenCode never registers `ask` (the agents
 * deny it in `config.toml` anyway).
 *
 * @module
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  type AskDialog,
  type AskDialogOutcome,
  type AskDialogQuestion,
  type AskDialogThemeLike,
  type AskDialogTuiLike,
  createAskDialog,
  toOneLine,
} from "../adapters/pi/tui/ask-dialog.js";
import type { AskResult, NormalizedQuestion } from "../core/ask.js";
import {
  formatResultForModel,
  normalizeQuestion,
  validateAnswer,
} from "../core/ask.js";
import type { ToolContribution, ToolUnitDescriptor } from "../core/slots.js";
import { log } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One question's structured outcome, carried in the tool `details`. */
export interface AskQuestionDetail {
  /** The question text as asked. */
  question: string;
  /** The slot the user (or the system) produced for it. */
  result: AskResult;
}

/** The ask tool's structured result payload. */
export interface AskToolDetails {
  questions: AskQuestionDetail[];
}

/** What the ask tool produces from a set of results: text + details. */
export interface AskAssembly {
  /** The model-facing text (one line per question). */
  text: string;
  /** The structured payload written back through the host's details slot. */
  details: AskToolDetails;
}

/** The duck-typed pi tool context the ask tool reads (ExtensionContext). */
export interface AskToolCtxLike {
  /** Host run mode — only `"tui"` can show the dialog. */
  mode?: unknown;
  /** The pi UI surface (only `custom` is used). */
  ui?: {
    custom?: (factory: unknown, options: unknown) => unknown;
  };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Loud argument error, phrased as guidance for the model (repo idiom). */
function argError(message: string): Error {
  return new Error(`ask 工具参数错误：${message}`);
}

/**
 * Drop terminal control sequences from a model-supplied string.
 *
 * Question texts and option labels are rendered verbatim by the dialog, so
 * an embedded escape sequence could repaint the form, move the hardware
 * cursor or spoof the terminal.  Argument parsing is the only place those
 * strings enter the tool, so stripping here covers every path; the dialog
 * itself and the user's own freeform input are left untouched.
 */
function sanitizeModelText(text: string): string {
  return stripTerminalSequences(text);
}

/** Parse one option entry (`{label, description?}`) of a question. */
function parseOption(
  raw: unknown,
  qIndex: number,
  oIndex: number,
): {
  label: string;
  description?: string;
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw argError(
      `第 ${qIndex + 1} 个问题的 options[${oIndex}] 必须是对象（{label, description?}）。`,
    );
  }
  const item = raw as Record<string, unknown>;
  if (typeof item.label !== "string") {
    throw argError(
      `第 ${qIndex + 1} 个问题的 options[${oIndex}].label 必须是非空字符串。`,
    );
  }
  // Strip first, then validate: a control-sequence-only label is empty once
  // sanitized and must not reach the dialog as a blank candidate.
  const label = sanitizeModelText(item.label);
  if (label.trim().length === 0) {
    throw argError(
      `第 ${qIndex + 1} 个问题的 options[${oIndex}].label 必须是非空字符串。`,
    );
  }
  const rawDescription =
    typeof item.description === "string"
      ? sanitizeModelText(item.description)
      : undefined;
  return {
    label,
    ...(rawDescription !== undefined && rawDescription.length > 0
      ? { description: rawDescription }
      : {}),
  };
}

/**
 * Parse one question entry into a dialog question.
 *
 * Boolean flags are coerced leniently (a non-boolean is treated as absent)
 * and `recommended` is kept only as a finite non-negative index — it is an
 * adapter-only UI hint, so a bad value degrades to "no recommendation"
 * rather than failing the call.  The core's `normalizeQuestion` applies the
 * defaults (empty options → freeform forced, `multiple` → false,
 * `allowFreeform` → true).
 */
function parseQuestion(raw: unknown, index: number): AskDialogQuestion {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw argError(`questions[${index}] 必须是问题对象。`);
  }
  const item = raw as Record<string, unknown>;
  if (typeof item.question !== "string") {
    throw argError(`questions[${index}].question 必须是非空字符串。`);
  }
  const question = sanitizeModelText(item.question);
  if (question.trim().length === 0) {
    throw argError(`questions[${index}].question 必须是非空字符串。`);
  }
  let options: { label: string; description?: string }[] = [];
  if (item.options !== undefined) {
    if (!Array.isArray(item.options)) {
      throw argError(
        `questions[${index}].options 必须是候选项数组（每项 {label, description?}）。`,
      );
    }
    options = item.options.map((opt, oIndex) =>
      parseOption(opt, index, oIndex),
    );
  }
  const normalized = normalizeQuestion({
    question,
    options,
    multiple: typeof item.multiple === "boolean" ? item.multiple : undefined,
    allowFreeform:
      typeof item.allowFreeform === "boolean" ? item.allowFreeform : undefined,
  });
  const rec = item.recommended;
  const recommended =
    typeof rec === "number" && Number.isFinite(rec) && rec >= 0
      ? Math.floor(rec)
      : undefined;
  return {
    ...normalized,
    ...(recommended !== undefined ? { recommended } : {}),
  };
}

/**
 * Validate the raw tool arguments into dialog questions.
 *
 * @param args - The raw tool arguments.
 * @returns One normalized question per entry, in order.
 * @throws A loud Chinese error when `questions` is missing / not a
 *   non-empty array, or an entry is malformed.
 */
export function parseAskArgs(args: unknown): AskDialogQuestion[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw argError("请提供包含 questions 数组的对象。");
  }
  const raw = (args as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) {
    throw argError(
      "questions 必须是问题数组，每项 {question, options?, multiple?, allowFreeform?, recommended?}。",
    );
  }
  if (raw.length === 0) {
    throw argError("questions 不能为空，至少提供一个问题。");
  }
  return raw.map((item, index) => parseQuestion(item, index));
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the tool outcome from the per-question results.
 *
 * `text` is one line per question — `<question text> => <core rendering>`
 * — joined with newlines (the question text collapses onto one line so the
 * one-line-per-question shape survives an embedded newline); `details`
 * carries each question's text with its structured result and is written
 * back through the host's details slot.
 *
 * @param questions - The normalized questions, in ask order.
 * @param results - The results, index-aligned with `questions`.
 * @returns The assembled text and structured details.
 */
export function assembleAskResults(
  questions: NormalizedQuestion[],
  results: AskResult[],
): AskAssembly {
  const lines: string[] = [];
  const details: AskToolDetails = { questions: [] };
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const result =
      results[i] ??
      ({
        status: "unavailable",
        reason: "aborted",
      } as AskResult);
    lines.push(
      `Q${i + 1}: ${toOneLine(question.question)} => ${formatResultForModel(question, result)}`,
    );
    details.questions.push({ question: question.question, result });
  }
  return { text: lines.join("\n"), details };
}

/**
 * Replace structurally impossible `answered` slots with an abort.
 *
 * The dialog cannot produce an illegal answer by construction, so a
 * violation means the component (or a future host) misbehaved: the core
 * validator is the single source of that judgement, and a violating answer
 * is dropped rather than handed to the model.
 *
 * @param questions - The normalized questions.
 * @param results - The results to check, index-aligned.
 * @returns The results with any invalid answer replaced.
 */
export function guardAnswers(
  questions: NormalizedQuestion[],
  results: AskResult[],
): AskResult[] {
  return results.map((result, i) => {
    const question = questions[i];
    if (question === undefined || result === undefined) return result;
    const check = validateAnswer(question, result);
    if (check.valid) return result;
    log("ask-tool", "invalid_answer", "", undefined, "warn", {
      index: i,
      errors: check.errors,
    });
    return { status: "unavailable", reason: "aborted" } as AskResult;
  });
}

// ---------------------------------------------------------------------------
// Dialog presentation
// ---------------------------------------------------------------------------

/** Overlay sizing for the ask form. */
const ASK_OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: { width: "80%", minWidth: 50, anchor: "center" },
};

/** All-unavailable results (no dialog was ever mounted, or none reported). */
function fallbackResults(
  questions: AskDialogQuestion[],
  reason: "timeout" | "aborted" | "no-ui",
): AskResult[] {
  return questions.map(() => ({ status: "unavailable", reason }) as AskResult);
}

/**
 * Return the model-facing text and write the structured details back.
 *
 * The details travel through the host-forwarded `hostCtx` write-back slot
 * (the pi bridge merges them into the tool result's `details`); a host that
 * never builds that object simply gets the text.
 */
function handBack(
  hostCtx: { details?: unknown } | undefined,
  assembly: AskAssembly,
): string {
  if (hostCtx !== undefined) hostCtx.details = assembly.details;
  return assembly.text;
}

/**
 * Mount the dialog and wait for the user's decision.
 *
 * The host's abort signal is wired to the dialog's `abort()` handle so a
 * cancellation closes the form and preserves the answers already committed.
 * An abort that lands before the dialog mounts is applied as soon as it
 * does; a signal that is already aborted never opens the UI at all.
 *
 * `ui.custom` rejects when the factory throws or the host force-closes the
 * overlay, so the await is guarded: the tool never throws, and a form that
 * never reported is reported as a system-side abort (whatever the user had
 * committed is unrecoverable on that path).
 *
 * @param opts - Questions, pi's `ui.custom` surface, the optional timeout
 *   seconds, and the optional abort signal.
 * @returns One result per question.
 */
export async function presentAskForm(opts: {
  questions: AskDialogQuestion[];
  custom: (factory: unknown, options: unknown) => unknown;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}): Promise<AskResult[]> {
  const { questions, custom } = opts;
  if (opts.signal?.aborted) return fallbackResults(questions, "aborted");

  let dialog: AskDialog | undefined;
  let abortBeforeMount = false;
  const onAbort = () => {
    if (dialog === undefined) abortBeforeMount = true;
    else dialog.abort();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const outcome = (await custom(
      (tui: unknown, theme: unknown, _keybindings: unknown, done: unknown) => {
        dialog = createAskDialog({
          questions,
          tui: tui as AskDialogTuiLike,
          theme: theme as AskDialogThemeLike,
          done: (result: AskDialogOutcome) => {
            (done as (outcome: AskDialogOutcome) => void)(result);
          },
          ...(opts.timeoutSeconds !== undefined
            ? { timeoutSeconds: opts.timeoutSeconds }
            : {}),
        });
        if (abortBeforeMount) dialog.abort();
        return dialog.component;
      },
      ASK_OVERLAY_OPTIONS,
    )) as AskDialogOutcome | undefined;
    // A host that closes the overlay without reporting a result treated the
    // form as gone — the unanswered questions are aborted, and any answer
    // the user had already committed is simply absent from the report.
    return outcome?.results ?? fallbackResults(questions, "aborted");
  } catch (error) {
    // pi rejects `ui.custom` when its factory throws or the host tears the
    // overlay down by force: nothing was ever reported, so every question is
    // unavailable for a system-side reason rather than a user refusal.
    log("ask-tool", "custom_rejected", "", undefined, "warn", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackResults(questions, "aborted");
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the ask tool contribution.
 *
 * @param timeoutSeconds - The `[zoo.ask].timeout` budget (undefined → the
 *   form waits for the user indefinitely).
 * @returns The tool contribution (sequential scheduling — the dialog owns
 *   the terminal).
 */
export function createAskTool(timeoutSeconds?: number): ToolContribution {
  return {
    name: "ask",
    description:
      "向用户提问并等待回答：只有在缺少用户决策就无法继续时才能使用。一次可提交多个问题，每个问题支持单选/多选、可选描述、推荐项，并默认允许自由输入。用户拒答或超时都会作为正常结果返回，不要据此反复追问。",
    args: {
      questions: {
        type: "array",
        description:
          "要提问的问题数组，每项 {question, options?, multiple?, allowFreeform?, recommended?}。",
        items: {
          type: "object",
          description: "单个问题。",
          properties: {
            question: {
              type: "string",
              description: "问题文本。",
            },
            options: {
              type: "array",
              description:
                "候选项数组，每项 {label, description?}；省略或留空则只能自由输入。",
              items: {
                type: "object",
                description: "候选项。",
                properties: {
                  label: {
                    type: "string",
                    description: "候选项文本。",
                  },
                  description: {
                    type: "string",
                    description: "候选项的补充说明。",
                  },
                },
                required: ["label"],
              },
            },
            multiple: {
              type: "boolean",
              description: "是否允许多选（默认单选）。",
            },
            allowFreeform: {
              type: "boolean",
              description:
                "是否允许用户自行输入（默认允许；无候选项时强制开启）。",
            },
            recommended: {
              type: "number",
              description: "推荐候选项在 options 中的索引。",
            },
          },
          required: ["question"],
        },
      },
    },
    required: ["questions"],
    // The dialog takes over the terminal, so two calls can never overlap.
    executionMode: "sequential",
    async execute(args, toolCtx, hostCtx) {
      const questions = parseAskArgs(args);
      const ctx = (toolCtx ?? {}) as AskToolCtxLike;
      const custom = ctx.ui?.custom;
      // No TUI to draw on (print / RPC / json mode, or a host without the
      // custom-component surface): every question reports the system-side
      // slot, still as a normal tool result.
      if (ctx.mode !== "tui" || typeof custom !== "function") {
        return handBack(
          hostCtx,
          assembleAskResults(questions, fallbackResults(questions, "no-ui")),
        );
      }
      const results = await presentAskForm({
        questions,
        custom,
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        ...(hostCtx?.signal !== undefined ? { signal: hostCtx.signal } : {}),
      });
      return handBack(
        hostCtx,
        assembleAskResults(questions, guardAnswers(questions, results)),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Unit descriptor
// ---------------------------------------------------------------------------

/**
 * The ask tool unit descriptor.
 *
 * The unit contributes its tool ONLY on the pi host — `piSwitchHost` is
 * present exactly when the extension runs inside pi, so on OpenCode the
 * create() returns no tools and `ask` never registers (fail-closed).
 */
export const unit: ToolUnitDescriptor = {
  name: "ask",
  kind: "tool",
  create(deps) {
    if (deps.piSwitchHost === undefined) {
      return { kind: "tool", tools: [] };
    }
    return {
      kind: "tool",
      tools: [createAskTool(deps.askTimeoutSeconds)],
    };
  },
};
