/**
 * OpenCode start publisher — the one path that delivers the plugin hooks.
 *
 * OpenCode has no `register` calls: the host receives one hooks object and
 * drives it afterwards.  The publication is therefore the whole delivery,
 * and the split still pays off, because the start has fallible work that
 * must not run after a host write:
 *
 *  - the runtime owner is created first, synchronously: this instance's
 *    context records, session catalog, host service declarations and
 *    lifecycle wiring, plus the close handle.  A start that fails in any
 *    later phase still has the runtime it created.
 *  - `prepare` activates the lifecycle extension (which binds the
 *    capability provision, including the host config pre-read), assembles
 *    the profile, builds the hook fragment, and reads the profile's skill
 *    directories.  A program error here — a capability the host could not
 *    read, a factory that throws — reaches the caller before the
 *    host could write anything.  A skill directory the scan cannot read is
 *    logged and skipped instead, so the start continues with the paths it
 *    collected.
 *  - `publish` hands over the complete publication: the hook fragment plus
 *    the teardown, which is the runtime's own close handle.
 *
 * The `config` hook is not a start write.  The host calls it with the config
 * it is about to use, after the plugin returned, and a later plugin may have
 * changed the agent table in between.  Its final materialisation check
 * therefore stays inside the hook, and the hook writes the skill paths the
 * preparation read instead of scanning again.
 *
 * @module
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConfigSnapshot,
  ProcessScope,
} from "../../core/config-snapshot.js";
import type { ContextRuntime } from "../../core/context/runtime.js";
import { createContextRuntime } from "../../core/context/runtime.js";
import type { CleanupReport } from "../../core/lifecycle/index.js";
import type { Capabilities } from "../../core/ports/index.js";
import type { ProcessState } from "../../core/process-state.js";
import { filterDisjointVariants } from "../../core/prompt-variant.js";
import type { RuntimeOwner } from "../../core/runtime.js";
import { createSessionAgentResource } from "../../core/session/agent.js";
import {
  contextSessionResources,
  createSessionResourceCatalog,
} from "../../core/session/resources.js";
import { scanSkillDirectories } from "../../core/skills.js";
import { log } from "../../utils/logger.js";
import { buildInfraHooks } from "./infra-hooks.js";
import {
  createOpenCodeLifecycleWiring,
  type OpenCodeLifecycleWiring,
  withSessionWork,
} from "./lifecycle-wiring.js";
import { assembleProfileHooks } from "./profile-hooks.js";
import { createOpenCodeHostServices, sessionScopeState } from "./services.js";

/** The absolute path of the repository's skills directory. */
const SKILLS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills",
);

/** The options of one OpenCode start. */
export interface OpenCodeStartOverrides {
  /** Test seam: `zdebug` runner for the auto-debug strategy. */
  zdebugExec?: Partial<Capabilities>["zdebugExec"];
  /** Test seam: the instance's context runtime to inspect in place. */
  contextRuntime?: ContextRuntime;
  /**
   * Test seam: the profile skill-directory scan of the preparation phase.
   * Defaults to the shared scan of `skills/`.  A program error thrown here
   * fails the start, which closes the runtime it created.
   */
  scanSkills?: (profileSkills: readonly string[]) => string[];
}

/** The prepared OpenCode start: the whole plugin, computed. */
export interface OpenCodeStartPrepared {
  /** The hook fragment, with every session hook already admitted. */
  readonly hooks: Record<string, any>;
  /** Stop every session and then the extension. */
  readonly dispose: () => Promise<CleanupReport>;
}

/** The published plugin: the host's hook surface plus the teardown. */
export type OpenCodeStartPublication = Record<string, any> & {
  dispose(): Promise<CleanupReport>;
};

/** The extension-scope declarations of one OpenCode plugin instance. */
type OpenCodeExtensionDeclarations = ReturnType<
  typeof createOpenCodeHostServices
>["extension"];

/** The explicit inputs of one OpenCode runtime. */
export interface OpenCodeRuntimeInput {
  /** The configuration generation this plugin instance belongs to. */
  readonly scope: ProcessScope<ConfigSnapshot>;
  /**
   * The process state this plugin instance runs over.
   *
   * The entry passes the state of this OpenCode process, so the server
   * plugin and the TUI panel read the same session identities and run
   * records.
   */
  readonly process: ProcessState;
  /** OpenCode plugin input (client, directory, ...). */
  readonly pluginInput: any;
  /** Optional test seams. */
  readonly overrides?: OpenCodeStartOverrides;
}

/** The inputs of one OpenCode start. */
interface OpenCodeStartInput {
  /** The host client the infrastructure hooks read. */
  readonly client: any;
  /** The process state this plugin instance runs over. */
  readonly process: ProcessState;
  /** The context records of this plugin instance. */
  readonly contextRuntime: ContextRuntime;
  /** The lifecycle wiring of this plugin instance. */
  readonly lifecycle: OpenCodeLifecycleWiring<OpenCodeExtensionDeclarations>;
  /** The close handle of this plugin instance. */
  readonly stop: () => Promise<CleanupReport>;
  /** Optional test seams. */
  readonly overrides?: OpenCodeStartOverrides;
}

/**
 * Build the runtime owner of one OpenCode plugin instance.
 *
 * The owner holds this instance's resources — the context records, the
 * session catalog, the host service declarations, the lifecycle wiring and
 * the close handle — created here, synchronously, so a start that fails in
 * the preparation phase still has a runtime to close.
 *
 * @param input - The configuration generation, the process state, the host
 *   input and the options of this runtime.
 * @returns The owner: its start publisher and its close handle.
 */
export function createOpenCodeRuntime(
  input: OpenCodeRuntimeInput,
): RuntimeOwner<OpenCodeStartPrepared, OpenCodeStartPublication> {
  const { scope, process, pluginInput, overrides } = input;
  const client = pluginInput.client;
  const directory: string = pluginInput.directory ?? "";

  // The context records of this plugin instance: one runtime per
  // instance, so two instances in one process never share session state,
  // a captured model limit, a published round view, or a
  // pending-view-change flag.
  const contextRuntime = overrides?.contextRuntime ?? createContextRuntime();
  const sessionCatalog = createSessionResourceCatalog([
    ...contextSessionResources(contextRuntime),
    createSessionAgentResource(process.sessionAgents),
  ]);

  // One lifecycle kernel backs this plugin instance: its extension scope
  // owns the capability provision and the assembled profile, and its
  // session scopes own the per-session state the always-on hooks drive
  // (the observed abort and the pending wake echo).
  const hostServices = createOpenCodeHostServices({
    scope,
    client,
    directory,
    process,
    contextRuntime,
    sessionCatalog,
    ...(overrides?.zdebugExec === undefined
      ? {}
      : { zdebugExec: overrides.zdebugExec }),
  });
  const lifecycle = createOpenCodeLifecycleWiring({
    extensionServices: hostServices.extension,
    sessionServices: hostServices.session,
    sessionCatalog,
  });

  // The close handle of this plugin instance: stop every remaining session
  // and then the extension, logging each cleanup failure instead of
  // dropping it.
  const stop = (): Promise<CleanupReport> => lifecycle.dispose();

  return {
    publisher: {
      prepare: () =>
        prepareOpenCodeStart({
          client,
          process,
          contextRuntime,
          lifecycle,
          stop,
          ...(overrides === undefined ? {} : { overrides }),
        }),
      publish: (prepared) => ({
        ...prepared.hooks,
        dispose: prepared.dispose,
      }),
    },
    stop,
  };
}

/**
 * Build the plugin hooks of one prepared start.
 *
 * Every fallible step runs here, before the host receives anything: the
 * activation of the extension (the capability provision and the assembled
 * profile), the skill-directory read, and the hook fragment.  The returned
 * hooks carry no host write.
 *
 * @param input - The instance resources, the host input and the options.
 * @returns The prepared start: the hooks and the runtime's close handle.
 */
async function prepareOpenCodeStart(
  input: OpenCodeStartInput,
): Promise<OpenCodeStartPrepared> {
  const { client, process, contextRuntime, lifecycle, stop, overrides } = input;
  const scanSkills =
    overrides?.scanSkills ??
    ((profileSkills: readonly string[]) =>
      scanSkillDirectories(SKILLS_DIR, [...profileSkills]));

  // Activate the extension before assembling the hooks: the capability
  // provision (including the host config pre-read) and the assembled
  // profile are services the kernel owns.  No session exists yet — the
  // session scopes are created when a hook first names one.
  const { services } = await lifecycle.activateExtension();
  const { capabilities, composition } = services;
  const { composed, selection } = composition;
  // The session → agent registry belongs to this process's state; the
  // infrastructure hooks populate it via `message.updated` events and the
  // units read it through `resolveAgent`.
  const { resolveAgent } = capabilities;
  // The provision's values are the host facts the adapter reads too: the
  // limits for its init log and both session resolvers for the units and
  // the delegation gate.
  const values = capabilities.values;

  // Read the profile's skill directories now, while no host write has
  // happened: the `config` hook writes the resulting paths and never scans
  // itself.  A directory the scan cannot read is logged and skipped.
  const skillPaths = scanSkills(composed.skills.map((skill) => skill.name));

  const selectionHooks = assembleProfileHooks(
    composed,
    values,
    selection,
    skillPaths,
  );

  // Assemble the model-family wordings from every enabled agent, tracking
  // the contributing agent so a dropped pair can be traced.  The union is
  // filtered before injection: `applyModelVariant` rewrites the text pair
  // by pair, so a pair whose wording overlaps an earlier pair would
  // rewrite that pair's output (cross-talk).  Keeping the first
  // occurrence and dropping the rest is fail-closed; the conflict is
  // logged rather than applied.
  const contributedVariants = composed.agents.flatMap((agent) =>
    (agent.promptVariants ?? []).map((pair) => ({ agent: agent.name, pair })),
  );
  const { kept: promptVariants, dropped } = filterDisjointVariants(
    contributedVariants.map((item) => item.pair),
  );
  if (dropped.length > 0) {
    const droppedPairs = new Set(dropped);
    const sources = [
      ...new Set(
        contributedVariants
          .filter((item) => droppedPairs.has(item.pair))
          .map((item) => item.agent),
      ),
    ];
    log.warn({
      hook: "prompt-variant",
      event: "conflict_dropped",
      dropped: dropped.length,
      sources,
    });
  }

  // Every hook addresses one session's state, never a whole scope: this
  // is the surface the always-on event hook drives.
  const sessions = {
    sessionState: async (sessionID: string | null | undefined) =>
      sessionScopeState(await lifecycle.ensureSession(sessionID)),
    handleEvent: (event: unknown) => lifecycle.handleEvent(event),
  };

  const hooks = {
    // Always-on infrastructure hooks.
    ...buildInfraHooks({
      client,
      sessionAgents: process.sessionAgents,
      resolveAgent,
      promptVariants,
      orchestrator: selection.orchestrator,
      sessions,
      contextRuntime,
    }),
    // Selection-driven registrations (from the adapter).
    ...selectionHooks,
  };

  return {
    // Every call that names a session enters through its session's permit:
    // a hook runs only for a live session, a tool call receives the
    // permit's signal, and a stop waits for both before disposing the
    // scope.  `config` and `tool.definition` name no session and stay
    // unwrapped.
    hooks: withSessionWork(hooks, lifecycle),
    // The host disposes the plugin through the runtime's own close handle.
    dispose: stop,
  };
}
