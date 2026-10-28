/**
 * Harness error type with a stable code.
 *
 * Self-tests assert codes rather than message text, so a reworded message
 * cannot make a failing gate look healthy and a passing gate look broken.
 */

/** Every failure the harness itself can raise. */
export type HarnessErrorCode =
  | "pi.host_not_found"
  | "rpc.timeout"
  | "rpc.exited"
  | "rpc.spawn_failed"
  | "cli.invalid_argument"
  | "cli.unknown_scenario"
  | "cli.no_scenarios"
  | "scenario.unknown"
  | "scenario.failed";

/**
 * A harness failure, not a product failure.
 */
export class HarnessError extends Error {
  /** Stable machine-readable cause. */
  readonly code: HarnessErrorCode;
  /** Optional supporting detail (paths, observed values). */
  readonly detail: string | undefined;

  /**
   * @param code - Stable cause of the failure.
   * @param message - Human-readable summary.
   * @param detail - Supporting detail, printed when the failure is reported.
   */
  constructor(code: HarnessErrorCode, message: string, detail?: string) {
    super(`${code}: ${message}`);
    this.name = "HarnessError";
    this.code = code;
    this.detail = detail;
  }
}
