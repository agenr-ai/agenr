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
const DEFAULT_MAX_SEEN_SESSIONS = 1000;
const seenSessions = new Map<string, true>();

function resolveMaxSeenSessions(): number {
  const raw = process.env.AGENR_OPENCLAW_MAX_SEEN_SESSIONS;
  if (!raw) {
    return DEFAULT_MAX_SEEN_SESSIONS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_MAX_SEEN_SESSIONS;
}

const maxSeenSessions = resolveMaxSeenSessions();

function shouldSkipSession(sessionKey: string): boolean {
  return SKIP_SESSION_PATTERNS.some((pattern) => sessionKey.includes(pattern));
}

function hasSeenSession(sessionKey: string): boolean {
  const seen = seenSessions.has(sessionKey);
  if (!seen) {
    return false;
  }
  // Refresh recency on access.
  seenSessions.delete(sessionKey);
  seenSessions.set(sessionKey, true);
  return true;
}

function markSessionSeen(sessionKey: string): void {
  seenSessions.set(sessionKey, true);
  while (seenSessions.size > maxSeenSessions) {
    const oldestKey = seenSessions.keys().next().value;
    if (!oldestKey) {
      break;
    }
    seenSessions.delete(oldestKey);
  }
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
          if (sessionKey && hasSeenSession(sessionKey)) {
            return;
          }

          const config = api.pluginConfig as AgenrPluginConfig | undefined;
          if (config?.enabled === false) {
            return;
          }
          if (sessionKey) {
            markSessionSeen(sessionKey);
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
