/**
 * Skill-level permission extraction and evaluation from the
 * `[agent.<name>].permission.skill` tables of config.toml.
 *
 * The pi `resources_discover` handler contributes the profile-listed skill
 * directories to pi at session bind time.  The contribution is filtered by
 * the active primary agent's skill rules (mirroring the OpenCode host,
 * which enforces the same rules through the installer-compiled
 * opencode.json): only skills the primary is allowed to use are
 * contributed.
 *
 * Parsing contract:
 *  - A missing `permission.skill` sub-table leaves the agent ABSENT from
 *    the returned map (= no filtering for that agent), matching the
 *    default-allow semantics of the config (e.g. dolphin declares only
 *    deny globs, so his unlisted skills stay allowed).
 *  - Declared TOML key order is preserved — evaluation is
 *    most-specific-wins and needs the declared order to break ties.
 *  - A skill rule value other than `"allow"` / `"deny"` (e.g. `"ask"`) is
 *    treated as `deny`: a skill that would prompt the user is not silently
 *    contributed.  A malformed (non-string) value is skipped and logged as
 *    a `skill_permission_invalid` warn, consistent with the warn style of
 *    `config-parse.ts`.
 *
 * Evaluation (`isSkillAllowed`): most-specific-wins.  An exact-name match
 * beats any glob; among glob patterns the longer pattern beats the shorter
 * (`"beaver-*"` beats `"*"`); ties resolve to the first declared rule.
 * No matching rule at all → ALLOW (default-allow, mirroring OpenCode).
 * Glob support is `*`-only: patterns without `*` are treated as exact
 * names.
 *
 * Framework-free: no host imports; the input is the whole parsed config
 * root, from which the top-level `agent` table is read.
 *
 * @module
 */

import { log } from "../../utils/logger.js";

/** One declared `[agent.<name>].permission.skill` rule. */
export type SkillPermissionRule = {
  /** The skill-name pattern (`*` wildcard only, or an exact name). */
  pattern: string;
  /** Whether the matched skill is contributed (`"allow"`) or withheld. */
  action: "allow" | "deny";
};

/**
 * Per-agent skill permission rules, keyed by agent name.
 *
 * The rule array preserves the declared TOML key order.  An agent absent
 * from the map has no skill rules (no filtering — default allow).
 */
export type SkillPermissionMap = Record<string, SkillPermissionRule[]>;

/**
 * Extract the `[agent.<name>].permission.skill` rules from the raw config.
 *
 * Reads the top-level `agent` table (sibling of `zoo`) from the whole
 * parsed config root, mirroring `parseAgentModes`.  For every agent entry
 * the `permission.skill` sub-table is collected into an ordered rule
 * list.  Fail-closed: an absent or non-object `agent` table yields an
 * empty map silently, a non-object agent entry or a non-object
 * `permission.skill` sub-table is skipped silently, a rule value other
 * than `"allow"` / `"deny"` is treated as `deny`, and a malformed
 * (non-string) value is skipped with exactly one `skill_permission_invalid`
 * warn.
 *
 * @param rawConfig - The whole parsed config.toml (root object, carrying
 *   the top-level `agent` table).
 * @returns A map of agent name → ordered skill rules.  Agents without a
 *   `permission.skill` sub-table are absent (no filtering).
 */
export function parseSkillPermissions(rawConfig: any): SkillPermissionMap {
  const agents = rawConfig?.agent as Record<string, unknown> | undefined;
  if (agents == null || typeof agents !== "object" || Array.isArray(agents)) {
    return {};
  }

  const permissions: SkillPermissionMap = {};
  for (const [name, entry] of Object.entries(agents)) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const permission = (entry as Record<string, unknown>).permission;
    if (permission == null || typeof permission !== "object") continue;
    const skill = (permission as Record<string, unknown>).skill;
    if (skill == null || typeof skill !== "object" || Array.isArray(skill)) {
      continue;
    }

    const rules: SkillPermissionRule[] = [];
    for (const [pattern, value] of Object.entries(
      skill as Record<string, unknown>,
    )) {
      if (value !== "allow" && value !== "deny") {
        if (typeof value !== "string") {
          log("config", "skill_permission_invalid", "", undefined, "warn", {
            agent: name,
            key: pattern,
            value,
          });
          continue;
        }
        // A non-allow/deny action (e.g. "ask") never silently contributes
        // the skill — treat it as a deny.
        rules.push({ pattern, action: "deny" });
        continue;
      }
      rules.push({ pattern, action: value });
    }
    permissions[name] = rules;
  }
  return permissions;
}

/**
 * Convert a skill-name pattern to a `*`-only glob regex.
 *
 * `*` matches any run of characters (including none); every other
 * character is matched literally.  Patterns without `*` are exact names.
 *
 * @param pattern - The declared pattern.
 * @returns The anchored, case-sensitive regex.
 */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const anchored = `^${escaped.replace(/\*/g, ".*")}$`;
  return new RegExp(anchored);
}

/**
 * Evaluate whether a skill is allowed for a rule set (most-specific-wins).
 *
 * An exact-name rule beats any glob rule; among glob rules the longer
 * pattern beats the shorter; equal-specificity ties resolve to the first
 * declared rule.  A skill with no matching rule is allowed (default-allow,
 * mirroring OpenCode semantics — an agent without a `"*"` rule keeps his
 * unlisted skills).
 *
 * @param rules - The agent's ordered skill rules (from
 *   `parseSkillPermissions`), possibly empty.
 * @param skillName - The skill directory name to evaluate.
 * @returns `true` when the skill may be contributed.
 */
export function isSkillAllowed(
  rules: SkillPermissionRule[],
  skillName: string,
): boolean {
  const candidates = rules.filter((rule) =>
    patternToRegExp(rule.pattern).test(skillName),
  );
  if (candidates.length === 0) return true;

  candidates.sort((a, b) => {
    const exactA = !a.pattern.includes("*") ? 1 : 0;
    const exactB = !b.pattern.includes("*") ? 1 : 0;
    if (exactA !== exactB) return exactB - exactA;
    if (a.pattern.length !== b.pattern.length) {
      return b.pattern.length - a.pattern.length;
    }
    // Ties keep declared order (stable sort).
    return 0;
  });

  return candidates[0].action === "allow";
}
