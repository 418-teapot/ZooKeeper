/**
 * Pi view host — the `/view` page channel.
 *
 * Implements the host-free `ViewHost` contract against pi's `appendEntry`
 * channel: the page is appended as a `zoo-view` custom entry, which the
 * registered entry renderer draws at the client's current width and which
 * never enters the LLM context.  All operations are best-effort: a missing
 * binding or a failing append drops the page and is logged.
 *
 * @module
 */

import type { ViewHost } from "../../core/ports/view.js";
import { log } from "../../utils/logger.js";
import type { PiAppendEntry } from "./tool-host.js";

/**
 * The data payload carried by a `zoo-view` custom entry.
 *
 * `lines` holds the page's complete logical lines: the renderer truncates
 * them at draw time, so the entry stays a durable JSON payload independent
 * of any terminal width.
 */
export interface PiViewEntryData {
  /** The page's complete logical lines, unrendered. */
  lines: string[];
}

/**
 * Create the pi view host over pi's `appendEntry` binding.
 *
 * @param appendEntry - Optional pi `appendEntry` binding (extension API)
 *   that `present` uses to post an in-session `zoo-view` custom entry.
 *   Absent (e.g. headless mode) drops the page with a debug log.
 * @returns The pi view host.
 */
export function createPiViewHost(appendEntry?: PiAppendEntry): ViewHost {
  return {
    present(sessionID, lines) {
      if (!appendEntry) {
        log.debug({
          hook: "view-host",
          event: "present_skipped",
          sessionId: sessionID,
          reason: "appendEntry unavailable",
        });
        return;
      }

      try {
        const data: PiViewEntryData = { lines: [...lines] };
        appendEntry("zoo-view", data);
      } catch (err) {
        log.warn({
          hook: "view-host",
          event: "present_failed",
          sessionId: sessionID,
          error: String(err),
        });
      }
    },
  };
}
