/**
 * Reply-strip hook unit — outbound ref-echo removal.
 *
 * Models often mimic the `[mN] ` line-start ref prefixes the render
 * layer injects into visible history messages, echoing one or more of
 * them at the START of their own replies.  The unit contributes a
 * text-finalization handler that strips those echoes from newly
 * generated assistant text before it is shown to the user, using the
 * core `stripLineStartRefs` rule (exact match, stacked prefixes
 * removed, strict otherwise).
 *
 * When a strip happens the handler logs a `reply_ref_stripped` warning
 * with the first 200 characters of the raw text.  The unit has no host
 * dependencies and is enabled purely by the profile hooks list: a
 * profile without `reply-strip` never instantiates it, so no handler
 * is contributed (fail-closed).
 *
 * @module
 */

import { stripLineStartRefs } from "../../core/context/reply-strip.js";
import type {
  HookUnitDescriptor,
  TextCompleteContribution,
  TextCompleteInput,
  TextCompleteOutput,
} from "../../core/slots.js";
import { log } from "../../utils/logger.js";

/**
 * Build the text-finalization handler that strips model-imitated
 * line-start ref echoes from finalized assistant text.
 *
 * The handler mutates `output.text` in place.  When the raw text
 * started with an exact `[mN] ` echo (one or more stacked), the
 * stripped tail is logged as a `reply_ref_stripped` warning.
 *
 * @returns The text-finalization contribution.
 */
export function createReplyStripHandler(): TextCompleteContribution {
  return {
    name: "replyStrip",
    handle: (input: TextCompleteInput, output: TextCompleteOutput) => {
      const before = output.text;
      output.text = stripLineStartRefs(output.text);

      // Detect ref-prefix stripping: when the reply started with an
      // exact `[mN] ` echo, log a warning with the stripped tail.
      if (before !== output.text) {
        log(
          "reply-strip",
          "reply_ref_stripped",
          input.sessionID,
          undefined,
          "warn",
          {
            fragment: before.slice(0, 200),
          },
        );
      }
    },
  };
}

/**
 * Reply-strip hook unit descriptor.
 *
 * Contributes one text-finalization handler; all other slots stay
 * empty.  The unit is enabled by the profile hooks list and instantiates
 * unconditionally when listed — the fail-closed gate lives in the
 * composition: an absent unit contributes no handler and no host event
 * key.
 */
export const unit: HookUnitDescriptor = {
  name: "reply-strip",
  kind: "hook",
  create() {
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [],
      transform: [],
      textComplete: [createReplyStripHandler()],
      toolDefinition: [],
      delegation: [],
    };
  },
};
