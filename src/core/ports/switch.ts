/**
 * Primary-switch capability port.
 *
 * Pure types: the host surfaces the `/<agent>` switch command drives.  The
 * file imports types only — never an implementation.
 *
 * @module
 */

/**
 * Host surfaces used by the primary-switch command.
 *
 * `getBaselineTools` / `setActiveTools` come from the host's extension
 * API; `setWidget` is read from the latest extension context's `ui`.
 * `newSession` delegates to the command context's `newSession` (the full
 * re-bind: the new session re-resolves the primary's prompt, skill filter,
 * tool trim, and widget at bind time).  The switch command unit contributes
 * no commands when this capability is absent (fail closed — OpenCode never
 * provides it, so `/<agent>` commands never register there).
 */
export interface SwitchHost {
  /**
   * The full untrimmed tool baseline, captured ONCE before any switch.
   *
   * Every switch computes `baseline minus deniedTools(target)` from this
   * fixed set, so tool denies never accumulate across switches.  The
   * capture is deferred to the first `getBaselineTools` call (which
   * always happens inside a switch handler — the host forbids calling
   * action methods at extension-load time) and cached.  `undefined` when
   * the baseline was unavailable — callers skip the trim then
   * (fail-closed).
   */
  getBaselineTools(): string[] | undefined;
  /** Replace the active tool set (used to trim denied tools). */
  setActiveTools(toolNames: string[]): void;
  /**
   * Render a widget above the editor (e.g. the active primary).
   *
   * Mirrors the host's `setWidget` shape: `lines` is the widget's
   * single-line content rendered above the editor.  `undefined` hides the
   * widget.
   */
  setWidget(key: string, lines: string[] | undefined): void;
  /**
   * Replace the current session with a fresh one bound to the new
   * primary identity.
   *
   * Mirrors the host command context's `newSession` shape
   * (`{ parentSession?, withSession? }`): the caller stashes the current
   * session id as `parentSession`, and `withSession` runs against the
   * fresh session once it is created.  All post-replacement work must be
   * done through the `SwitchNewSessionOps` facade handed to
   * `withSession` — never through this host's own methods, which close
   * over the process-level (pre-replacement) API.  A `{ cancelled: true }`
   * result means the replacement was aborted and no session was created.
   * Absent on hosts without the replacement API — the switch fails
   * closed.
   */
  newSession(options: {
    parentSession?: string;
    withSession?: (ops: SwitchNewSessionOps) => void | Promise<void>;
  }): Promise<{ cancelled: boolean }>;
}

/**
 * Per-fresh-session operations handed to a `newSession` `withSession`
 * callback.
 *
 * The host invalidates the captured extension API and command context after
 * session replacement: the action methods of the context captured before
 * the switch throw a stale-context error.  Post-replacement work — widget,
 * tool trim — MUST therefore run through the handles provided here, which
 * the host binds to the fresh session, never through a process-level
 * `SwitchHost` captured before the switch.
 *
 * A host may not be able to execute every operation synchronously inside
 * `withSession`: the tool actions may still operate on the old session's
 * bindings.  The host therefore defers the trim and applies it at the new
 * session's first `before_agent_start` (or other fresh-context event) where
 * a non-stale API exists.
 */
export interface SwitchNewSessionOps {
  /**
   * Render a widget above the editor (e.g. the active primary).
   *
   * `undefined` hides the widget.
   */
  setWidget(key: string, lines: string[] | undefined): void;
  /** Replace the fresh session's active tool set (denied-tool trim). */
  setActiveTools(toolNames: string[]): void;
}

/** The primary-switch capability. */
export interface SwitchPort {
  /**
   * Host-specific switch surfaces.
   *
   * Absent on hosts without them (OpenCode) — the switch command unit
   * contributes no commands then, so no `/<agent>` command ever registers
   * there.
   */
  switchHost: SwitchHost;
}
