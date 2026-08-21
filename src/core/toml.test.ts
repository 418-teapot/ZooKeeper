/**
 * Integration tests for the vendored smol-toml 1.7.1 parser
 * (`vendor/smol-toml/`) — the parser pi.ts uses at runtime to read
 * config.toml.
 *
 * The parser's syntax behavior is covered by upstream's own test suite;
 * this file guards the contract ZooKeeper depends on: extracting the
 * `[zoo.*]` section (and the poly profile's five arrays) from the real
 * config.toml, plus a multi-line array smoke check.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "../../vendor/smol-toml/index.js";

const CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../config.toml",
);

describe("vendor smol-toml — config.toml zoo section", () => {
  const parsed = parse(readFileSync(CONFIG_PATH, "utf-8"));

  it("extracts the poly profile lists", () => {
    const poly = (parsed.zoo as any).mode.poly;
    assert.deepEqual(poly.agents, [
      "dolphin",
      "mola",
      "beaver",
      "lynx",
      "spider",
      "eagle",
      "kiwi",
    ]);
    assert.deepEqual(poly.skills, [
      "beaver-tdd",
      "code-review",
      "first-principles",
      "git-commit",
      "grill",
      "kiwi-distill",
      "kiwi-verify",
      "mola-plan",
      "wiki-ingest",
      "wiki-query",
      "wiki-verify",
    ]);
    assert.deepEqual(poly.hooks, [
      "context-metrics",
      "context-pruning",
      "direct-work-nudge",
      "json-error-nudge",
      "post-task-nudge",
      "task-delegation",
      "task-prompt",
    ]);
    assert.deepEqual(poly.tools, ["compress", "decompress"]);
    assert.deepEqual(poly.commands, ["go", "dcp"]);
  });

  it("extracts the validation / context / logging sections", () => {
    const zoo = parsed.zoo as any;
    assert.deepEqual(zoo.validation, {
      context_word_limit: 200,
      prompt_word_limit: 500,
    });
    assert.equal(zoo.context.protected_messages, 20);
    assert.equal(zoo.context.dedup.threshold_context, 100000);
    assert.deepEqual(zoo.context.dedup.protected_tools, []);
    assert.equal(zoo.context.compress.max_ranges, 8);
    assert.equal(zoo.context.nudge.min_context, "60%");
    assert.deepEqual(zoo.logging, {
      max_file_size_mb: 5,
      max_backups: 2,
      retention_days: 7,
    });
  });

  it("extracts quoted provider model keys (dotted table segments)", () => {
    const aliyun = (parsed.provider as any).Aliyun;
    assert.equal(aliyun.npm, "@ai-sdk/anthropic");
    const volces = (parsed.provider as any).Volces;
    assert.equal(volces.models["deepseek-v4-pro"].limit.context, 1000000);
    assert.equal(aliyun.models["deepseek-v4-flash"].reasoning, true);
  });
});

describe("vendor smol-toml — multi-line arrays", () => {
  it("parses multi-line arrays with comments, blank lines, and trailing commas", () => {
    const toml = [
      "[zoo.mode.poly]",
      "agents = [  # opening comment",
      '  "dolphin",  # trailing comment',
      "",
      '  "mola",',
      "  # pure comment line",
      '  "beaver",',
      "]",
      "skills = [",
      '  "beaver-tdd",',
      '  "code-review",',
      "]",
      "tools = [",
      "]",
      'single = [ "one" ]',
    ].join("\n");
    const parsed = parse(toml);
    const poly = (parsed.zoo as any).mode.poly;
    assert.deepEqual(poly.agents, ["dolphin", "mola", "beaver"]);
    assert.deepEqual(poly.skills, ["beaver-tdd", "code-review"]);
    assert.deepEqual(poly.tools, []);
    assert.deepEqual(poly.single, ["one"]);
  });
});
