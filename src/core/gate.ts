/**
 * Framework-independent delegation gate.
 *
 * The delegation strategy for a `subagent` tool call is contributed by
 * hook units as named judges, then composed into a single pure gate that
 * both hosts consume.  A gate runs its judges in order and returns the
 * first refusal; an empty judge chain yields no refusal (allow).  The
 * gate itself never touches a framework, a session, or a client — it
 * decides purely from the request `{caller, target, prompt}`.
 *
 * Mechanism vs. strategy: the subagent tool provides the execution
 * capability and contains no delegation policy; the policy lives entirely
 * in the hook-contributed judges.  The gate belongs to the path, not the
 * mechanism — on both hosts the adapter layer applies it at the entry
 * boundary (the `tool.execute.before` event on OpenCode, the tool
 * registration wrapper on pi), so the decision is independent of the
 * entry point.
 *
 * @module
 */

/**
 * A delegation request judged by the gate.
 *
 * Fields are optional to represent "absent" at the caller boundary: a
 * judge that depends on a missing field skips that judgment (returns
 * `null`), preserving each host's original skip semantics.  The request
 * is host-agnostic — the decision depends only on these fields.
 *
 * A judge that needs `caller` declares it via `needsCaller` (see
 * `DelegationJudgeContribution`) so the consuming host knows whether the
 * asynchronous caller resolution must run.
 */
export interface DelegationRequest {
  /** The calling agent name, when resolvable. */
  caller?: string;
  /** The target subagent type, when a string was supplied. */
  target?: string;
  /** The delegated task prompt, when a string was supplied. */
  prompt?: string;
}

/**
 * A refusal produced by a judge, carrying the human-readable reason.
 */
export interface DelegationRefusal {
  /** Why the delegation was refused. */
  reason: string;
}

/**
 * A refusal produced by the composed gate, identifying the refusing
 * judge.
 *
 * `composeGate` attaches the judge's `name` to each refusal so a host
 * (or a downstream log consumer) can tell which strategy rejected the
 * delegation — this is what makes gate-blocked events filterable by the
 * refusing policy.
 */
export interface DelegationGateRefusal {
  /** The name of the judge that refused. */
  judge: string;
  /** Why the delegation was refused. */
  reason: string;
}

/**
 * One named delegation judge contributed by a hook unit.
 *
 * A judge inspects a request and returns a refusal, or `null` to allow
 * (including skipping when the fields it depends on are absent).
 */
export interface DelegationJudgeContribution {
  /** Judge label used for logging. */
  name: string;
  /**
   * Whether the judge needs the `caller` field of the request.
   *
   * Caller resolution is an asynchronous session query on the OpenCode
   * host, so the gate consumer runs it only when at least one judge
   * declares this — avoiding a session lookup on every delegation for
   * profiles whose judges (e.g. the prompt judge) ignore the caller.
   */
  needsCaller?: boolean;
  /** Decide on a delegation request. */
  judge(req: DelegationRequest): DelegationRefusal | null;
}

/**
 * The composed gate: runs its judges in order, returning the first
 * refusal or `null` when every judge allows.
 *
 * The returned refusal carries the `judge` name that produced it (see
 * `DelegationGateRefusal`).
 */
export type DelegationGate = (
  req: DelegationRequest,
) => DelegationGateRefusal | null;

/**
 * Compose an ordered list of judges into a single gate.
 *
 * The first judge to return a refusal wins; later judges are not run.
 * Each refusal is wrapped with the refusing judge's `name` so the
 * consumer (and any downstream log) can tell which strategy rejected
 * the delegation.  An empty chain composes to `null` (allow) — a valid
 * profile that enables no delegation judges intentionally passes every
 * delegation.
 *
 * @param judges - The judges in execution order.
 * @returns The composed gate, or `null` for an empty judge chain.
 */
export function composeGate(
  judges: DelegationJudgeContribution[],
): DelegationGate | null {
  if (judges.length === 0) return null;
  return (req) => {
    for (const contribution of judges) {
      const refusal = contribution.judge(req);
      if (refusal !== null) {
        return { judge: contribution.name, reason: refusal.reason };
      }
    }
    return null;
  };
}
