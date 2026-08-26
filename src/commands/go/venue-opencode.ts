/**
 * OpenCode venue for the plan handoff protocol.
 *
 * Adapts the OpenCode v1 client slice to the host-agnostic `Venue`
 * contract used by `executeHandoff` (in `src/core/handoff.ts`): session
 * creation with the executor agent set at create time, plan-reference
 * injection via `promptAsync` plus a silent `noReply` confirmation,
 * and TUI focus switching via `route.navigate` + `tui.publish`.
 *
 * @module
 */

import type { Venue } from "../../core/handoff.js";
import { buildConfirmText } from "../../core/plan.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal client interface required for the OpenCode venue.
 *
 * Only the APIs used by the venue are declared.  The full OpenCode
 * client object is much larger; this interface keeps the venue thin
 * while remaining trivially compatible.
 */
export interface PlanClient {
  session?: {
    create?: (input: {
      body: { parentID?: string; title?: string; agent?: string };
      query?: { directory?: string };
    }) => Promise<{ data?: { id?: string }; error?: unknown }>;
    /** Raw SDK format: path.id + body.{agent, parts}. */
    promptAsync?: (input: {
      path: { id: string };
      body: { agent?: string; parts: Array<{ type: "text"; text: string }> };
    }) => Promise<unknown>;
    prompt?: (input: {
      path: { id: string };
      body: {
        noReply?: boolean;
        parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
      };
    }) => Promise<unknown>;
  };
  tui?: {
    publish?: (input: {
      body: { type: string; properties: { sessionID: string } };
    }) => Promise<unknown>;
  };
  route?: {
    navigate?: (name: string, params?: Record<string, unknown>) => void;
  };
}

// ---------------------------------------------------------------------------
// Venue factory
// ---------------------------------------------------------------------------

/**
 * Build the OpenCode venue from a v1 client and the default primary.
 *
 * The factory itself never throws — the plugin builds the venue even
 * when no primary is configured or the client is partial (e.g. a null
 * profile).  Validation happens at `createVenue` time, when `/go`
 * actually runs: the missing-client API and the undefined default
 * primary are fail-closed errors there.
 *
 * The workspace directory is captured at construction: the Venue
 * contract's `createVenue` receives only the parent session id, but the
 * OpenCode session-create API needs the directory in its query.
 *
 * @param client - The OpenCode v1 client slice (may be partial or absent).
 * @param defaultPrimary - The executor agent name for the new session,
 *   or `undefined` when no primary is configured.
 * @param directory - The workspace directory for the new session.
 * @returns The OpenCode venue.
 */
export function createOpenCodeVenue(
  client: PlanClient | null | undefined,
  defaultPrimary: string | undefined,
  directory: string,
): Venue {
  return {
    /**
     * Create the new session with the executor agent set at create time.
     *
     * @param ctx - The handoff context: the parent session id and the
     *   session title derived from the resolved plan.
     * @returns The created session id.
     * @throws Error when the session-create API is unavailable (fail
     *   closed, the missing-client behaviour) or the default primary is
     *   undefined.
     */
    async createVenue(ctx) {
      if (!client?.session?.create) {
        throw new Error(
          "Session creation API is not available. " +
            "Ensure the OpenCode plugin is properly loaded.",
        );
      }
      if (!defaultPrimary) {
        throw new Error(
          "No default primary agent is configured. " +
            "Set a primary agent mode in config.toml to run /go.",
        );
      }
      const createResult = await client.session.create({
        body: { title: ctx.title, agent: defaultPrimary },
        query: { directory },
      });
      if (createResult.error || !createResult.data?.id) {
        const errMsg = createResult.error ?? "no session ID returned";
        log(
          "go-command",
          "session_create_failed",
          ctx.parentage,
          undefined,
          "error",
          { error: String(errMsg) },
        );
        throw new Error(`Failed to create execution session: ${errMsg}`);
      }
      return { id: createResult.data.id };
    },

    /**
     * Prepare the session's agent identity — a no-op on OpenCode because
     * the agent is set at create time.
     */
    async installAgent() {},

    /**
     * Deliver the plan reference into the new session.
     *
     * Sends the plan reference via `promptAsync`, then the silent
     * confirmation via `session.prompt(noReply)` (the confirmation text
     * appears in the TUI but is never processed by the LLM).  The
     * confirmation is best-effort — a failure is logged and swallowed.
     *
     * @param session - The created session.
     * @param planReference - The plan-reference prompt text.
     * @throws Error when `promptAsync` is unavailable or rejects.
     */
    async deliver(session, planReference) {
      if (!client?.session?.promptAsync) {
        throw new Error(
          "promptAsync is not available on the client. " +
            "Ensure the OpenCode plugin provides session.promptAsync.",
        );
      }
      await client.session.promptAsync({
        path: { id: session.id },
        body: {
          agent: defaultPrimary,
          parts: [{ type: "text", text: planReference }],
        },
      });
      if (client?.session?.prompt) {
        try {
          await client.session.prompt({
            path: { id: session.id },
            body: {
              noReply: true,
              parts: [
                {
                  type: "text",
                  text: buildConfirmText(),
                  ignored: true,
                },
              ],
            },
          });
          log("go-command", "confirm_injected", session.id, undefined, "info");
        } catch (err) {
          log(
            "go-command",
            "confirm_inject_failed",
            session.id,
            undefined,
            "warn",
            { error: String(err) },
          );
        }
      }
    },

    /**
     * Move the TUI focus to the new session.
     *
     * Navigates to home first (a clean break from the old session so
     * keyboard up-arrow stays within the new session's history), then
     * publishes the `tui.session.select` SSE event that the TUI
     * frontend reacts to.
     *
     * @param session - The created session.
     */
    async focus(session) {
      if (client?.route?.navigate) {
        client.route.navigate("home");
        log("go-command", "navigated_home", session.id, undefined, "info");
      }
      if (client?.tui?.publish) {
        await client.tui.publish({
          body: {
            type: "tui.session.select",
            properties: { sessionID: session.id },
          },
        });
        log("go-command", "tui_switched", session.id, undefined, "info", {
          newSessionID: session.id,
        });
      }
    },
  };
}
