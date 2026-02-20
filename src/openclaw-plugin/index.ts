import type { Client } from "@libsql/client";
import { Type } from "@sinclair/typebox";
import { closeDb, getDb, initDb } from "../db/client.js";
import { KNOWLEDGE_TYPES, SCOPE_LEVELS } from "../types.js";
import {
  formatRecallAsMarkdown,
  resolveAgenrPath,
  resolveBudget,
  runRecall,
} from "./recall.js";
import { checkSignals, resolveSignalConfig } from "./signals.js";
import { runExtractTool, runRecallTool, runRetireTool, runStoreTool } from "./tools.js";
import type {
  AgenrPluginConfig,
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  PluginApi,
  PluginHookAgentContext,
} from "./types.js";

// Session key substrings that indicate non-interactive sessions to skip.
const SKIP_SESSION_PATTERNS = [":subagent:", ":cron:"];
const DEFAULT_MAX_SEEN_SESSIONS = 1000;
const seenSessions = new Map<string, true>();
let pluginDb: Client | null = null;
let pluginDbInit: Promise<void> | null = null;
let didRegisterDbShutdown = false;

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

function registerDbShutdown(): void {
  if (didRegisterDbShutdown) {
    return;
  }
  didRegisterDbShutdown = true;
  process.once("exit", () => {
    if (!pluginDb) {
      return;
    }
    closeDb(pluginDb);
    pluginDb = null;
    pluginDbInit = null;
  });
}

async function ensurePluginDb(config?: AgenrPluginConfig): Promise<Client> {
  if (!pluginDb) {
    const dbPath = config?.dbPath ?? process.env["AGENR_DB_PATH"] ?? undefined;
    pluginDb = getDb(dbPath);
    registerDbShutdown();
  }
  if (!pluginDbInit) {
    pluginDbInit = initDb(pluginDb).catch((err) => {
      pluginDbInit = null;
      throw err;
    });
  }
  await pluginDbInit;
  return pluginDb;
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

    api.on(
      "before_prompt_build",
      async (
        _event: BeforePromptBuildEvent,
        ctx: PluginHookAgentContext,
      ): Promise<BeforePromptBuildResult | undefined> => {
        try {
          const sessionKey = ctx.sessionKey ?? "";
          if (!sessionKey) {
            return;
          }
          if (shouldSkipSession(sessionKey)) {
            return;
          }

          const config = api.pluginConfig as AgenrPluginConfig | undefined;
          if (config?.enabled === false) {
            return;
          }
          if (config?.signalsEnabled === false) {
            return;
          }

          const db = await ensurePluginDb(config);
          const signalConfig = resolveSignalConfig(config);
          const signal = await checkSignals(db, sessionKey, signalConfig);
          if (!signal) {
            return;
          }

          return { prependContext: signal };
        } catch (err) {
          // Never block prompt build - log and swallow.
          api.logger.warn(
            `agenr plugin before_prompt_build signal check failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      },
    );

    if (api.registerTool) {
      const config = api.pluginConfig as AgenrPluginConfig | undefined;
      const agenrPath = resolveAgenrPath(config);

      api.registerTool(
        {
          name: "agenr_recall",
          label: "Agenr Recall",
          description:
            "Retrieve relevant knowledge entries from agenr long-term memory using semantic search. Use mid-session when you need context you do not already have. Session-start recall is already handled automatically.",
          parameters: Type.Object({
            query: Type.Optional(Type.String({ description: "What to search for." })),
            context: Type.Optional(
              Type.Union(
                [Type.Literal("default"), Type.Literal("session-start")],
                { description: "Use session-start for fast bootstrap without embedding." },
              ),
            ),
            limit: Type.Optional(Type.Number({ description: "Max results (default: 10)." })),
            types: Type.Optional(Type.String({ description: "Comma-separated entry types to filter." })),
            since: Type.Optional(
              Type.String({ description: "Only entries newer than this (ISO date or relative, e.g. 7d)." }),
            ),
            threshold: Type.Optional(Type.Number({ description: "Minimum relevance score 0.0-1.0." })),
            platform: Type.Optional(Type.String({ description: "Platform filter: openclaw, claude-code, codex." })),
            project: Type.Optional(Type.String({ description: "Project scope. Pass * for all projects." })),
          }),
          async execute(_toolCallId, params) {
            return runRecallTool(agenrPath, params);
          },
        },
        { name: "agenr_recall" },
      );

      api.registerTool(
        {
          name: "agenr_store",
          label: "Agenr Store",
          description:
            "Store new knowledge entries in agenr long-term memory. Call immediately after any decision, user preference, lesson learned, or important fact. Do not ask first - just store.",
          parameters: Type.Object({
            entries: Type.Array(
              Type.Object({
                content: Type.String({ description: "What to remember." }),
                type: Type.Unsafe<string>({
                  type: "string",
                  enum: [...KNOWLEDGE_TYPES],
                  description: "Entry type: fact | decision | preference | todo | lesson | event",
                }),
                importance: Type.Optional(
                  Type.Number({ description: "Importance 1-10 (default 7, use 9 for critical, 10 sparingly)." }),
                ),
                source: Type.Optional(Type.String()),
                tags: Type.Optional(Type.Array(Type.String())),
                scope: Type.Optional(
                  Type.Unsafe<string>({
                    type: "string",
                    enum: [...SCOPE_LEVELS],
                  }),
                ),
              }),
              { description: "Entries to store." },
            ),
            platform: Type.Optional(Type.String({ description: "Platform tag for all entries." })),
            project: Type.Optional(Type.String({ description: "Project tag for all entries." })),
          }),
          async execute(_toolCallId, params) {
            return runStoreTool(agenrPath, params);
          },
        },
        { name: "agenr_store" },
      );

      api.registerTool(
        {
          name: "agenr_extract",
          label: "Agenr Extract",
          description: "Extract knowledge entries from raw text using the agenr LLM extractor.",
          parameters: Type.Object({
            text: Type.String({ description: "Raw text to extract knowledge from." }),
            store: Type.Optional(Type.Boolean({ description: "Store extracted entries (default: false)." })),
            source: Type.Optional(Type.String({ description: "Source label for extracted entries." })),
          }),
          async execute(_toolCallId, params) {
            return runExtractTool(agenrPath, params);
          },
        },
        { name: "agenr_extract" },
      );

      api.registerTool(
        {
          name: "agenr_retire",
          label: "Agenr Retire",
          description: "Mark a memory entry as retired (soft delete). Retired entries are excluded from all recall.",
          parameters: Type.Object({
            entry_id: Type.String({ description: "Entry ID to retire." }),
            reason: Type.Optional(Type.String({ description: "Retirement reason." })),
            persist: Type.Optional(Type.Boolean({ description: "Persist retirement to ledger." })),
          }),
          async execute(_toolCallId, params) {
            return runRetireTool(agenrPath, params);
          },
        },
        { name: "agenr_retire" },
      );
    }
  },
};

export default plugin;
