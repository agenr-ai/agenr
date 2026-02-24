import type { Client } from "@libsql/client";
import { Type } from "@sinclair/typebox";
import fs, { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { closeDb, getDb, initDb } from "../db/client.js";
import { createLlmClient } from "../llm/client.js";
import { runSimpleStream, type StreamSimpleFn } from "../llm/stream.js";
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
  BeforeResetEvent,
  PluginApi,
  PluginHookAgentContext,
  PluginLogger,
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
const handoffSeenSessionIds = new Set<string>();

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

type HandoffMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

interface CommandHookEvent {
  type: string;
  action: string;
  sessionKey: string;
  timestamp: Date;
  messages: string[];
  context?: {
    sessionEntry?: {
      sessionFile?: string;
      sessionId?: string;
    };
    commandSource?: string;
    senderId?: string;
    cfg?: unknown;
  };
}

interface CommandHookApi {
  on(
    hook: "command",
    handler: (event: CommandHookEvent, ctx: PluginHookAgentContext) => Promise<void>,
  ): void;
}

const HANDOFF_TRANSCRIPT_MAX_MESSAGES = 50;
const HANDOFF_TRANSCRIPT_MAX_CHARS = 8000;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

const HANDOFF_SUMMARY_SYSTEM_PROMPT = `You are a session summarizer for an AI agent memory system. Your job is
to produce a concise handoff note from a conversation transcript so the
next session can orient quickly.

The transcript may cover one or two sessions labeled with timestamps and
surfaces (webchat, telegram, etc.). Use this temporal and surface context
in your summary. If the sessions are separated by more than 30 minutes,
begin WORKING ON with a note like "Resumed 4 hours after a telegram
session." If sessions are continuous, omit the gap.

If the two sessions cover clearly unrelated topics, label them separately
using "PRIOR SESSION TOPIC:" and "CURRENT SESSION TOPIC:" instead of a
unified WORKING ON section.

Produce these sections in plain text (no markdown, no bullet symbols,
use plain dashes for lists):

WORKING ON: One to two sentences on the main task or topic, including
the project or system being worked on (e.g. "Working on agenr plugin
(#199) in the agenr-ai/agenr repo.").

KEY FINDINGS: Decisions, discoveries, or conclusions reached this
session.

OPEN THREADS: Unresolved questions or next steps. Write "None" if
everything was wrapped up.

IMPORTANT FACTS: Stateful facts only - file paths, version numbers,
env states, config values. Do NOT repeat decisions already in KEY
FINDINGS. Write "None" if nothing new.

Keep the total response under 500 words. Plain text only.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTextFromContent(content: unknown, separator: string): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "text") {
      continue;
    }
    const blockText = block["text"];
    if (typeof blockText !== "string") {
      continue;
    }
    const trimmed = blockText.trim();
    if (trimmed) {
      textParts.push(trimmed);
    }
  }
  return textParts.join(separator).trim();
}

function extractHandoffContent(content: unknown): string {
  return extractTextFromContent(content, " ");
}

function formatHandoffTimestamp(timestamp: string): string {
  if (!timestamp) {
    return "unknown time";
  }
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "unknown time";
  }

  const pad2 = (value: number): string => value.toString().padStart(2, "0");
  return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())} ${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;
}

function getBaseSessionPath(filePath: string): string {
  const resetMatch = filePath.match(/^(.+\.jsonl)\.reset\..+$/);
  return resetMatch ? resetMatch[1] : filePath;
}

function deriveSessionIdFromSessionFile(sessionFile: string): string {
  const baseSessionPath = getBaseSessionPath(sessionFile);
  const baseName = path.basename(baseSessionPath, ".jsonl").trim();
  return baseName || "";
}

async function readSessionsJson(sessionsDir: string): Promise<Record<string, unknown>> {
  try {
    const sessionsJsonPath = path.join(sessionsDir, "sessions.json");
    const raw = await fs.promises.readFile(sessionsJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readAndParseSessionJsonl(sessionFile: string): Promise<unknown[]> {
  try {
    const raw = await fs.promises.readFile(sessionFile, "utf8");
    const messages: unknown[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        messages.push(parsed);
      } catch {
        // skip malformed lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

function getSurfaceForSessionFile(
  sessionFilePath: string,
  sessionsJson: Record<string, unknown>,
): string {
  try {
    const normalizedTarget = path.resolve(sessionFilePath);
    for (const value of Object.values(sessionsJson)) {
      if (!isRecord(value)) {
        continue;
      }
      const entrySessionFile = value["sessionFile"];
      if (typeof entrySessionFile !== "string" || !entrySessionFile.trim()) {
        continue;
      }
      if (path.resolve(entrySessionFile) !== normalizedTarget) {
        continue;
      }

      const origin = isRecord(value["origin"]) ? value["origin"] : null;
      const originSurface =
        origin && typeof origin["surface"] === "string" ? origin["surface"].trim() : "";
      if (originSurface) {
        return originSurface;
      }

      const deliveryContext = isRecord(value["deliveryContext"]) ? value["deliveryContext"] : null;
      const channel =
        deliveryContext && typeof deliveryContext["channel"] === "string"
          ? deliveryContext["channel"].trim()
          : "";
      return channel || "prior session";
    }
    return "prior session";
  } catch {
    return "prior session";
  }
}

async function readMessagesFromJsonl(filePath: string): Promise<HandoffMessage[]> {
  try {
    const messages: HandoffMessage[] = [];
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (!isRecord(parsed) || parsed["type"] !== "message") {
        continue;
      }
      const message = parsed["message"];
      if (!isRecord(message)) {
        continue;
      }

      const role = message["role"];
      if (role !== "user" && role !== "assistant") {
        continue;
      }

      const content = extractHandoffContent(message["content"]);
      if (!content) {
        continue;
      }

      const timestamp = typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : "";
      messages.push({
        role,
        content,
        timestamp,
      });
    }

    return messages;
  } catch {
    return [];
  }
}

async function findPriorResetFile(sessionsDir: string, currentSessionFile: string): Promise<string | null> {
  try {
    const currentUuid = path.basename(currentSessionFile, ".jsonl");
    const entries = await fs.promises.readdir(sessionsDir);
    const resetEntries = entries.filter((entry) => /\.jsonl\.reset\./.test(entry));
    const candidates = resetEntries.filter((entry) => entry.split(".jsonl")[0] !== currentUuid);
    if (candidates.length === 0) {
      return null;
    }

    const stats = await Promise.all(
      candidates.map(async (entry) => {
        const filePath = path.join(sessionsDir, entry);
        const fileStats = await fs.promises.stat(filePath);
        return {
          filePath,
          mtime: fileStats.mtime,
        };
      }),
    );

    stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const latest = stats[0];
    if (!latest) {
      return null;
    }

    const ageMs = Date.now() - latest.mtime.getTime();
    if (ageMs < MILLIS_PER_DAY) {
      return latest.filePath;
    }
    return null;
  } catch {
    return null;
  }
}

function buildMergedTranscript(
  priorMessages: HandoffMessage[],
  priorSurface: string,
  currentMessages: HandoffMessage[],
  currentSurface: string,
): string {
  const cleanPrior = priorMessages
    .map((message) => ({ ...message, content: message.content.trim() }))
    .filter((message) => message.content.length > 0);
  const cleanCurrent = currentMessages
    .map((message) => ({ ...message, content: message.content.trim() }))
    .filter((message) => message.content.length > 0);

  const lines: string[] = [];
  if (cleanPrior.length > 0) {
    lines.push(`--- Session ${formatHandoffTimestamp(cleanPrior[0]?.timestamp ?? "")} [${priorSurface}] ---`);
    lines.push(...cleanPrior.map((message) => `[${message.role}]: ${message.content}`));
    lines.push("");
  }

  lines.push(
    `--- Session ${formatHandoffTimestamp(cleanCurrent[0]?.timestamp ?? "")} [${currentSurface}] (ended) ---`,
  );
  lines.push(...cleanCurrent.map((message) => `[${message.role}]: ${message.content}`));

  return lines.join("\n");
}

function countTranscriptContentLines(transcript: string): number {
  return transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("---")).length;
}

function capTranscriptLength(params: {
  priorMessages: HandoffMessage[];
  priorSurface: string;
  currentMessages: HandoffMessage[];
  currentSurface: string;
  maxChars: number;
}): string {
  let cappedPrior = [...params.priorMessages];
  let transcript = buildMergedTranscript(
    cappedPrior,
    params.priorSurface,
    params.currentMessages,
    params.currentSurface,
  );

  while (transcript.length > params.maxChars && cappedPrior.length > 0) {
    cappedPrior = cappedPrior.slice(1);
    transcript = buildMergedTranscript(
      cappedPrior,
      params.priorSurface,
      params.currentMessages,
      params.currentSurface,
    );
  }

  if (transcript.length > params.maxChars) {
    transcript = transcript.slice(-params.maxChars);
    const firstNewline = transcript.indexOf("\n");
    if (firstNewline > 0) {
      transcript = transcript.slice(firstNewline + 1);
    }
  }

  return transcript;
}

function extractAssistantSummaryText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }
  return extractTextFromContent(message["content"], "\n");
}

function mapCurrentSessionMessage(message: unknown): HandoffMessage | null {
  if (!isRecord(message)) {
    return null;
  }
  const role = message["role"];
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const content = extractHandoffContent(message["content"]);
  if (!content) {
    return null;
  }
  const timestamp = typeof message["timestamp"] === "string" ? message["timestamp"] : "";
  return {
    role,
    content,
    timestamp,
  };
}

async function summarizeSessionForHandoff(
  currentRawMessages: BeforeResetEvent["messages"],
  sessionsDir: string,
  currentSessionFile: string,
  logger: PluginApi["logger"],
  streamSimpleImpl?: StreamSimpleFn,
): Promise<string | null> {
  try {
    const sessionsJson = await readSessionsJson(sessionsDir);
    const currentSurface = getSurfaceForSessionFile(currentSessionFile, sessionsJson);
    const currentMessages = (Array.isArray(currentRawMessages) ? currentRawMessages : [])
      .map((message) => mapCurrentSessionMessage(message))
      .filter((message): message is HandoffMessage => message !== null);

    const currentSlice = currentMessages.slice(
      -Math.min(currentMessages.length, HANDOFF_TRANSCRIPT_MAX_MESSAGES),
    );
    const priorBudget = HANDOFF_TRANSCRIPT_MAX_MESSAGES - currentSlice.length;

    let priorSlice: HandoffMessage[] = [];
    let priorSurface = "prior session";
    const priorFile = await findPriorResetFile(sessionsDir, currentSessionFile);
    if (priorFile && priorBudget > 0) {
      const priorAllMessages = await readMessagesFromJsonl(priorFile);
      priorSlice = priorAllMessages.slice(-priorBudget);
      priorSurface = getSurfaceForSessionFile(getBaseSessionPath(priorFile), sessionsJson);
    }

    let transcript = buildMergedTranscript(priorSlice, priorSurface, currentSlice, currentSurface);
    const nonHeaderLineCount = countTranscriptContentLines(transcript);
    if (nonHeaderLineCount < 3) {
      console.log("[agenr] before_reset: skipping LLM summary - reason: short transcript");
      return null;
    }

    if (currentSlice.length < 5 && priorSlice.length === 0) {
      console.log("[agenr] before_reset: skipping LLM summary - reason: too few messages");
      return null;
    }

    if (transcript.length > HANDOFF_TRANSCRIPT_MAX_CHARS) {
      transcript = capTranscriptLength({
        priorMessages: priorSlice,
        priorSurface,
        currentMessages: currentSlice,
        currentSurface,
        maxChars: HANDOFF_TRANSCRIPT_MAX_CHARS,
      });
    }

    let llmClient;
    try {
      llmClient = createLlmClient({});
    } catch (err) {
      console.log("[agenr] before_reset: skipping LLM summary - reason: LLM client init failed");
      return null;
    }

    const resolvedModel = llmClient.resolvedModel;
    const credentials = llmClient.credentials;
    const apiKey = typeof credentials.apiKey === "string" ? credentials.apiKey.trim() : "";
    if (!apiKey) {
      console.log("[agenr] before_reset: no apiKey available, skipping LLM summary");
      return null;
    }

    const context = {
      systemPrompt: HANDOFF_SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user" as const, content: transcript, timestamp: Date.now() }],
      tools: [],
    };

    console.log(
      `[agenr] before_reset: sending to LLM model=${resolvedModel.model} chars=${transcript.length} currentMsgs=${currentSlice.length} priorMsgs=${priorSlice.length}`,
    );
    const assistantMsg = await runSimpleStream({
      model: resolvedModel.model,
      context,
      options: { apiKey },
      verbose: false,
      streamSimpleImpl,
    });

    if (assistantMsg.stopReason === "error") {
      console.log("[agenr] before_reset: skipping LLM summary - reason: LLM error stop");
      return null;
    }

    const summaryText = extractAssistantSummaryText(assistantMsg);
    if (!summaryText) {
      console.log("[agenr] before_reset: skipping LLM summary - reason: empty summary text");
      return null;
    }
    console.log(`[agenr] before_reset: LLM summary received chars=${summaryText.length}`);
    return summaryText;
  } catch (err) {
    console.log(
      `[agenr] before_reset: summarize handoff failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function getEntryImportance(entry: Record<string, unknown>): number | null {
  const rawImportance = entry["importance"];
  if (typeof rawImportance === "number" && Number.isFinite(rawImportance)) {
    return rawImportance;
  }
  if (typeof rawImportance === "string" && rawImportance.trim().length > 0) {
    const parsed = Number(rawImportance);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function getEntryTags(entry: Record<string, unknown>): string[] {
  const rawTags = entry["tags"];
  if (!Array.isArray(rawTags)) {
    return [];
  }
  const tags: string[] = [];
  for (const rawTag of rawTags) {
    if (typeof rawTag !== "string") {
      continue;
    }
    const normalized = rawTag.trim().toLowerCase();
    if (normalized) {
      tags.push(normalized);
    }
  }
  return tags;
}

async function retireFallbackHandoffEntries(params: {
  agenrPath: string;
  budget: number;
  defaultProject?: string;
  fallbackSubject: string;
  logger: PluginApi["logger"];
  source: "before_reset" | "command" | "session_start";
}): Promise<void> {
  try {
    const browseResult = await runRecall(params.agenrPath, params.budget, params.defaultProject, undefined, {
      context: "browse",
      since: "1d",
      limit: 100,
    });
    if (!browseResult) {
      return;
    }

    const retirePromises: Promise<void>[] = [];
    for (const item of browseResult.results) {
      const entryRecord = isRecord(item.entry) ? item.entry : null;
      if (!entryRecord) {
        continue;
      }

      const entryId =
        typeof entryRecord["id"] === "string" && entryRecord["id"].trim()
          ? entryRecord["id"].trim()
          : null;
      if (!entryId) {
        continue;
      }

      const entrySubject = typeof entryRecord["subject"] === "string" ? entryRecord["subject"].trim() : "";
      if (entrySubject !== params.fallbackSubject) {
        continue;
      }

      const importance = getEntryImportance(entryRecord);
      if (importance !== 9) {
        continue;
      }

      const tags = getEntryTags(entryRecord);
      if (!tags.includes("handoff")) {
        continue;
      }

      retirePromises.push(
        runRetireTool(params.agenrPath, {
          entry_id: entryId,
          reason: "superseded by LLM handoff",
        })
          .then(() => undefined)
          .catch((err) => {
            params.logger.debug?.(
              `[agenr] ${params.source}: fallback retire failed for ${entryId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }),
      );
    }

    await Promise.allSettled(retirePromises);
  } catch (err) {
    params.logger.debug?.(
      `[agenr] ${params.source}: fallback retire lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function normalizeHandoffMessages(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!isRecord(message)) {
      return message;
    }
    if (message["role"] === "user" || message["role"] === "assistant") {
      return message;
    }
    if (message["type"] !== "message" || !isRecord(message["message"])) {
      return message;
    }
    const parsedMessage: Record<string, unknown> = { ...message["message"] };
    if (typeof parsedMessage["timestamp"] !== "string" && typeof message["timestamp"] === "string") {
      parsedMessage["timestamp"] = message["timestamp"];
    }
    return parsedMessage;
  });
}

async function runHandoffForSession(opts: {
  messages: unknown[];
  sessionFile: string | null;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  agenrPath: string;
  budget: number;
  defaultProject: string | undefined;
  storeConfig: Record<string, unknown>;
  sessionsDir: string;
  logger: PluginLogger | undefined;
  source: "before_reset" | "command" | "session_start";
}): Promise<void> {
  const sessionId = opts.sessionId.trim() || opts.sessionKey;
  if (handoffSeenSessionIds.has(sessionId)) {
    return;
  }
  handoffSeenSessionIds.add(sessionId);
  const evictionTimer = setTimeout(() => {
    handoffSeenSessionIds.delete(sessionId);
  }, 60_000);
  if (typeof evictionTimer.unref === "function") {
    evictionTimer.unref();
  }

  const normalizedMessages = normalizeHandoffMessages(opts.messages);
  if (normalizedMessages.length === 0) {
    return;
  }

  if (!opts.sessionFile) {
    opts.logger?.debug?.(`[agenr] ${opts.source}: no sessionFile in event, using fallback`);
  }

  // Phase 1: store fallback immediately so the next session can always read it.
  const fallbackText = extractLastExchangeText(normalizedMessages);
  let fallbackEntrySubject: string | null = null;
  if (fallbackText) {
    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    fallbackEntrySubject = `session handoff ${timestamp}`;
    const fallbackEntry = {
      entries: [
        {
          type: "event",
          importance: 9,
          subject: fallbackEntrySubject,
          content: fallbackText,
          tags: ["handoff", "session"],
        },
      ],
    };
    try {
      await runStoreTool(opts.agenrPath, fallbackEntry, opts.storeConfig, opts.defaultProject);
      opts.logger?.debug?.(`[agenr] ${opts.source}: fallback handoff stored`);
    } catch (err) {
      opts.logger?.debug?.(
        `[agenr] ${opts.source}: fallback store failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fallbackEntrySubject = null;
    }
  }

  // Phase 2: best-effort LLM upgrade, intentionally fire-and-forget.
  if (opts.sessionFile) {
    void testingApi
      .summarizeSessionForHandoff(
        normalizedMessages,
        opts.sessionsDir,
        opts.sessionFile,
        opts.logger ?? {
          warn: () => undefined,
          error: () => undefined,
        },
      )
      .then(async (summary) => {
        if (!summary) {
          return;
        }

        if (fallbackEntrySubject) {
          await retireFallbackHandoffEntries({
            agenrPath: opts.agenrPath,
            budget: opts.budget,
            defaultProject: opts.defaultProject,
            fallbackSubject: fallbackEntrySubject,
            logger: opts.logger ?? {
              warn: () => undefined,
              error: () => undefined,
            },
            source: opts.source,
          });
        }

        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const llmEntry = {
          entries: [
            {
              type: "event",
              importance: 9,
              subject: `session handoff ${timestamp}`,
              content: summary,
              tags: ["handoff", "session"],
            },
          ],
        };

        try {
          await runStoreTool(opts.agenrPath, llmEntry, opts.storeConfig, opts.defaultProject);
          opts.logger?.debug?.(`[agenr] ${opts.source}: LLM handoff stored`);
        } catch (err) {
          opts.logger?.debug?.(
            `[agenr] ${opts.source}: LLM handoff store failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })
      .catch((err) => {
        opts.logger?.debug?.(
          `[agenr] ${opts.source}: LLM handoff rejected: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}

const testingApi = {
  clearState(): void {
    seenSessions.clear();
    sessionSignalState.clear();
    handoffSeenSessionIds.clear();
  },
  readSessionsJson,
  readAndParseSessionJsonl,
  getBaseSessionPath,
  getSurfaceForSessionFile,
  readMessagesFromJsonl,
  findPriorResetFile,
  buildMergedTranscript,
  capTranscriptLength,
  summarizeSessionForHandoff,
  runHandoffForSession,
};

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

            const [{ previousSessionFile, previousTurns }, browseResult] = await Promise.all([
              findPreviousSessionFile(sessionsDir, ctx.sessionId, api.logger).then(async (file) => ({
                previousSessionFile: file,
                previousTurns: file ? await extractRecentTurns(file) : "",
              })),
              runRecall(agenrPath, budget, project, undefined, {
                context: "browse",
                since: "1d",
                limit: 20,
              }),
            ]);

            if (previousSessionFile) {
              let messages: unknown[] | null = null;
              try {
                messages = await testingApi.readAndParseSessionJsonl(previousSessionFile);
              } catch {
                messages = null;
              }

              if (Array.isArray(messages) && messages.length > 0) {
                void testingApi
                  .runHandoffForSession({
                    messages,
                    sessionFile: previousSessionFile,
                    sessionId:
                      deriveSessionIdFromSessionFile(previousSessionFile) ||
                      (ctx.sessionId ?? ctx.sessionKey ?? ""),
                    sessionKey: ctx.sessionKey ?? "",
                    agentId,
                    agenrPath,
                    budget,
                    defaultProject: project,
                    storeConfig: {
                      ...(config as Record<string, unknown> | undefined),
                      logger: api.logger,
                    },
                    sessionsDir,
                    logger: api.logger,
                    source: "session_start",
                  })
                  .catch((err) => {
                    api.logger.debug?.(
                      `[agenr] session_start: handoff fire-and-forget failed: ${err instanceof Error ? err.message : String(err)}`,
                    );
                  });
              }
            }

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

    api.on("before_reset", async (event, ctx): Promise<void> => {
      try {
        api.logger.info?.(`[agenr] before_reset: fired sessionKey=${ctx.sessionKey ?? "none"} agentId=${ctx.agentId ?? "none"} msgs=${Array.isArray(event.messages) ? event.messages.length : "non-array"} sessionFile=${event.sessionFile ?? "none"} source=before_reset`);
        const sessionKey = ctx.sessionKey;
        if (!sessionKey) {
          return;
        }

        const messages = event.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
          return;
        }

        const currentSessionFile =
          typeof event.sessionFile === "string" && event.sessionFile.trim()
            ? event.sessionFile.trim()
            : null;
        const agentId = ctx.agentId?.trim() || "main";
        const sessionsDir =
          config?.sessionsDir ?? path.join(os.homedir(), `.openclaw/agents/${agentId}/sessions`);
        const agenrPath = resolveAgenrPath(config);
        const defaultProject = config?.project?.trim() || undefined;
        const budget = resolveBudget(config);
        const storeConfig: Record<string, unknown> = {
          ...(config as Record<string, unknown> | undefined),
          logger: api.logger,
        };
        const sessionId = ctx.sessionId ?? ctx.sessionKey ?? sessionKey;

        await runHandoffForSession({
          messages,
          sessionFile: currentSessionFile,
          sessionId,
          sessionKey,
          agentId,
          agenrPath,
          budget,
          defaultProject,
          storeConfig,
          sessionsDir,
          logger: api.logger,
          source: "before_reset",
        });
      } catch (err) {
        api.logger.warn(
          `agenr plugin before_reset failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    (api as unknown as CommandHookApi).on(
      "command",
      async (event: CommandHookEvent, ctx: PluginHookAgentContext): Promise<void> => {
        try {

          if (event.action !== "new" && event.action !== "reset") {
            return;
          }

          const sessionKey = event.sessionKey;
          if (!sessionKey) {
            return;
          }

          const sessionFile =
            (event.context?.sessionEntry as { sessionFile?: string } | undefined)?.sessionFile ?? null;
          const sessionId =
            (event.context?.sessionEntry as { sessionId?: string } | undefined)?.sessionId ?? sessionKey;
          api.logger.info?.(
            `[agenr] command hook: fired action=${event.action} sessionKey=${sessionKey} sessionFile=${sessionFile ?? "none"} source=command`,
          );

          let messages: unknown[] = [];
          if (sessionFile) {
            messages = await testingApi.readAndParseSessionJsonl(sessionFile);
          }

          if (messages.length === 0) {
            return;
          }

          const agentId = ctx.agentId?.trim() || "main";
          const sessionsDir =
            config?.sessionsDir ?? path.join(os.homedir(), `.openclaw/agents/${agentId}/sessions`);
          const agenrPath = resolveAgenrPath(config);
          const defaultProject = config?.project?.trim() || undefined;
          const budget = resolveBudget(config);
          const storeConfig: Record<string, unknown> = {
            ...(config as Record<string, unknown> | undefined),
            logger: api.logger,
          };

          await runHandoffForSession({
            messages,
            sessionFile,
            sessionId,
            sessionKey,
            agentId,
            agenrPath,
            budget,
            defaultProject,
            storeConfig,
            sessionsDir,
            logger: api.logger,
            source: "command",
          });
        } catch (err) {
          api.logger.warn(
            `agenr plugin command hook failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    );

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

export const __testing = testingApi;

export default plugin;
