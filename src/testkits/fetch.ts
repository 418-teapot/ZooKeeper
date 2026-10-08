/**
 * Test doubles for `globalThis.fetch`.
 *
 * The fetch suites swap out `globalThis.fetch` per test so no real network
 * request is made.  `installFetchMock` centralises that swap and records every
 * requested URL; `restoreFetch` puts the original back (call it from
 * `afterEach` so the swap never leaks into a later test file).
 *
 * @module
 */

/** A fake fetch handler: given a requested URL, returns the response to use. */
export type FetchHandler = (url: string) => Response;

/** A `fetch` mock plus its recording and teardown handles. */
export interface FetchMock {
  /** Every URL passed to the fake `fetch`, in call order. */
  calls: string[];
  /** Restore the `globalThis.fetch` that was in place at import. */
  restoreFetch(): void;
}

const originalFetch = globalThis.fetch;

/** Restore the `globalThis.fetch` replaced by `installFetchMock`. */
export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

/**
 * Install a fake `fetch` that records every requested URL and answers with
 * `handler(url)`.
 */
export function installFetchMock(handler: FetchHandler): FetchMock {
  const calls: string[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push(url);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
  return { calls, restoreFetch };
}
