import { formatRecallAsMarkdown, resolveAgenrPath, resolveBudget, runRecall } from "./recall.js";
import type {
  AgenrPluginConfig,
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  PluginApi,
} from "./types.js";

// Session key substrings that indicate non-interactive sessions to skip.
const SKIP_SESSION_PATTERNS = [":subagent:", ":cron:"];

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
      async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartResult | undefined> => {
        try {
          const sessionKey = event.sessionKey ?? "";
          if (shouldSkipSession(sessionKey)) {
            return;
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
