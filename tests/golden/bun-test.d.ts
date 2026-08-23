/**
 * Minimal type declarations for the `bun:test` module.
 *
 * The repository's `tsc --noEmit` check has no Bun type package
 * installed, so the golden tests declare the small subset of the
 * `bun:test` API they use.  Runtime behaviour comes from Bun itself.
 *
 * @module
 */

declare module "bun:test" {
  export interface TestExpectation {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toMatch(regexp: RegExp | string): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toThrow(expected?: string | RegExp): void;
    readonly not: TestExpectation;
    readonly rejects: TestExpectation;
    readonly resolves: TestExpectation;
  }

  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function expect(actual: unknown, message?: string): TestExpectation;
}
