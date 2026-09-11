/**
 * Unit tests for the native HTML→Markdown converter loader
 * (`src/core/webfetch/native.ts`).
 *
 * Covers: the single flat addon candidate (`tools/zweb/zweb.node`) and
 * the fail-closed `null` contract — an empty list, paths that do not
 * exist, and paths that exist but cannot be loaded all yield `null`
 * instead of throwing.  When this machine has a built native addon, a
 * real load plus an HTML→Markdown conversion is exercised as well.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  htmlConverterCandidatePaths,
  loadHtmlConverter,
  loadHtmlConverterFrom,
} from "./native.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Repository root, derived the same way the module under test does. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Fake root used for deterministic path-shape assertions. */
const FAKE_ROOT = "/repo";

/** The candidate list for this machine. */
const realCandidates = htmlConverterCandidatePaths();

/** Whether any native candidate exists on this machine. */
const nativeAvailable = realCandidates.some((path) => existsSync(path));

/** An existing file that is not a loadable native module. */
const NOT_A_MODULE = resolve(REPO_ROOT, "src/core/webfetch/native.ts");

// ---------------------------------------------------------------------------
// Candidate path resolution
// ---------------------------------------------------------------------------

describe("htmlConverterCandidatePaths", () => {
  it("returns the single flat addon path", () => {
    const paths = htmlConverterCandidatePaths({ root: FAKE_ROOT });
    assert.deepEqual(paths, ["/repo/tools/zweb/zweb.node"]);
  });

  it("defaults to this repository root", () => {
    const paths = htmlConverterCandidatePaths();
    assert.deepEqual(paths, [`${REPO_ROOT}/tools/zweb/zweb.node`]);
  });
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

describe("loadHtmlConverterFrom", () => {
  it("returns null for an empty candidate list", () => {
    assert.equal(loadHtmlConverterFrom([]), null);
  });

  it("returns null when no candidate exists", () => {
    const paths = htmlConverterCandidatePaths({
      root: "/nonexistent-native-root",
    });
    assert.equal(loadHtmlConverterFrom(paths), null);
  });

  it("returns null for an existing but unloadable file", () => {
    assert.equal(existsSync(NOT_A_MODULE), true);
    assert.equal(loadHtmlConverterFrom([NOT_A_MODULE]), null);
  });
});

describe("loadHtmlConverter", () => {
  it("loads this machine's native converter and converts HTML", () => {
    if (!nativeAvailable) return; // native addon not built on this machine

    const converter = loadHtmlConverter();
    assert.ok(converter, "expected the native addon to load");
    const markdown = converter("<h1>x</h1>");
    assert.match(markdown, /# x/);
  });

  it("falls through a broken candidate to a working one", () => {
    if (!nativeAvailable) return; // native addon not built on this machine

    const converter = loadHtmlConverterFrom([NOT_A_MODULE, ...realCandidates]);
    assert.ok(converter, "expected a later candidate to load");
    assert.match(converter("<h1>x</h1>"), /# x/);
  });
});
