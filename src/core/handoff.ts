/**
 * Host-agnostic plan handoff protocol.
 *
 * Coordinates the `/go` handoff as a fixed six-step sequence.  The plan
 * resolution and status transition live in `./plan.ts`; the session
 * creation, prompt delivery, and TUI focus are delegated to a
 * host-provided `HandoffTarget` so the same orchestration drives both
 * the OpenCode and pi hosts.
 *
 * The step order is deliberately chosen so that the plan file is only
 * marked `executing` AFTER the plan reference has been delivered into
 * the new session.  A delivery failure therefore leaves the plan file
 * untouched — the handoff is re-runnable instead of stranding a dead
 * `executing` plan.
 *
 * @module
 */

import { log } from "../utils/logger.js";
import {
  buildPlanReference,
  findPlanByStatus,
  updatePlanStatus,
  writePlan,
} from "./plan.js";

// ---------------------------------------------------------------------------
// Handoff target contract
// ---------------------------------------------------------------------------

/**
 * Host-specific session handoff surface.
 *
 * Each host adapts its native session APIs to this interface.  The
 * methods are called in the fixed order defined by `executeHandoff`;
 * a throwing method aborts the handoff before the plan is marked
 * `executing`.
 */
export interface HandoffTarget {
  /**
   * Create the new session that will execute the plan.
   *
   * @param ctx - The handoff context: the parent session id and the
   *   new-session title derived from the resolved plan.
   * @returns The created session id (may be empty on hosts whose TUI
   *   binds the replacement session without an id).
   */
  create(ctx: { parentage: string; title: string }): Promise<{ id: string }>;
  /**
   * Prepare the new session's agent identity.
   *
   * Runs after creation, before delivery.  On OpenCode the agent is set
   * at create time so this is a no-op; on pi it switches the primary
   * agent so the replaced session starts as the executor.
   */
  installAgent(): void | Promise<void>;
  /**
   * Deliver the plan reference into the new session.
   *
   * This is the point of no return: once it resolves the handoff is
   * considered successful and the plan is marked `executing`.  A throw
   * here leaves the plan file untouched.
   *
   * @param session - The created session.
   * @param planReference - The plan-reference prompt text.
   */
  deliver(session: { id: string }, planReference: string): Promise<void>;
  /**
   * Move the user's TUI focus to the new session.
   *
   * Runs last, after the plan has been marked `executing`.  A no-op on
   * hosts whose TUI binds the replacement session automatically.
   *
   * @param session - The created session.
   */
  focus(session: { id: string }): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Handoff orchestration
// ---------------------------------------------------------------------------

/**
 * Execute the `/go` handoff as a fixed six-step sequence.
 *
 * Exact order: resolve (`findPlanByStatus(directory, "planning-done")`,
 * throwing with the user-facing message when none exists) →
 * `handoffTarget.create({ parentage: sessionID, title })` →
 * `handoffTarget.installAgent()` →
 * `handoffTarget.deliver(session, planReference)` → mark `executing`
 * (only after delivery succeeded — a deliver failure leaves the plan
 * file untouched so `/go` is re-runnable) →
 * `handoffTarget.focus(session)`.
 *
 * @param opts - The handoff inputs: the handoff target, the current
 *   session id (becomes the new session's parent), and the workspace
 *   directory where plan files live.
 * @throws Error when no `planning-done` plan exists, the handoff target
 *   fails at any step, or the plan file cannot be written.
 */
export async function executeHandoff(opts: {
  handoffTarget: HandoffTarget;
  sessionID: string;
  directory: string;
}): Promise<void> {
  const { handoffTarget, sessionID, directory } = opts;

  // --- 1. Resolve the planning-done plan ---
  const plan = findPlanByStatus(directory, "planning-done");

  if (!plan) {
    throw new Error(
      `No plan with status "planning-done" found for session ` +
        `${sessionID.slice(0, 8)}…. ` +
        "Create a plan with mola first, then run /go.",
    );
  }

  log("go-command", "plan_found", sessionID, undefined, "info", {
    path: plan.path,
    slug: plan.slug,
  });

  // --- 2. Create the new session ---
  const session = await handoffTarget.create({
    parentage: sessionID,
    title: `Execute: ${plan.slug}`,
  });
  log("go-command", "session_created", sessionID, undefined, "info", {
    newSessionID: session.id,
  });

  // --- 3. Prepare the session's agent identity ---
  await handoffTarget.installAgent();

  // --- 4. Deliver the plan reference into the new session ---
  //
  // This is the point of no return.  The plan status is marked
  // `executing` ONLY after delivery succeeds, so a deliver failure
  // leaves the plan file untouched and `/go` can be re-run.
  const planReference = buildPlanReference(plan.path);
  await handoffTarget.deliver(session, planReference);
  log("go-command", "prompt_injected", sessionID, undefined, "info", {
    newSessionID: session.id,
  });

  // --- 5. Mark the plan as executing ---
  const updatedContent = updatePlanStatus(plan.content, "executing");
  writePlan(plan.path, updatedContent);
  log("go-command", "status_updated", sessionID, undefined, "info", {
    path: plan.path,
    newStatus: "executing",
  });

  // --- 6. Move the TUI focus to the new session ---
  await handoffTarget.focus(session);
}
