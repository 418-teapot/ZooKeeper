/**
 * Sequencer: a one-at-a-time gate over some shared state.
 *
 * A host may dispatch several tool calls at once, and a tool that changes
 * state through a read-modify-write cycle loses updates that way. The
 * invariant worth protecting is "changes to this resource do not
 * interleave", not "no other tool may run while I am running" — so the
 * exclusion lives here, beside the state it protects, rather than as a
 * host scheduling hint that would also idle unrelated concurrent work.
 *
 * Semantics:
 *  - while the gate is free, a submitted function starts immediately (no
 *    waiting a tick — a caller that mounts UI synchronously still does);
 *  - concurrent entrants start in arrival order, and the next one starts
 *    only after the previous settles;
 *  - a rejected function is reported to its own caller and never blocks
 *    the ones queued behind it;
 *  - no re-entrancy detection: a function that submits to its own gate
 *    while running waits for itself, so callers must not do that.
 *
 * @module
 */

/**
 * A single-slot FIFO gate: queued functions start in submission order and
 * never overlap.
 */
export type Sequencer = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Create a sequencer.
 *
 * @returns A function that runs `fn` alone, behind everything submitted
 *   before it, resolving or rejecting with `fn`'s own outcome.
 */
export function createSequencer(): Sequencer {
  const waiting: Array<() => void> = [];
  let busy = false;

  /** Hand the gate to the next caller, or free it when none is left. */
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) busy = false;
    else next();
  };

  return <T>(fn: () => Promise<T>): Promise<T> => {
    // The async body runs synchronously up to its first await, so `fn`
    // starts the moment `run` is called; `finally` then settles the gate
    // whether `fn` resolved or rejected.
    const run = async (): Promise<T> => {
      busy = true;
      try {
        return await fn();
      } finally {
        release();
      }
    };
    if (!busy) return run();
    return new Promise<void>((resolve) => waiting.push(resolve)).then(run);
  };
}
