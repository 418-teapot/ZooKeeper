/**
 * Mechanical boundary test: src/core/** must never import from src/adapters/.
 *
 * Recursively scans every non-test TypeScript file under src/core and asserts
 * that no import or export specifier contains `/adapters/`. This enforces the
 * host-agnostic invariant of the core layer.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CORE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Regex matching import/export specifier strings.
 *
 * Covers:
 * - `import { x } from "path"`
 * - `export { x } from "path"`
 * - `import type { x } from "path"`
 * - `import "path"` (side-effect imports)
 *
 * Group 1 is the module specifier.
 */
const IMPORT_EXPORT_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g;

/**
 * Recursively collect all `.ts` files under `dir`, excluding test files.
 */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

describe("core import boundary", () => {
  it("never imports from src/adapters/", () => {
    const violations: Array<{ file: string; specifier: string }> = [];

    for (const file of collectSourceFiles(CORE_DIR)) {
      const content = readFileSync(file, "utf-8");

      for (const match of content.matchAll(IMPORT_EXPORT_PATTERN)) {
        const specifier = match[1];
        if (specifier?.includes("/adapters/")) {
          violations.push({ file, specifier });
        }
      }
    }

    assert.strictEqual(
      violations.length,
      0,
      `core files must not import from adapters:\n${violations
        .map((v) => `  ${v.file}: ${v.specifier}`)
        .join("\n")}`,
    );
  });
});
