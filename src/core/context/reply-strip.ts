/**
 * Outbound reply ref-stripping (`reply-strip`).
 *
 * Models often mimic the `[mN] ` line-start prefixes the render layer
 * injects into visible history messages, echoing one or more of them at
 * the START of their own replies.  This module strips those echoes from
 * newly generated assistant text before it is persisted / shown to the
 * user.
 *
 * The rule is deliberately strict — only an EXACT start-of-text match
 * of `[mN] ` (natural integer, single trailing space, no preceding
 * whitespace or newline) is removed, and removal repeats so stacked
 * prefixes (`[m3] [m5] body`) are fully removed.  No fuzzy variant is
 * tolerated: a missing trailing space, leading whitespace, a malformed
 * bracket, or a mid-text occurrence all leave the text unchanged.
 *
 * @module
 */

/**
 * Exact line-start message-ref prefix matched at the very start of the
 * reply: `[mN] ` — natural integer, single trailing space.  The `^`
 * anchor binds to the first character, so no leading whitespace or
 * newline is tolerated.
 */
const REPLY_REF_PREFIX = /^\[m\d+\] /;

/**
 * Strip every exact line-start `[mN] ` prefix from the start of the
 * reply text.
 *
 * Removal repeats until the text no longer starts with the exact prefix,
 * so stacked echoes like `[m3] [m5] body` are fully removed.  Text that
 * does not start with the exact prefix — a missing trailing space,
 * leading whitespace/newline, malformed brackets, a mid-text occurrence,
 * or an empty string — is returned unchanged.
 *
 * @param text - The raw assistant reply text.
 * @returns The reply with leading exact `[mN] ` echoes removed.
 */
export function stripLineStartRefs(text: string): string {
  let result = text;
  while (REPLY_REF_PREFIX.test(result)) {
    result = result.replace(REPLY_REF_PREFIX, "");
  }
  return result;
}
