/**
 * Glob/wildcard pattern matching for tool name protection.
 *
 * Provides `matchesGlob` for converting glob patterns to regex and testing,
 * and `isToolNameProtected` for checking tool names against a list of
 * patterns (exact matches first, then glob patterns).
 *
 * @module
 */

/**
 * Escape regex special characters in a string.
 * Only characters that are not glob metacharacters (*, ?, **) are escaped.
 *
 * @param str - The string to escape.
 * @returns The string with regex special characters escaped.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a glob pattern to a RegExp.
 *
 * Supported glob features:
 * - `*` — matches any characters except `/`
 * - `?` — matches any single character except `/`
 * - `**` — matches any characters including `/`
 *
 * @param pattern - The glob pattern to convert.
 * @returns A RegExp equivalent to the glob pattern.
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = "^";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*" && pattern[i + 1] === "*") {
      // `**` — match anything including `/`
      regexStr += ".*";
      i += 2;
    } else if (ch === "*") {
      // `*` — match anything except `/`
      regexStr += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      // `?` — match single char except `/`
      regexStr += "[^/]";
      i += 1;
    } else {
      // Escape other regex special chars
      regexStr += escapeRegex(ch);
      i += 1;
    }
  }

  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Check if an input string matches a glob pattern.
 *
 * Supports `*` (any chars except `/`), `?` (single char except `/`),
 * and `**` (any chars including `/`).
 *
 * @param input   - The string to test.
 * @param pattern - The glob pattern to test against.
 * @returns `true` if the input matches the pattern.
 */
export function matchesGlob(input: string, pattern: string): boolean {
  return globToRegex(pattern).test(input);
}

/**
 * Check if a tool name is protected by any of the given patterns.
 *
 * First checks exact match against the patterns list, then falls back to
 * glob matching for patterns containing `*` or `?`.
 *
 * @param toolName - The tool name to check.
 * @param patterns - The list of patterns (exact names or globs).
 * @returns `true` if the tool name matches any pattern.
 */
export function isToolNameProtected(
  toolName: string,
  patterns: string[],
): boolean {
  // Fast path: exact match
  if (patterns.includes(toolName)) return true;

  // Glob match for patterns containing wildcards
  for (const pattern of patterns) {
    if (
      (pattern.includes("*") || pattern.includes("?")) &&
      matchesGlob(toolName, pattern)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extract file paths from tool call parameters.
 *
 * Inspects common parameter keys (`path`, `filePath`, `file`) and the
 * apply_patch-style nested `file.path` pattern.
 *
 * @param params - The tool call parameters.
 * @returns Array of file path strings found, possibly empty.
 */
export function getFilePathsFromParameters(
  params: Record<string, unknown>,
): string[] {
  const paths: string[] = [];

  // Check common patterns: path, filePath, file
  for (const key of ["path", "filePath", "file"]) {
    if (typeof params[key] === "string") {
      paths.push(params[key] as string);
    }
  }

  // Check apply_patch pattern: { file: { path: "..." } }
  const file = params.file;
  if (file && typeof file === "object" && typeof (file as Record<string, unknown>).path === "string") {
    paths.push((file as Record<string, unknown>).path as string);
  }

  // Check apply_patch content — scan for "*** Add File:", etc.
  for (const key of Object.keys(params)) {
    if (typeof params[key] === "string") {
      const content = params[key] as string;
      const lines = content.split("\n");
      for (const line of lines) {
        const match = line.match(/^\*\*\* (?:Add|Delete|Update) File:\s*(.+)$/);
        if (match) {
          paths.push(match[1].trim());
        }
      }
    }
  }

  // Check multiedit nested edits[].filePath
  const edits = params.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (typeof edit === "object" && edit && typeof (edit as any).filePath === "string") {
        paths.push((edit as any).filePath);
      }
    }
  }

  return paths;
}

/**
 * Check if a file path matches any of the given glob patterns.
 *
 * Delegates to {@link matchesGlob} for each pattern.
 *
 * @param filePath - The file path to check.
 * @param patterns - List of glob patterns to test against.
 * @returns `true` if the file path matches any pattern.
 */
export function isFilePathProtected(
  filePath: string,
  patterns: string[],
): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((p) => matchesGlob(filePath, p));
}
