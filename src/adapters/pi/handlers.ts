/**
 * Pi event handler factory.
 *
 * Builds the fourteen handlers the pi host registers, each closing over the
 * explicit {@link PiEventHandlerDeps} the wiring layer supplies:
 *
 *  - `session_start` ensures the session's lifecycle scope with pi's own
 *    reason, then seeds the `zoo` widget and the todo column at startup /
 *    resume, trims the active tool set by the primary's denies, drops the
 *    session's cached round view, and rebuilds the run registry from the
 *    persisted transcript.
 *  - `session_shutdown` stops that scope (nested sessions first, then the
 *    extension services) and reports every cleanup failure: pi replaces its
 *    extension runtime, so the session resources must not outlive it.
 *  - `before_agent_start` resolves the current agent identity through the
 *    identity core and prepends the matching composed agent prompt to the
 *    chainable system prompt; an unresolved identity or an agent outside
 *    the profile leaves the prompt untouched (fail-closed).
 *  - `resources_discover` contributes the profile-listed skill
 *    directories, filtered by the active primary's
 *    `[agent.<name>].permission.skill` rules.
 *  - `tool_result` / `context` / `message_end` run the composed after-exec
 *    / transform / text-finalization contributions.
 *  - `tool_call` enforces the composed delegation gate on `subagent`
 *    calls: a refusal returns `{ block: true, reason }`, which pi surfaces
 *    to the model as an error tool result; every other tool call passes
 *    through untouched.  The event is registered only when the profile
 *    composes a delegation gate (see `hasGateHandlers`).
 *  - `session_tree` drops this session's cached todo view after a tree
 *    navigation.
 *  - `agent_end`, `agent_before_settle`, `agent_settled`,
 *    `ui_prompt_start` and `ui_prompt_end` drive the loop settle wiring:
 *    `agent_end` records the finished run's terminal messages, the
 *    pre-settle boundary judges them and returns a `zoo-loop-wake` entry
 *    with `continue: true` when the composed strategy wakes, and
 *    `agent_settled` flushes the log.  These are inert unless the profile
 *    composes a settle contribution (see `hasSettledHandlers`).
 *
 * The mutable loop state (`uiPromptDepth`, the last run's messages) lives
 * in this factory's closure so the settle events share it.
 *
 * @module
 */

import {
  buildPiContextHandler,
  buildPiMessageEndHandler,
  buildPiToolResultHandler,
} from "../../compose-pi.js";
import type { ComposedResult } from "../../core/compose.js";
import { clearRoundView } from "../../core/context/round-view.js";
import type { CleanupReport } from "../../core/lifecycle/index.js";
import type { LoopEngine, StopCause } from "../../core/loop/index.js";
import type { SkillPermissionMap } from "../../core/permissions/skill-permissions.js";
import { filterAllowedSkills } from "../../core/permissions/skill-permissions.js";
import { applyModelVariant } from "../../core/prompt-variant.js";
import { getPrimary, resolveIdentity } from "../../core/subagent/identity.js";
import { flushLogs, log } from "../../utils/logger.js";
import type { PiLifecycleOutcome } from "./lifecycle.js";
import type { PiLiveContext } from "./live-context.js";
import {
  askWentUnanswered,
  boundaryEntries,
  countTurnToolCalls,
  readActivityOutcome,
  resolveContextModelId,
  settledTurnMessages,
} from "./settled-turn.js";
import { type PiHistoryEntry, rebuildSubagentRuns } from "./subagent-scan.js";
import type { PiEventHandlers } from "./types.js";

/**
 * The wiring surfaces the event handlers close over.
 *
 * Everything the handlers cannot derive from the composed result is
 * injected here: the extension-scope live context, the loop engine, and the
 * wiring-layer callbacks (`applyPrimaryToolTrim`, the widget and todo
 * refresh hooks, the switch drain, the todo cache invalidator, the
 * lifecycle operations).
 */
export interface PiEventHandlerDeps {
  /**
   * The extension-scope live context: every handler publishes the context
   * of the event it is handling, and the adapter, tool host, fleet widget
   * and switch host read it from there.
   */
  liveContext: PiLiveContext;
  /** The current session id, read from the live context. */
  getSessionId(): string | undefined;
  /** The composed profile contributions. */
  composed: ComposedResult;
  /** The loop engine, or undefined when the profile composes no settle hook. */
  engine: LoopEngine | undefined;
  /** Per-agent skill permission rules (`[agent.<name>].permission.skill`). */
  skillPermissions: SkillPermissionMap;
  /**
   * The composed profile's skill directory names.
   *
   * Read per bind from the published profile catalog, so a bind that
   * happens after composition contributes the same list the subagent driver
   * seeds its sub-sessions with.
   */
  getProfileSkills(): string[];
  /** Resolve the absolute paths of the existing profile skill directories. */
  collectSkillPaths(names: string[]): string[];
  /** Apply the active primary's tool denies to the active tool set. */
  applyPrimaryToolTrim(): void;
  /**
   * Register (or re-seed) the `zoo` fleet widget of the session the event
   * context names.  An absent / unknown session registers nothing.
   */
  registerFleetWidget(ctx?: unknown): void;
  /** Re-render the fleet widget (registry / primary change nudge). */
  refreshFleetWidget(): void;
  /** Re-read the session's todo state and re-render the widget. */
  refreshTodoView(): void;
  /** Seed the todo column once (the `before_agent_start` fallback). */
  seedTodoView(): void;
  /** Drain post-replacement switch operations in the new session closure. */
  drainPendingSwitchOps(): void;
  /**
   * Ensure the session scope of the id the current event context carries.
   *
   * Handlers call this before touching session resources (the fleet widget,
   * its listener, the todo view).  A context with no usable session id
   * creates nothing and reports `false`.
   */
  ensureSession(ctx?: unknown): Promise<boolean>;
  /**
   * Forward a real `session_start` to the lifecycle kernel: the scope is
   * ensured and pi's reason reaches the start hooks unmodified.  A payload
   * without a reason only ensures the scope.
   */
  startSession(event: unknown, ctx?: unknown): Promise<PiLifecycleOutcome>;
  /**
   * Stop the extension on `session_shutdown` (nested sessions first, then
   * extension services) and report every cleanup failure.
   */
  stopExtension(event: unknown): Promise<CleanupReport>;
  /** Drop a session's cached todo state after a tree navigation. */
  invalidateTodo(sessionId: string): void;
  /**
   * Resolve the caller of a delegation through pi's identity core (the
   * same source the subagent tool uses).  No session argument: pi binds
   * the identity per async chain, not per session.  `undefined` means
   * unresolvable, which the delegation judge refuses.
   */
  resolveCallerAgent(): Promise<string | undefined>;
}

/**
 * Build the pi event handlers over an explicit set of wiring surfaces.
 *
 * @param deps - The wiring surfaces the handlers close over.
 * @returns The fourteen handlers plus the registration gates.
 */
export function createPiEventHandlers(
  deps: PiEventHandlerDeps,
): PiEventHandlers {
  const { liveContext } = deps;
  // Open blocking UI prompt count: a run that ends while this is > 0 was
  // waiting for the user, not genuinely finished.
  let uiPromptDepth = 0;
  // The most recent finished run's terminal messages, recorded by
  // `agent_end`.  pi's pre-settle boundary event carries no transcript, so
  // the judge derives the run's activity and handback facts from this
  // slice; the two events fire back to back in the same run lifecycle.
  let lastRunMessages: readonly unknown[] = [];

  const toolResultHandler = buildPiToolResultHandler(deps.composed.afterExec);
  const contextHandler = buildPiContextHandler(deps.composed.transform);
  const messageEndHandler = buildPiMessageEndHandler(
    deps.composed.textComplete,
  );

  return {
    async beforeAgentStart(evt, ctx?) {
      liveContext.publish(ctx);
      // A turn may be the first event that observes the session (flows
      // without a `session_start`), so the scope is ensured before the
      // widget / todo wiring touches session resources.  No id, nothing.
      await deps.ensureSession(ctx);
      // Reset the session's reminder budget when a real user message starts
      // a turn.  pi fires `before_agent_start` for a submitted prompt and
      // for a run started by `sendMessage({ triggerTurn: true })` while
      // idle, and only the former is a user turn: the event's `messageType`
      // is the field that tells them apart.  A wake continued at the
      // pre-settle boundary resumes through `agent.continue()` and never
      // emits this event, so the injected wake keeps its spent budget
      // either way.
      const promptSessionId = deps.getSessionId();
      if (
        evt.messageType === "user" &&
        deps.engine !== undefined &&
        promptSessionId !== undefined &&
        promptSessionId.length > 0
      ) {
        deps.engine.reset(promptSessionId);
      }
      // Drain any pending post-replacement switch operations.  This handler
      // runs in the NEW session's closure (the factory re-ran on
      // `newSession`), so the pi API in scope here is the fresh, non-stale
      // one — unlike the captured API that pi invalidated on replacement.
      // The tool trim was deferred from `withSession` (to avoid touching the
      // stale action bindings) and is applied here exactly once at the new
      // session's first turn.
      deps.drainPendingSwitchOps();
      // Re-apply the current primary's deny trim.  `session_start` already
      // does this at bind time; this fallback covers flows where a session
      // begins without one (and keeps the active set authoritative after a
      // deferred switch drain).  Idempotent — it always filters the fixed
      // baseline, so repeated calls never accumulate denies.
      deps.applyPrimaryToolTrim();
      // Fallback seed: covers flows where `session_start` fires before the
      // identity is set, or a session begins without a `session_start` in
      // some flows.  Registration is idempotent — re-running it re-seeds the
      // widget and never stacks a terminal-input listener.
      deps.registerFleetWidget(ctx);
      // Seed the todo column on the first turn that resolves a session when
      // `session_start` did not already do so; the one-shot flag keeps later
      // turns from re-reading the store.
      deps.seedTodoView();
      // Resolve the current agent identity: the AsyncLocalStorage store first
      // (a delegated sub-session), falling back to the active primary.  The
      // composed agents list is looked up by the resolved identity's name;
      // when the machinery is off (no primary) or the agent is not in the
      // profile the system prompt is returned unchanged (silent
      // fail-closed).
      const identity = resolveIdentity();
      const agent = identity
        ? deps.composed.agents.find(
            (candidate) => candidate.name === identity.name,
          )
        : undefined;
      return {
        systemPrompt:
          agent === undefined
            ? evt.systemPrompt
            : `${applyModelVariant(agent.prompt, resolveContextModelId(ctx), agent.promptVariants)}\n\n${evt.systemPrompt}`,
      };
    },
    async sessionStart(evt?, ctx?) {
      liveContext.publish(ctx);
      // The real start notice: ensure the session scope and run the start
      // hooks with pi's own reason.  This also creates the session's fleet
      // resources, so the registration below seeds the scope they belong
      // to (no separate ensure here — a first-use create+start must not
      // register twice).
      await deps.startSession(evt, ctx);
      // Trim the session's active tool set by the current primary's denies at
      // session bind time (startup / reload / resume / replacement), so the
      // primary's deny list takes effect from the first turn — before the
      // /<agent> switch path or a /go handoff would otherwise be the first
      // place it applied.  `before_agent_start` runs it again as a fallback
      // (idempotent).
      deps.applyPrimaryToolTrim();
      // Register the fleet widget at session startup / resume (before any
      // LLM turn), so the current primary shows immediately.
      // `before_agent_start` runs the same registration as a fallback.
      deps.registerFleetWidget(ctx);
      // Seed the widget's todo column from this session's plan; the store
      // read is async, so the column appears once it resolves.
      deps.refreshTodoView();
      // Rebuild the run registry from the session's persisted message
      // history.  The registry is process-level state, so a pi exit wipes
      // it; on restore / resume this rescans the current session's
      // `subagent` tool calls (via `buildContextEntries()`) and rewrites the
      // registry, so the fleet widget keeps showing historical subagent
      // runs.  The rebuild is recursive: each finished run's
      // `details.sessionPath` points at its sub-session file, which is
      // rescanned for nested delegations (beaver → lynx → ...),
      // reconstructing the full parent/child tree.  A missing / unreadable
      // sub-session file skips only that branch (warn).  Idempotent: run ids
      // are the pi run ids and the registry's terminal-immutability rule
      // never duplicates or overwrites an existing entry.  Best-effort: an
      // unavailable session manager / history leaves the registry untouched
      // (fresh session).
      const sessionId = deps.getSessionId();
      // Resolve this session's own context: a registry rebuild must read the
      // transcript of the session the event names, never whichever context
      // was published last.
      const sessionManager =
        sessionId === undefined
          ? undefined
          : liveContext.forSession(sessionId)?.sessionManager;
      // Drop this session's cached round view.  pi never fires a session
      // deleted event, so `cleanupSession` (the only other caller of
      // `clearRoundView`) is never reached in this process: without this
      // call every session ever opened leaves its frozen snapshot resident.
      // The record is runtime-only and every pruning round republishes it,
      // so clearing at startup / reload / resume is safe.  Deliberately NOT
      // `cleanupSession` — that also deletes the persisted state file, which
      // must survive a resume.
      if (typeof sessionId === "string" && sessionId.length > 0) {
        clearRoundView(sessionId);
        // A (re)starting session begins with a fresh reminder budget, so its
        // previous entry — left by an earlier run of the same session id —
        // is dropped here.  pi fires no session-deletion event, so the
        // entries of sessions that never restart are reclaimed by the
        // engine's size cap instead.  Guarded by the engine's presence so a
        // profile without the todo-continuation hook does zero loop
        // bookkeeping.
        if (deps.engine !== undefined) deps.engine.reset(sessionId);
      }
      // A fresh session (re)bind starts with a clean prompt-depth count: if
      // a `ui_prompt_end` was ever dropped (extension reload mid-prompt,
      // host-side cancellation), a stale positive count would misclassify
      // every later settle as `awaiting-input` and silently disable the loop
      // for the rest of the process.
      if (deps.engine !== undefined) uiPromptDepth = 0;
      if (
        typeof sessionId === "string" &&
        sessionId.length > 0 &&
        sessionManager?.buildContextEntries !== undefined
      ) {
        try {
          // Call as a method: extracting the function reference unbinds
          // `this`, and pi's SessionManager.buildContextEntries reads
          // `this.getEntries()` — an unbound call crashes at runtime.
          const entries =
            sessionManager.buildContextEntries() as PiHistoryEntry[];
          rebuildSubagentRuns(entries, sessionId);
        } catch (err) {
          log.warn({
            hook: "plugin",
            event: "registry_rebuild_failed",
            sessionId,
            error: String(err),
          });
        }
      }
      deps.refreshFleetWidget();
    },
    async resourcesDiscover(_evt?, ctx?) {
      liveContext.publish(ctx);
      // Ensure the session scope: this bind-time event may be the first one
      // that observes a session (flows without `session_start`).  No id,
      // nothing created.
      await deps.ensureSession(ctx);
      // Filter the contributed skill directories by the active primary's
      // `[agent.<name>].permission.skill` rules.  The filter applies at
      // session-bind time against the primary active AT THAT MOMENT — pi's
      // `resources_discover` fires once per session bind and its results are
      // merge-only (cannot be retracted mid-session), so a later runtime
      // `/mola` switch does NOT re-filter the already-contributed skills
      // (accepted pi limitation).  When no primary is configured, or the
      // primary has no skill rules, the full profile list is contributed
      // unfiltered (machinery-off behaviour unchanged, consistent with
      // `before_agent_start`).
      const primary = getPrimary();
      const rules =
        primary === undefined ? undefined : deps.skillPermissions[primary];
      const profileSkills = deps.getProfileSkills();
      if (rules === undefined) {
        return { skillPaths: deps.collectSkillPaths(profileSkills) };
      }
      const kept = filterAllowedSkills(profileSkills, rules);
      const dropped = profileSkills.length - kept.length;
      log.info({
        hook: "resources",
        event: "skills_filtered",
        agent: primary,
        kept: kept.length,
        dropped,
      });
      return { skillPaths: deps.collectSkillPaths(kept) };
    },
    async toolResult(event, ctx) {
      liveContext.publish(ctx);
      await deps.ensureSession(ctx);
      const result = await toolResultHandler(event, ctx);
      // A successful `todo` call changed this session's plan: refresh the
      // widget's todo view after the existing chain has run, without
      // touching its result.  Other tools and error results leave the cache
      // alone.
      if (event.toolName === "todo" && !event.isError) {
        deps.refreshTodoView();
      }
      return result;
    },
    contextHandler: async (event, ctx) => {
      liveContext.publish(ctx);
      // A transform event may be the session's first observation, so the
      // scope is ensured before the composed chain reads session state.
      await deps.ensureSession(ctx);
      return contextHandler(event, ctx);
    },
    messageEnd: (event, ctx) => {
      liveContext.publish(ctx);
      return messageEndHandler(event, ctx);
    },
    async toolCall(event, ctx?) {
      liveContext.publish(ctx);
      await deps.ensureSession(ctx);
      const gate = deps.composed.gate;
      // No strategy (valid profile) → allow.  The key is not registered in
      // that case; this guard keeps a direct call inert too.
      if (gate === null) return undefined;
      // Only the delegation tool is gated; every other tool call passes
      // through untouched (the gate belongs to the delegation path).
      if (event.toolName !== "subagent") return undefined;
      // A non-string field is left undefined so the inner tool's own
      // argument validation reports it (the wrapper's boundary semantics).
      const raw =
        event.input && typeof event.input === "object" ? event.input : {};
      const target = typeof raw.agent === "string" ? raw.agent : undefined;
      const prompt = typeof raw.prompt === "string" ? raw.prompt : undefined;
      // The caller comes from the identity resolver only when at least one
      // judge needs it; otherwise it is left undefined (OpenCode parity).
      // An unresolvable caller stays `undefined`, which the judge refuses
      // (fail-closed).
      const caller = deps.composed.gateNeedsCaller
        ? await deps.resolveCallerAgent()
        : undefined;

      const refusal = gate({ caller, target, prompt });
      if (refusal === null) return undefined;
      log.warn({
        hook: "subagent-tool",
        event: "delegation_blocked",
        sessionId: deps.getSessionId(),
        caller: caller ?? null,
        target: target ?? null,
        judge: refusal.judge,
        reason: refusal.reason,
      });
      return { block: true, reason: refusal.reason };
    },
    async sessionTree(_evt?, ctx?) {
      liveContext.publish(ctx);
      await deps.ensureSession(ctx);
      // Tree navigation (`/tree`) moves the active leaf to another branch,
      // so the transcript the todo store restores from has changed: drop
      // this session's cached state and let the next `todo` call re-scan.
      // No-ops when no session resolves or this factory execution owns no
      // store (a host with no todo restore path — the tool never
      // registered).
      const sessionId = deps.getSessionId();
      if (sessionId !== undefined) deps.invalidateTodo(sessionId);
      // Re-read the invalidated cache so the widget shows the branch the
      // navigation moved to.
      deps.refreshTodoView();
    },
    hasSettledHandlers: deps.engine !== undefined,
    hasGateHandlers: deps.composed.gate !== null,
    async sessionShutdown(evt?, _ctx?) {
      // pi replaces its extension runtime (quit / reload / new / resume /
      // fork), so the whole scope stops: nested sessions first, then the
      // extension services.  The event context is stale from here on, so it
      // is deliberately NOT published to the live context — no handler may
      // write session resources after the scope stopped.
      const report = await deps.stopExtension(evt);
      // Cleanup failures are reported here: a failed disposer must never be
      // swallowed silently.
      for (const failure of report.errors) {
        log.warn({
          hook: "lifecycle",
          event: "cleanup_failed",
          sessionId: failure.sessionID,
          scope: failure.scope,
          service: failure.service,
          error: String(failure.error),
        });
      }
    },
    agentEnd(evt?, ctx?) {
      // Passive record only: the judge runs at the pre-settle boundary.  The
      // loop is inert without a settle strategy (the settle events are never
      // registered), and this guard keeps a direct call (tests) inert too.
      if (deps.engine === undefined) return;
      liveContext.publish(ctx);
      // The run's terminal messages feed the boundary judge.  An unreadable
      // payload records an empty run, which yields no activity and no
      // handback fact (silence is the todo list's call, not the
      // transcript's).
      const raw = (evt as { messages?: unknown } | undefined)?.messages;
      lastRunMessages = Array.isArray(raw) ? raw : [];
    },
    async beforeSettle(evt?, ctx?) {
      // Same registration gate as `agent_end`: no strategy, no judge.
      if (deps.engine === undefined) return {};
      // A loop judge must never break the host session, and a stale
      // extension context (pi invalidates one on session replacement /
      // reload) can make even reading `sessionManager` throw.  Isolate the
      // whole body: log and fail closed.
      let sessionID: string | undefined;
      try {
        liveContext.publish(ctx);
        sessionID = deps.getSessionId();
        // pi computes the outcome from the run's terminal stop reason, so it
        // is the host's own verdict: only a run that completed may wake.  An
        // aborted run's terminal message is often recorded as
        // `stopReason: "error"` (a user Esc), so re-deriving the outcome from
        // the transcript misclassified it as settled; pi reports it as
        // `outcome: "error"` here, and pi does not fire this boundary at all
        // for a user abort.
        const outcome = readActivityOutcome(evt);
        // Derive the settled turn's facts from the messages `agent_end`
        // recorded: whether it made any tool call at all.  An unreadable
        // transcript, or one with no assistant message, simply yields no
        // activity — silence is NOT implied by it: the todo list is the
        // authority on wakefulness, and the engine consults `hadActivity`
        // only while the session's awaiting-progress lock is held.  A fresh
        // settle with no prior wake is judged against the list regardless of
        // activity.
        const turn = settledTurnMessages(lastRunMessages);
        const hadActivity = countTurnToolCalls(turn) > 0;
        // A headless ask could not reach the user (no UI to draw on), so the
        // turn ends with the question unanswered: stop and let the user read
        // it after the process exits rather than auto-continuing into
        // unwanted work.
        const askUnanswered = askWentUnanswered(turn);
        const cause: StopCause =
          outcome !== "completed"
            ? "aborted"
            : uiPromptDepth > 0 || askUnanswered
              ? "awaiting-input"
              : "settled";
        log.debug({
          hook: "loop",
          event: "settle_received",
          sessionId: sessionID,
          cause,
          outcome,
          hadActivity,
        });
        // No live pi session to attribute the reminder to → fail closed.
        if (sessionID === undefined || sessionID.length === 0) {
          log.debug({
            hook: "loop",
            event: "settle_skipped",
            reason: "no-session",
          });
          return {};
        }
        // Only the orchestrator session is continued; a delegated child
        // session is driven by its own identity and must not be woken by the
        // root extension.
        if (resolveIdentity()?.kind === "subagent") {
          log.debug({
            hook: "loop",
            event: "settle_skipped",
            sessionId: sessionID,
            reason: "subagent",
          });
          return {};
        }
        // `hadActivity` is derived above from the settled turn's tool calls;
        // the engine's interlocks and the todo strategy's gates decide the
        // rest.
        const decision = await deps.engine.run({
          sessionID,
          cause,
          hadActivity,
        });
        if (decision === null) return {};
        // Count BEFORE returning the entry, mirroring the OpenCode host: once
        // pi adopts the boundary result the verdict has taken effect, so the
        // wake must already be counted — re-judging this settle must not
        // produce a second reminder.  pi commits the entry and runs the
        // continuation within this run, so the verdict and its effect cannot
        // diverge and no queued reminder outlives the run that produced it.
        deps.engine.record(sessionID, decision.name);
        log.info({
          hook: "loop",
          event: "wake_injected",
          sessionId: sessionID,
          handler: decision.name,
          used: deps.engine.used(sessionID, decision.name),
        });
        return {
          entries: [
            ...boundaryEntries(evt),
            {
              type: "custom_message",
              customType: "zoo-loop-wake",
              content: decision.text,
              // Shown in the TUI so the user can see the loop wake fire; the
              // model receives it as a user-role message either way (pi
              // converts custom messages via convertToLlm).
              display: true,
            },
          ],
          continue: true,
        };
      } catch (err) {
        log.warn({
          hook: "loop",
          event: "settle_failed",
          sessionId: sessionID,
          error: String(err),
        });
        return {};
      }
    },
    agentSettled(_evt?, ctx?) {
      liveContext.publish(ctx);
      // A single-shot host can exit right after the last run, before the
      // periodic flush timer fires; make the verdict durable.
      flushLogs();
    },
    uiPromptStart: (_evt?, ctx?) => {
      liveContext.publish(ctx);
      uiPromptDepth += 1;
    },
    uiPromptEnd: (_evt?, ctx?) => {
      liveContext.publish(ctx);
      if (uiPromptDepth > 0) uiPromptDepth -= 1;
    },
  };
}
