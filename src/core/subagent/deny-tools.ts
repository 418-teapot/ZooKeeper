/**
 * Tool-level permission deny extraction from the `[agent.<name>].permission`
 * tables of config.toml.
 *
 * The primary-switch command trims the pi active tool set by the target
 * agent's tool-level permission denies.  Only TOP-LEVEL `permission`
 * keys whose value is exactly `"deny"` count as tool-level denies — the
 * sub-tables (`permission.bash`, `permission.edit`, `permission.skill`)
 * encode fine-grained bash-pattern / edit-glob / skill rules and are
 * explicitly NOT tool-level denies (those rules are not implemented on
 * this host).
 *
 * Framework-free: no host imports, and the input is the raw permission
 * table value — the caller extracts it from the parsed config.  Fail
 * closed: a missing or malformed table yields an empty list rather than
 * guessing.
 *
 * @module
 */

/**
 * Per-agent map of tool-level denied tool names, keyed by agent name.
 *
 * Each value is the sorted list of top-level `[agent.<name>].permission`
 * keys whose value is exactly `"deny"`.  An agent absent from the map
 * has no tool-level denies (the active tool set is left untouched).
 */
export type AgentPermissionMap = Record<string, string[]>;

/**
 * Extract the sorted list of tool-level denied tool names from a raw
 * `[agent.<name>].permission` table.
 *
 * Only top-level keys whose value is exactly the string `"deny"` are
 * collected.  Sub-table values (objects / arrays — the fine-grained
 * `permission.bash` / `permission.edit` / `permission.skill` rules) are
 * never treated as tool-level denies, and any other scalar value
 * (`"ask"`, `"allow"`, ...) is ignored.  The result is sorted for
 * deterministic output regardless of TOML key order.
 *
 * @param permission - The raw `permission` table value, or `undefined`
 *   when the agent declares none.
 * @returns The sorted denied tool names (empty when none or malformed).
 */
export function extractDeniedTools(permission: unknown): string[] {
  if (
    permission === null ||
    typeof permission !== "object" ||
    Array.isArray(permission)
  ) {
    return [];
  }

  const denied: string[] = [];
  for (const [key, value] of Object.entries(
    permission as Record<string, unknown>,
  )) {
    if (value === "deny") denied.push(key);
  }
  return denied.sort();
}
