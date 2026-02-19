import {
  formatRecallAsSummary,
  formatRecallAsMarkdown,
  resolveAgenrPath,
  resolveBudget,
  runRecall,
  writeAgenrMd,
} from "./recall.js";
import type {
  AgenrPluginConfig,
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  PluginApi,
  PluginHookAgentContext,
} from "./types.js";

// Session key substrings that indicate non-interactive sessions to skip.
const SKIP_SESSION_PATTERNS = [":subagent:", ":cron:"];
const seenSessions = new Set<string>();

function shouldSkipSession(sessionKey: string): boolean {
  return SKIP_SESSION_PATTERNS.some((pattern) => sessionKey.includes(pattern));
}

const plugin = {
  id: "agenr",
  name: "agenr memory context",
  description: "Injects agenr long-term memory into every agent session via before_agent_start",

  register(api: PluginApi): void {
    api.on(
      "before_agent_start",
      async (
        _event: BeforeAgentStartEvent,
        ctx: PluginHookAgentContext
      ): Promise<BeforeAgentStartResult | undefined> => {
        try {
          const sessionKey = ctx.sessionKey ?? "";
          if (shouldSkipSession(sessionKey)) {
            return;
          }
          if (sessionKey && seenSessions.has(sessionKey)) {
            return;
          }
          if (sessionKey) {
            seenSessions.add(sessionKey);
          }

          const config = api.pluginConfig as AgenrPluginConfig | undefined;
          if (config?.enabled === false) {
            return;
          }

          const agenrPath = resolveAgenrPath(config);
          const budget = resolveBudget(config);

          const result = await runRecall(agenrPath, budget);
          if (!result) {
            return;
          }

          const markdown = formatRecallAsMarkdown(result);
          if (!markdown.trim()) {
            return;
          }

          const workspaceDir =
            typeof ctx.workspaceDir === "string" ? ctx.workspaceDir.trim() : "";
          if (workspaceDir) {
            const now = new Date();
            const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
            void writeAgenrMd(formatRecallAsSummary(result, timestamp), workspaceDir);
          }

          return { prependContext: markdown };
        } catch (err) {
          // Never block session start - log and swallow.
          api.logger.warn(
            `agenr plugin before_agent_start recall failed: ${err instanceof Error ? err.message : String(err)}`
          );
          return;
        }
      }
    );
  },
};

export default plugin;
