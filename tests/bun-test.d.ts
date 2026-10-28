/**
 * Minimal type declarations for the `bun:test` module.
 *
 * The repository has no Bun type package installed, so the TypeScript test
 * suites share this declaration of the `bun:test` API subset they use.
 * Runtime behaviour comes from Bun itself.
 *
 * @module
 */

declare module "bun:test" {
  export interface TestExpectation {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toContain(expected: string): void;
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
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function expect(actual: unknown, message?: string): TestExpectation;
}
