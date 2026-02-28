import type { Client } from "@libsql/client";
import { Type } from "@sinclair/typebox";
import fs, { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { readConfig } from "../config.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { strengthenCoRecallEdges } from "../db/co-recall.js";
import { computeRecallFeedback } from "../db/feedback.js";
import { checkAndFlagLowQuality } from "../db/review-queue.js";
import { createLlmClient } from "../llm/client.js";
import { runSimpleStream, type StreamSimpleFn } from "../llm/stream.js";
import { KNOWLEDGE_TYPES, SCOPE_LEVELS } from "../types.js";
import { toNumber, toStringValue } from "../utils/entry-utils.js";
import {
  buildQuery,
  classifyMessage,
  clearMidSessionState,
  clearMidSessionStates,
  formatMidSessionRecall,
  getMidSessionState,
  markStoreCall,
  shouldRecall,
} from "./mid-session-recall.js";
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
  stripPromptMetadata,
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
const MAX_RECALLED_SESSIONS = 200;
const DEFAULT_MID_SESSION_NORMAL_LIMIT = 5;
const DEFAULT_MID_SESSION_COMPLEX_LIMIT = 8;
const DEFAULT_MID_SESSION_QUERY_SIMILARITY_THRESHOLD = 0.85;
const DEFAULT_STORE_NUDGE_THRESHOLD = 8;
const DEFAULT_STORE_NUDGE_MAX_PER_SESSION = 3;
const sessionRecalledEntries = new Map<string, Set<string>>();
// Single-concurrency assumption: OpenClaw processes one turn at a time per session.
// sessionRef.current is set at the start of before_prompt_build and read by tool execute wrappers.
const sessionRef = { current: "" };

function isDebugEnabled(config: AgenrPluginConfig | undefined): boolean {
  return process.env.AGENR_DEBUG === "1" || config?.debug === true;
}

function debugLog(enabled: boolean, tag: string, message: string): void {
  if (enabled) {
    console.error(`[${tag}] ${message}`);
  }
}

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

function stashSessionRecalledEntries(sessionKey: string, recalledIds: Set<string>): void {
  if (!sessionKey || recalledIds.size === 0) {
    return;
  }

  sessionRecalledEntries.delete(sessionKey);
  sessionRecalledEntries.set(sessionKey, recalledIds);
  while (sessionRecalledEntries.size > MAX_RECALLED_SESSIONS) {
    const oldestKey = sessionRecalledEntries.keys().next().value;
    if (!oldestKey) {
      break;
    }
    sessionRecalledEntries.delete(oldestKey);
  }
}

function resolveMidSessionLimit(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  const normalized = Math.trunc(raw);
  if (normalized <= 0) {
    return fallback;
  }
  return normalized;
}

function resolveMidSessionSimilarityThreshold(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_MID_SESSION_QUERY_SIMILARITY_THRESHOLD;
  }
  if (raw < 0 || raw > 1) {
    return DEFAULT_MID_SESSION_QUERY_SIMILARITY_THRESHOLD;
  }
  return raw;
}

interface StoreNudgeConfig {
  enabled: boolean;
  threshold: number;
  maxPerSession: number;
}

function resolveStoreNudgeConfig(config: AgenrPluginConfig | undefined): StoreNudgeConfig {
  return {
    enabled: config?.storeNudge?.enabled !== false,
    threshold: resolveMidSessionLimit(
      config?.storeNudge?.threshold,
      DEFAULT_STORE_NUDGE_THRESHOLD,
    ),
    maxPerSession: resolveMidSessionLimit(
      config?.storeNudge?.maxPerSession,
      DEFAULT_STORE_NUDGE_MAX_PER_SESSION,
    ),
  };
}

function getRecallEntryId(item: unknown): string | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const rawEntry = (item as { entry?: unknown }).entry;
  if (typeof rawEntry !== "object" || rawEntry === null) {
    return null;
  }
  const rawId = (rawEntry as { id?: unknown }).id;
  if (typeof rawId !== "string") {
    return null;
  }
  const normalized = rawId.trim();
  return normalized.length > 0 ? normalized : null;
}

interface RecalledEntryMetrics {
  id: string;
  qualityScore: number;
  recallCount: number;
}

async function fetchRecalledEntryMetrics(db: Client, entryIds: Set<string>): Promise<RecalledEntryMetrics[]> {
  const ids = Array.from(entryIds).map((id) => id.trim()).filter((id) => id.length > 0);
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `
      SELECT id, quality_score, recall_count
      FROM entries
      WHERE id IN (${placeholders})
    `,
    args: ids,
  });

  return result.rows.map((row) => ({
    id: toStringValue((row as { id?: unknown }).id),
    qualityScore: toNumber((row as { quality_score?: unknown }).quality_score),
    recallCount: toNumber((row as { recall_count?: unknown }).recall_count),
  }));
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

The transcript contains messages from a single session labeled with a
timestamp and surface (webchat, telegram, etc.). Only include information
explicitly present in the transcript. Do not infer or invent details.

If the session contains no substantive work (e.g. just greetings or
small talk), write "No significant activity" for WORKING ON and "None"
for all other sections.

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

const HANDOFF_SUMMARY_SYSTEM_PROMPT_WITH_BACKGROUND = `You are a session summarizer for an AI agent memory system. Your job is
to produce a concise handoff note so the next session can orient quickly.

The transcript has two clearly labeled sections:

1. "BACKGROUND CONTEXT (DO NOT SUMMARIZE)" - a prior session included
   ONLY for orientation. Do NOT include facts, versions, or states from
   this section in your summary. It is there so you understand what came
   before.

2. "SUMMARIZE THIS SESSION ONLY" - the session that just ended. Your
   summary must cover ONLY this section.

If the current session contains no substantive work (e.g. just greetings
or small talk), write "No significant activity" for WORKING ON and
"None" for all other sections. Do NOT fall back to summarizing the
background context.

Only include information explicitly present in the current session
transcript. Do not infer or invent details.

Produce these sections in plain text (no markdown, no bullet symbols,
use plain dashes for lists):

WORKING ON: One to two sentences on the main task or topic, including
the project or system being worked on (e.g. "Working on agenr plugin
(#199) in the agenr-ai/agenr repo.").

KEY FINDINGS: Decisions, discoveries, or conclusions reached in the
current session only.

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

function stripInjectedContext(text: string): string {
  if (!text) {
    return "";
  }

  let cleaned = text;
  // Strip large agenr-injected context blocks (## Recent session/memory/Relevant memory
  // and any ## agenr Memory Context sub-blocks that follow them).
  cleaned = cleaned.replace(
    /(?:^|\n)## (?:Recent session|Recent memory|Relevant memory)\b[\s\S]*?(?=(?:^|\n)(?:## (?!Recent session|Recent memory|Relevant memory|agenr Memory Context)|Conversation info|\[(?:user|assistant)\]:|AGENR SIGNAL:|=== )|$)/g,
    "",
  );
  // Strip standalone ## agenr Memory Context blocks (if not already caught above).
  cleaned = cleaned.replace(
    /(?:^|\n)## agenr Memory Context[\s\S]*?(?=(?:^|\n)(?:## (?!agenr Memory Context)|Conversation info|\[(?:user|assistant)\]:|AGENR SIGNAL:|=== )|$)/g,
    "",
  );
  // Strip signal headline and following bullet entries.
  cleaned = cleaned.replace(/^\s*AGENR SIGNAL:.*(?:\n\s*-\s*\[[^\n]*)*/gm, "");
  // Strip OpenClaw conversation metadata JSON block.
  cleaned = cleaned.replace(
    /Conversation info \(untrusted metadata\):\s*\`\`\`json[\s\S]*?\`\`\`/g,
    "",
  );
  // Strip OpenClaw prompt timestamp prefixes.
  cleaned = cleaned.replace(/\[\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} (?:[A-Z]{2,5}|GMT[+-]\d{1,2})\] /g, "");

  return cleaned.trim();
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

function formatHandoffLogTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, "-");
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
      const strippedContent = stripInjectedContext(content);
      if (!strippedContent) {
        continue;
      }

      const timestamp = typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : "";
      messages.push({
        role,
        content: strippedContent,
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
    const currentBasename = path.basename(currentSessionFile);
    const currentUuid = currentBasename.split(".jsonl")[0];
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

function buildTranscript(messages: HandoffMessage[], surface: string): string {
  const cleanMessages = messages
    .map((message) => ({ ...message, content: message.content.trim() }))
    .filter((message) => message.content.length > 0);

  const lines: string[] = [];
  lines.push(`--- Session ${formatHandoffTimestamp(cleanMessages[0]?.timestamp ?? "")} [${surface}] (ended) ---`);
  lines.push(...cleanMessages.map((message) => `[${message.role}]: ${message.content}`));

  return lines.join("\n");
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
    lines.push("=== BACKGROUND CONTEXT (DO NOT SUMMARIZE) ===");
    lines.push(`Prior session ${formatHandoffTimestamp(cleanPrior[0]?.timestamp ?? "")} [${priorSurface}]`);
    lines.push(...cleanPrior.map((message) => `[${message.role}]: ${message.content}`));
    lines.push("");
  }

  lines.push("=== SUMMARIZE THIS SESSION ONLY ===");
  lines.push(
    `Current session ${formatHandoffTimestamp(cleanCurrent[0]?.timestamp ?? "")} [${currentSurface}] (ended)`,
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
  const strippedContent = stripInjectedContext(content);
  if (!strippedContent) {
    return null;
  }
  const timestamp = typeof message["timestamp"] === "string" ? message["timestamp"] : "";
  return {
    role,
    content: strippedContent,
    timestamp,
  };
}

async function summarizeSessionForHandoff(
  currentRawMessages: BeforeResetEvent["messages"],
  sessionsDir: string,
  currentSessionFile: string,
  logger: PluginApi["logger"],
  includeBackground: boolean,
  streamSimpleImpl?: StreamSimpleFn,
  logEnabled = false,
  logDir?: string,
  debugEnabled = false,
): Promise<string | null> {
  try {
    const sessionsJson = await readSessionsJson(sessionsDir);
    const currentSurface = getSurfaceForSessionFile(currentSessionFile, sessionsJson);
    const currentMessages = (Array.isArray(currentRawMessages) ? currentRawMessages : [])
      .map((message) => mapCurrentSessionMessage(message))
      .filter((message): message is HandoffMessage => message !== null);

    let currentSlice = currentMessages.slice(
      -Math.min(currentMessages.length, HANDOFF_TRANSCRIPT_MAX_MESSAGES),
    );
    if (currentSlice.length < 4) {
      debugLog(debugEnabled, "before_reset", "skipping LLM summary - reason: too few messages");
      return null;
    }

    let priorSlice: HandoffMessage[] = [];
    let priorSurface = "prior session";
    let transcript = "";
    if (includeBackground) {
      const priorBudget = HANDOFF_TRANSCRIPT_MAX_MESSAGES - currentSlice.length;
      const priorFile = await findPriorResetFile(sessionsDir, currentSessionFile);
      if (priorFile && priorBudget > 0) {
        const priorAllMessages = await readMessagesFromJsonl(priorFile);
        priorSlice = priorAllMessages.slice(-priorBudget);
        priorSurface = getSurfaceForSessionFile(getBaseSessionPath(priorFile), sessionsJson);
      }
      transcript = buildMergedTranscript(priorSlice, priorSurface, currentSlice, currentSurface);
    } else {
      transcript = buildTranscript(currentSlice, currentSurface);
    }

    const nonHeaderLineCount = countTranscriptContentLines(transcript);
    if (nonHeaderLineCount < 3) {
      debugLog(debugEnabled, "before_reset", "skipping LLM summary - reason: short transcript");
      return null;
    }

    if (includeBackground) {
      if (transcript.length > HANDOFF_TRANSCRIPT_MAX_CHARS) {
        transcript = capTranscriptLength({
          priorMessages: priorSlice,
          priorSurface,
          currentMessages: currentSlice,
          currentSurface,
          maxChars: HANDOFF_TRANSCRIPT_MAX_CHARS,
        });
      }
    } else if (transcript.length > HANDOFF_TRANSCRIPT_MAX_CHARS) {
      while (transcript.length > HANDOFF_TRANSCRIPT_MAX_CHARS && currentSlice.length > 1) {
        currentSlice = currentSlice.slice(1);
        transcript = buildTranscript(currentSlice, currentSurface);
      }
      if (transcript.length > HANDOFF_TRANSCRIPT_MAX_CHARS) {
        transcript = transcript.slice(-HANDOFF_TRANSCRIPT_MAX_CHARS);
        const firstNewline = transcript.indexOf("\n");
        if (firstNewline > 0) {
          transcript = transcript.slice(firstNewline + 1);
        }
      }
    }

    let llmClient;
    try {
      llmClient = createLlmClient({});
    } catch (err) {
      debugLog(debugEnabled, "before_reset", "skipping LLM summary - reason: LLM client init failed");
      return null;
    }

    const resolvedModel = llmClient.resolvedModel;
    const credentials = llmClient.credentials;
    const apiKey = typeof credentials.apiKey === "string" ? credentials.apiKey.trim() : "";
    if (!apiKey) {
      debugLog(debugEnabled, "before_reset", "no apiKey available, skipping LLM summary");
      return null;
    }

    const systemPrompt = includeBackground
      ? HANDOFF_SUMMARY_SYSTEM_PROMPT_WITH_BACKGROUND
      : HANDOFF_SUMMARY_SYSTEM_PROMPT;
    const context = {
      systemPrompt,
      messages: [{ role: "user" as const, content: transcript, timestamp: Date.now() }],
      tools: [],
    };

    if (includeBackground) {
      debugLog(
        debugEnabled,
        "before_reset",
        `sending to LLM model=${resolvedModel.modelId} chars=${transcript.length} currentMsgs=${currentSlice.length} priorMsgs=${priorSlice.length}`,
      );
    } else {
      debugLog(
        debugEnabled,
        "before_reset",
        `sending to LLM model=${resolvedModel.modelId} chars=${transcript.length} msgs=${currentSlice.length}`,
      );
    }
    const assistantMsg = await runSimpleStream({
      model: resolvedModel.model,
      context,
      options: { apiKey },
      verbose: false,
      streamSimpleImpl,
    });
    if (assistantMsg.stopReason === "error") {
      debugLog(debugEnabled, "before_reset", "skipping LLM summary - reason: LLM error stop");
      return null;
    }

    const summaryText = extractAssistantSummaryText(assistantMsg);
    if (!summaryText) {
      debugLog(debugEnabled, "before_reset", "skipping LLM summary - reason: empty summary text");
      return null;
    }

    const normalizedLogDir = typeof logDir === "string" ? logDir.trim() : "";
    if (logEnabled && normalizedLogDir) {
      const timestamp = formatHandoffLogTimestamp(new Date());
      const requestPath = path.join(normalizedLogDir, `handoff-${timestamp}-request.txt`);
      const responsePath = path.join(normalizedLogDir, `handoff-${timestamp}-response.txt`);
      const requestPayload = [
        "=== SYSTEM PROMPT ===",
        systemPrompt,
        "",
        "=== TRANSCRIPT ===",
        transcript,
        "",
        "=== METADATA ===",
        `model: ${resolvedModel.modelId}`,
        `currentMsgs: ${currentSlice.length}`,
        `priorMsgs: ${priorSlice.length}`,
        `includeBackground: ${includeBackground}`,
        `transcriptChars: ${transcript.length}`,
      ].join("\n");
      const responsePayload = [
        "=== LLM RESPONSE ===",
        summaryText,
        "",
        "=== METADATA ===",
        `model: ${resolvedModel.modelId}`,
        `stopReason: ${assistantMsg.stopReason}`,
        `responseChars: ${summaryText.length}`,
      ].join("\n");

      try {
        await fs.promises.mkdir(normalizedLogDir, { recursive: true });
        await Promise.all([
          fs.promises.writeFile(requestPath, requestPayload, "utf8"),
          fs.promises.writeFile(responsePath, responsePayload, "utf8"),
        ]);
        debugLog(debugEnabled, "handoff", `logged LLM request/response to ${normalizedLogDir}`);
      } catch (err) {
        console.error(
          `[agenr] handoff: failed to write LLM request/response logs: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }


    debugLog(debugEnabled, "before_reset", `LLM summary received chars=${summaryText.length}`);
    return summaryText;
  } catch (err) {
    console.error(
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
  dbPath?: string;
  fallbackSubject: string;
  logger: PluginApi["logger"];
  debugEnabled?: boolean;
  source: "before_reset" | "command" | "session_start";
}): Promise<void> {
  try {
    const browseResult = await runRecall(params.agenrPath, params.budget, params.defaultProject, undefined, {
      context: "browse",
      since: "1d",
      limit: 100,
    }, params.dbPath);
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
        }, params.dbPath)
          .then(() => {
            debugLog(Boolean(params.debugEnabled), "session-start", `retired handoff ${entryId}`);
          })
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
  includeBackground?: boolean;
  logEnabled?: boolean;
  logDir?: string;
  debugEnabled?: boolean;
  logger: PluginLogger | undefined;
  source: "before_reset" | "command" | "session_start";
  dbPath?: string;
}): Promise<void> {
  const sessionId = opts.sessionId.trim() || opts.sessionKey;
  if (handoffSeenSessionIds.has(sessionId)) {
    debugLog(Boolean(opts.debugEnabled), opts.source, `dedup skip sessionId=${sessionId}`);
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
      await runStoreTool(opts.agenrPath, fallbackEntry, opts.storeConfig, opts.defaultProject, opts.dbPath);
      debugLog(Boolean(opts.debugEnabled), opts.source, "fallback handoff stored");
    } catch (err) {
      console.error(
        `[agenr] ${opts.source}: fallback store failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      fallbackEntrySubject = null;
    }
  }

  // Phase 2: await LLM upgrade so before_reset does not resolve early.
  if (opts.sessionFile) {
    const includeBackground = opts.includeBackground ?? false;
    const summary = await testingApi.summarizeSessionForHandoff(
      normalizedMessages,
      opts.sessionsDir,
      opts.sessionFile,
      opts.logger ?? {
        warn: () => undefined,
        error: () => undefined,
      },
      includeBackground,
      undefined,
      opts.logEnabled ?? false,
      opts.logDir,
      opts.debugEnabled ?? false,
    );

    if (summary) {
      if (fallbackEntrySubject) {
        await retireFallbackHandoffEntries({
          agenrPath: opts.agenrPath,
          budget: opts.budget,
          defaultProject: opts.defaultProject,
          dbPath: opts.dbPath,
          fallbackSubject: fallbackEntrySubject,
          logger: opts.logger ?? {
            warn: () => undefined,
            error: () => undefined,
          },
          debugEnabled: opts.debugEnabled,
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
        await runStoreTool(opts.agenrPath, llmEntry, opts.storeConfig, opts.defaultProject, opts.dbPath);
        debugLog(Boolean(opts.debugEnabled), opts.source, "LLM handoff stored");
      } catch (err) {
        console.error(
          `[agenr] ${opts.source}: LLM handoff store failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

const testingApi = {
  clearState(): void {
    seenSessions.clear();
    sessionSignalState.clear();
    clearMidSessionStates();
    handoffSeenSessionIds.clear();
    sessionRecalledEntries.clear();
    sessionRef.current = "";
  },
  readSessionsJson,
  readAndParseSessionJsonl,
  getBaseSessionPath,
  getSurfaceForSessionFile,
  readMessagesFromJsonl,
  stripInjectedContext,
  findPriorResetFile,
  buildTranscript,
  buildMergedTranscript,
  capTranscriptLength,
  HANDOFF_SUMMARY_SYSTEM_PROMPT,
  HANDOFF_SUMMARY_SYSTEM_PROMPT_WITH_BACKGROUND,
  summarizeSessionForHandoff,
  runHandoffForSession,
};

const plugin = {
  id: "agenr",
  name: "agenr memory context",
  description: "Injects agenr long-term memory into every agent session via before_prompt_build",

  register(api: PluginApi): void {
    const config = api.pluginConfig as AgenrPluginConfig | undefined;
    const debug = isDebugEnabled(config);
    const includeBackground = config?.handoff?.includeBackground ?? false;
    const handoffLogEnabled = config?.handoff?.logEnabled === true;
    const handoffLogDirRaw = config?.handoff?.logDir;
    const handoffLogDir =
      typeof handoffLogDirRaw === "string" && handoffLogDirRaw.trim()
        ? handoffLogDirRaw.trim()
        : undefined;

    api.on(
      "before_prompt_build",
      async (
        event: BeforePromptBuildEvent,
        ctx: PluginHookAgentContext,
      ): Promise<BeforePromptBuildResult | undefined> => {
        try {
          sessionRef.current = "";
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
          sessionRef.current = dedupeKey || sessionKey;
          const agenrPath = resolveAgenrPath(config);
          const budget = resolveBudget(config);
          const project = config?.project?.trim() || undefined;
          let markdown: string | undefined;
          let midSessionMarkdown: string | undefined;
          const isFirstInSession = dedupeKey ? !hasSeenSession(dedupeKey) : true;
          const stateKey = dedupeKey || sessionKey;
          const state = isFirstInSession ? undefined : getMidSessionState(stateKey);
          if (state) {
            state.turnCount += 1;
          }

          if (isFirstInSession) {
            debugLog(debug, "session-start", `sessionKey=${sessionKey} dedupeKey=${dedupeKey} isFirst=true`);
            if (dedupeKey) {
              markSessionSeen(dedupeKey);
            }

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
              }, config?.dbPath),
            ]);

            if (previousSessionFile) {
              let messages: unknown[] | null = null;
              try {
                messages = await testingApi.readAndParseSessionJsonl(previousSessionFile);
              } catch {
                messages = null;
              }

              if (Array.isArray(messages) && messages.length > 0) {
                const sessionKey = ctx.sessionKey ?? "";
                debugLog(debug, "session-start", "triggered sessionKey=" + sessionKey);
                try {
                  await testingApi.runHandoffForSession({
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
                    includeBackground,
                    logEnabled: handoffLogEnabled,
                    logDir: handoffLogDir,
                    debugEnabled: debug,
                    logger: api.logger,
                    source: "session_start",
                    dbPath: config?.dbPath,
                  });
                  debugLog(debug, "session-start", "runHandoffForSession completed");
                } catch (err) {
                  console.error(
                    `[agenr] session_start: handoff failed: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
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
              const rawSemantic = await runRecall(agenrPath, budget, project, seed, undefined, config?.dbPath);
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
            debugLog(debug, "session-start", `browse returned ${browseResult?.results.length ?? 0} entries`);
            debugLog(debug, "session-start", `semantic recall returned ${semanticResult?.results.length ?? 0} entries`);

            if (browseResult) {
              debugLog(
                debug,
                "session-start",
                `browse returned ${browseResult.results.length} entries, checking for handoffs to retire`,
              );
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
                    }, config?.dbPath)
                      .then(() => {
                        debugLog(debug, "session-start", `retired handoff ${entryId}`);
                      })
                      .catch((err) => {
                        console.error(
                          `[agenr] session-start: retire handoff ${entryId} failed: ${err instanceof Error ? err.message : String(err)}`,
                        );
                      }),
                  );
                } else {
                  debugLog(debug, "session-start", "handoff entry missing id, skipping retire");
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
            debugLog(debug, "session-start", `prependContext chars=${markdown?.length ?? 0}`);

            const recalledIds = new Set<string>();
            for (const item of browseResult?.results ?? []) {
              const id =
                typeof item.entry?.id === "string" && item.entry.id.trim()
                  ? item.entry.id.trim()
                  : null;
              if (id) {
                recalledIds.add(id);
              }
            }
            for (const item of semanticResult?.results ?? []) {
              const id =
                typeof item.entry?.id === "string" && item.entry.id.trim()
                  ? item.entry.id.trim()
                  : null;
              if (id) {
                recalledIds.add(id);
              }
            }
            stashSessionRecalledEntries(sessionKey, recalledIds);
            debugLog(debug, "session-start", `stashed ${recalledIds.size} recalled IDs`);
          } else {
            debugLog(debug, "prompt-build", `sessionKey=${sessionKey} isFirst=false`);
          }

          if (state && config?.midSessionRecall?.enabled !== false) {
            const rawPrompt = typeof event.prompt === "string" ? stripPromptMetadata(event.prompt) : "";
            const userMessage = rawPrompt.trim();
            if (userMessage) {
              state.recentMessages.push(userMessage);
            }

            const classification = classifyMessage(userMessage);
            debugLog(
              debug,
              "mid-session-recall",
              `turn=${state.turnCount} classification=${classification} msg="${userMessage.slice(0, 80)}"`,
            );
            if (classification !== "trivial") {
              const query = buildQuery(state.recentMessages.toArray());
              const threshold = resolveMidSessionSimilarityThreshold(
                config?.midSessionRecall?.querySimilarityThreshold,
              );
              if (shouldRecall(query, state.lastRecallQuery, threshold)) {
                const limit = classification === "complex"
                  ? resolveMidSessionLimit(
                    config?.midSessionRecall?.complexLimit,
                    DEFAULT_MID_SESSION_COMPLEX_LIMIT,
                  )
                  : resolveMidSessionLimit(
                    config?.midSessionRecall?.normalLimit,
                    DEFAULT_MID_SESSION_NORMAL_LIMIT,
                  );
                debugLog(
                  debug,
                  "mid-session-recall",
                  `firing recall query="${query.slice(0, 100)}" limit=${limit}`,
                );
                const midSessionResult = await runRecall(
                  agenrPath,
                  budget,
                  project,
                  query,
                  { limit },
                  config?.dbPath,
                );
                if (midSessionResult) {
                  state.lastRecallQuery = query;
                }

                if (midSessionResult && midSessionResult.results.length > 0) {
                  const alreadyRecalledIds = sessionRecalledEntries.get(sessionKey) ?? new Set<string>();
                  const freshResults = midSessionResult.results.filter((item) => {
                    const id = getRecallEntryId(item);
                    if (!id) {
                      return true;
                    }
                    if (alreadyRecalledIds.has(id)) {
                      return false;
                    }
                    if (state.recalledIds.has(id)) {
                      return false;
                    }
                    return true;
                  });

                  for (const item of freshResults) {
                    const id = getRecallEntryId(item);
                    if (id) {
                      state.recalledIds.add(id);
                    }
                  }

                  midSessionMarkdown = formatMidSessionRecall(freshResults);
                  debugLog(
                    debug,
                    "mid-session-recall",
                    `raw=${midSessionResult.results.length} alreadyRecalled=${alreadyRecalledIds.size} stateRecalled=${state.recalledIds.size} fresh=${freshResults.length} injected=${!!midSessionMarkdown}`,
                  );
                }
              }
            }
          }

          let signal: string | undefined;
          if (config?.signalsEnabled !== false) {
            const signalConfig = resolveSignalConfig(config);
            // Always call checkSignals so the watermark advances even if we suppress delivery.
            // This prevents stale-watermark bursts when cooldown expires.
            const db = await ensurePluginDb(config);
            const candidateSignal = await checkSignals(db, sessionKey, signalConfig);
            debugLog(debug, "signals", `check result=${candidateSignal ? "found" : "none"}`);
            const state = sessionSignalState.get(sessionKey) ?? { lastSignalAt: 0, signalCount: 0 };

            // Suppress delivery (but NOT watermark advance) during cooldown or session cap.
            const isCooldown =
              signalConfig.cooldownMs > 0 && Date.now() - state.lastSignalAt < signalConfig.cooldownMs;
            const isMaxReached =
              signalConfig.maxPerSession > 0 && state.signalCount >= signalConfig.maxPerSession;

            if (candidateSignal && !isCooldown && !isMaxReached) {
              sessionSignalState.set(sessionKey, {
                lastSignalAt: Date.now(),
                signalCount: state.signalCount + 1,
              });
              signal = candidateSignal;
            }
            debugLog(debug, "signals", `cooldown=${isCooldown} maxReached=${isMaxReached} injected=${!!signal}`);
          }

          let storeNudge: string | undefined;
          if (!isFirstInSession && state) {
            const nudgeConfig = resolveStoreNudgeConfig(config);
            if (nudgeConfig.enabled) {
              const gap = state.turnCount - state.lastStoreTurn;
              debugLog(
                debug,
                "store-nudge",
                `check gap=${gap} threshold=${nudgeConfig.threshold} nudgeCount=${state.nudgeCount} maxPerSession=${nudgeConfig.maxPerSession}`,
              );
              if (gap >= nudgeConfig.threshold && state.nudgeCount < nudgeConfig.maxPerSession) {
                storeNudge = "[MEMORY CHECK] You have not stored any knowledge recently. Review the conversation for decisions, preferences, lessons, or facts worth remembering.";
                state.nudgeCount += 1;
                state.lastStoreTurn = state.turnCount;
                debugLog(debug, "store-nudge", `injecting nudge #${state.nudgeCount}`);
              } else {
                const reason = gap < nudgeConfig.threshold
                  ? "gap_below_threshold"
                  : "max_reached";
                debugLog(debug, "store-nudge", `skipped reason=${reason}`);
              }
            } else {
              debugLog(debug, "store-nudge", "skipped reason=disabled");
            }
          }

          const prependContext = [markdown, midSessionMarkdown, signal, storeNudge]
            .filter(Boolean)
            .join("\n\n");
          debugLog(
            debug,
            "prompt-build",
            `prependContext total chars=${prependContext.length} (recall=${markdown?.length ?? 0} midSession=${midSessionMarkdown?.length ?? 0} signal=${signal?.length ?? 0} nudge=${storeNudge?.length ?? 0})`,
          );
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

        const recalledEntryIds = sessionRecalledEntries.get(sessionKey);
        sessionRecalledEntries.delete(sessionKey);
        const messages = event.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
          return;
        }
        debugLog(debug, "before_reset", "triggered sessionKey=" + sessionKey + " msgs=" + messages.length);

        if (recalledEntryIds && recalledEntryIds.size > 0) {
          const runtimeConfig = readConfig(process.env);
          if (runtimeConfig) {
            try {
              const db = await ensurePluginDb(config);
              const feedbackResult = await computeRecallFeedback(
                db,
                sessionKey,
                messages,
                recalledEntryIds,
                runtimeConfig,
                api.logger,
              );
              try {
                const timestamp = new Date().toISOString();
                await strengthenCoRecallEdges(db, feedbackResult.usedIds, timestamp);
              } catch (err) {
                api.logger.warn(
                  `agenr plugin before_reset co-recall edges failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }

              try {
                const qualityMetrics = await fetchRecalledEntryMetrics(db, recalledEntryIds);
                for (const metric of qualityMetrics) {
                  await checkAndFlagLowQuality(db, metric.id, metric.qualityScore, metric.recallCount);
                }
              } catch (err) {
                api.logger.warn(
                  `agenr plugin before_reset quality check failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            } catch (err) {
              api.logger.warn(
                `agenr plugin before_reset feedback failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
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
          includeBackground,
          logEnabled: handoffLogEnabled,
          logDir: handoffLogDir,
          debugEnabled: debug,
          logger: api.logger,
          source: "before_reset",
          dbPath: config?.dbPath,
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
          debugLog(debug, "command", "triggered action=" + event.action + " sessionKey=" + event.sessionKey);
          if (event.action !== "new" && event.action !== "reset") {
            return;
          }

          if (event.action === "new" || event.action === "reset") {
            const resetKey = event.sessionKey;
            if (resetKey) {
              clearMidSessionState(resetKey);
            }
            const resetSessionId =
              (event.context?.sessionEntry as { sessionId?: string } | undefined)
                ?.sessionId?.trim() ?? "";
            if (resetSessionId && resetSessionId !== resetKey) {
              clearMidSessionState(resetSessionId);
            }
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
            includeBackground,
            logEnabled: handoffLogEnabled,
            logDir: handoffLogDir,
            debugEnabled: debug,
            logger: api.logger,
            source: "command",
            dbPath: config?.dbPath,
          });

          debugLog(debug, "command", "handoff complete");
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
            around: Type.Optional(
              Type.String({
                description:
                  "Bias recall toward a specific date. Entries closer to this date rank higher. ISO date or relative (e.g. 7d = 7 days ago).",
              }),
            ),
            aroundRadius: Type.Optional(
              Type.Number({ description: "Window radius in days for --around (default: 14)." }),
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
            const dbPath = runtimeConfig?.dbPath;
            return runRecallTool(agenrPath, params, defaultProject, dbPath);
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
            const key = sessionRef.current;
            if (key) {
              markStoreCall(key);
              debugLog(debug, "store-nudge", `store detected session=${key}`);
            }
            const agenrPath = resolveAgenrPath(runtimeConfig);
            const defaultProject = runtimeConfig?.project?.trim() || undefined;
            const toolConfig: Record<string, unknown> = {
              ...(runtimeConfig as Record<string, unknown> | undefined),
              logger: api.logger,
            };
            const dbPath = runtimeConfig?.dbPath;
            return runStoreTool(
              agenrPath,
              params,
              toolConfig,
              defaultProject,
              dbPath,
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
            const dbPath = runtimeConfig?.dbPath;
            return runExtractTool(agenrPath, params, dbPath);
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
            const dbPath = runtimeConfig?.dbPath;
            return runRetireTool(agenrPath, params, dbPath);
          },
        },
      );
    }
  },
};

export const __testing = testingApi;

export default plugin;
