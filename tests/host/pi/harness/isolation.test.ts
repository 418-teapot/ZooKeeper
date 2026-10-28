/**
 * Self-tests for the per-scenario isolation builder.
 *
 * The E2E run must never read the developer's HOME, pi configuration or
 * provider credentials.  These tests prove the builder yields a fresh root
 * per scenario and a child environment carrying only harness-owned values.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildEnv, createIsolatedRoot } from "./isolation.js";

/** Repository root (three levels above this file). */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** A plausible developer environment full of secrets. */
const DEVELOPER_ENV = {
  HOME: "/home/developer",
  PATH: "/usr/local/bin:/usr/bin",
  LANG: "zh_CN.UTF-8",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  OPENAI_API_KEY: "sk-openai-secret",
  HTTP_PROXY: "http://proxy.internal:3128",
  PI_CODING_AGENT_DIR: "/home/developer/.pi/agent",
  ZOO_PI_DATA_DIR: "/home/developer/.pi/agent",
};

describe("createIsolatedRoot", () => {
  test("creates one fresh root per scenario with owned directories", () => {
    const first = createIsolatedRoot({ repoRoot: REPO_ROOT, scenario: "a" });
    const second = createIsolatedRoot({ repoRoot: REPO_ROOT, scenario: "a" });
    try {
      expect(first.root).not.toBe(second.root);
      for (const dir of [
        first.home,
        first.agentDir,
        first.sessionDir,
        first.workDir,
        first.artifactsDir,
      ]) {
        expect(existsSync(dir)).toBe(true);
        expect(dir.startsWith(first.root)).toBe(true);
      }
      // The extension entry is the repository's real one, never a copy.
      const settings = JSON.parse(
        readFileSync(join(first.agentDir, "settings.json"), "utf8"),
      ) as { extensions?: string[] };
      expect(settings.extensions?.length).toBe(1);
      expect(settings.extensions?.[0]?.startsWith(REPO_ROOT)).toBe(true);
      expect(settings.extensions?.[0]?.endsWith("entry.ts")).toBe(true);
    } finally {
      rmSync(first.root, { recursive: true, force: true });
      rmSync(second.root, { recursive: true, force: true });
    }
  });

  test("writes the model, agent and mode files inside the root", () => {
    const isolated = createIsolatedRoot({ repoRoot: REPO_ROOT, scenario: "b" });
    try {
      const models = JSON.parse(
        readFileSync(join(isolated.agentDir, "models.json"), "utf8"),
      ) as { providers: Record<string, { api: string }> };
      expect(models.providers.e2e?.api).toBe("e2e-opaque");
      const agents = JSON.parse(
        readFileSync(join(isolated.agentDir, "agents.json"), "utf8"),
      ) as { agents: Record<string, { provider: string }> };
      expect(agents.agents.lynx?.provider).toBe("e2e");
      const mode = JSON.parse(
        readFileSync(join(isolated.home, ".zoo", "mode.json"), "utf8"),
      ) as { mode: string };
      expect(mode.mode).toBe("poly");
    } finally {
      rmSync(isolated.root, { recursive: true, force: true });
    }
  });
});

describe("buildChildEnv", () => {
  test("drops developer credentials, proxy and real pi locations", () => {
    const isolated = createIsolatedRoot({ repoRoot: REPO_ROOT, scenario: "c" });
    try {
      const env = buildChildEnv(DEVELOPER_ENV, isolated, {
        ZOO_E2E_TRACE: isolated.tracePath,
      });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.HTTP_PROXY).toBeUndefined();
      expect(env.HOME).toBe(isolated.home);
      expect(env.PI_CODING_AGENT_DIR).toBe(isolated.agentDir);
      expect(env.PI_CODING_AGENT_SESSION_DIR).toBe(isolated.sessionDir);
      expect(env.ZOO_PI_DATA_DIR).toBe(isolated.agentDir);
      expect(env.PATH).toBe(DEVELOPER_ENV.PATH);
      expect(env.PI_OFFLINE).toBe("1");
      expect(env.PI_SKIP_VERSION_CHECK).toBe("1");
      expect(env.PI_TELEMETRY).toBe("0");
    } finally {
      rmSync(isolated.root, { recursive: true, force: true });
    }
  });

  test("ignores harness keys that a caller tries to override", () => {
    const isolated = createIsolatedRoot({ repoRoot: REPO_ROOT, scenario: "d" });
    try {
      const env = buildChildEnv(DEVELOPER_ENV, isolated, {
        HOME: "/tmp/elsewhere",
        PI_OFFLINE: "0",
      });
      expect(env.HOME).toBe(isolated.home);
      expect(env.PI_OFFLINE).toBe("1");
    } finally {
      rmSync(isolated.root, { recursive: true, force: true });
    }
  });

  test("keeps no inherited key beyond the documented allowlist", () => {
    const isolated = createIsolatedRoot({ repoRoot: REPO_ROOT, scenario: "e" });
    try {
      const env = buildChildEnv(DEVELOPER_ENV, isolated, {
        ZOO_E2E_TRACE: isolated.tracePath,
      });
      const allowed = new Set([
        "PATH",
        "LANG",
        "HOME",
        "PI_CODING_AGENT_DIR",
        "PI_CODING_AGENT_SESSION_DIR",
        "ZOO_PI_DATA_DIR",
        "PI_OFFLINE",
        "PI_SKIP_VERSION_CHECK",
        "PI_TELEMETRY",
        "ZOO_E2E_TRACE",
      ]);
      for (const key of Object.keys(env)) expect(allowed.has(key)).toBe(true);
    } finally {
      rmSync(isolated.root, { recursive: true, force: true });
    }
  });
});
