/**
 * Tests for the pi per-agent model map loader
 * (`src/adapters/pi/agent-models.ts`).
 *
 * The loader reads `~/.pi/agent/agents.json` (materialised by the
 * installer) into an agent → `"provider/model"` map consumed by the
 * subagent tool.  Each entry is a `{provider, model}` pair whose model is
 * the pi registry `id` (which may itself carry a provider prefix); the
 * loader concatenates them into `"provider/model"`.  Fail-closed contract:
 * a missing file, malformed JSON, a non-object root / `agents` table, or
 * entries missing a non-string `provider` / `model` all degrade to an
 * empty map — the error surface is the subagent tool, which reports an
 * actionable error naming agents.json (strict mode: no inheritance, no
 * default fallback).
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { _resetForTesting as _resetLoggerForTesting } from "../../utils/logger.js";
import { loadAgentsJson, parseAgentsJson } from "./agent-models.js";

afterEach(() => {
  _resetLoggerForTesting();
});

describe("parseAgentsJson", () => {
  it('parses a well-formed agents.json into an agent → "provider/model" map', () => {
    const map = parseAgentsJson(
      JSON.stringify({
        agents: {
          lynx: { provider: "Dummy", model: "dummy-small" },
          beaver: { provider: "Dummy", model: "dummy-large" },
        },
      }),
    );
    assert.deepEqual(map, {
      lynx: "Dummy/dummy-small",
      beaver: "Dummy/dummy-large",
    });
  });

  it("concatenates a registry id that already carries a provider prefix", () => {
    const map = parseAgentsJson(
      JSON.stringify({
        agents: {
          lynx: { provider: "Dummy", model: "dummy/prefixed-id" },
        },
      }),
    );
    // The model half is the full registry id; the map value is the
    // concatenation, so resolveModel splits on the first `/` back into
    // (provider, full registry id).
    assert.deepEqual(map, {
      lynx: "Dummy/dummy/prefixed-id",
    });
  });

  it("skips agents with a missing provider", () => {
    const map = parseAgentsJson(
      JSON.stringify({
        agents: {
          lynx: { provider: "Dummy", model: "dummy-small" },
          beaver: { model: "dummy-large" },
          spider: { provider: "", model: "dummy-x" },
          kiwi: { provider: 42, model: "dummy-y" },
        },
      }),
    );
    assert.deepEqual(map, { lynx: "Dummy/dummy-small" });
  });

  it("skips agents with a missing or non-string model", () => {
    const map = parseAgentsJson(
      JSON.stringify({
        agents: {
          lynx: { provider: "Dummy", model: "dummy-small" },
          beaver: { provider: "Dummy" },
          spider: { provider: "Dummy", model: 42 },
          kiwi: "not-an-object",
        },
      }),
    );
    assert.deepEqual(map, { lynx: "Dummy/dummy-small" });
  });

  it("returns an empty map for malformed JSON", () => {
    assert.deepEqual(parseAgentsJson("{ not json"), {});
  });

  it("returns an empty map for a non-object root", () => {
    assert.deepEqual(parseAgentsJson(JSON.stringify([1, 2])), {});
    assert.deepEqual(parseAgentsJson(JSON.stringify("agents")), {});
  });

  it("returns an empty map for a non-object agents table", () => {
    assert.deepEqual(parseAgentsJson(JSON.stringify({ agents: [] })), {});
    assert.deepEqual(parseAgentsJson(JSON.stringify({ agents: "x" })), {});
  });

  it("returns an empty map for an empty agents table", () => {
    assert.deepEqual(parseAgentsJson(JSON.stringify({ agents: {} })), {});
  });
});

describe("loadAgentsJson", () => {
  it('loads a well-formed agents.json into an agent → "provider/model" map', () => {
    const file = tmpdir();
    const path = join(file, "agents.json");
    writeFileSync(
      path,
      JSON.stringify({
        agents: { lynx: { provider: "Dummy", model: "dummy-small" } },
      }),
    );
    assert.deepEqual(loadAgentsJson(path), {
      lynx: "Dummy/dummy-small",
    });
  });

  it("returns an empty map when the file is missing (fail-closed)", () => {
    assert.deepEqual(loadAgentsJson(join(tmpdir(), "no-such-agents.json")), {});
  });

  it("returns an empty map when the file is invalid (fail-closed)", () => {
    const path = join(tmpdir(), "bad-agents.json");
    writeFileSync(path, "{ not json");
    assert.deepEqual(loadAgentsJson(path), {});
  });
});
