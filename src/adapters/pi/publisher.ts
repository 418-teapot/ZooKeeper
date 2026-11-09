/**
 * Pi start publisher — the one path that writes ZooKeeper's surfaces into pi.
 *
 * `createPiRuntime` builds the runtime owner of one pi instance: the host
 * service declarations, the lifecycle wiring and the close handle, all
 * synchronous, so the owner exists before the first fallible step.  Its
 * publisher then runs the start in two phases: `prepare` (see `wire.ts`)
 * computes the whole start without touching pi, and `publish` performs the
 * writes, in a fixed order: the tools, the commands, the `zoo-notice` entry
 * renderer, and finally the event keys.
 *
 * The order is the reason the split exists.  pi's registration calls have no
 * rollback, so a start that fails halfway leaves the host half wired.  Every
 * fallible step therefore runs in the preparation phase, and a failure
 * during publication stops the writes that follow it instead of being
 * swallowed.
 *
 * The publication is the prepared start.  It carries what later phases read:
 * the event handlers and the registrations pi received.  The close handle of
 * the runtime belongs to the owner, so a failed start can close what it
 * created.
 *
 * The main extension, the inline factory a sub-session loads
 * (`buildPiSubagentExtension`) and every nested sub-session start through
 * this owner, so no entry has a second publication path.
 *
 * @module
 */

import { registerPiHandlers } from "../../compose-pi.js";
import type { CleanupReport } from "../../core/lifecycle/index.js";
import type { RuntimeOrigin, RuntimeOwner } from "../../core/runtime.js";
import { startRuntime } from "../../core/runtime.js";
import type { PiProcessScope } from "./config.js";
import type { PiProcessState } from "./process.js";
import type { ExtensionAPI } from "./types.js";
import {
  createPiRuntimeInstance,
  type PiStartOptions,
  type PiStartPrepared,
  preparePiStart,
} from "./wire.js";

/**
 * Write one prepared start into pi.
 *
 * A host call pi does not offer is skipped (fail-closed), so a partial
 * API instance receives only the surfaces it supports.  A throwing call
 * propagates and ends the publication: later writes never run.
 *
 * @param pi - The pi ExtensionAPI instance, or absent in a unit test.
 * @param prepared - The prepared start.
 * @returns The publication (the prepared start, now attached).
 */
export function publishPiStart(
  pi: ExtensionAPI | undefined,
  prepared: PiStartPrepared,
): PiStartPrepared {
  if (pi?.registerTool) {
    for (const tool of prepared.tools) {
      pi.registerTool(
        tool as unknown as Parameters<ExtensionAPI["registerTool"]>[0],
      );
    }
  }
  if (pi?.registerCommand) {
    for (const command of prepared.commands) {
      pi.registerCommand(command.name, {
        description: command.description,
        handler: command.handler,
      });
    }
  }
  if (pi?.registerEntryRenderer) {
    pi.registerEntryRenderer(
      "zoo-notice",
      prepared.noticeRenderer as unknown as Parameters<
        ExtensionAPI["registerEntryRenderer"]
      >[1],
    );
  }
  if (pi !== undefined) registerPiHandlers(pi, prepared);
  return prepared;
}

/** The explicit inputs of one pi runtime. */
export interface PiRuntimeInput {
  /** The configuration generation this runtime belongs to. */
  readonly scope: PiProcessScope;
  /** The origin of this runtime. */
  readonly origin: RuntimeOrigin;
  /**
   * The process state this runtime runs over.
   *
   * The entry passes the state of this pi process, so a reload keeps the
   * session identities and run records of the previous generation; a
   * sub-session runtime receives its parent's state and never creates one.
   */
  readonly process: PiProcessState;
  /** The pi ExtensionAPI instance, or absent in a unit test. */
  readonly pi?: ExtensionAPI;
  /** Optional host options and test seams. */
  readonly overrides?: PiStartOptions;
}

/**
 * Build the runtime owner of one pi instance.
 *
 * The owner holds the instance resources (created here, synchronously) and
 * the start publisher over them.  A nested sub-session starts through this
 * publisher too, so the child factory is supplied here rather than by the
 * preparation phase; no pi API instance means no sub-session driver either
 * (fail-closed), so the factory is only handed over with one.
 *
 * @param input - The generation, the origin, the process state, the pi API
 *   instance and the host options of this runtime.
 * @returns The owner: its start publisher and its close handle.
 */
export function createPiRuntime(
  input: PiRuntimeInput,
): RuntimeOwner<PiStartPrepared, PiStartPrepared> {
  const { scope, origin, process, pi, overrides } = input;
  const options: PiStartOptions = {
    ...overrides,
    ...(pi === undefined
      ? {}
      : {
          childRuntime: (
            onClose: (close: () => Promise<CleanupReport>) => void,
            agent: string,
          ) =>
            buildPiSubagentExtension(scope, {
              agent,
              process,
              ...(overrides?.entryPath !== undefined
                ? { entryPath: overrides.entryPath }
                : {}),
              onClose,
            }),
        }),
  };
  const instance = createPiRuntimeInstance({
    scope,
    origin,
    process,
    ...(pi === undefined ? {} : { piApi: pi }),
    overrides: options,
  });
  return {
    publisher: {
      prepare: () =>
        preparePiStart({
          scope,
          origin,
          process,
          ...(pi === undefined ? {} : { piApi: pi }),
          overrides: options,
          instance,
        }),
      publish: (prepared) => publishPiStart(pi, prepared),
    },
    stop: instance.stop,
  };
}

/**
 * Build the inline extension factory ZooKeeper's sub-sessions load.
 *
 * The factory captures the process scope AND the process state of the
 * composition root that built it — it never reads config.toml or agents.json
 * again — so a sub-session composes the same configuration generation as its
 * parent and writes into the same session identities and run records.
 * It starts a subagent runtime through the same start protocol as the main
 * entry, which means a nested sub-session creates its own inline factory in
 * turn.  `onClose` receives the close handle of the started child, so the
 * driver that owns the run can stop that scope before it disposes the SDK
 * session; a child start that fails closes its own runtime, so `onClose` is
 * never called for it.
 *
 * @param scope - The parent's configuration generation, passed through
 *   unchanged.
 * @param options - The delegated agent, the parent's process state, the
 *   host's extension file entry and the close reporter.
 * @returns The factory pi loads into the sub-session runtime.
 */
export function buildPiSubagentExtension(
  scope: PiProcessScope,
  options: {
    /**
     * The agent this sub-session runtime is built for.  Every session of
     * the runtime is that delegation, so it answers identity directly.
     */
    agent: string;
    /** The parent runtime's process state, inherited unchanged. */
    process: PiProcessState;
    /** The host's extension file entry, left out of the sub-session. */
    entryPath?: string;
    /** Receives the close handle of the child start. */
    onClose?: (close: () => Promise<CleanupReport>) => void;
  },
): (pi: ExtensionAPI) => Promise<void> {
  return async (childPi: ExtensionAPI): Promise<void> => {
    const handle = await startRuntime({
      scope,
      origin: { kind: "subagent", agent: options.agent },
      createRuntime: ({ scope: childScope, origin }) =>
        createPiRuntime({
          scope: childScope,
          origin,
          process: options.process,
          pi: childPi,
          ...(options.entryPath === undefined
            ? {}
            : { overrides: { entryPath: options.entryPath } }),
        }),
    });
    options.onClose?.(handle.stop);
  };
}
