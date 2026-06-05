/** Per-agent tool deny-list. Denied tools are invisible to the LLM. */
export const BLOCKED: Record<string, string[]> = {
  build: ["grep", "glob", "webfetch", "websearch"],
  spider: ["edit", "write", "bash"],
  explore: ["edit", "write"],
};
