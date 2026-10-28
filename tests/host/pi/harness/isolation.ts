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
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  /** The single extension file pi discovers (real extension + probe). */
  entryPath: string;
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
 * @returns The created root and its paths.
 */
export function createIsolatedRoot(options: {
  repoRoot: string;
  scenario: string;
  baseDir?: string;
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
  const entryPath = join(
    repoRoot,
    "tests",
    "host",
    "pi",
    "harness",
    "extension",
    "entry.ts",
  );

  writeJson(join(agentDir, "settings.json"), {
    defaultProvider: PROVIDER_ID,
    defaultModel: MODEL_ID,
    defaultThinkingLevel: "off",
    defaultTools: [],
    extensions: [entryPath],
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
  writeJson(join(agentDir, "agents.json"), {
    agents: { lynx: { provider: PROVIDER_ID, model: MODEL_ID } },
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
    entryPath,
  };
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
