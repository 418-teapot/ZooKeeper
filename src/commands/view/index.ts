/**
 * `/view` command unit barrel export.
 *
 * Contributes the `/view` command: it reads the session's current
 * conversation, runs the context transform's own phases over a copy of the
 * session state, and presents the resulting message view — the `mN` lines
 * the next transform will send.  Nothing is required from an earlier
 * round, and nothing is written: no state, no store, no published view, no
 * notice.
 *
 * The unit needs the view host, which only a host with a width-aware
 * client renders (pi).  A host that cannot bind it contributes no command,
 * so the command never registers where it could not be drawn (fail-closed,
 * the same rule the other host-only units follow).
 *
 * @module
 */

import { previewRound } from "../../core/context/pipeline.js";
import { formatViewPage } from "../../core/context/view-page.js";
import { defineCommand } from "../../core/unit.js";

/**
 * `/view` command unit descriptor.
 *
 * The command contribution previews the transform's output and hands the
 * composed page's complete logical lines to the view host, which owns the
 * final width.  A session whose host cannot name its conversation, or one
 * that holds no message, presents the formatter's hint instead of an empty
 * page.
 */
export const unit = defineCommand({
  name: "view",
  needs: ["adapter", "contextConfig", "contextRuntime", "viewHost"],
  uses: ["tools"],
  create(caps, uses) {
    return {
      kind: "command",
      commands: [
        {
          name: "view",
          description: "显示当轮上下文视图的 mN 行",
          handle: async (input, permit) => {
            if (permit === undefined) return;
            const state = caps.contextRuntime.read(permit, (committed) => {
              return committed;
            });
            if (state === undefined) return;
            caps.viewHost.present(
              input.sessionID,
              formatViewPage(
                previewRound({
                  runtime: caps.contextRuntime,
                  sessionId: input.sessionID,
                  state,
                  adapter: caps.adapter,
                  messages: input.messages,
                  config: caps.contextConfig,
                  hasCompressTool: uses.tools.includes("compress"),
                }),
              ),
            );
          },
        },
      ],
    };
  },
});
