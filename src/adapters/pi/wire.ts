/**
 * Pi host wiring — capability provision, registration, and the loop engine.
 *
 * Turns the `zoo` config into the pi-facing wiring: the host capability
 * provision the shared composition service consumes
 * (`buildPiCapabilities`), the session → agent resolver
 * (`buildPiResolveAgent`), the profile skill-directory lookup
 * (`collectSkillPaths`), and the preparation of a start (`preparePiStart`)
 * — the host services the lifecycle kernel creates (see `services.ts`: the
 * session contexts, the adapter, the tool host built on the contexts, the
 * todo and profile catalogs, the tool baselines, the fleet surface, the
 * switch surface, the capability provision, the assembled profile), the
 * loop engine over the composed contributions, the event handlers, and the
 * tool / command / renderer registrations pi receives.
 *
 * This module performs no pi host call: a start is prepared here and
 * published by `publisher.ts`, so every fallible step completes before the
 * first host write.
 *
 * The entry point activates the extension scope BEFORE composing, so the
 * provision receives extension-scope ports the kernel owns.  Session
 * scopes come into existence only when an event names a session.
 *
 * The fourteen event handlers themselves are built by
 * `createPiEventHandlers` (see `handlers.ts`); this module only supplies
 * their wiring surfaces.
 *
 * The pieces the composition and the loop engine need are lifecycle
 * services too (see `services.ts`): the `capabilities` service builds the
 * provision over the extension-scope ports, the `composition` service
 * assembles the profile over that provision through the shared core
 * service, and the `loop` service builds the engine over the composed
 * settle strategies.  Both `preparePiStart` and the per-session scopes
 * read them from the extension scope, so no host code has to hand a
 * session its loop resources.
 *
 * @module
 */

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { ASK_TOOL_NAME } from "../../core/ask.js";
import { configCapabilities } from "../../core/capabilities.js";
import type { HostAdapter } from "../../core/context/lens.js";
import {
  type ContextRuntime,
  createContextRuntime,
} from "../../core/context/runtime.js";
import type { CleanupReport, WorkPermit } from "../../core/lifecycle/index.js";
import type { QuestionChannelProvider } from "../../core/ports/ask.js";
import type { Capabilities } from "../../core/ports/index.js";
import type { SwitchHost } from "../../core/ports/switch.js";
import type { ToolHost } from "../../core/ports/tool-host.js";
import { originAgent, type RuntimeOrigin } from "../../core/runtime.js";
import {
  createSessionAgentResource,
  type SessionAgentRegistry,
} from "../../core/session/agent.js";
import {
  contextSessionResources,
  createSessionResourceCatalog,
} from "../../core/session/resources.js";
import { scanSkillDirectories } from "../../core/skills.js";
import type { SubagentDriver } from "../../core/subagent/driver.js";
import type {
  RunRegistry,
  RunScope,
  RunSnapshot,
} from "../../core/subagent/registry.js";
import { todoSourceFromStore } from "../../core/todo/source.js";
import type { ToolCallContext, ToolContribution } from "../../core/unit.js";
import { loadHtmlConverter } from "../../core/webfetch/native.js";
import type { HtmlConverter } from "../../core/webfetch/pipeline.js";
import { log } from "../../utils/logger.js";
import { createPiAdapter } from "./adapter.js";
import { createPiQuestionChannel } from "./ask-form.js";
import type { PiProcessScope } from "./config.js";
import { createPiEventHandlers } from "./handlers.js";
import { createPiHandoffTarget, type PiCommandCtx } from "./handoff-target.js";
import type { PiLifecycleContext } from "./lifecycle.js";
import {
  createPiLifecycleWiring,
  type PiLifecycleWiring,
  type PiSessionWorkRunner,
  SDK_STOP_REASON,
} from "./lifecycle-wiring.js";
import { createPiMessageInjector } from "./message-injector.js";
import type { PiProcessState } from "./process.js";
import {
  applyToolDefinitionContributions,
  buildPiCommandRegistrationPlan,
} from "./registration.js";
import { createPiHostServices, type PiCapabilities } from "./services.js";
import { createPiSubagentDriver } from "./subagent.js";
import { createPiHandoffIdentity } from "./switch-host.js";
import { mergeTerminalToolDetails, truecolorWrap } from "./terminal-details.js";
import { withAskVisibility } from "./tool-availability.js";
import {
  buildSubagentCardRenderer,
  buildTodoCardRenderer,
} from "./tui/index.js";
import { buildPiNoticeEntryRenderer } from "./tui/notice.js";
import type {
  ExtensionAPI,
  PiCommandContext,
  PiEventHandlers,
} from "./types.js";

// realpathSync follows the symlink to the real module location, so the
// computed skill paths resolve into the project directory even when the
// extension is loaded through pi's auto-discovery symlink.
const __dirname = dirname(realpathSync(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Profile-driven composition
// ---------------------------------------------------------------------------

/**
 * The explicit facts the pi identity resolver reads.
 *
 * Every fact names a session-owning scope the host knows directly.  None of
 * them is ambient: the resolver never infers an identity from whichever
 * event happened to run last, so two sessions that interleave cannot
 * exchange identities.
 */
export interface PiAgentSources {
  /** The session → agent bindings of this process. */
  readonly sessionAgents: SessionAgentRegistry;
  /** The subagent run records of this process. */
  readonly runs: RunRegistry;
  /**
   * The agent this runtime's factory fixed, or `undefined` in a main
   * runtime.  A sub-session runtime is built for exactly one delegation, so
   * its fixed agent answers every session of that runtime — including
   * events that precede the run's first progress report.
   */
  fixedAgent?: string;
  /**
   * The orchestrator the selection resolved, or `undefined` when it
   * resolved none.  Read lazily: the resolver is built before the planner
   * runs.  This is the main-session answer.
   */
  orchestrator: () => string | undefined;
}

/**
 * Build the session → agent resolver for the pi host.
 *
 * The answer comes from explicit sources only, in this order:
 *  (a) the shared session agent registry — an existing binding wins, which
 *      includes the target a switch replacement bound at its own
 *      `session_start`;
 *  (b) the fixed agent of this runtime (a sub-session runtime built for one
 *      delegation) — the answering source for a sub-session's own events;
 *  (c) reverse lookup by session id in the subagent run registry — a
 *      session recorded as some run's `childSession` is driven by that
 *      run's delegated agent;
 *  (d) the orchestrator the selection resolved — the main-session answer.
 *
 * Every answer except an absent orchestrator is bound into the shared
 * registry, so later lookups hit it in O(1).  A memo never goes stale: a
 * childSession belongs to exactly one run, a run's `agent` is fixed at
 * creation, and a runtime's fixed agent outlives the runtime.  A pending
 * switch target is never a source: only the replacement's own
 * `session_start` claims it (see `switch-host.ts`), so a resolver answer
 * never applies one session's target to another.  With no source
 * answering, the session resolves to `undefined` (fail-closed, unbound).
 *
 * @param sources - The explicit identity facts of this runtime: the process
 *   state's two stores and this runtime's own facts.
 * @returns The resolver handed to `Capabilities.resolveAgent`.
 */
export function buildPiResolveAgent(
  sources: PiAgentSources,
): (sessionID: string) => string | undefined {
  const { sessionAgents, runs } = sources;
  return (sessionID: string): string | undefined => {
    const known = sessionAgents.resolve(sessionID);
    if (known !== undefined) return known;
    const fixed = sources.fixedAgent;
    if (fixed !== undefined) {
      sessionAgents.bind(sessionID, fixed);
      return fixed;
    }
    const run = runs.findByChildSession(sessionID);
    if (run !== undefined) {
      sessionAgents.bind(sessionID, run.agent);
      return run.agent;
    }
    const orchestrator = sources.orchestrator();
    if (orchestrator === undefined) return undefined;
    sessionAgents.bind(sessionID, orchestrator);
    return orchestrator;
  };
}

// ---------------------------------------------------------------------------
// Native fetch converter
// ---------------------------------------------------------------------------

/**
 * Loader for the native HTML→Markdown converter.
 *
 * The pi entry point supplies one; the assembly probes it once, before
 * the selection pass, and binds the loaded converter as a value.
 */
type HtmlConverterLoader = () => HtmlConverter | null;

/**
 * Probe the native HTML→Markdown converter for the fetch tool.
 *
 * Fail-closed in the pi host adapter: when the addon is unavailable
 * (wrong platform, ABI mismatch, not built) the core loader returns
 * `null`, a single warn is logged (`converter_unavailable`), and the host
 * declares no `htmlConverter` capability — so the fetch tool unit's needs
 * are unmet and the planner skips it (matching the null-profile
 * principle: a capability that cannot run contributes nothing).  The
 * probe answers a static availability question; a failing fetch at
 * runtime is never treated as unavailability.
 *
 * @param loadConverter - Loader for the native converter. Defaults to
 *   {@link loadHtmlConverter}; tests inject a stub.
 * @returns The converter, or `null` when unavailable.
 */
export function loadPiHtmlConverter(
  loadConverter: HtmlConverterLoader = loadHtmlConverter,
): HtmlConverter | null {
  const converter = loadConverter();
  if (converter === null) {
    log.warn({ hook: "fetch-tool", event: "converter_unavailable" });
    return null;
  }
  return converter;
}

/**
 * Build the pi host's capability provision.
 *
 * The shared composition service consumes this provision: it binds these
 * values, materialises the profile and returns the host-agnostic assembly
 * (see `core/composition.ts`).  pi composes every category and consumes the
 * agent, skill, after-exec, transform, and command slots (the
 * `unknown_unit` warning fires when a profile name has no matching registry
 * unit).  `Capabilities` are adapted to the pi host: `client` is empty,
 * `directory` is the process working directory, and `resolveAgent`
 * identifies each session through the shared session agent registry
 * (subagent child sessions → their delegated agent, the root session → the
 * orchestrator the composition resolved; see `buildPiResolveAgent`).  The
 * host adapter / tool host are taken from `hostDeps` (the entry point
 * supplies the kernel-created services).
 *
 * The session resolver depends on the orchestrator a selection pass
 * resolves, so this provision adopts every finished selection: the role
 * state lives here, in the runtime's own provision, and the composition
 * never depends back on it.  An unresolved role is adopted as `undefined`,
 * so an unbound session stays unresolved (fail-closed).
 *
 * Exported for unit testing — `zookeeperPi` wires this with the scope of
 * its configuration generation.
 *
 * @param scope - The configuration generation this provision belongs to.
 * @param processState - The process state this runtime runs over: the identity
 *   and run stores every generation of this process shares.
 * @param hostDeps - Optional host ports (the entry point passes the
 *   extension-scope services the kernel created).
 * @returns The capability provision and the instance's session resolvers.
 */
export function buildPiCapabilities(
  scope: PiProcessScope,
  processState: PiProcessState,
  hostDeps?: {
    /**
     * The context records of this extension instance.  The entry point
     * passes the instance's own runtime; a composition built without one
     * (a unit test) gets a private one, so two compositions never share
     * session state.
     */
    contextRuntime?: ContextRuntime;
    adapter?: HostAdapter<unknown>;
    toolHost?: ToolHost;
    switchHost?: SwitchHost;
    /** The command context of one session, or undefined when it has none. */
    getCommandCtx?: (sessionID: string) => PiCommandCtx | null | undefined;
    /**
     * The agent this runtime's factory fixed (a sub-session runtime), or
     * absent in a main runtime.  Every session of a sub-session runtime is
     * the delegation it was built for.
     */
    fixedAgent?: string;
    /**
     * Host user-message injector for the `/debug` command (only supplied
     * by the real pi entry point).  Undefined without it — `/debug`
     * reports the Case was created but could not auto-start.
     */
    messageInjector?: Partial<Capabilities>["messageInjector"];
    /**
     * The run scope of this runtime.
     *
     * The subagent tool writes every delegation through it, so the runtime's
     * stop ends exactly the runs this runtime started.  Absent in a bare
     * composition (a unit test): the subagent tool then contributes nothing.
     */
    runs?: RunScope;
    /**
     * Host subagent driver (only supplied by the real pi entry point).
     * Undefined without it — the subagent tool unit then contributes no
     * tools (fail-closed, matching OpenCode).
     */
    subagentDriver?: SubagentDriver;
    /**
     * todo port the composition reads (only on the pi host).  Built by the
     * host's extension-scope service over its own transcript scan; it is a
     * routing catalog, so the todo tool unit and the progress hooks reach
     * the store of the session a call names without holding one session's
     * state.  Undefined without it — the todo tool unit contributes no
     * tools (fail-closed, the subagent precedent), so `todo` never
     * registers on a host that cannot restore todo state from its
     * transcript.
     */
    todoStore?: Partial<Capabilities>["todoStore"];
    /**
     * Lazily supplies the host's full untrimmed tool-name baseline for
     * subagent capability computation.  The baseline cannot be captured at
     * extension-load time (pi forbids calling action methods then), so the
     * supplier is invoked lazily on first subagent execution and cached.
     */
    subagentBaseline?: () => string[] | undefined;
    /**
     * Test seam: workspace root the auto-debug strategy scans for Cases.
     * Defaults to the process working directory on the real host.
     */
    directory?: string;
    /** Test seam: `zdebug` runner for the auto-debug strategy. */
    zdebugExec?: Partial<Capabilities>["zdebugExec"];
    /**
     * Native HTML→Markdown converter loader for the fetch tool (only
     * supplied by the real pi entry point).  The assembly probes it once,
     * before selection, and only for an active profile (a `null` profile
     * selects nothing, so it is never probed); the loaded converter is
     * bound by value, and undefined (or a `null` probe result) declares no
     * `htmlConverter`, so the fetch tool unit is skipped (fail-closed,
     * matching OpenCode).
     */
    loadHtmlConverter?: HtmlConverterLoader;
    /**
     * Host head truncator for the fetch tool (only supplied by the real pi
     * entry point).  Undefined without it — the fetch tool unit is skipped
     * (fail-closed, matching OpenCode).
     */
    truncateHead?: Partial<Capabilities>["truncateHead"];
    /**
     * Question-channel provider of this runtime (supplied by the handler
     * wiring, which also hands it to the execution bridge and the
     * visibility rule).  Undefined without it — the ask tool unit
     * contributes no tools (fail-closed, matching OpenCode).
     */
    askQuestionChannel?: Partial<Capabilities>["askQuestionChannel"];
  },
): PiCapabilities {
  const { modeProfile, askConfig, subagentModels } = scope.snapshot;

  // The orchestrator the composition resolves, read lazily by the session
  // resolver: the resolver exists before the composition pass runs.
  let selectedOrchestrator: string | undefined;
  // The one session → agent resolver of this runtime.  Event handlers, the
  // subagent tool's caller resolution and the primary trim all read it, so
  // every surface answers a session the same way.
  const resolveAgent = buildPiResolveAgent({
    sessionAgents: processState.sessionAgents,
    runs: processState.runs,
    ...(hostDeps?.fixedAgent === undefined
      ? {}
      : { fixedAgent: hostDeps.fixedAgent }),
    orchestrator: () => selectedOrchestrator,
  });
  // The caller resolver the delegation gate and the subagent tool read: the
  // same session resolver, attributed by the session id the call names.
  const resolveCallerAgent = async (
    sessionID: string,
  ): Promise<string | undefined> => resolveAgent(sessionID);

  // Probe the native HTML→Markdown converter BEFORE the selection pass,
  // and only for an active profile: a `null` profile selects nothing, so
  // probing there would only emit a spurious `converter_unavailable`
  // warning.  The probe runs once, at assembly time: a `null` result
  // (missing addon, wrong platform, ABI mismatch) declares no
  // `htmlConverter` key, so the fetch tool unit's `needs` are unmet and the
  // planner skips it.  Availability is decided here and never by a runtime
  // fetch failure.
  const htmlConverter =
    modeProfile === null ? null : (hostDeps?.loadHtmlConverter?.() ?? null);

  // The context records of this composition: one runtime per plugin
  // instance, so two instances never share state.
  const contextRuntime = hostDeps?.contextRuntime ?? createContextRuntime();

  const values: Partial<Capabilities> = {
    ...configCapabilities(scope.snapshot),
    askTimeoutSeconds: askConfig?.timeoutSeconds,
    switchHost: hostDeps?.switchHost,
    // The pi subagent driver (in-process SDK session execution).  Only the
    // real pi entry point supplies one; unit tests and other hosts omit it
    // so the subagent tool never registers (fail-closed).
    subagentDriver: hostDeps?.subagentDriver,
    // The run records of this runtime: the subagent tool writes each
    // delegation into its own scope, so the runtime's stop ends only its
    // own runs.
    runs: hostDeps?.runs,
    // The todo port (pi host only).  The extension-scope service provides
    // a routing catalog; without it the todo tool unit is skipped
    // (fail-closed).
    todoStore: hostDeps?.todoStore,
    // The todo read port the progress hooks consume.  pi has no SDK client
    // to read todos from, so the port is bound to the same catalog the
    // todo tool uses.  The catalog's session stores are released with
    // their session scopes, so an unbound session is read through the
    // transcript without being cached.  Absent without a catalog: the
    // nudge hooks keep firing without the todo reminder, and the
    // continuation hook degrades to an empty list (fail-closed in both
    // cases).
    todoSource:
      hostDeps?.todoStore === undefined
        ? undefined
        : todoSourceFromStore(hostDeps.todoStore),
    // The full untrimmed tool baseline for subagent capability
    // computation, passed through as a thunk: the unit invokes it inside
    // `execute`, which is always post-load, so the supplier (pi's
    // `getActiveTools`, forbidden during extension loading) never runs at
    // assembly time.
    subagentBaseline: hostDeps?.subagentBaseline,
    // The per-agent model map for subagent sessions, materialised by the
    // installer into `~/.pi/agent/agents.json` as `{provider, model}`
    // pairs (mapped values are concatenated `"provider/model"` strings).
    // Read once per configuration generation by the entry point (fail-closed
    // to empty when missing/invalid); strict mode: this map is the sole
    // model source — the subagent tool errors (never inherits or falls
    // back) when the target agent's entry is absent.
    subagentModels,
    // The probed converter, bound by value.  `null` here means the addon
    // is unavailable or no profile is active; either way no key is
    // declared.
    htmlConverter: htmlConverter ?? undefined,
    // The host head truncator for the fetch pipeline.  Absent without it
    // (fail-closed, paired with the converter).
    truncateHead: hostDeps?.truncateHead,
    // The ask tool's question-channel provider.  Without it the ask tool
    // unit is skipped (fail-closed, so `ask` never registers on
    // OpenCode).
    askQuestionChannel: hostDeps?.askQuestionChannel,
    // pi has no SDK client: the context-pruning transform runs and
    // returns the pruned replacement to pi.  The release notification
    // does not need a client: it posts through the unified pi tool
    // host's `notify` port as a `zoo-notice` appendEntry entry.  The
    // marking producers (dedup / purge-errors) have no
    // user-visible notification on pi.
    zdebugExec: hostDeps?.zdebugExec,
    contextRuntime,
    directory: hostDeps?.directory ?? process.cwd(),
    resolveCallerAgent,
    toolHost: hostDeps?.toolHost,
    // The `/debug` startup injector: sends a model-visible user message
    // into the current session.  Only the real pi entry point supplies it.
    messageInjector: hostDeps?.messageInjector,
    // Native pi host adapter.  The pi adapter names no session of its
    // own: the entry paths pass the session id to the transform.  A
    // unit test that only inspects the composed shape gets the same
    // adapter.
    adapter: hostDeps?.adapter ?? createPiAdapter(),
    // The `/go` handoff target.  `getCommandCtx` resolves the command
    // context of the parentage session the command handler bound when it
    // was admitted.  Built from host facts only — the executor agent
    // travels with each handoff call, so the target is the same for
    // every selection.
    handoffTarget: createPiHandoffTarget({
      getCommandCtx: (sessionID) => hostDeps?.getCommandCtx?.(sessionID),
      identity: createPiHandoffIdentity(processState),
    }),
    // The one session → agent resolver of this runtime: the composition
    // binds it as a capability and the wiring reads it from this
    // provision, so every surface answers a session the same way.
    resolveAgent,
  };

  return {
    values,
    // Adopt the role a composition pass resolved.  An unresolved role
    // stays `undefined`, so an unbound session fails closed instead of
    // borrowing another agent's prompt.
    adopt: (selection) => {
      selectedOrchestrator = selection.orchestrator;
    },
    resolveAgent,
    resolveCallerAgent,
  };
}

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

/**
 * Collect the absolute paths of the profile-listed skill directories.
 *
 * pi's `loadSkillsFromDir` discovers a skill when a directory contains
 * SKILL.md.  A skill registers only when its directory name appears in
 * `profileSkills` AND the directory actually exists under skills/
 * (mirroring the OpenCode preparation's fail-closed scan).  The
 * scan itself is shared with OpenCode (`scanSkillDirectories`); this
 * wrapper only supplies the base directory resolved from pi's module
 * location.
 *
 * @param profileSkills - Skill directory names declared by the profile.
 * @returns Absolute paths of the existing, profile-listed directories.
 */
export function collectSkillPaths(profileSkills: string[]): string[] {
  const skillsDir = resolve(__dirname, "../../../skills");
  return scanSkillDirectories(skillsDir, profileSkills);
}

// ---------------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------------

/** The result shape pi's tool bridge returns to the host. */
export interface PiToolBridgeResult {
  /** The tool's model-facing content parts. */
  content: { type: "text"; text: string }[];
  /** The persisted structured payload. */
  details: Record<string, unknown>;
}

/**
 * The content-free repaint signal handed to pi's `onUpdate`.
 *
 * pi re-invokes a live tool card's renderer whenever a partial result
 * arrives, and the card body projects its own state — never the partial
 * payload — so a repaint sends this empty partial.  The `content` array is
 * always empty; no text ever streams through it.
 *
 * Forward-compat dependency: the signal relies on the pi SDK's current
 * partial handling, where any partial (even an empty one) triggers a
 * re-render.  If a future pi version filters out empty partials as no-ops,
 * the live card would freeze again — the signal would then need whatever
 * payload that pi still re-renders on.
 */
interface PiRepaintSignal {
  /** The partial content pi re-renders on — always empty. */
  content: [];
}

/** The pi partial-result callback of one tool call. */
type PiOnUpdate = (partial: PiRepaintSignal) => void;

/**
 * Build pi's `execute` bridge for one composed tool.
 *
 * Every call is admitted for the session its own tool context names: the
 * whole execution runs under the issued permit, so a call that arrives
 * without a session, after the session stopped, or with a cancelled caller
 * runs no tool at all.  The permit's signal replaces pi's native one, so
 * the tool stops when the session or the extension stops.  The native
 * surface reaches the tool as a host-neutral call context — never as the
 * pi object — and the tool's structured result is mapped back onto pi's
 * `content` / `details` shape.
 *
 * @param tool - The composed tool contribution.
 * @param run - The lifecycle admission surface.
 * @param publish - Binds a tool call's context under its session id.
 * @param questionChannel - Builds the call's question channel from pi's
 *   own context, or omits it when pi cannot ask.
 * @param runs - The run records of this process (the terminal details read
 *   the run the call id names).
 * @returns The bridge pi registers for the tool.
 */
export function buildPiToolExecute(
  tool: ToolContribution,
  run: PiSessionWorkRunner,
  publish: (sessionID: string, ctx: unknown) => void,
  questionChannel: QuestionChannelProvider,
  runs: RunRegistry,
): (
  toolCallId: unknown,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<PiToolBridgeResult> {
  return async (toolCallId, params, signal, onUpdate, ctx) => {
    // pi's native signal is this call's caller cancellation; it revokes
    // this call's permit only, never another call's.
    const caller = signal instanceof AbortSignal ? signal : undefined;
    const result = await run.runSession(
      ctx,
      async (permit) => {
        // A tool call may be the first event that observes the session
        // (flows without a `session_start`), and every session-scoped
        // reader — the todo transcript scan, the session's fleet ui —
        // resolves the context by session id.
        publish(permit.sessionID, ctx);
        const channel = questionChannel(ctx);
        const repaint =
          typeof onUpdate === "function" ? (onUpdate as PiOnUpdate) : undefined;
        // The native surface is translated here: the tool-call id (the
        // run's registry id for the fleet widget), the permit whose signal
        // replaces pi's native one, a content-free repaint request, and the
        // question channel.  The sub-session model is NOT forwarded —
        // strict mode reads the agents.json configured model only (never
        // the parent session's model).
        const call: ToolCallContext = {
          sessionID: permit.sessionID,
          ...(typeof toolCallId === "string" && toolCallId.length > 0
            ? { callID: toolCallId }
            : {}),
          signal: permit.signal,
          permit,
          notifyChanged: () => {
            // A UI callback must never break a run: a throwing host
            // callback is recorded and swallowed here, in the adapter.
            if (repaint === undefined) return;
            try {
              repaint({ content: [] });
            } catch (err) {
              log.warn({
                hook: "pi-tool-bridge",
                event: "notify_changed_failed",
                sessionId: permit.sessionID,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
          ...(channel !== undefined ? { questionChannel: channel } : {}),
        };
        const outcome = await tool.execute(params, call);
        return {
          content: [{ type: "text" as const, text: outcome.text }],
          // The tool's payload is merged INTO (never over) the bridge's own
          // details, so the run's fact pointer always survives.
          details: mergeTerminalToolDetails(toolCallId, outcome.data, runs),
        };
      },
      caller,
    );
    // A refused call never runs the tool: it reports an empty result in the
    // host's own shape.
    return result ?? { content: [], details: {} };
  };
}

/** One tool registration a pi start publishes. */
export interface PiToolRegistration {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** The JSON-Schema parameter object pi validates the arguments with. */
  readonly parameters: object;
  /** Set when pi must register the tool inactive (the ask tool). */
  readonly defaultActive?: boolean;
  /** Live transcript card renderer, for a composed tool with one. */
  readonly renderCall?: unknown;
  /** Live transcript card body renderer, paired with `renderCall`. */
  readonly renderResult?: unknown;
  /** The admitted execution bridge pi calls. */
  readonly execute: (
    toolCallId: unknown,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<PiToolBridgeResult>;
}

/** One command registration a pi start publishes. */
export interface PiCommandStart {
  readonly name: string;
  readonly description: string;
  /** The admitted handler pi invokes with pi's own command context. */
  readonly handler: (args: string, ctx: unknown) => Promise<void>;
}

/** The prepared pi start: every host write, computed and unwritten. */
export interface PiStartPrepared extends PiEventHandlers {
  /** The tool registrations publish writes, in composition order. */
  readonly tools: readonly PiToolRegistration[];
  /** The command registrations publish writes, in composition order. */
  readonly commands: readonly PiCommandStart[];
  /** The `zoo-notice` entry renderer publish registers. */
  readonly noticeRenderer: unknown;
}

/** The options of one pi start. */
export interface PiStartOptions {
  /** Subagent driver used in place of the real pi SDK driver. */
  subagentDriver?: SubagentDriver;
  /**
   * Test seam: workspace root the auto-debug strategy scans for Cases.
   * Defaults to the process working directory.
   */
  directory?: string;
  /** Test seam: `zdebug` runner for the auto-debug strategy. */
  zdebugExec?: Partial<Capabilities>["zdebugExec"];
  /**
   * Path of this host's extension file entry.  The sub-session resource
   * loader leaves it out, because the child loads ZooKeeper from the
   * inline factory instead.
   */
  entryPath?: string;
  /** Test seam: the instance's context runtime to inspect in place. */
  contextRuntime?: ContextRuntime;
  /**
   * Question-channel provider of this runtime.  The entry point leaves it
   * out to get pi's own dialog; a framework host that asks through another
   * surface (IPC, a remote UI) injects its own.  One provider feeds both
   * the ask tool's execution bridge and the tool's visibility.
   */
  askQuestionChannel?: QuestionChannelProvider;
  /**
   * Test seam: the enhancer chain applied to the composed tool definitions.
   * Defaults to the composed `tool.definition` contributions.
   */
  applyToolDefinitions?: typeof applyToolDefinitionContributions;
  /**
   * The inline extension factory a sub-session of this runtime loads.  The
   * start publisher supplies it, so a nested sub-session starts through the
   * same publisher.  Absent when the runtime holds no pi API instance: the
   * subagent tool then registers no tool (fail-closed).
   */
  childRuntime?: (
    onClose: (close: () => Promise<CleanupReport>) => void,
    agent: string,
  ) => (pi: ExtensionAPI) => Promise<void>;
}

/** The extension-scope declarations of one pi runtime instance. */
type PiExtensionDeclarations = ReturnType<
  typeof createPiHostServices
>["extension"];

/** The session-scope declarations of one pi runtime instance. */
type PiSessionDeclarations = ReturnType<typeof createPiHostServices>["session"];

/**
 * The resources one pi runtime owns before its first fallible step.
 *
 * Every member is created synchronously: the lifecycle wiring, the context
 * records and the question channel exist before the extension activates, so
 * a start that fails in any phase still has a runtime to close.
 */
export interface PiRuntimeInstance {
  /** The context records of this extension instance. */
  readonly contextRuntime: ContextRuntime;
  /** The question-channel provider this instance resolved. */
  readonly askQuestionChannel: QuestionChannelProvider;
  /** The lifecycle wiring of this instance. */
  readonly lifecycle: PiLifecycleWiring<
    PiExtensionDeclarations,
    PiSessionDeclarations
  >;
  /**
   * Stop this instance's extension scope.  pi never sends
   * `session_shutdown` for an SDK-created session, so a host that owns the
   * runtime (a subagent driver) stops the scope itself, before it disposes
   * the session.
   */
  readonly stop: () => Promise<CleanupReport>;
}

/** The explicit inputs of one pi runtime instance. */
export interface PiRuntimeInstanceInput {
  /** The configuration generation this instance belongs to. */
  readonly scope: PiProcessScope;
  /** The origin of this runtime. */
  readonly origin: RuntimeOrigin;
  /** The process state this instance runs over (shared, never created here). */
  readonly process: PiProcessState;
  /** The pi ExtensionAPI instance, or absent in a unit test. */
  readonly piApi?: ExtensionAPI;
  /** Optional host options and test seams. */
  readonly overrides?: PiStartOptions;
}

/** The inputs of one pi start. */
export interface PiStartInput extends PiRuntimeInstanceInput {
  /** The resources this runtime owns. */
  readonly instance: PiRuntimeInstance;
}

/**
 * Create the resources of one pi runtime instance.
 *
 * Declares the host services, wires them to the lifecycle kernel and binds
 * the close handle, without creating any service and without calling pi:
 * both are synchronous, so the owner exists before the first fallible step
 * of the start (the activation and the enhancer chain, see
 * `preparePiStart`).
 *
 * @param input - The generation, the origin, the pi API instance and the
 *   host options of this runtime.
 * @returns The instance resources, including the close handle.
 */
export function createPiRuntimeInstance(
  input: PiRuntimeInstanceInput,
): PiRuntimeInstance {
  const { scope, origin, process, piApi, overrides } = input;
  // The agent this runtime is fixed to: the origin is the only main/child
  // difference, so every surface below derives from it.
  const fixedAgent = originAgent(origin);
  // The single pi tool host routes every in-session chat notification
  // (tool prompts, /dcp reports, command failures) through pi's
  // `appendEntry` channel as a `zoo-notice` custom entry — persistent,
  // rendered by the entry renderer, never part of the LLM context (the
  // pi equivalent of v1's ignored noReply message).  `appendEntry` is
  // passed as a value, so it is defensively bound to the API object when
  // present (pi's current implementation is closure-based and works
  // unbound, but a future `this`-dependent implementation would silently
  // break otherwise).  The tool host service (declared below) reads it.
  const appendEntry =
    typeof piApi?.appendEntry === "function"
      ? piApi.appendEntry.bind(piApi)
      : undefined;
  // The per-agent status-bar colors (`[agent.<name>].color`) of this
  // generation.  Only the `zoo` widget text is colorized below — the tool /
  // command surfaces stay plain.
  const agentColors = scope.snapshot.agentColors;
  // The per-agent skill permission rules
  // (`[agent.<name>].permission.skill`) of this generation.
  // `resources_discover` filters the contributed skill directories by the
  // active primary's rules; an agent absent from the map (or no primary)
  // contributes unfiltered (default-allow, machinery-off unchanged).
  const skillPermissions = scope.snapshot.skillPermissions;
  // Wrap a name in a truecolor ANSI foreground sequence when the agent
  // has a configured color; otherwise return it unchanged (fail-closed).
  // pi's widget Text component preserves ANSI codes and is
  // ANSI-width-aware, so the raw escape sequences survive and render.
  const colorizeAgent = (name: string): string => {
    const hex = agentColors[name];
    if (hex === undefined) return name;
    return truecolorWrap(hex, name);
  };
  // The overlay title for a run: `<agent> · <label>` (the label when the run
  // carries one, otherwise just the agent).  Mirrors the fleet row body so
  // the inspection overlay reads as the same run the widget selected.  The
  // agent name is pre-colorized with the same `[agent.<name>].color` source
  // as the widget (`colorizeAgent`), so the title carries the run's agent
  // color; pi's Text / truncateToWidth / visibleWidth preserve ANSI codes
  // (only the collapse-preview path strips them), so the wrapped name
  // survives the overlay render verbatim.  Unconfigured → the plain name.
  const runTitle = (run: RunSnapshot): string => {
    const labelPart =
      run.label !== undefined && run.label.length > 0 ? ` · ${run.label}` : "";
    return `${colorizeAgent(run.agent)}${labelPart}`;
  };
  // Wrap any text in the run's agent truecolor sequence when the agent has a
  // configured color; `undefined` when it does not (the overlay then falls
  // back to its fixed border color — the current default).  Used for the
  // transcript overlay border so it reads as the inspected run's agent color.
  const agentBorderColorize = (
    run: RunSnapshot,
  ): ((text: string) => string) | undefined => {
    const hex = agentColors[run.agent];
    if (hex === undefined) return undefined;
    return (text) => truecolorWrap(hex, text);
  };

  // The context records of this extension instance: one runtime per
  // instance, so two instances in one process never share session state, a
  // captured model limit, a published round view, or a
  // pending-view-change flag.  The catalog declares the context records and
  // the explicit session records: the session resources service releases
  // them when the scope stops, and the session lifecycle coordinator
  // deletes them when the host deletes the session.
  const contextRuntime = overrides?.contextRuntime ?? createContextRuntime();
  const sessionCatalog = createSessionResourceCatalog([
    ...contextSessionResources(contextRuntime),
    createSessionAgentResource(process.sessionAgents),
  ]);

  // The question-channel provider of this runtime.  The ask tool's
  // execution bridge and the active-tool visibility rule read this one
  // provider, so an injected provider changes what the model sees and what
  // a call reaches alike.  pi's own dialog is the default.
  const askQuestionChannel =
    overrides?.askQuestionChannel ?? createPiQuestionChannel;

  // The host service declarations.  Every state owner the composition
  // touches — the session contexts, the adapter, the tool host built on
  // the contexts, the todo catalog, the profile catalog, the tool
  // baselines, the fleet surface and the switch surface — is a lifecycle
  // service, so the kernel creates (and stops) them.  The capability
  // provision is a service over those ports, the composition a service
  // over that provision, and the loop engine a service over the
  // composition, so no service here receives a session-scoped store.
  const declarations = createPiHostServices({
    scope,
    contextRuntime,
    sessionCatalog,
    piApi,
    appendEntry,
    colorizeAgent,
    titleForRun: runTitle,
    borderColorizeForRun: agentBorderColorize,
    process,
    capabilities: (ports) =>
      buildPiCapabilities(scope, process, {
        contextRuntime,
        runs: ports.runScope,
        adapter: ports.adapter,
        toolHost: ports.toolHost,
        switchHost: ports.switchHost.host,
        // The agent this runtime is fixed to (a sub-session runtime), so
        // the session resolver answers it without any ambient state.
        ...(fixedAgent === undefined ? {} : { fixedAgent }),
        // Test seams: workspace root and `zdebug` runner for the
        // auto-debug strategy.  Both default to the real host behaviour
        // when omitted.
        directory: overrides?.directory,
        zdebugExec: overrides?.zdebugExec,
        // The `/go` handoff target reads the command context of the
        // session it replaces: the command bridge bound that context when
        // its session admitted the command.
        getCommandCtx: (sessionID) =>
          ports.sessionContexts.commandForSession(sessionID),
        // The `/debug` startup injector sends a model-visible user message
        // through pi's `sendUserMessage`.  Only the real pi API instance
        // provides it; test-only compositions stay without one.
        messageInjector: piApi ? createPiMessageInjector(piApi) : undefined,
        // The pi subagent driver — the in-process SDK session executor.
        // Only wired when a real pi API instance is present (the extension
        // runs inside pi); test-only and driver-less compositions stay
        // closed.  A test override replaces the SDK driver with a fake so
        // bridge tests run without loading the pi SDK.  The skill seam is
        // injected from the same config/profile sources the main session's
        // `resources_discover` uses: each sub-session is seeded with the
        // skill directories its OWN `[agent.<name>.permission.skill]` rules
        // allow.  The profile catalog is read lazily, per run, so a
        // delegation that starts after composition sees the published
        // value.
        subagentDriver:
          overrides?.subagentDriver ??
          (piApi
            ? createPiSubagentDriver({
                skillPermissions,
                getProfileSkills: () => ports.profileCatalog.get(),
                collectSkillPaths,
                // The child loads ZooKeeper through the inline factory
                // captured from this composition root, and its own run
                // reports back the close handle of that runtime.
                entryPath: overrides?.entryPath,
                ...(overrides?.childRuntime === undefined
                  ? {}
                  : { createChildExtension: overrides.childRuntime }),
              })
            : undefined),
        // The todo port (pi host only).  The extension-scope catalog routes
        // every call to the store of the session the call names, so the
        // todo tool unit and the `session_tree` handler reach the state of
        // the session they belong to without owning it.  Absent without a
        // pi API instance: the tool unit is then skipped (fail-closed) and
        // `todo` never registers on a host that cannot restore its state
        // from the transcript.
        todoStore: piApi === undefined ? undefined : ports.todo,
        // The subagent capability baseline: the shared untrimmed active
        // tool set minus `ask` (a sub-session has no question channel),
        // captured lazily on first use and cached.  Both faces read the
        // same capture, so the main session's primary denies and ask
        // visibility never reach a sub-session.  The capture is DEFERRED
        // because pi forbids calling action methods (including
        // `getActiveTools`) during extension loading; the first consumer
        // always runs post-bind, so the capture is the real untrimmed
        // universe.  `undefined` when unavailable (also after the
        // extension stopped) → capability computation yields an empty set
        // (fail-closed).
        subagentBaseline:
          piApi === undefined
            ? undefined
            : () => ports.toolBaselines.subagent(),
        // Native HTML→Markdown converter for the fetch tool.  Wired here
        // (the real pi entry point); the wrapper warns once when the addon
        // is unavailable, the assembly then declares no `htmlConverter`
        // key, and the planner skips the fetch unit (fail-closed).
        loadHtmlConverter: loadPiHtmlConverter,
        // Host head truncator for the fetch pipeline.  Wired here alongside
        // the converter loader; the fetch unit registers only when both are
        // present.
        truncateHead,
        // The ask tool's question-channel provider: the one this runtime
        // resolved, so the ask unit registers on pi only and stays closed
        // on OpenCode.
        askQuestionChannel,
      }),
  });

  // The session id one event context names.  Each call resolves its own
  // context: no entry point falls back to a context another event
  // published.
  const resolveSessionID = (ctx: unknown): string | undefined =>
    (ctx as PiLifecycleContext | undefined)?.sessionManager?.getSessionId?.();

  // The lifecycle wiring of this extension instance: the extension
  // activation, session admission, the real start notice, and the
  // extension stop pi's `session_shutdown` drives.  Handlers and the tool /
  // command bridges below route their work through it.
  const lifecycle = createPiLifecycleWiring({
    extensionServices: declarations.extension,
    sessionServices: declarations.session,
    sessionCatalog,
    // pi keeps the live session id on the event context's session manager.
    getSessionID: resolveSessionID,
  });

  // The close handle of this instance's extension scope.  pi never sends
  // `session_shutdown` for an SDK-created session, so a host that owns this
  // runtime (a subagent driver) stops the scope itself, before it disposes
  // the session.
  const stop = (): Promise<CleanupReport> =>
    lifecycle.stopExtension({
      type: "session_shutdown",
      reason: SDK_STOP_REASON,
    });

  return { contextRuntime, askQuestionChannel, lifecycle, stop };
}

/**
 * Build the pi handlers and prepare the profile's pi surfaces.
 *
 * Activates the host services (session contexts, adapter, tool host, todo
 * catalog, profile catalog, tool baselines, fleet surface, switch surface)
 * through the lifecycle kernel, which also composes the profile against
 * those extension-scope ports and builds the loop engine when the profile
 * contributes a settle strategy.  The pass then builds the event handlers
 * over those surfaces and every registration pi is to receive: the tools
 * (after the composed `tool.definition` enhancers ran), the commands with
 * their admitted handlers, and the notice entry renderer.  Nothing is
 * written to pi here — `publisher.ts` performs the writes.
 *
 * Asynchronous because the extension activation awaits the kernel and the
 * enhancer chain awaits each contributor's `handle` (which may return a
 * promise); both are fallible, so both run in this phase.
 *
 * Exported for unit testing — the start publisher wires this with the scope
 * of its configuration generation and the instance resources it created.
 *
 * @param input - The generation, the origin, the pi API instance, the host
 *   options, and the resources this runtime owns.
 * @returns The prepared start: the handlers and the registrations.
 */
export async function preparePiStart(
  input: PiStartInput,
): Promise<PiStartPrepared> {
  const { scope, origin, piApi, overrides, instance } = input;
  // The agent this runtime is fixed to: the origin is the only main/child
  // difference, so every surface below derives from it.
  const fixedAgent = originAgent(origin);
  const applyToolDefinitions =
    overrides?.applyToolDefinitions ?? applyToolDefinitionContributions;
  // The per-agent skill permission rules
  // (`[agent.<name>].permission.skill`) of this generation.
  // `resources_discover` filters the contributed skill directories by the
  // active primary's rules; an agent absent from the map (or no primary)
  // contributes unfiltered (default-allow, machinery-off unchanged).
  const skillPermissions = scope.snapshot.skillPermissions;
  // The context records, the question channel and the lifecycle wiring this
  // runtime owns: created before the first fallible step, so a failed start
  // has them to close.
  const { contextRuntime, askQuestionChannel, lifecycle } = instance;

  // Activate the extension scope BEFORE anything else: the profile is
  // composed over services the kernel created, not over objects this
  // function built and then wrapped.  No session exists at this point — the
  // session scopes are created when an event first names one.
  const extension = await lifecycle.activateExtension();
  const {
    sessionContexts,
    capabilities,
    todo,
    profileCatalog,
    toolBaselines,
    fleet,
    switchHost,
    composition,
    loop,
  } = extension.services;

  // The assembled profile and the loop engine over its settle strategies
  // are services of this extension scope: the composition reads the
  // capability provision, and the engine is created after it.  The session
  // resolvers belong to the provision that built them.
  const { composed } = composition;
  const { resolveAgent, resolveCallerAgent } = capabilities;
  // The run scope of this runtime: the card renderers, the terminal tool
  // details, the history rebuild and the fleet widget read the process table
  // through it, and the subagent tool writes into it.
  const { runScope: runs } = extension.services;
  const snapshot = scope.snapshot;

  // Loop-engine wiring.  The composed strategies judge a stopped turn; each
  // declares its own wake allowance (`maxWakes`) and reads its own config,
  // so the engine needs no configuration of its own.  This host classifies
  // the stop cause at pi's pre-settle boundary and returns a wake as an
  // injected custom message.  The engine holds the strategies only: each
  // session scope owns the handle that keeps its reminder budget and
  // awaiting lock, so the handle ends with the scope.
  const hasSettledHandlers = loop.engine !== undefined;

  // Whether this host registered the ask tool.  The tool registers inactive
  // (`defaultActive: false`), so the visibility rule — not the registration
  // — decides whether the model may ask the user.
  const askRegistered =
    piApi?.registerTool !== undefined &&
    Object.values(composed.tools).some((tool) => tool.name === ASK_TOOL_NAME);

  // Whether the session's primary denies the ask tool.  An unresolvable
  // primary reports a deny, so ask stays hidden (fail-closed).
  const askDeniedByPrimary = (sessionID: string): boolean => {
    const primary = resolveAgent(sessionID);
    if (primary === undefined) return true;
    return (snapshot.agentPermissions[primary] ?? []).includes(ASK_TOOL_NAME);
  };

  // Write one active-tool set: the candidate set, then the ask rule.
  //
  // Every active-tool writer of this adapter goes through here — the primary
  // deny trim and the deferred switch trim — so one rule decides the ask
  // tool in both and no writer corrects another.  The ask tool is visible
  // only while the session's primary permits it AND the event's own context
  // yields a question channel: an external host configuration may activate
  // it, and every event corrects that to this session's answer.
  //
  // The host is written only when the resolved set differs from the current
  // one: a write rebuilds the system prompt, so a steady-state event stays
  // silent.  A host that reports no current set is written anyway.
  const applyToolSet = (
    sessionID: string,
    ctx: unknown,
    candidates: readonly string[],
  ): void => {
    const next = withAskVisibility(candidates, {
      registered: askRegistered,
      available: askQuestionChannel(ctx) !== undefined,
      denied: askDeniedByPrimary(sessionID),
    });
    const current = piApi?.getActiveTools?.();
    if (
      current !== undefined &&
      current.length === next.length &&
      next.every((tool, index) => current[index] === tool)
    ) {
      return;
    }
    piApi?.setActiveTools?.(next);
    const hadAsk = candidates.includes(ASK_TOOL_NAME);
    const hasAsk = next.includes(ASK_TOOL_NAME);
    if (hadAsk !== hasAsk) {
      log.debug({
        hook: "permissions",
        event: hasAsk ? "ask_tool_activated" : "ask_tool_hidden",
        sessionId: sessionID,
      });
    }
  };

  // Apply one session's active tool set: its primary's tool-level denies,
  // then the ask rule (see `applyToolSet`).
  //
  // pi has no host-level per-agent permission enforcement (unlike
  // OpenCode), so the extension trims pi's process-wide registered tool
  // face per session.  The trim is computed from the SHARED untrimmed
  // baseline (`toolBaselines.primary`) minus the session's primary denies,
  // so it is idempotent and denies never accumulate across repeated calls
  // or primary switches.  Without a baseline the trim cannot decide the
  // tool face, so only the ask rule runs — on the live set, which leaves
  // every other tool as it is.  A sub-session runtime is skipped: the
  // driver already restricts its tool face by the capability allowlist.
  const applyActiveTools = (sessionID: string, ctx: unknown): void => {
    if (fixedAgent !== undefined) return;
    const primary = resolveAgent(sessionID);
    const baseline =
      primary === undefined ? undefined : toolBaselines.primary();
    if (baseline === undefined || baseline.length === 0) {
      // No baseline to trim: correct ask on the live set.  An unresolvable
      // primary denies ask (fail-closed).  A host that reports no live set
      // leaves nothing to correct.
      const current = piApi?.getActiveTools?.();
      if (current !== undefined) applyToolSet(sessionID, ctx, current);
      return;
    }
    const denied =
      primary === undefined ? [] : (snapshot.agentPermissions[primary] ?? []);
    const deniedSet = new Set(denied);
    // Always resolve the FULL `baseline minus denies` set (never a delta):
    // this both removes the current primary's denies and restores tools a
    // previously active primary had denied.  Log only an actual removal so
    // a steady-state turn (denies already absent) stays quiet.
    applyToolSet(
      sessionID,
      ctx,
      baseline.filter((tool) => !deniedSet.has(tool)),
    );
    const removed = denied.filter((tool) => baseline.includes(tool));
    if (removed.length > 0) {
      log.info({
        hook: "permissions",
        event: "primary_tools_trimmed",
        agent: primary,
        removed,
      });
    }
  };

  // Register the `zoo` fleet widget (component factory) above the editor
  // through the fleet resources of the session the event names.
  //
  // The session scope owns every host write the widget needs — the
  // `setWidget` binding and the terminal-input listener — so a session that
  // stops (or whose extension stops) releases both, and a later registration
  // on a stopped scope writes nothing.  Registration stays idempotent: pi
  // replays `session_start` after a reload / resume, so re-registering
  // re-seeds the widget and releases the previous listener instead of
  // stacking a second one.  The factory reads the active primary and the run
  // registry LIVE on every render, so registration is a `setWidget` call and
  // all subsequent updates are `refresh()` nudges.
  //
  // Fails closed: no session id, no scope for that session, no active
  // primary, or no `ui` surface all no-op silently.
  const registerFleetWidget = (sessionID: string | undefined): void => {
    fleet.register(sessionID);
  };

  // Startup anchor: mirror the OpenCode host's `plugin_init` event so a
  // pi log records which profile-driven composition was loaded.  Sessionless
  // (load-time) entry: it buffers and flushes into the first pi session's
  // file once that session materialises.
  log.info({
    hook: "plugin",
    event: "plugin_init",
    agents: composed.agents.map((agent) => agent.name),
    skills: composed.skills.map((skill) => skill.name),
    limits: snapshot.limits,
  });

  // Publish the composed profile's skill directory names.  The subagent
  // driver reads them per run and `resources_discover` reads them per bind,
  // so both consume this one publication — no mutable local is handed out.
  profileCatalog.publish(composed.skills.map((skill) => skill.name));

  // Build the tool registrations publish writes.  The composed
  // `tool.definition` contributions (the subagent-prompt format hint, when
  // the subagent-prompt hook unit is enabled) run here: pi has no native
  // `tool.definition` event, so the OpenCode chain is applied at this
  // boundary instead — enriching the tool arguments' descriptions before pi
  // registers the tools, with the tool itself staying policy-free.  The
  // delegation gate is enforced separately on pi's native `tool_call` event
  // (see `handlers.toolCall`).
  const definitionEnrichedTools = await applyToolDefinitions(
    composed.tools,
    composed.toolDefinition,
  );
  // pi draws a live transcript card for the subagent and todo tools.  The
  // card renderers are adapter-owned (they read pi TUI state), so
  // registration installs them by tool name; every other tool registers
  // without one.
  const cardRenderers = new Map([
    ["subagent", buildSubagentCardRenderer(runs)],
    ["todo", buildTodoCardRenderer()],
  ]);
  const tools: PiToolRegistration[] = [];
  const registered = new Set<string>();
  for (const tool of Object.values(definitionEnrichedTools)) {
    if (registered.has(tool.name)) continue;
    registered.add(tool.name);
    const args = tool.args ?? {};
    const required = tool.required ?? Object.keys(args);
    const card = cardRenderers.get(tool.name);
    tools.push({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      // The ask tool registers inactive: the model may ask the user only
      // while the session has a question channel, which the bind-time
      // events decide (see `applyToolSet`).  Every other tool keeps pi's
      // own registration default.
      ...(tool.name === ASK_TOOL_NAME ? { defaultActive: false } : {}),
      ...(card === undefined
        ? {}
        : { renderCall: card.renderCall, renderResult: card.renderResult }),
      // pi's validateToolArguments accepts plain JSON-Schema parameters.
      parameters: {
        type: "object",
        properties: args,
        ...(required.length > 0 ? { required } : {}),
      } as unknown as object,
      execute: buildPiToolExecute(
        tool,
        lifecycle,
        (sessionID, ctx) => sessionContexts.bind(sessionID, ctx),
        askQuestionChannel,
        runs,
      ),
    });
  }

  // Build the command registrations publish writes.  Each handler is
  // admitted for the session its own command context names: a command that
  // arrives without a session or after the session stopped runs nothing.  A
  // command the contribution marks as replacing (`/go` and the `/<agent>`
  // switches) is admitted as a CONTROL operation, because pi tears its
  // session down inside the replacement call and a stop waiting for that
  // call would never return.  Every other command is ordinary session work,
  // so a stop cancels it and waits for it to return.  The context reaches
  // the session contexts only after admission either way.
  const commands: PiCommandStart[] = buildPiCommandRegistrationPlan(
    composed.commands,
  ).map((registration) => ({
    name: registration.name,
    description: registration.description,
    handler: async (args: string, ctx: unknown): Promise<void> => {
      const work = (permit: WorkPermit) => {
        // The command context is the session's own: the handoff target and
        // the switch host resolve it from the command entry by the permit's
        // session id.
        sessionContexts.bindCommand(permit.sessionID, ctx as PiCommandCtx);
        return registration.handler(args, ctx as PiCommandContext, permit);
      };
      await (registration.replacesSession
        ? lifecycle.runControl(ctx, work)
        : lifecycle.runSession(ctx, work));
    },
  }));

  // The `zoo-notice` entry renderer: every notify — tool prompts, /dcp
  // reports, command failures — posts a `zoo-notice` entry that needs a
  // renderer, so it is built independently of the profile and the composed
  // commands.  The renderer itself is duck-typed (no pi package import).
  const noticeRenderer = buildPiNoticeEntryRenderer();

  // The fourteen handlers close over the wiring surfaces assembled above;
  // their bodies live in `handlers.ts`.
  const handlers = createPiEventHandlers({
    sessionContexts,
    contextRuntime,
    composed,
    hasSettledHandlers,
    skillPermissions,
    getProfileSkills: () => profileCatalog.get(),
    collectSkillPaths,
    applyActiveTools,
    registerFleetWidget,
    refreshTodoView: (sessionID) => fleet.refreshTodoView(sessionID),
    seedTodoView: (sessionID) => fleet.seedTodoView(sessionID),
    // The switch surface's pending replacement rides the explicit
    // process-level handoff store, because a switch spans two factory
    // executions — see `adapters/pi/switch-host.ts`.  The replacement's own
    // `session_start` claims it: that start binds the target primary before
    // the session's bind-time handlers resolve it, and keeps the deferred
    // trim for the session that drains it.  A sub-session runtime inherits
    // its parent's store but serves one delegation, so it never claims.
    claimPendingSwitchOps: (sessionID, facts) => {
      if (fixedAgent !== undefined) return;
      switchHost.claimPending(sessionID, facts);
    },
    // The queued trim is applied through the same writer as the primary
    // trim, so the ask rule answers with this session's context.
    drainPendingSwitchOps: (sessionID, ctx) => {
      if (fixedAgent !== undefined) return;
      const deferred = switchHost.drainPendingOps(sessionID);
      if (deferred === undefined) return;
      applyToolSet(sessionID, ctx, deferred);
    },
    runs,
    invalidateTodo: (sessionId) => todo.invalidate(sessionId),
    resolveAgent,
    resolveCallerAgent,
    ...(fixedAgent === undefined ? {} : { fixedAgent }),
    runSession: (ctx, work, signal) =>
      lifecycle.runSession(
        ctx,
        (permit, services) =>
          work(permit, {
            settle: services.settleState,
            loop: services.loopSession,
          }),
        signal,
      ),
    startSession: (event, ctx) => lifecycle.startSession(event, ctx),
    stopExtension: (event) => lifecycle.stopExtension(event),
  });

  return { ...handlers, tools, commands, noticeRenderer };
}
