/**
 * Shared profile skill-directory scan.
 *
 * Both hosts discover skills the same way: read the entries of a skills
 * directory and keep only the ones the active profile names AND that are
 * actually directories.  The host adapters differ only in where the
 * results land — pi returns the paths to `loadSkillsFromDir`, OpenCode
 * writes them into `config.skills.paths` — so the scan itself lives here.
 *
 * @module
 */

import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../utils/logger.js";

/**
 * Collect the absolute paths of the profile-listed skill directories.
 *
 * Fail-closed: an entry registers only when its name appears in
 * `profileSkills` AND it is a directory.  A missing skills directory
 * (ENOENT) is skipped silently; any other read error logs a warning and
 * yields the paths collected so far rather than throwing.
 *
 * @param skillsDir - Absolute path of the directory holding skill
 *   directories.
 * @param profileSkills - Skill directory names declared by the active
 *   profile.
 * @returns Absolute paths of the existing, profile-listed directories.
 */
export function scanSkillDirectories(
  skillsDir: string,
  profileSkills: string[],
): string[] {
  const paths: string[] = [];
  try {
    for (const entry of readdirSync(skillsDir)) {
      if (!profileSkills.includes(entry)) continue;
      const fullPath = resolve(skillsDir, entry);
      if (!statSync(fullPath).isDirectory()) continue;
      paths.push(fullPath);
      log.debug({ hook: "plugin", event: "skill_registered", skill: entry });
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      log.warn({
        hook: "plugin",
        event: "skill_register_error",
        error: String(err),
      });
    }
  }
  return paths;
}
