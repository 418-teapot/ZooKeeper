/**
 * Tests for the pi extension entry point (`src/pi.ts`).
 *
 * The entry only loads the config, wires the handlers, and registers
 * them against pi; the real config.toml drives the assertions.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { piProcessState } from "./adapters/pi/process.js";
import { JSON_ERROR_REMINDER_MARKER } from "./core/prompts.js";
import { zookeeperPi } from "./pi.js";
import { withModeFile } from "./testkits/mode-file.js";
import {
  joinedText,
  mockApi,
  resetPiTestState,
  SESSION_CTX,
} from "./testkits/pi-wiring.js";
import { _getBufferForTesting } from "./utils/logger.js";

afterEach(resetPiTestState);

// The official transcript message components render through the coding-agent
// module-level theme singleton; the built-in dark theme ships with the
// package and needs no configuration.  Bun runs each test file in its own
// worker, so the initialization never leaks into other files.
initTheme();

// ---------------------------------------------------------------------------
// Thin entry wiring
// ---------------------------------------------------------------------------

describe("zookeeperPi — thin entry wiring", () => {
  it("registers the resident event handlers against the real config.toml (poly full)", async () => {
    // The real config.toml carries [zoo.mode.poly] (and a second
    // [zoo.mode.mono] sub-table).  Point the mode state file at poly so
    // the entry selects the full profile.
    await withModeFile(JSON.stringify({ mode: "poly" }), async () => {
      const api = mockApi();
      await zookeeperPi(api as any);
      assert.equal(typeof api.handlers.session_start, "function");
      assert.equal(typeof api.handlers.session_shutdown, "function");
      assert.equal(typeof api.handlers.before_agent_start, "function");
      assert.equal(typeof api.handlers.resources_discover, "function");
      assert.equal(typeof api.handlers.tool_result, "function");
      assert.equal(typeof api.handlers.context, "function");
      assert.equal(typeof api.handlers.message_end, "function");
      // Loop settle events register because the real poly profile
      // enables the todo-continuation hook.  The judge runs on `agent_end`
      // (while the run still streams) so pi's own loop drains the wake.
      assert.equal(typeof api.handlers.agent_end, "function");
      assert.equal(typeof api.handlers.ui_prompt_start, "function");
      assert.equal(typeof api.handlers.ui_prompt_end, "function");

      // No ctrl+tab cyclic primary-switch shortcut is registered:
      // switching is done exclusively through the /<agent> commands, which
      // replace the session.
      assert.deepEqual(
        api.shortcuts.filter((s) => s.shortcut === "ctrl+tab"),
        [],
        "no ctrl+tab shortcut may be registered",
      );

      // The extension load logs a single plugin_init startup anchor with
      // the composed agents/skills/limits (mirrors the OpenCode host).
      const inits = _getBufferForTesting().filter(
        (entry) => entry.event === "plugin_init",
      );
      assert.equal(
        inits.length,
        1,
        "exactly one plugin_init at extension load",
      );
      const init = inits[0];
      assert.equal(init.hook, "plugin");
      assert.equal(init.sessionId, "");
      assert.equal(init.level, "info");
      assert.equal(
        (init.agents as string[]).length,
        7,
        "real poly profile composes 7 agents",
      );
      assert.equal(
        (init.skills as string[]).length,
        14,
        "real poly profile composes 14 skills",
      );
      assert.deepEqual(init.limits, {
        contextWordLimit: 200,
        promptWordLimit: 500,
      });

      // The zoo-notice entry renderer is registered against the real
      // config.toml profile so in-session notifications render in the TUI.
      assert.ok(
        api.renderers.some(
          (r) =>
            r.customType === "zoo-notice" && typeof r.renderer === "function",
        ),
        "zoo-notice renderer must be registered",
      );

      const prompt = (await api.handlers.before_agent_start(
        { messageType: "user", systemPrompt: "base" },
        SESSION_CTX,
      )) as { systemPrompt: string } | undefined;
      assert.ok(prompt, "the handler must admit the event's session");
      assert.ok(prompt.systemPrompt.startsWith("<Role>"));

      const resources = (await api.handlers.resources_discover(
        undefined,
        SESSION_CTX,
      )) as { skillPaths: string[] } | undefined;
      assert.ok(resources, "the handler must admit the event's session");
      // The default primary (dolphin) denies the beaver-*/kiwi-*/mola-*
      // skill globs in config.toml, so 4 of the 14 profile skills are
      // filtered out at session bind.
      assert.equal(resources.skillPaths.length, 10);
      for (const path of resources.skillPaths) {
        assert.ok(
          !/beaver-|kiwi-|mola-/.test(path),
          `${path} must not be a dolphin-denied skill`,
        );
      }

      // tool_result runs the real poly hooks: json-error-nudge is
      // enabled there, so a JSON parse error output gets the reminder.
      const toolResult = (await api.handlers.tool_result(
        {
          type: "tool_result",
          toolName: "browser",
          toolCallId: "call-json",
          content: [
            { type: "text", text: "Error: json parse error at line 3" },
          ],
          isError: true,
        },
        SESSION_CTX,
      )) as { content: { type: string; text?: string }[] } | undefined;
      assert.ok(
        toolResult,
        "json-error-nudge must fire on the real poly profile",
      );
      assert.ok(
        joinedText(toolResult).includes(JSON_ERROR_REMINDER_MARKER),
        "output must carry the JSON reminder marker",
      );

      // message_end strips model-imitated line-start ref echoes from
      // finalized assistant text.
      const messageEnd = (await api.handlers.message_end(
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[m3] hello" }],
          },
        },
        SESSION_CTX,
      )) as
        | {
            message: {
              role: string;
              content: { type: string; text: string }[];
            };
          }
        | undefined;
      assert.ok(messageEnd);
      assert.equal(messageEnd?.message?.content[0]?.text, "hello");
    });
  });
});

// ---------------------------------------------------------------------------
// Configuration generations
// ---------------------------------------------------------------------------

describe("zookeeperPi — configuration generations", () => {
  it("keeps the session identities and the run records across a reload", async () => {
    // pi replays the extension factory, and every replay is a new
    // generation of the same process.  The session → agent bindings and the
    // subagent run records belong to the process, so the reloaded
    // generation must read the ones the previous one wrote.
    await withModeFile(JSON.stringify({ mode: "mono" }), async () => {
      await zookeeperPi(mockApi() as any);
    });
    const process = piProcessState();
    process.sessionAgents.bind("sess-keep", "mola");
    process.runs.start({
      id: "call-keep",
      agent: "lynx",
      parentSession: "sess-keep",
      startedAt: 100,
    });

    await withModeFile(JSON.stringify({ mode: "poly" }), async () => {
      const api = mockApi();
      await zookeeperPi(api as any);

      assert.equal(
        piProcessState(),
        process,
        "the reload keeps the process owner",
      );
      assert.equal(
        process.sessionAgents.resolve("sess-keep"),
        "mola",
        "the binding survives the reload",
      );
      assert.equal(
        process.runs.get("call-keep")?.agent,
        "lynx",
        "the run record survives the reload",
      );

      // The reloaded handlers read that same owner: the bound session keeps
      // its agent's prompt instead of falling back to the orchestrator.
      const prompt = (await api.handlers.before_agent_start(
        { messageType: "user", systemPrompt: "base" },
        { sessionManager: { getSessionId: () => "sess-keep" } },
      )) as { systemPrompt: string } | undefined;
      assert.ok(prompt, "the handler must admit the bound session");
      assert.ok(
        prompt.systemPrompt.includes("你是 mola"),
        `the bound agent's prompt must survive the reload: ${prompt.systemPrompt}`,
      );
    });
  });

  it("parses a new generation on reload", async () => {
    // pi replays the extension factory on reload.  Each call is one
    // configuration generation: the config and the mode state are read
    // again, so a changed mode file selects the other profile.
    await withModeFile(JSON.stringify({ mode: "mono" }), async () => {
      const api = mockApi();
      await zookeeperPi(api as any);
      const first = _getBufferForTesting().filter(
        (entry) => entry.event === "plugin_init",
      );
      assert.equal(first.length, 1);
      assert.deepEqual(first[0].agents, ["dolphin", "mola"]);
    });

    await withModeFile(JSON.stringify({ mode: "poly" }), async () => {
      const api = mockApi();
      await zookeeperPi(api as any);
      const inits = _getBufferForTesting().filter(
        (entry) => entry.event === "plugin_init",
      );
      assert.equal(inits.length, 2, "the reload composes once");
      assert.equal(
        (inits[1].agents as string[]).length,
        7,
        "the reload reads the new generation",
      );
    });
  });
});
