import type { Client } from "@libsql/client";
import { Type } from "@sinclair/typebox";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb, initDb } from "../db/client.js";
import { KNOWLEDGE_TYPES, SCOPE_LEVELS } from "../types.js";
import {
  formatRecallAsMarkdown,
  resolveAgenrPath,
  resolveBudget,
  runRecall,
  type RecallResult,
} from "./recall.js";
import {
  buildSemanticSeed,
  extractLastExchangeText,
  extractRecentTurns,
  findPreviousSessionFile,
} from "./session-query.js";
import { checkSignals, resolveSignalConfig } from "./signals.js";
import { runExtractTool, runRecallTool, runRetireTool, runStoreTool } from "./tools.js";
import type {
  AgenrPluginConfig,
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  PluginApi,
  PluginHookAgentContext,
} from "./types.js";

// Session key substrings that indicate non-interactive sessions to skip.
const SKIP_SESSION_PATTERNS = [":subagent:", ":cron:"];
const DEFAULT_MAX_SEEN_SESSIONS = 1000;
const seenSessions = new Map<string, true>();

interface SessionSignalState {
  lastSignalAt: number;
  signalCount: number;
}

const sessionSignalState = new Map<string, SessionSignalState>();

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
  description: "Injects agenr long-term memory into every agent session via before_prompt_build",

  register(api: PluginApi): void {
    const config = api.pluginConfig as AgenrPluginConfig | undefined;

    api.on(
      "before_prompt_build",
      async (
        event: BeforePromptBuildEvent,
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

          if (config?.enabled === false) {
            return;
          }

          const dedupeKey = ctx.sessionId ?? sessionKey;
          let markdown: string | undefined;
          const isFirstInSession = dedupeKey ? !hasSeenSession(dedupeKey) : true;

          if (isFirstInSession) {
            if (dedupeKey) {
              markSessionSeen(dedupeKey);
            }

            const agenrPath = resolveAgenrPath(config);
            const budget = resolveBudget(config);
            const project = config?.project?.trim() || undefined;
            const agentId = ctx.agentId?.trim() || "main";
            const sessionsDir =
              config?.sessionsDir ?? path.join(os.homedir(), `.openclaw/agents/${agentId}/sessions`);

            const [previousTurns, browseResult] = await Promise.all([
              findPreviousSessionFile(sessionsDir, ctx.sessionId, api.logger).then((file) =>
                file ? extractRecentTurns(file) : Promise.resolve(""),
              ),
              runRecall(agenrPath, budget, project, undefined, {
                context: "browse",
                since: "1d",
                limit: 20,
              }),
            ]);

            const seed = buildSemanticSeed(previousTurns, event.prompt ?? "");
            let semanticResult: RecallResult | null = null;
            if (seed) {
              const browseIds = new Set<string>();
              for (const item of browseResult?.results ?? []) {
                const id =
                  typeof item.entry?.id === "string" && item.entry.id.trim()
                    ? item.entry.id.trim()
                    : null;
                if (id) {
                  browseIds.add(id);
                }
              }
              const rawSemantic = await runRecall(agenrPath, budget, project, seed);
              if (rawSemantic) {
                rawSemantic.results = rawSemantic.results.filter((item) => {
                  const id =
                    typeof item.entry?.id === "string" && item.entry.id.trim()
                      ? item.entry.id.trim()
                      : null;
                  if (!id) {
                    return true;
                  }
                  return !browseIds.has(id);
                });
                semanticResult = rawSemantic.results.length > 0 ? rawSemantic : null;
              }
            }

            if (browseResult) {
              const retirePromises: Promise<void>[] = [];
              for (const item of browseResult.results) {
                const entry = item.entry;
                const subject = typeof entry.subject === "string" ? entry.subject : "";
                if (!subject.toLowerCase().startsWith("session handoff")) {
                  continue;
                }
                const entryId = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : null;
                if (entryId) {
                  retirePromises.push(
                    runRetireTool(agenrPath, {
                      entry_id: entryId,
                      reason: "consumed at session start",
                    })
                      .then(() => undefined)
                      .catch((err) => {
                        api.logger.debug?.(
                          `[agenr] session-start: retire handoff ${entryId} failed: ${err instanceof Error ? err.message : String(err)}`,
                        );
                      }),
                  );
                } else {
                  api.logger.debug?.(
                    "[agenr] session-start: handoff entry missing id, skipping retire",
                  );
                }
              }
              await Promise.allSettled(retirePromises);
            }

            const sections: string[] = [];
            if (previousTurns.trim()) {
              sections.push(`## Recent session\n${previousTurns.trim()}`);
            }
            if (browseResult) {
              const formatted = formatRecallAsMarkdown(browseResult);
              if (formatted.trim()) {
                sections.push(`## Recent memory\n${formatted.trim()}`);
              }
            }
            if (semanticResult) {
              const formatted = formatRecallAsMarkdown(semanticResult);
              if (formatted.trim()) {
                sections.push(`## Relevant memory\n${formatted.trim()}`);
              }
            }
            markdown = sections.length > 0 ? sections.join("\n\n") : undefined;
          }

          let signal: string | undefined;
          if (config?.signalsEnabled !== false) {
            const signalConfig = resolveSignalConfig(config);
            // Always call checkSignals so the watermark advances even if we suppress delivery.
            // This prevents stale-watermark bursts when cooldown expires.
            const db = await ensurePluginDb(config);
            const candidateSignal = await checkSignals(db, sessionKey, signalConfig);
            if (candidateSignal) {
              const state = sessionSignalState.get(sessionKey) ?? { lastSignalAt: 0, signalCount: 0 };

              // Suppress delivery (but NOT watermark advance) during cooldown or session cap.
              const inCooldown =
                signalConfig.cooldownMs > 0 && Date.now() - state.lastSignalAt < signalConfig.cooldownMs;
              const overCap =
                signalConfig.maxPerSession > 0 && state.signalCount >= signalConfig.maxPerSession;

              if (!inCooldown && !overCap) {
                sessionSignalState.set(sessionKey, {
                  lastSignalAt: Date.now(),
                  signalCount: state.signalCount + 1,
                });
                signal = candidateSignal;
              }
            }
          }

          const prependContext = [markdown, signal].filter(Boolean).join("\n\n");
          if (!prependContext) {
            return;
          }
          return { prependContext };
        } catch (err) {
          // Never block prompt build - log and swallow.
          api.logger.warn(
            `agenr plugin before_prompt_build signal check failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      },
    );

    api.on("before_reset", (event, ctx): void => {
      try {
        const sessionKey = ctx.sessionKey;
        if (!sessionKey) {
          return;
        }

        const messages = event.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
          return;
        }

        // Write importance:10 handoff entry to agenr DB so Phase 1B browse picks it up
        // in the new session. Entry is retired after first use (see auto-retire below).
        const handoffText = extractLastExchangeText(messages);
        if (handoffText) {
          const agenrPath = resolveAgenrPath(config);
          const defaultProject = config?.project?.trim() || undefined;
          const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
          const handoffEntry = {
            entries: [
              {
                type: "event",
                importance: 10,
                subject: `session handoff ${timestamp}`,
                content: handoffText,
                tags: ["handoff", "session"],
              },
            ],
          };
          const storeConfig: Record<string, unknown> = {
            ...(config as Record<string, unknown> | undefined),
            logger: api.logger,
          };
          runStoreTool(agenrPath, handoffEntry, storeConfig, defaultProject).catch((err) => {
            api.logger.debug?.(
              `[agenr] before_reset: handoff store failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      } catch (err) {
        api.logger.warn(
          `agenr plugin before_reset failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    if (api.registerTool) {
      if (config?.enabled === false) {
        return;
      }

      const makeDisabledToolResult = () => ({
        content: [{ type: "text" as const, text: "agenr tools are disabled by plugin configuration." }],
      });

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
                [Type.Literal("default"), Type.Literal("session-start"), Type.Literal("browse")],
                {
                  description:
                    "Use session-start for fast bootstrap without embedding. Use browse for temporal browsing (date+importance, no query needed, no semantic search).",
                },
              ),
            ),
            limit: Type.Optional(Type.Number({ description: "Max results (default: 10)." })),
            types: Type.Optional(Type.String({ description: "Comma-separated entry types to filter." })),
            since: Type.Optional(
              Type.String({ description: "Only entries newer than this (ISO date or relative, e.g. 7d)." }),
            ),
            until: Type.Optional(
              Type.String({ description: "Only entries older than this ceiling (ISO date or relative, e.g. 7d = entries created before 7 days ago). Use with since for a date window." }),
            ),
            platform: Type.Optional(Type.String({ description: "Platform filter: openclaw, claude-code, codex." })),
            project: Type.Optional(Type.String({ description: "Project scope. Pass * for all projects." })),
          }),
          async execute(_toolCallId, params) {
            const runtimeConfig = api.pluginConfig as AgenrPluginConfig | undefined;
            if (runtimeConfig?.enabled === false) {
              return makeDisabledToolResult();
            }
            const agenrPath = resolveAgenrPath(runtimeConfig);
            const defaultProject = runtimeConfig?.project?.trim() || undefined;
            return runRecallTool(agenrPath, params, defaultProject);
          },
        },
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
                subject: Type.Optional(
                  Type.String({
                    description: "Short subject label. Inferred from content if omitted.",
                  }),
                ),
                type: Type.Unsafe<string>({
                  type: "string",
                  enum: [...KNOWLEDGE_TYPES],
                  description: `Entry type: ${KNOWLEDGE_TYPES.join(" | ")}`,
                }),
                importance: Type.Optional(
                  Type.Integer({
                    minimum: 1,
                    maximum: 10,
                    default: 7,
                    description: "Importance 1-10 (default 7, use 9 for critical, 10 sparingly).",
                  }),
                ),
                source: Type.Optional(
                  Type.String({ description: "Source label for this entry (e.g. conversation, file path)." }),
                ),
                tags: Type.Optional(Type.Array(Type.String())),
                scope: Type.Optional(
                  Type.Unsafe<string>({
                    type: "string",
                    enum: [...SCOPE_LEVELS],
                    description: `Scope level: ${SCOPE_LEVELS.join(" | ")}.`,
                  }),
                ),
              }),
              { description: "Entries to store." },
            ),
            platform: Type.Optional(Type.String({ description: "Platform tag for all entries." })),
            project: Type.Optional(Type.String({ description: "Project tag for all entries." })),
          }),
          async execute(_toolCallId, params) {
            const runtimeConfig = api.pluginConfig as AgenrPluginConfig | undefined;
            if (runtimeConfig?.enabled === false) {
              return makeDisabledToolResult();
            }
            const agenrPath = resolveAgenrPath(runtimeConfig);
            const defaultProject = runtimeConfig?.project?.trim() || undefined;
            const toolConfig: Record<string, unknown> = {
              ...(runtimeConfig as Record<string, unknown> | undefined),
              logger: api.logger,
            };
            return runStoreTool(
              agenrPath,
              params,
              toolConfig,
              defaultProject,
            );
          },
        },
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
            const runtimeConfig = api.pluginConfig as AgenrPluginConfig | undefined;
            if (runtimeConfig?.enabled === false) {
              return makeDisabledToolResult();
            }
            const agenrPath = resolveAgenrPath(runtimeConfig);
            return runExtractTool(agenrPath, params);
          },
        },
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
            const runtimeConfig = api.pluginConfig as AgenrPluginConfig | undefined;
            if (runtimeConfig?.enabled === false) {
              return makeDisabledToolResult();
            }
            const agenrPath = resolveAgenrPath(runtimeConfig);
            return runRetireTool(agenrPath, params);
          },
        },
      );
    }
  },
};

export const __testing = {
  clearState(): void {
    seenSessions.clear();
    sessionSignalState.clear();
  },
};

export default plugin;
