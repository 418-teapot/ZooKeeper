/**
 * Plan lifecycle hook for ZooKeeper OpenCode plugin.
 *
 * Provides the `/go` command handler that transitions a plan from
 * `planning-done` to `executing` by creating a new dolphin session,
 * injecting the plan content, switching TUI focus, and updating
 * the plan file's frontmatter status.
 *
 * @module
 */

import {
  buildConfirmText,
  buildPlanReference,
  findPlanByStatus,
  updatePlanStatus,
  writePlan,
} from "../../core/plan.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal client interface required for plan handoff.
 *
 * Only the APIs used by the `/go` handler are declared. The full
 * OpenCode client object is much larger; this interface keeps the hook
 * thin while remaining trivially compatible.
 */
export interface PlanClient {
  session?: {
    create?: (input: {
      body: { parentID?: string; title?: string; agent?: string };
      query?: { directory?: string };
    }) => Promise<{ data?: { id?: string }; error?: unknown }>;
    delete?: (input: {
      path: { id: string };
    }) => Promise<{ data?: unknown; error?: unknown }>;
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
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle the `/go` command: locate a `planning-done` plan, create a dolphin
 * child session, inject plan content, switch TUI focus, and update the
 * plan's frontmatter status to `executing`.
 *
 * Plans are found flat under `<directory>/.zoo/plans/` using the newest
 * (latest mtime) file matching the target status.
 *
 * Failures (no plan found, session creation failure, missing client API)
 * are surfaced via thrown Error with user-facing messages. The hook
 * adapter in `src/index.ts` converts these to `output.parts` entries.
 *
 * @param client - OpenCode client providing session and TUI APIs.
 * @param sessionID - The current session identifier.
 * @param directory - The workspace directory for plan files and new session.
 * @throws Error when no `planning-done` plan exists, frontmatter is
 *   malformed, or a required client API is unavailable.
 */
export async function handleGoCommand(
  client: PlanClient | null | undefined,
  sessionID: string,
  directory: string,
): Promise<void> {
  // --- 1. Locate the planning-done plan ---
  const plan = findPlanByStatus(directory, "planning-done");

  if (!plan) {
    throw new Error(
      `No plan with status "planning-done" found for session ` +
        `${sessionID.slice(0, 8)}…. ` +
        "Create a plan with mola first, then run /go.",
    );
  }

  log("plan-lifecycle", "plan_found", sessionID, undefined, "info", {
    path: plan.path,
    slug: plan.slug,
  });

  // --- 2. Validate client availability ---
  if (!client?.session?.create) {
    throw new Error(
      "Session creation API is not available. " +
        "Ensure the OpenCode plugin is properly loaded.",
    );
  }

  // --- 3. Create dolphin child session ---
  const title = `Execute: ${plan.slug}`;
  const createResult = await client.session.create({
    body: { title, agent: "dolphin" },
    query: { directory },
  });

  if (createResult.error || !createResult.data?.id) {
    const errMsg = createResult.error ?? "no session ID returned";
    log(
      "plan-lifecycle",
      "session_create_failed",
      sessionID,
      undefined,
      "error",
      { error: String(errMsg) },
    );
    throw new Error(`Failed to create dolphin session: ${errMsg}`);
  }

  const newSessionID = createResult.data.id;
  log("plan-lifecycle", "session_created", sessionID, undefined, "info", {
    newSessionID,
    title,
  });

  // --- 4. Update plan status to "executing" ---
  //
  // Pure sync, no network — do this early to prevent re-processing
  // if any subsequent step fails.
  const updatedContent = updatePlanStatus(plan.content, "executing");
  writePlan(plan.path, updatedContent);
  log("plan-lifecycle", "status_updated", sessionID, undefined, "info", {
    path: plan.path,
    newStatus: "executing",
  });

  // --- 5. Go to home screen first (like /new) then switch to new session ---
  //
  // Navigating to home before selecting the new session mimics OpenCode's
  // /new command flow. This creates a clean break from the old session
  // context so keyboard up-arrow in the new session navigates within
  // prompt history instead of jumping back to the old session.
  //
  // Uses `tui.publish()` with SSE event `tui.session.select` rather than
  // `tui.selectSession()`. The latter endpoint exists and returns 200 but
  // does not trigger a TUI switch; the TUI frontend subscribes to SSE
  // events and only responds to published `tui.session.select` messages.
  //
  // (See docs/plan-mode-design.md §16 #42)
  if (client.route?.navigate) {
    client.route.navigate("home");
    log("plan-lifecycle", "navigated_home", sessionID, undefined, "info");
  }

  if (client.tui?.publish) {
    await client.tui.publish({
      body: {
        type: "tui.session.select",
        properties: { sessionID: newSessionID },
      },
    });
    log("plan-lifecycle", "tui_switched", sessionID, undefined, "info", {
      newSessionID,
    });
  }

  // --- 6. Inject plan reference into the new session ---
  const planReference = buildPlanReference(plan.path);

  if (!client.session?.promptAsync) {
    throw new Error(
      "promptAsync is not available on the client. " +
        "Ensure the OpenCode plugin provides session.promptAsync.",
    );
  }
  await client.session.promptAsync({
    path: { id: newSessionID },
    body: {
      agent: "dolphin",
      parts: [{ type: "text", text: planReference }],
    },
  });
  log("plan-lifecycle", "prompt_injected", sessionID, undefined, "info", {
    newSessionID,
  });

  // --- 7. Inject silent confirmation into the new session ---
  //
  // Uses session.prompt with noReply: true — the confirmation text
  // appears in the TUI but the LLM never processes it. The sentinel
  // throw in command.execute.before (index.ts) prevents OpenCode from
  // creating an additional user message from the empty template.
  //
  // Pattern from opencode-dynamic-context-pruning:
  //   sendIgnoredMessage → session.prompt({ noReply: true, parts: [...] })
  if (client.session?.prompt) {
    try {
      await client.session.prompt({
        path: { id: newSessionID },
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
      log("plan-lifecycle", "confirm_injected", sessionID, undefined, "info");
    } catch (err) {
      log(
        "plan-lifecycle",
        "confirm_inject_failed",
        sessionID,
        undefined,
        "warn",
        { error: String(err) },
      );
    }
  }

  // --- 8. (Optional) Delete the old planning session ---
  //
  // If navigate("home") in step 5 does not fully prevent keyboard
  // up-arrow from jumping back to the old session, uncomment the
  // block below to delete it. Deleting loses the session log; use
  // only as a fallback.
  //
  // Must happen AFTER promptAsync/prompt calls — deleting the parent
  // session before injecting prompts can cause "current session is deleted"
  // errors because OpenCode may validate the active session context.
  //
  // if (client.session?.delete) {
  //   try {
  //     await client.session.delete({ path: { id: sessionID } });
  //     log(
  //       "plan-lifecycle",
  //       "old_session_deleted",
  //       sessionID,
  //       undefined,
  //       "info",
  //     );
  //   } catch (err) {
  //     log(
  //       "plan-lifecycle",
  //       "old_session_delete_failed",
  //       sessionID,
  //       undefined,
  //       "warn",
  //       { error: String(err) },
  //     );
  //   }
  // }
}
