/**
 * Ask-form presentation — the pi host side of the `ask` tool.
 *
 * Mounts the multi-question dialog (`./tui/ask-dialog.ts`) through pi's
 * `ui.custom` surface (inline, in the editor slot) and blocks until the
 * user's decision.  The host's abort signal is wired to the dialog's `abort()` handle so a
 * cancellation closes the form and preserves the answers already
 * committed.
 *
 * The tool adapter (`src/tools/ask.ts`) owns argument parsing, result
 * mapping and the tool schema; everything that touches the pi UI lives
 * here, so the tool never imports the dialog factory directly.
 *
 * @module
 */

import type { AskResult } from "../../core/ask.js";
import { log } from "../../utils/logger.js";
import {
  type AskDialog,
  type AskDialogOutcome,
  type AskDialogQuestion,
  type AskDialogThemeLike,
  type AskDialogTuiLike,
  createAskDialog,
} from "./tui/ask-dialog.js";

// The tool adapter reaches the dialog only through this facade: the question
// shape it parses into and the one-line renderer it uses for `content` are
// re-exported here so `src/tools/ask.ts` never imports the dialog directly.
export type {
  AskDialogComponent,
  AskDialogOutcome,
  AskDialogQuestion,
} from "./tui/ask-dialog.js";
export { toOneLine } from "./tui/ask-dialog.js";

// ---------------------------------------------------------------------------
// Dialog presentation
// ---------------------------------------------------------------------------

/** All-unavailable results (no dialog was ever mounted, or none reported). */
export function fallbackResults(
  questions: AskDialogQuestion[],
  reason: "timeout" | "aborted" | "no-ui",
): AskResult[] {
  return questions.map(() => ({ status: "unavailable", reason }) as AskResult);
}

/**
 * Mount the dialog and wait for the user's decision.
 *
 * The host's abort signal is wired to the dialog's `abort()` handle so a
 * cancellation closes the form and preserves the answers already committed.
 * An abort that lands before the dialog mounts is applied as soon as it
 * does; a signal that is already aborted never opens the UI at all.
 *
 * `ui.custom` rejects when the factory throws or the host force-closes
 * the form, so the await is guarded: the tool never throws, and a form
 * that never reported is reported as a system-side abort (whatever the
 * user had committed is unrecoverable on that path).
 *
 * The form mounts inline: with no mount options passed, pi places the
 * dialog in the editor slot below the transcript instead of compositing
 * it over the output, so the agent's latest text stays visible and
 * scrollable while the form is open.
 *
 * @param opts - Questions, pi's `ui.custom` surface, the optional timeout
 *   seconds, and the optional abort signal.
 * @returns One result per question.
 */
export async function presentAskForm(opts: {
  questions: AskDialogQuestion[];
  custom: (factory: unknown, options?: unknown) => unknown;
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
    )) as AskDialogOutcome | undefined;
    // A host that closes the form without reporting a result treated the
    // form as gone — the unanswered questions are aborted, and any answer
    // the user had already committed is simply absent from the report.
    return outcome?.results ?? fallbackResults(questions, "aborted");
  } catch (error) {
    // pi rejects `ui.custom` when its factory throws or the host tears the
    // form down by force: nothing was ever reported, so every question is
    // unavailable for a system-side reason rather than a user refusal.
    log("ask-tool", "custom_rejected", "", undefined, "warn", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackResults(questions, "aborted");
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
