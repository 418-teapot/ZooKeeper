/**
 * Auto-debug capability port.
 *
 * Pure types: the wake budget parsed from `[zoo.autodebug]` plus the
 * injected `zdebug` runner and read-only filesystem the strategy drives.
 * The file imports types only — never an implementation.
 *
 * @module
 */

import type { AutoDebugConfig } from "../config-types.js";

/**
 * The outcome of one `zdebug` CLI invocation that ran to completion.
 *
 * A non-zero `exitCode` is still a completed process: the strategy (not
 * this port) decides what a business error means, so the port imposes no
 * exit-code policy of its own.
 */
export interface ZdebugExecResult {
  /** Captured standard output. */
  stdout: string;
  /** Captured standard error. */
  stderr: string;
  /** The process exit status (`-1` when terminated by a signal). */
  exitCode: number;
}

/**
 * Injected runner for the `zdebug` CLI.
 *
 * The auto-debug strategy reads a Case's status and re-runs its
 * verification experiment through this port.  It resolves for any
 * process that ran to completion, including a non-zero CLI exit; it
 * rejects only when the process could not be launched (the binary is not
 * on `PATH`).  The invocation is unbounded: each criterion's declared
 * timeout is enforced by `zdebug` itself.  The default implementation
 * spawns `zdebug` from `PATH`; tests inject a fake so no real binary
 * runs.
 *
 * @param args - CLI arguments, without the leading program name.
 * @param cwd - Working directory for the invocation.
 */
export type ZdebugExec = (
  args: readonly string[],
  cwd: string,
) => Promise<ZdebugExecResult>;

/** One directory entry returned by the injected filesystem port. */
export interface AutoDebugDirEntry {
  /** Entry name (no path). */
  name: string;
  /** Whether the entry is a directory. */
  isDirectory: boolean;
}

/**
 * Injected read-only filesystem for the auto-debug strategy.
 *
 * The strategy scans the workspace for Cases through this port; tests
 * inject a fake so no real disk is touched.  A missing directory lists
 * as empty; only genuine I/O failures throw.
 */
export interface AutoDebugFs {
  /** List a directory's entries; an absent directory yields `[]`. */
  listDir(path: string): Promise<AutoDebugDirEntry[]>;
}

/** The auto-debug capability. */
export interface AutoDebugPort {
  /**
   * Auto-debug loop wake budget (`[zoo.autodebug]`), parsed fail-closed.
   *
   * The auto-debug strategy reads its wake allowance from here; a
   * missing/invalid section leaves this capability unprovided and the
   * unit contributes no settle handler at all.
   */
  autoDebugConfig: AutoDebugConfig;
  /**
   * Injected runner for the `zdebug` CLI.
   *
   * Absent on hosts that do not wire one — the strategy then falls back to
   * the default subprocess wrapper.  Tests always inject a fake so no real
   * binary runs.
   */
  zdebugExec: ZdebugExec;
  /**
   * Injected read-only filesystem for the auto-debug strategy.
   *
   * Absent on hosts that do not wire one — the strategy then falls back to
   * the default `node:fs` reader.  Tests always inject a fake.
   */
  autoDebugFs: AutoDebugFs;
}
