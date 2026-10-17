/**
 * Settled-turn contract.
 *
 * The leaf module both the loop engine and the contributing strategies
 * import: the host's stop cause, the strategy verdict, and the shape of a
 * contributed settle handler.  It imports nothing from the engine or from
 * any unit-assembly module, which breaks the former
 * slots ↔ loop type cycle.
 *
 * @module
 */

/**
 * Why the agent's turn ended, as reported by a host.
 *
 * The engine consumes it for its settle interlock; only `"settled"`
 * proceeds to strategy consultation.
 */
export type StopCause = "settled" | "awaiting-input" | "aborted";

/**
 * A verdict for one settled turn.
 *
 * `wake` carries the text to deliver; `silence` carries a
 * machine-readable reason.  The reason vocabulary is the contributor's:
 * the engine knows only its own silence reasons, a strategy names its own
 * gates.  The generic parameter lets a strategy pin its reason type while
 * the engine consumes the widened default.
 */
export type Decision<R extends string = string> =
  | { kind: "wake"; text: string }
  | { kind: "silence"; reason: R };

/**
 * The strategy view of a stopped turn.
 *
 * The engine consults a strategy only after its interlocks pass, so a
 * strategy never sees the stop cause or the budget: it receives the
 * session and the turn's activity fact and returns a wake/silence
 * verdict.
 */
export interface SettledInput {
  /** Session whose turn stopped. */
  sessionID: string;
  /**
   * Whether the settled turn made ANY tool call at all — reads and todo
   * updates count; only a pure-text turn is activity-free. The engine
   * uses it to release its awaiting-progress lock; strategies judge
   * wakefulness from their own state, not from this fact.
   */
  hadActivity: boolean;
}

/**
 * The host's report of a stopped turn, before the engine's interlocks.
 *
 * Carries the stop cause the engine needs to decide whether any strategy
 * may be consulted; the engine reads its own budget state.
 */
export interface SettleRequest {
  /** Session whose turn stopped. */
  sessionID: string;
  /** Why the agent's turn ended. */
  cause: StopCause;
  /** Whether the settled turn made any tool call. */
  hadActivity: boolean;
}

/**
 * One named "agent turn settled" handler contributed by a hook unit.
 *
 * The handler judges whether the settled turn should be woken to finish
 * remaining work and returns that {@link Decision}; hosts deliver a
 * `wake` text and ignore a `silence`.  Judgment lives entirely in the
 * contributing unit — the engine only reads the verdict.  The unit also
 * declares its own wake allowance, so the engine can enforce the budget
 * interlock without any configuration of its own.
 */
export interface SettledContribution {
  /** Handler label used for logging and budget accounting. */
  name: string;
  /**
   * Maximum number of wakes the engine may deliver for this strategy per
   * session.  A strategy whose allowance is spent is skipped so later
   * strategies may still win.
   */
  maxWakes: number;
  handle(input: SettledInput): Promise<Decision>;
}
