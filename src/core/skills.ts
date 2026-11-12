/**
 * Generation skill catalog — discover once, then select.
 *
 * A skill is a directory under skills/ and a selectable resource, not an
 * executable unit.  A runtime generation reads the directory once, keeps the
 * resulting snapshot, and selects the names its profile declares.  Every
 * later consumer (a host config write, a session bind, a sub-session) reads
 * that selection and never reads the directory again.
 *
 * The snapshot records the three facts a consumer needs: the usable entries
 * (name plus absolute path, name-sorted), the entries that exist but cannot
 * be used (a plain file, a dangling link) and a root read failure.  The
 * selection keeps a missing name and an unusable one apart, so a host can
 * report the two causes separately.
 *
 * Directory presence is the only validity rule: a directory, or a symbolic
 * link to one, is a skill.  The hosts load the skill content themselves.
 *
 * Framework-free: no host imports, no logging.  The discovery reads the
 * filesystem once; the selection is pure.
 *
 * @module
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  isSkillAllowed,
  type SkillPermissionRule,
} from "./permissions/skill-permissions.js";

/** One usable skill: the directory name and its absolute path. */
export interface SkillEntry {
  /** The directory name, which is also the skill name. */
  readonly name: string;
  /** The absolute path of the skill directory. */
  readonly path: string;
}

/** One generation's immutable reading of the skills directory. */
export interface SkillSnapshot {
  /** The usable entries, sorted by name. */
  readonly entries: readonly SkillEntry[];
  /** Names present in the directory but unusable, sorted by name. */
  readonly invalid: readonly string[];
  /** The root read failure, or `null` when the directory was read. */
  readonly error: string | null;
}

/** The profile's skills, resolved against one snapshot. */
export interface SkillSelection {
  /** The selected entries, in profile order. */
  readonly selected: readonly SkillEntry[];
  /** Profile names the directory does not hold, in profile order. */
  readonly missing: readonly string[];
  /** Profile names present but unusable, in profile order. */
  readonly invalid: readonly string[];
}

/**
 * How one assembly pass obtains its skills.
 *
 * `read` is a generation start: it reads the directory once and selects the
 * profile's names from the snapshot.  `given` is a runtime that inherits the
 * selection its outer generation already made, so it reads no directory and
 * repeats no missing, invalid or root-read diagnostic — the outer pass
 * reported them.  It still logs every delivered entry as registered.
 */
export type SkillSource =
  | {
      readonly kind: "read";
      /** Absolute path of the directory holding the skills. */
      readonly dir: string;
      /** The directory read; defaults to {@link discoverSkills}. */
      readonly discover?: (dir: string) => SkillSnapshot;
    }
  | {
      readonly kind: "given";
      /** The entries the outer pass selected. */
      readonly entries: readonly SkillEntry[];
    };

/**
 * Whether one directory entry is a usable skill directory.
 *
 * An entry that reports itself as a directory is usable without further
 * reading.  Every other entry is followed through `statSync`, so a symbolic
 * link to a directory counts and a dead or cyclic link does not.
 *
 * @param path - Absolute path of the entry.
 * @param dirent - The entry as the directory read reported it.
 * @returns True when the entry resolves to a directory.
 */
function isUsableDirectory(path: string, dirent: Dirent): boolean {
  if (dirent.isDirectory()) return true;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read the skills directory into an immutable snapshot.
 *
 * Fail-closed: a root the host cannot read yields no entries and an `error`,
 * never a throw, and an unreadable entry is reported as invalid.
 *
 * @param skillsDir - Absolute path of the directory holding the skills.
 * @returns The snapshot.
 */
export function discoverSkills(skillsDir: string): SkillSnapshot {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(skillsDir, { withFileTypes: true });
  } catch (err) {
    return { entries: [], invalid: [], error: String(err) };
  }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entries: SkillEntry[] = [];
  const invalid: string[] = [];
  for (const dirent of dirents) {
    const path = resolve(skillsDir, dirent.name);
    if (!isUsableDirectory(path, dirent)) {
      invalid.push(dirent.name);
      continue;
    }
    entries.push({ name: dirent.name, path });
  }
  return { entries, invalid, error: null };
}

/**
 * Select the profile's skills from one snapshot.
 *
 * A name the snapshot holds selects that entry; a name it reports invalid and
 * a name it does not hold are skipped and reported separately.  A name the
 * profile lists twice selects one entry.
 *
 * @param snapshot - The generation's snapshot.
 * @param profileSkills - Skill names the active profile declares.
 * @returns The selection.
 */
export function selectSkills(
  snapshot: SkillSnapshot,
  profileSkills: readonly string[],
): SkillSelection {
  const available = new Map(
    snapshot.entries.map((entry) => [entry.name, entry]),
  );
  const unusable = new Set(snapshot.invalid);
  const selected: SkillEntry[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const name of profileSkills) {
    const entry = available.get(name);
    if (entry !== undefined) {
      if (!selected.includes(entry)) selected.push(entry);
    } else if (unusable.has(name)) {
      if (!invalid.includes(name)) invalid.push(name);
    } else if (!missing.includes(name)) {
      missing.push(name);
    }
  }
  return { selected, missing, invalid };
}

/**
 * Keep the entries an agent may discover.
 *
 * An agent without rules (`undefined`) is unrestricted, mirroring the
 * default-allow config semantics.
 *
 * @param entries - The selected entries.
 * @param rules - The agent's ordered skill rules, or `undefined` when the
 *   agent declares none.
 * @returns The entries the agent may discover, in the given order.
 */
export function filterSkillEntries(
  entries: readonly SkillEntry[],
  rules: SkillPermissionRule[] | undefined,
): SkillEntry[] {
  if (rules === undefined) return [...entries];
  return entries.filter((entry) => isSkillAllowed(rules, entry.name));
}
