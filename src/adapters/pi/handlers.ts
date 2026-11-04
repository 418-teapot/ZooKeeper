/**
 * Pi event handler factory.
 *
 * Builds the fourteen handlers the pi host registers, each closing over the
 * explicit {@link PiEventHandlerDeps} the wiring layer supplies.  Every
 * handler admits its business through `runSession` with the context of the
 * event it is handling, so the work runs under that session's permit and a
 * call with no session runs nothing.  The event's context is bound under
 * that permit's session id only after admission:
 *
 *  - `session_start` forwards the real start notice with pi's own reason
 *    (a lifecycle control entry that no permit governs), then seeds the
 *    `zoo` widget and the todo column at startup / resume, trims the active
 *    tool set by the primary's denies, and rebuilds the run registry from
 *    the persisted transcript.  A start notice is not a stop, so it
 *    releases no session record.
 *  - `session_shutdown` stops that scope (nested sessions first, then the
 *    extension services) and reports every cleanup failure: pi replaces its
 *    extension runtime, so the session resources must not outlive it.  It is
 *    a control entry as well and takes no permit.
 *  - `before_agent_start` resolves the session's agent through the shared
 *    resolver and prepends the matching composed agent prompt to the
 *    chainable system prompt; an unresolved agent or one outside the
 *    profile leaves the prompt untouched (fail-closed).
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
 * The mutable loop state (each session's open UI prompt depth and its last
 * run's messages) lives in this factory's closure, keyed by session id, so
 * two sessions settling at once never read each other's entry.
 *
 * @module
 */

import {
  buildPiContextHandler,
  buildPiMessageEndHandler,
  buildPiToolResultHandler,
} from "../../compose-pi.js";
import type { ComposedResult } from "../../core/compose.js";
import type { ContextRuntime } from "../../core/context/runtime.js";
import type { CleanupReport, WorkPermit } from "../../core/lifecycle/index.js";
import type { LoopEngine, StopCause } from "../../core/loop/index.js";
import type { SkillPermissionMap } from "../../core/permissions/skill-permissions.js";
import { filterAllowedSkills } from "../../core/permissions/skill-permissions.js";
import { applyModelVariant } from "../../core/prompt-variant.js";
import { flushLogs, log } from "../../utils/logger.js";
import type { PiLifecycleOutcome } from "./lifecycle.js";
import type { PiSessionContexts } from "./session-contexts.js";
import {
  askWentUnanswered,
  boundaryEntries,
  countTurnToolCalls,
  readActivityOutcome,
  resolveContextModelId,
  settledTurnMessages,
} from "./settled-turn.js";
import { type PiHistoryEntry, rebuildSubagentRuns } from "./subagent-scan.js";
import type { PiToolHostContext } from "./tool-host.js";
import type { PiBoundaryResult, PiEventHandlers } from "./types.js";

/**
 * The wiring surfaces the event handlers close over.
 *
 * Everything the handlers cannot derive from the composed result is
 * injected here: the extension-scope session contexts, the loop engine and
 * the wiring-layer callbacks (`applyPrimaryToolTrim`, the widget and todo
 * refresh hooks, the switch drain, the todo cache invalidator, and the
 * lifecycle operations).
 */
export interface PiEventHandlerDeps {
  /**
   * The extension-scope session contexts: every handler binds the context
   * of the event it is handling under that event's session id, and the tool
   * host, fleet widget, todo scan and switch / handoff hosts read it by id.
   */
  sessionContexts: PiSessionContexts;
  /** The composed profile contributions. */
  composed: ComposedResult;
  /** The context records of this extension instance. */
  contextRuntime: ContextRuntime;
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
  /**
   * Apply the named session's primary tool denies to the active tool set.
   *
   * The session id comes from the event being handled, so the trim never
   * applies one session's denies on another's behalf.
   */
  applyPrimaryToolTrim(sessionID: string): void;
  /**
   * Register (or re-seed) one session's `zoo` fleet widget.  An absent or
   * unknown id registers nothing.
   */
  registerFleetWidget(sessionID: string | undefined): void;
  /** Re-render one session's fleet widget (registry / primary nudge). */
  refreshFleetWidget(sessionID: string | undefined): void;
  /** Re-read one session's todo state and re-render its widget. */
  refreshTodoView(sessionID: string | undefined): void;
  /** Seed one session's todo column once (the `before_agent_start` fallback). */
  seedTodoView(sessionID: string | undefined): void;
  /** Drain post-replacement switch operations in the new session closure. */
  drainPendingSwitchOps(): void;
  /**
   * Admit one unit of work for the session this call's context names.
   *
   * The session id always comes from this call's own context, never from
   * the context another event bound.  A context with no usable id, a
   * stopped session, and a stopped extension all run nothing and return
   * `undefined`.
   */
  runSession<T>(
    ctx: unknown,
    work: (permit: WorkPermit) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | undefined>;
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
   * Resolve the agent driving a session, through the same resolver every
   * other handler reads.
   *
   * @param sessionID - The session the event names.
   * @returns The agent, or `undefined` when nothing resolves it.
   */
  resolveAgent(sessionID: string): string | undefined;
  /**
   * Resolve the caller of a delegation (the same session → agent
   * resolver).  `undefined` means unresolvable, which the delegation judge
   * refuses.
   */
  resolveCallerAgent(sessionID: string): Promise<string | undefined>;
  /**
   * The agent this runtime's factory fixed, or `undefined` in a main
   * runtime.
   *
   * A sub-session runtime serves exactly one delegation, so this is its
   * session kind: its own settle must never be woken by the root
   * extension, and its tool face stays driver-restricted.
   */
  fixedAgent?: string;
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
  const { sessionContexts } = deps;
  // Open blocking UI prompt count per session: a run that ends while this
  // is > 0 was waiting for the user, not genuinely finished.
  const uiPromptDepths = new Map<string, number>();
  // Each session's most recent finished run's terminal messages, recorded
  // by `agent_end`.  pi's pre-settle boundary event carries no transcript,
  // so the judge derives the run's activity and handback facts from this
  // slice; the two events fire back to back in the same run lifecycle.
  const lastRunMessages = new Map<string, readonly unknown[]>();

  const toolResultHandler = buildPiToolResultHandler(deps.composed.afterExec);
  const contextHandler = buildPiContextHandler(
    deps.composed.transform,
    deps.contextRuntime,
  );
  const messageEndHandler = buildPiMessageEndHandler(
    deps.composed.textComplete,
  );

  return {
    async beforeAgentStart(evt, ctx?) {
      return deps.runSession(ctx, (permit) => {
        sessionContexts.bind(permit.sessionID, ctx);
        // Reset the session's reminder budget when a real user message
        // starts a turn.  pi fires `before_agent_start` for a submitted
        // prompt and for a run started by `sendMessage({ triggerTurn: true
        // })` while idle, and only the former is a user turn: the event's
        // `messageType` is the field that tells them apart.  A wake
        // continued at the pre-settle boundary resumes through
        // `agent.continue()` and never emits this event, so the injected
        // wake keeps its spent budget either way.
        if (evt.messageType === "user" && deps.engine !== undefined) {
          deps.engine.reset(permit.sessionID);
        }
        // Drain any pending post-replacement switch operations.  This
        // handler runs in the NEW session's closure (the factory re-ran on
        // `newSession`), so the pi API in scope here is the fresh,
        // non-stale one — unlike the captured API that pi invalidated on
        // replacement.  The tool trim was deferred from `withSession` (to
        // avoid touching the stale action bindings) and is applied here
        // exactly once at the new session's first turn.
        deps.drainPendingSwitchOps();
        // Re-apply the session's primary deny trim.  `session_start`
        // already does this at bind time; this fallback covers flows where
        // a session begins without one (and keeps the active set
        // authoritative after a deferred switch drain).  Idempotent — it
        // always filters the fixed baseline, so repeated calls never
        // accumulate denies.
        deps.applyPrimaryToolTrim(permit.sessionID);
        // Fallback seed: covers flows where `session_start` fires before
        // the identity is set, or a session begins without a
        // `session_start` in some flows.  Registration is idempotent —
        // re-running it re-seeds the widget and never stacks a
        // terminal-input listener.
        deps.registerFleetWidget(permit.sessionID);
        // Seed the todo column on the first turn that resolves a session
        // when `session_start` did not already do so; the one-shot flag
        // keeps later turns from re-reading the store.
        deps.seedTodoView(permit.sessionID);
        // Resolve this event's session agent through the shared resolver
        // (an existing binding, this runtime's fixed agent, a recorded
        // child session, a pending switch target, or the orchestrator).
        // The composed agents list is looked up by that name; an unresolved
        // session or an agent outside the profile returns the system prompt
        // unchanged (silent fail-closed).
        const resolved = deps.resolveAgent(permit.sessionID);
        const agent =
          resolved === undefined
            ? undefined
            : deps.composed.agents.find(
                (candidate) => candidate.name === resolved,
              );
        return {
          systemPrompt:
            agent === undefined
              ? evt.systemPrompt
              : `${applyModelVariant(agent.prompt, resolveContextModelId(ctx), agent.promptVariants)}\n\n${evt.systemPrompt}`,
        };
      });
    },
    async sessionStart(evt?, ctx?) {
      // The real start notice: pi's own reason reaches the start hooks
      // unmodified.  It is a lifecycle control entry, so it runs whether or
      // not the session business below is admitted.
      await deps.startSession(evt, ctx);
      await deps.runSession(ctx, (permit) => {
        sessionContexts.bind(permit.sessionID, ctx);
        // Trim the session's active tool set by its primary's denies at
        // bind time (startup / reload / resume / replacement), so the deny
        // list takes effect from the first turn — before the /<agent>
        // switch path or a /go handoff would otherwise be the first place
        // it applied.  `before_agent_start` runs it again as a fallback
        // (idempotent).
        deps.applyPrimaryToolTrim(permit.sessionID);
        // Register the fleet widget at session startup / resume (before any
        // LLM turn), so the current primary shows immediately.
        // `before_agent_start` runs the same registration as a fallback.
        deps.registerFleetWidget(permit.sessionID);
        // Seed the widget's todo column from this session's plan; the store
        // read is async, so the column appears once it resolves.
        deps.refreshTodoView(permit.sessionID);
        // A fresh session (re)bind starts with a clean prompt-depth count:
        // if a `ui_prompt_end` was ever dropped (extension reload
        // mid-prompt, host-side cancellation), a stale positive count would
        // misclassify every later settle as `awaiting-input` and silently
        // disable the loop for the rest of the process.
        if (deps.engine !== undefined) uiPromptDepths.delete(permit.sessionID);
        // Rebuild the run registry from the session's persisted message
        // history.  The registry is process-level state, so a pi exit wipes
        // it; on restore / resume this rescans the session's `subagent` tool
        // calls (via `buildContextEntries()`) and rewrites the registry, so
        // the fleet widget keeps showing historical subagent runs.  The
        // rebuild is recursive: each finished run's `details.sessionPath`
        // points at its sub-session file, which is rescanned for nested
        // delegations (beaver → lynx → ...), reconstructing the full
        // parent/child tree.  A missing / unreadable sub-session file skips
        // only that branch (warn).  Idempotent: run ids are the pi run ids
        // and the registry's terminal-immutability rule never duplicates or
        // overwrites an existing entry.  Best-effort: an unavailable session
        // manager / history leaves the registry untouched (fresh session).
        // The transcript read comes from this event's own context, never
        // from another session's bound context.
        const sessionManager = (ctx as PiToolHostContext | undefined)
          ?.sessionManager;
        if (typeof sessionManager?.buildContextEntries === "function") {
          try {
            // Call as a method: extracting the function reference unbinds
            // `this`, and pi's SessionManager.buildContextEntries reads
            // `this.getEntries()` — an unbound call crashes at runtime.
            const entries =
              sessionManager.buildContextEntries() as PiHistoryEntry[];
            rebuildSubagentRuns(entries, permit.sessionID);
          } catch (err) {
            log.warn({
              hook: "plugin",
              event: "registry_rebuild_failed",
              sessionId: permit.sessionID,
              error: String(err),
            });
          }
        }
        deps.refreshFleetWidget(permit.sessionID);
      });
    },
    async resourcesDiscover(_evt?, ctx?) {
      return deps.runSession(ctx, (permit) => {
        sessionContexts.bind(permit.sessionID, ctx);
        // Filter the contributed skill directories by this session's
        // primary `[agent.<name>].permission.skill` rules.  The filter
        // applies at session-bind time against the primary resolved AT THAT
        // MOMENT (a replacement session resolves the switch target from the
        // pending slot) —
        // pi's `resources_discover` fires once per session bind and its
        // results are merge-only (cannot be retracted mid-session), so a
        // later runtime `/mola` switch does NOT re-filter the
        // already-contributed skills (accepted pi limitation).  When no
        // primary is configured, or the primary has no skill rules, the
        // full profile list is contributed unfiltered (machinery-off
        // behaviour unchanged, consistent with `before_agent_start`).
        const primary = deps.resolveAgent(permit.sessionID);
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
      });
    },
    async toolResult(event, ctx) {
      return deps.runSession(ctx, async (permit) => {
        sessionContexts.bind(permit.sessionID, ctx);
        const result = await toolResultHandler(event, ctx);
        // A successful `todo` call changed this session's plan: refresh the
        // widget's todo view after the existing chain has run, without
        // touching its result.  Other tools and error results leave the
        // cache alone.
        if (event.toolName === "todo" && !event.isError) {
          deps.refreshTodoView(permit.sessionID);
        }
        return result;
      });
    },
    contextHandler: async (event, ctx) =>
      deps.runSession(ctx, (permit) => {
        sessionContexts.bind(permit.sessionID, ctx);
        return contextHandler(event, ctx, permit.sessionID, permit);
      }),
    messageEnd: async (event, ctx) =>
      deps.runSession(ctx, (permit) => {
        sessionContexts.bind(permit.sessionID, ctx);
        return messageEndHandler(event, ctx);
      }),
    async toolCall(event, ctx?) {
      return deps.runSession(ctx, async (permit) => {
        sessionContexts.bind(permit.sessionID, ctx);
        const gate = deps.composed.gate;
        // No strategy (valid profile) → allow.  The key is not registered
        // in that case; this guard keeps a direct call inert too.
        if (gate === null) return undefined;
        // Only the delegation tool is gated; every other tool call passes
        // through untouched (the gate belongs to the delegation path).
        if (event.toolName !== "subagent") return undefined;
        // A non-string field is left undefined so the inner tool's own
        // argument validation reports it (the wrapper's boundary
        // semantics).
        const raw =
          event.input && typeof event.input === "object" ? event.input : {};
        const target = typeof raw.agent === "string" ? raw.agent : undefined;
        const prompt = typeof raw.prompt === "string" ? raw.prompt : undefined;
        // The caller comes from the identity resolver only when at least
        // one judge needs it; otherwise it is left undefined (OpenCode
        // parity).  An unresolvable caller stays `undefined`, which the
        // judge refuses (fail-closed).
        const caller = deps.composed.gateNeedsCaller
          ? await deps.resolveCallerAgent(permit.sessionID)
          : undefined;

        const refusal = gate({ caller, target, prompt });
        if (refusal === null) return undefined;
        log.warn({
          hook: "subagent-tool",
          event: "delegation_blocked",
          sessionId: permit.sessionID,
          caller: caller ?? null,
          target: target ?? null,
          judge: refusal.judge,
          reason: refusal.reason,
        });
        return { block: true, reason: refusal.reason };
      });
    },
    async sessionTree(_evt?, ctx?) {
      await deps.runSession(ctx, (permit) => {
        sessionContexts.bind(permit.sessionID, ctx);
        // Tree navigation (`/tree`) moves the active leaf to another
        // branch, so the transcript the todo store restores from has
        // changed: drop this session's cached state and let the next `todo`
        // call re-scan.  No-ops when this factory execution owns no store
        // (a host with no todo restore path — the tool never registered).
        deps.invalidateTodo(permit.sessionID);
        // Re-read the invalidated cache so the widget shows the branch the
        // navigation moved to.
        deps.refreshTodoView(permit.sessionID);
      });
    },
    hasSettledHandlers: deps.engine !== undefined,
    hasGateHandlers: deps.composed.gate !== null,
    async sessionShutdown(evt?, _ctx?) {
      // pi replaces its extension runtime (quit / reload / new / resume /
      // fork), so the whole scope stops: nested sessions first, then the
      // extension services.  The event context is stale from here on, so it
      // is deliberately NOT bound to the session contexts — no handler may
      // write session resources after the scope stopped.  The stop is a
      // lifecycle control entry: no permit governs it.
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
    async agentEnd(evt?, ctx?) {
      // Passive record only: the judge runs at the pre-settle boundary.  The
      // loop is inert without a settle strategy (the settle events are never
      // registered), and this guard keeps a direct call (tests) inert too.
      if (deps.engine === undefined) return;
      await deps.runSession(ctx, (permit) => {
        sessionContexts.bind(permit.sessionID, ctx);
        // The run's terminal messages feed the boundary judge.  An
        // unreadable payload records an empty run, which yields no activity
        // and no handback fact (silence is the todo list's call, not the
        // transcript's).
        const raw = (evt as { messages?: unknown } | undefined)?.messages;
        lastRunMessages.set(permit.sessionID, Array.isArray(raw) ? raw : []);
      });
    },
    async beforeSettle(evt?, ctx?) {
      // Same registration gate as `agent_end`: no strategy, no judge.
      if (deps.engine === undefined) return {};
      const engine = deps.engine;
      // A loop judge must never break the host session, and a stale
      // extension context (pi invalidates one on session replacement /
      // reload) can make even reading `sessionManager` throw.  Isolate the
      // whole body: log and fail closed.
      let sessionID: string | undefined;
      try {
        const result = await deps.runSession<PiBoundaryResult>(
          ctx,
          async (permit) => {
            sessionID = permit.sessionID;
            sessionContexts.bind(permit.sessionID, ctx);
            // pi computes the outcome from the run's terminal stop reason, so
            // it is the host's own verdict: only a run that completed may
            // wake.  An aborted run's terminal message is often recorded as
            // `stopReason: "error"` (a user Esc), so re-deriving the outcome
            // from the transcript misclassified it as settled; pi reports it
            // as `outcome: "error"` here, and pi does not fire this boundary
            // at all for a user abort.
            const outcome = readActivityOutcome(evt);
            // Derive the settled turn's facts from the messages `agent_end`
            // recorded: whether it made any tool call at all.  An unreadable
            // transcript, or one with no assistant message, simply yields no
            // activity — silence is NOT implied by it: the todo list is the
            // authority on wakefulness, and the engine consults `hadActivity`
            // only while the session's awaiting-progress lock is held.  A
            // fresh settle with no prior wake is judged against the list
            // regardless of activity.
            const turn = settledTurnMessages(
              lastRunMessages.get(permit.sessionID) ?? [],
            );
            const hadActivity = countTurnToolCalls(turn) > 0;
            // A headless ask could not reach the user (no UI to draw on), so
            // the turn ends with the question unanswered: stop and let the
            // user read it after the process exits rather than
            // auto-continuing into unwanted work.
            const askUnanswered = askWentUnanswered(turn);
            const cause: StopCause =
              outcome !== "completed"
                ? "aborted"
                : (uiPromptDepths.get(permit.sessionID) ?? 0) > 0 ||
                    askUnanswered
                  ? "awaiting-input"
                  : "settled";
            log.debug({
              hook: "loop",
              event: "settle_received",
              sessionId: permit.sessionID,
              cause,
              outcome,
              hadActivity,
            });
            // Only the orchestrator session is continued; a delegated child
            // session is driven by its own agent and must not be woken by
            // the root extension.
            if (deps.fixedAgent !== undefined) {
              log.debug({
                hook: "loop",
                event: "settle_skipped",
                sessionId: permit.sessionID,
                reason: "subagent",
              });
              return {};
            }
            // `hadActivity` is derived above from the settled turn's tool
            // calls; the engine's interlocks and the todo strategy's gates
            // decide the rest.
            const decision = await engine.run({
              sessionID: permit.sessionID,
              cause,
              hadActivity,
            });
            if (decision === null) return {};
            // Count BEFORE returning the entry, mirroring the OpenCode host:
            // once pi adopts the boundary result the verdict has taken
            // effect, so the wake must already be counted — re-judging this
            // settle must not produce a second reminder.  pi commits the
            // entry and runs the continuation within this run, so the verdict
            // and its effect cannot diverge and no queued reminder outlives
            // the run that produced it.
            engine.record(permit.sessionID, decision.name);
            log.info({
              hook: "loop",
              event: "wake_injected",
              sessionId: permit.sessionID,
              handler: decision.name,
              used: engine.used(permit.sessionID, decision.name),
            });
            return {
              entries: [
                ...boundaryEntries(evt),
                {
                  type: "custom_message",
                  customType: "zoo-loop-wake",
                  content: decision.text,
                  // Shown in the TUI so the user can see the loop wake fire;
                  // the model receives it as a user-role message either way
                  // (pi converts custom messages via convertToLlm).
                  display: true,
                },
              ],
              continue: true,
            };
          },
        );
        // No admitted session to attribute the reminder to → fail closed.
        if (result === undefined) {
          log.debug({
            hook: "loop",
            event: "settle_skipped",
            reason: "no-session",
          });
        }
        return result ?? {};
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
    async agentSettled(_evt?, ctx?) {
      await deps.runSession(ctx, (permit) => {
        sessionContexts.bind(permit.sessionID, ctx);
        // A single-shot host can exit right after the last run, before the
        // periodic flush timer fires; make the verdict durable.
        flushLogs();
      });
    },
    async uiPromptStart(_evt?, ctx?) {
      await deps.runSession(ctx, (permit) => {
        sessionContexts.bind(permit.sessionID, ctx);
        uiPromptDepths.set(
          permit.sessionID,
          (uiPromptDepths.get(permit.sessionID) ?? 0) + 1,
        );
      });
    },
    async uiPromptEnd(_evt?, ctx?) {
      await deps.runSession(ctx, (permit) => {
        sessionContexts.bind(permit.sessionID, ctx);
        const depth = uiPromptDepths.get(permit.sessionID) ?? 0;
        if (depth > 0) uiPromptDepths.set(permit.sessionID, depth - 1);
      });
    },
  };
}
