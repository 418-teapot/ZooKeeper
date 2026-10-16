/**
 * Shared nudge-injection helper for the tool-output hooks.
 *
 * Every output nudge in the plugin follows the same skeleton: normalise
 * the tool name, gate on the tool, run an ordered guard chain, append the
 * produced text after a blank line, and emit an injected log entry.  This
 * module owns that skeleton; the varying parts — the tool predicate, the
 * guards, the text, and the log descriptors — are supplied as parameters.
 *
 * Scope: text appended to a host tool's output object.  The context-budget
 * reminder in `core/context/nudge.ts` is a different subsystem (it draws
 * refs on the transcript view) and does not use this helper.
 *
 * Framework-free: only the file logger is imported.
 *
 * @module
 */

import { log } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A skip descriptor: the log event to emit, plus extra log fields.
 *
 * A guard that returns one of these blocks injection.  An omitted `event`
 * means the skip is silent (no log entry) — the original behaviour of
 * guards that simply returned.
 */
export interface NudgeSkip {
  /** Skip-log event name; omitted means a silent skip. */
  event?: string;
  /** Extra fields merged into the skip log entry. */
  fields?: Record<string, unknown>;
}

/**
 * One guard in the ordered chain.
 *
 * Returns `null` to let injection proceed, or a {@link NudgeSkip} to block
 * it.  Guards run in order and stop at the first blocker, so a guard that
 * computes shared state (e.g. the matched pattern) can rely on every
 * earlier guard having passed.
 */
export type NudgeGuard = () => NudgeSkip | null;

/**
 * A tool-gated nudge variant.
 *
 * The helper picks the first rule whose `matches` accepts the lowercased
 * tool name, runs its guards, then appends `text()` and logs `event`.
 */
export interface NudgeRule {
  /** Tool-name predicate, evaluated against the lowercased tool name. */
  matches: (tool: string) => boolean;
  /** Ordered guards; the first returning a skip blocks injection. */
  guards?: NudgeGuard[];
  /**
   * Build the text appended to the output.  Returning a promise is
   * supported; the helper then resolves asynchronously.  The text is
   * always prefixed with a blank line (`"\n\n"`).
   */
  text: () => string | Promise<string>;
  /** Injected-log event name. */
  event: string;
  /**
   * Extra fields for the injected log entry, read after `text` runs so the
   * provider can expose computed facts (e.g. whether a todo nudge was
   * added).
   */
  fields?: () => Record<string, unknown>;
}

/** Inputs to {@link applyNudge}. */
export interface NudgeContext {
  /** Hook module name written to both log entries. */
  hook: string;
  /** Session id written to both log entries. */
  sessionID: string;
  /** Optional call id written to both log entries. */
  callID?: string;
  /** Raw tool name; lowercased before rule matching. */
  tool: string;
  /** Output object mutated in place. */
  output: { output?: string };
  /**
   * Skip log emitted when no rule matches the tool; omitted means the
   * non-matching tool is skipped silently.
   */
  gateSkip?: NudgeSkip;
  /** Tool-gated rules; the first matching rule is applied. */
  rules: NudgeRule[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Emit a skip log entry when the descriptor carries an event.
 *
 * Skip entries are logged at `"debug"` because a non-firing nudge is
 * expected noise; the field set is caller-defined so per-hook reasons
 * stay intact.
 */
function emitSkip(ctx: NudgeContext, skip?: NudgeSkip): void {
  if (!skip?.event) return;
  log(ctx.hook, skip.event, ctx.sessionID, ctx.callID, "debug", skip.fields);
}

/**
 * Append the produced text and emit the injected log entry.
 *
 * The text is separated from the existing output by a blank line.  A
 * missing output value is treated as the empty string so a handler that
 * runs before any text exists still produces a well-formed string.
 */
function finish(ctx: NudgeContext, rule: NudgeRule, text: string): void {
  ctx.output.output = `${ctx.output.output ?? ""}\n\n${text}`;
  log(ctx.hook, rule.event, ctx.sessionID, ctx.callID, "info", rule.fields?.());
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Apply the first matching nudge rule to the output object.
 *
 * Skeleton:
 * 1. Lowercase the tool name and pick the first rule whose `matches`
 *    accepts it; when none does, emit `gateSkip` (if any) and stop.
 * 2. Run the rule's guards in order; the first returning a skip emits its
 *    log (if it names an event) and stops.
 * 3. Build the text and append it after a blank line, then emit the
 *    injected log entry with the rule's computed fields.
 *
 * A synchronous text provider is applied and logged before returning
 * (`void`), so synchronous callers stay synchronous.  An async provider
 * makes the call return a promise that resolves once the text has been
 * appended and logged.
 *
 * @param ctx - The hook name, session/call ids, tool, output, and rules.
 * @returns `void` for a synchronous text provider; otherwise a promise.
 */
export function applyNudge(ctx: NudgeContext): void | Promise<void> {
  const tool = ctx.tool.toLowerCase();
  const rule = ctx.rules.find((r) => r.matches(tool));

  if (!rule) {
    emitSkip(ctx, ctx.gateSkip);
    return;
  }

  for (const guard of rule.guards ?? []) {
    const skip = guard();
    if (skip) {
      emitSkip(ctx, skip);
      return;
    }
  }

  const produced = rule.text();
  if (typeof produced === "string") {
    finish(ctx, rule, produced);
    return;
  }
  return produced.then((text) => finish(ctx, rule, text));
}
