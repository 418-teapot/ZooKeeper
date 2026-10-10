/**
 * OpenCode user-message injector for commands that start an in-session
 * turn.
 *
 * Adapts the OpenCode v1 `session.promptAsync` API to the host-agnostic
 * `MessageInjector` contract: the text is delivered as a real user
 * message the model reads on its next turn.  The session's current agent
 * is resolved and passed explicitly, because OpenCode's prompt defaults
 * the session agent when the body omits it — injecting without the agent
 * would silently switch the session identity.  An unresolvable agent
 * fails closed instead of switching.
 *
 * @module
 */

import type { MessageInjector } from "../../core/slots.js";
import { log } from "../../utils/logger.js";
import { resolveSessionAgent } from "./tool-host.js";

/**
 * Minimal client interface required by the injector.
 *
 * Only `session.promptAsync` (delivery) and `session.get` (the agent
 * fallback read inside `resolveSessionAgent`) are used.  The full
 * OpenCode client object is much larger; this slice keeps the injector
 * thin while remaining trivially compatible with it.
 */
export interface InjectorClient {
  session?: {
    promptAsync?: (input: {
      path: { id: string };
      body?: {
        agent?: string;
        parts: Array<{ type: "text"; text: string }>;
      };
    }) => Promise<unknown>;
    get?: (input: {
      path: { id: string };
    }) => Promise<{ agent?: string } | undefined>;
  };
}

/**
 * Build the OpenCode message injector from a v1 client and the
 * session-agent resolver.
 *
 * @param client - The OpenCode client (may be partial or absent).
 * @param resolveAgent - Resolves a session's agent name from the shared
 *   session-agent registry.
 * @returns The OpenCode message injector.
 */
export function createOpenCodeMessageInjector(
  client: InjectorClient | null | undefined,
  resolveAgent: (sessionID: string) => string | undefined,
): MessageInjector {
  return {
    /**
     * Inject `text` into `sessionID` as a model-visible user message.
     *
     * @param sessionID - The current session id.
     * @param text - The user-message text.
     * @throws Error when `promptAsync` is unavailable, the session agent
     *   cannot be resolved, or the injection request rejects.
     */
    async inject(sessionID, text) {
      if (!client?.session?.promptAsync) {
        throw new Error(
          "session.promptAsync 不可用，无法自动启动调查。" +
            "请确认 ZooKeeper 插件已正确加载。",
        );
      }
      const agent = await resolveSessionAgent(sessionID, client, resolveAgent);
      if (agent === undefined) {
        throw new Error(
          "无法解析当前会话的 agent，已取消自动启动以避免切换会话身份。",
        );
      }
      log("debug-command", "inject_start", sessionID, undefined, "info", {
        agent,
      });
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { agent, parts: [{ type: "text", text }] },
      });
    },
  };
}
