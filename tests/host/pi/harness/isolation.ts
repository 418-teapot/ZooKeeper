/**
 * Per-scenario isolation.
 *
 * Every core scenario runs in its own temporary root: the pi agent
 * directory (settings/models/agents), the session store, the mode state
 * file, the working directory and the artifacts.  The child environment is
 * built from an allowlist, so the developer's HOME, pi configuration, proxy
 * settings and provider credentials never reach the pi process.  The only
 * inputs from outside the root are the pi installation, the ZooKeeper
 * sources and the repository's own config.toml.
 *
 * A scenario that needs a different value from config.toml runs against an
 * isolated copy of ZooKeeper instead: the copy's real `src/` makes the
 * production config lookup read the copy's config.toml, and every other
 * repository input stays a symlink.  The repository config.toml itself is
 * never rewritten.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Provider id registered by the harness extension. */
export const PROVIDER_ID = "e2e";

/** API id the deterministic provider owns (never spoken over the wire). */
export const PROVIDER_API = "e2e-opaque";

/** Model id selected everywhere, including in the SDK sub-session. */
export const MODEL_ID = "deterministic";

/** `provider/model` reference the assertions expect in `get_state`. */
export const MODEL_REF = `${PROVIDER_ID}/${MODEL_ID}`;

/** ZooKeeper mode profile that carries the todo and subagent units. */
export const ZOO_MODE = "poly";

/**
 * Environment inherited from the harness process.
 *
 * Deliberately short: everything else is set by the harness, so no
 * credential, proxy or pi location can leak in.
 */
const INHERITED_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;

/** Keys the harness owns; caller-provided extras may not override them. */
const HARNESS_OWNED_KEYS = new Set([
  "HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "ZOO_PI_DATA_DIR",
  "PI_OFFLINE",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
]);

/** One scenario's temporary root and its derived paths. */
export interface IsolatedRoot {
  /** Repository under test (read only). */
  repoRoot: string;
  /** Scenario id this root belongs to. */
  scenario: string;
  /** Temporary root of the scenario. */
  root: string;
  /** Isolated HOME of the pi process. */
  home: string;
  /** `PI_CODING_AGENT_DIR`. */
  agentDir: string;
  /** `PI_CODING_AGENT_SESSION_DIR`. */
  sessionDir: string;
  /** pi's working directory (kept empty). */
  workDir: string;
  /** Directory holding RPC/trace/stderr artifacts. */
  artifactsDir: string;
  /** Trace file this scenario's pi process appends to. */
  tracePath: string;
  /** ZooKeeper's extension entry (the repository's real `src/pi.ts`, or the
   * entry of this scenario's isolated copy). */
  zooEntryPath: string;
  /** The observation probe's extension entry. */
  probeEntryPath: string;
}

/** Filesystem-safe scenario slug for directory names. */
function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/** Write a JSON file, creating parent directories. */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Create a fresh isolated root for one scenario.
 *
 * @param options - Creation inputs.
 * @param options.repoRoot - Repository under test.
 * @param options.scenario - Scenario id (used in the directory name).
 * @param options.subagentTimeoutSeconds - When given, ZooKeeper runs from an
 *   isolated copy whose `[zoo.subagent].timeout` carries this value.
 * @returns The created root and its paths.
 */
export function createIsolatedRoot(options: {
  repoRoot: string;
  scenario: string;
  baseDir?: string;
  subagentTimeoutSeconds?: number;
}): IsolatedRoot {
  const { repoRoot, scenario } = options;
  const parent = options.baseDir ?? tmpdir();
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, `zookeeper-pi-e2e-${slug(scenario)}-`));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const sessionDir = join(agentDir, "sessions");
  const workDir = join(root, "work");
  const artifactsDir = join(root, "artifacts");
  for (const dir of [agentDir, sessionDir, workDir, artifactsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  // Two extension files, ZooKeeper first: the probe observes the runtime of
  // a sub-session that loads ZooKeeper from its inline factory, so both
  // must be loadable independently.
  const zooEntryPath =
    options.subagentTimeoutSeconds === undefined
      ? join(repoRoot, "src", "pi.ts")
      : createZooCopy(repoRoot, root, options.subagentTimeoutSeconds);
  const probeEntryPath = join(
    repoRoot,
    "tests",
    "host",
    "pi",
    "harness",
    "extension",
    "probe-entry.ts",
  );

  writeJson(join(agentDir, "settings.json"), {
    defaultProvider: PROVIDER_ID,
    defaultModel: MODEL_ID,
    defaultThinkingLevel: "off",
    defaultTools: [],
    extensions: [zooEntryPath, probeEntryPath],
    quietStartup: true,
    retry: { enabled: false },
    compaction: { enabled: false },
  });

  // The provider owns a private api id and never performs a request; the
  // baseUrl is unroutable metadata, so a regression that tried to connect
  // would fail the scenario instead of reaching a real service.
  writeJson(join(agentDir, "models.json"), {
    providers: {
      [PROVIDER_ID]: {
        name: "E2E Deterministic",
        baseUrl: "http://127.0.0.1:9/e2e",
        api: PROVIDER_API,
        apiKey: "e2e-dummy",
        models: [
          {
            id: MODEL_ID,
            name: MODEL_ID,
            api: PROVIDER_API,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  });

  // Strict mode: the subagent tool reads the child model from agents.json.
  // The nested scenario delegates two levels, so every target it names is
  // listed here.
  const childModel = { provider: PROVIDER_ID, model: MODEL_ID };
  writeJson(join(agentDir, "agents.json"), {
    agents: {
      lynx: childModel,
      beaver: childModel,
      spider: childModel,
    },
  });

  // config.toml declares several [zoo.mode.*] profiles; the active one
  // lives in the mode state file, which resolves under the isolated HOME.
  writeJson(join(home, ".zoo", "mode.json"), { mode: ZOO_MODE });

  return {
    repoRoot,
    scenario,
    root,
    home,
    agentDir,
    sessionDir,
    workDir,
    artifactsDir,
    tracePath: join(artifactsDir, "trace.jsonl"),
    zooEntryPath,
    probeEntryPath,
  };
}

/**
 * Repository inputs the isolated copy reads read-only through symlinks.
 *
 * The production code resolves these from its module location: the toml
 * parser, the skill directories, the release artifacts, the zweb addon and
 * the packages a sub-session imports dynamically.
 */
const SHARED_INPUTS = [
  "node_modules",
  "vendor",
  "skills",
  "release",
  "tools",
] as const;

/**
 * Replace the `timeout` of the `[zoo.subagent]` section.
 *
 * @param text - The config.toml text.
 * @param seconds - Timeout to write.
 * @returns The text with only that section's timeout changed.
 */
function withSubagentTimeout(text: string, seconds: number): string {
  const header = "[zoo.subagent]";
  const start = text.indexOf(header);
  if (start < 0) return `${text}${header}\ntimeout = ${seconds}\n`;
  const bodyStart = text.indexOf("\n", start) + 1;
  const nextSection = text.indexOf("\n[", bodyStart);
  const bodyEnd = nextSection < 0 ? text.length : nextSection;
  const body = text.slice(bodyStart, bodyEnd);
  const replaced = /^timeout\s*=.*$/m.test(body)
    ? body.replace(/^timeout\s*=.*$/m, `timeout = ${seconds}`)
    : `timeout = ${seconds}\n${body}`;
  return `${text.slice(0, bodyStart)}${replaced}${text.slice(bodyEnd)}`;
}

/**
 * Copy ZooKeeper into the scenario root with a different config.toml.
 *
 * The production config path resolves from this module's real location, so
 * the copy keeps a real `src/`; everything else links back to the
 * repository.  The copy lives under the scenario root and is removed with
 * it.
 *
 * @param repoRoot - Repository under test.
 * @param root - Scenario root.
 * @param subagentTimeoutSeconds - Timeout the copied config.toml carries.
 * @returns The copy's extension entry.
 */
function createZooCopy(
  repoRoot: string,
  root: string,
  subagentTimeoutSeconds: number,
): string {
  const zooDir = join(root, "zoo");
  mkdirSync(zooDir, { recursive: true });
  cpSync(join(repoRoot, "src"), join(zooDir, "src"), { recursive: true });
  copyFileSync(join(repoRoot, "package.json"), join(zooDir, "package.json"));
  const config = readFileSync(join(repoRoot, "config.toml"), "utf8");
  writeFileSync(
    join(zooDir, "config.toml"),
    withSubagentTimeout(config, subagentTimeoutSeconds),
  );
  for (const input of SHARED_INPUTS) {
    const target = join(repoRoot, input);
    if (existsSync(target)) {
      symlinkSync(target, join(zooDir, input), "dir");
    }
  }
  return join(zooDir, "src", "pi.ts");
}

/**
 * Build the environment of one pi process.
 *
 * @param base - Ambient environment (usually `process.env`).
 * @param isolated - The scenario root.
 * @param extra - Additional harness-owned values (e.g. the trace path).
 * @returns The child environment to spawn pi with.
 */
export function buildChildEnv(
  base: Record<string, string | undefined>,
  isolated: IsolatedRoot,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_KEYS) {
    const value = base[key];
    if (typeof value === "string" && value !== "") env[key] = value;
  }
  Object.assign(env, {
    HOME: isolated.home,
    PI_CODING_AGENT_DIR: isolated.agentDir,
    PI_CODING_AGENT_SESSION_DIR: isolated.sessionDir,
    ZOO_PI_DATA_DIR: isolated.agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  });
  for (const [key, value] of Object.entries(extra)) {
    if (HARNESS_OWNED_KEYS.has(key)) continue;
    env[key] = value;
  }
  return env;
}
