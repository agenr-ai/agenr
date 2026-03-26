import { promises as fs } from "node:fs";

import type { TranscriptPort } from "../../../core/ports.js";
import type { ParsedTranscript, TranscriptMessage } from "../../../core/types.js";
import {
  DEFAULT_TOOL_RESULT_DROP_NAMES,
  DEFAULT_TOOL_RESULT_KEEP_NAMES,
  asRecord,
  extractToolCallBlocks,
  getString,
  shouldKeepToolResult,
  summarizeToolCall,
  toolResultPlaceholder,
  type ToolCallContext,
} from "./tool-summarization.js";

type OpenClawRole = "user" | "assistant" | "toolResult" | "system" | "unknown";

const TEXT_BLOCK_TYPES = new Set(["input_text", "output_text", "text"]);
const SKIPPED_RECORD_TYPES = new Set(["compaction", "custom", "thinking_level_change"]);
const TOOL_RESULT_POLICY = {
  dropToolNames: new Set([...DEFAULT_TOOL_RESULT_DROP_NAMES, "agenr_recall", "image"]),
  keepToolNames: new Set(DEFAULT_TOOL_RESULT_KEEP_NAMES.filter((name) => name !== "image")),
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes supported timestamp inputs to ISO-8601 strings.
 *
 * @param value - Candidate timestamp value from transcript data.
 * @returns ISO timestamp when parsing succeeds, otherwise `undefined`.
 */
export function parseTimestampValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value > 1e12 ? value : value * 1000;
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}

/**
 * Extracts the first usable timestamp from a transcript record.
 *
 * @param record - Transcript record to inspect.
 * @returns ISO timestamp when a supported timestamp field is present.
 */
export function extractTimestamp(record: Record<string, unknown>): string | undefined {
  for (const field of ["timestamp", "ts", "created_at", "createdAt", "time", "date"]) {
    const parsed = parseTimestampValue(record[field]);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

/**
 * Parses a single JSON line when it contains an object payload.
 *
 * @param line - Raw JSONL line text.
 * @returns Parsed object record, or `null` when the line is empty or invalid.
 */
export function parseJsonObjectLine(line: string): Record<string, unknown> | null {
  if (!line || line.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Iterates JSONL lines and invokes a callback for each valid object record.
 *
 * @param raw - Raw JSONL document contents.
 * @param warnings - Warning accumulator for malformed lines.
 * @param onRecord - Callback invoked with each parsed object record and line number.
 */
export function parseJsonlLines(
  raw: string,
  warnings: string[],
  onRecord: (record: Record<string, unknown>, lineNumber: number) => void,
): void {
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(`Skipped malformed JSONL line ${index + 1}`);
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }

    onRecord(parsed as Record<string, unknown>, index + 1);
  }
}

function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    const normalized = normalizeWhitespace(content);
    return normalized ? [normalized] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const textBlocks: string[] = [];
  let nonTextBlockCount = 0;

  for (const block of content) {
    if (typeof block === "string") {
      const normalized = normalizeWhitespace(block);
      if (normalized) {
        textBlocks.push(normalized);
      }
      continue;
    }

    const record = asRecord(block);
    if (!record) {
      continue;
    }

    if (typeof record.text === "string") {
      const normalized = normalizeWhitespace(record.text);
      if (normalized) {
        textBlocks.push(normalized);
      }
      continue;
    }

    const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    if (typeof record.content === "string" && TEXT_BLOCK_TYPES.has(type)) {
      const normalized = normalizeWhitespace(record.content);
      if (normalized) {
        textBlocks.push(normalized);
      }
      continue;
    }

    nonTextBlockCount += 1;
  }

  if (textBlocks.length === 0 && nonTextBlockCount > 0) {
    textBlocks.push(`[non-text content omitted: ${nonTextBlockCount} block${nonTextBlockCount === 1 ? "" : "s"}]`);
  }

  return textBlocks;
}

/**
 * Collapses message content blocks into a single normalized text string.
 *
 * @param content - Raw OpenClaw message content.
 * @returns Whitespace-normalized transcript text.
 */
export function normalizeMessageText(content: unknown): string {
  return normalizeWhitespace(extractTextBlocks(content).join("\n"));
}

async function getFileMtimeTimestamp(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return parseTimestampValue(stat.mtime.toISOString());
  } catch {
    return undefined;
  }
}

/**
 * Resolves a fallback timestamp using candidate values, file metadata, and current time.
 *
 * @param filePath - Transcript file path used for metadata fallback.
 * @param candidates - Candidate timestamps to try in order.
 * @returns ISO timestamp guaranteed to be present.
 */
export async function resolveTimestampFallback(
  filePath: string,
  ...candidates: Array<string | undefined>
): Promise<string> {
  for (const candidate of candidates) {
    const parsed = parseTimestampValue(candidate);
    if (parsed) {
      return parsed;
    }
  }

  const fileMtime = await getFileMtimeTimestamp(filePath);
  if (fileMtime) {
    return fileMtime;
  }

  return new Date().toISOString();
}

/**
 * Ensures every parsed message has a usable timestamp.
 *
 * @param filePath - Transcript file path used for fallback resolution.
 * @param messages - Parsed transcript messages to update in place.
 * @param options - Optional session-level timestamp hints.
 * @returns The fallback timestamp applied to messages missing timestamps.
 */
export async function applyMessageTimestampFallbacks(
  filePath: string,
  messages: TranscriptMessage[],
  options?: { sessionTimestamp?: string },
): Promise<string> {
  const fallbackTimestamp = await resolveTimestampFallback(filePath, options?.sessionTimestamp);
  for (const message of messages) {
    message.timestamp = parseTimestampValue(message.timestamp) ?? fallbackTimestamp;
  }

  return fallbackTimestamp;
}

function normalizeOpenClawRole(value: unknown): OpenClawRole {
  if (typeof value !== "string") {
    return "unknown";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "user" || normalized === "human") {
    return "user";
  }

  if (normalized === "assistant" || normalized === "ai" || normalized === "developer") {
    return "assistant";
  }

  if (normalized === "system") {
    return "system";
  }

  if (normalized === "tool" || normalized === "toolresult" || normalized === "tool_result") {
    return "toolResult";
  }

  return "unknown";
}

function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n[...truncated]`;
}

function isPureBase64(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 500) {
    return false;
  }

  if (!/[+/=]/.test(trimmed)) {
    return false;
  }

  return /^[A-Za-z0-9+/=\s]{500,}$/.test(trimmed);
}

function normalizeLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeSessionLabel(value: string): string | undefined {
  const normalized = normalizeLabel(value);
  return normalized.length > 0 ? normalized : undefined;
}

function extractRawTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const textBlocks: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      textBlocks.push(block);
      continue;
    }

    const record = asRecord(block);
    if (!record) {
      continue;
    }

    if (typeof record.text === "string") {
      textBlocks.push(record.text);
      continue;
    }

    const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    if (typeof record.content === "string" && TEXT_BLOCK_TYPES.has(type)) {
      textBlocks.push(record.content);
    }
  }

  return textBlocks;
}

function extractConversationLabel(content: unknown): string | undefined {
  const rawTextBlocks = extractRawTextBlocks(content);

  for (const block of rawTextBlocks) {
    const matches = block.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
    for (const match of matches) {
      const candidate = match[1];
      if (!candidate) {
        continue;
      }

      try {
        const parsed = JSON.parse(candidate);
        const record = asRecord(parsed);
        const conversationLabel = record ? getString(record.conversation_label) : undefined;
        const normalizedLabel = conversationLabel ? normalizeSessionLabel(conversationLabel) : undefined;
        if (normalizedLabel) {
          return normalizedLabel;
        }
      } catch {
        // Ignore malformed metadata blocks embedded in user content.
      }
    }
  }

  return undefined;
}

function extractAssistantTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    const normalized = normalizeWhitespace(content);
    return normalized ? [normalized] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      const normalized = normalizeWhitespace(block);
      if (normalized) {
        textParts.push(normalized);
      }
      continue;
    }

    const record = asRecord(block);
    if (!record) {
      continue;
    }

    if (typeof record.text === "string") {
      const normalized = normalizeWhitespace(record.text);
      if (normalized) {
        textParts.push(normalized);
      }
      continue;
    }

    const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    if (typeof record.content === "string" && TEXT_BLOCK_TYPES.has(type)) {
      const normalized = normalizeWhitespace(record.content);
      if (normalized) {
        textParts.push(normalized);
      }
    }
  }

  return textParts;
}

function pushMessage(
  messages: TranscriptMessage[],
  role: "user" | "assistant",
  text: string,
  timestamp?: string,
): void {
  messages.push({
    index: messages.length,
    role,
    text,
    timestamp,
  });
}

/**
 * Parses OpenClaw JSONL session exports into normalized agenr transcripts.
 */
export class OpenClawTranscriptParser implements TranscriptPort {
  /**
   * Parses an OpenClaw JSONL transcript file into agenr transcript data.
   *
   * @param filePath - Absolute or relative path to the transcript file.
   * @param options - Optional parser flags for verbose diagnostics.
   * @returns Parsed transcript messages, warnings, and metadata.
   */
  async parseFile(filePath: string, options?: { verbose?: boolean }): Promise<ParsedTranscript> {
    const raw = await fs.readFile(filePath, "utf8");
    const warnings: string[] = [];
    const messages: TranscriptMessage[] = [];
    const verbose = options?.verbose === true;

    const stats = {
      totalMessageRecords: 0,
      systemDropped: 0,
      base64Dropped: 0,
      skippedRecordTypes: 0,
      toolResultsDropped: 0,
      toolResultsKept: 0,
    };

    let sessionId: string | undefined;
    let sessionLabel: string | undefined;
    let sessionTimestamp: string | undefined;
    const modelsUsed: string[] = [];
    const modelsUsedSet = new Set<string>();

    const pendingToolCalls: ToolCallContext[] = [];
    const pendingToolCallsById = new Map<string, ToolCallContext>();

    const addModelUsed = (value: unknown) => {
      const modelId = getString(value);
      if (!modelId || modelsUsedSet.has(modelId)) {
        return;
      }

      modelsUsedSet.add(modelId);
      modelsUsed.push(modelId);
    };

    const resolveToolContext = (message: Record<string, unknown>): ToolCallContext | null => {
      const toolCallId =
        getString(message.toolCallId) ??
        getString(message.tool_call_id) ??
        getString(message.call_id) ??
        getString(message.id);
      if (toolCallId && pendingToolCallsById.has(toolCallId)) {
        const context = pendingToolCallsById.get(toolCallId) ?? null;
        pendingToolCallsById.delete(toolCallId);
        if (context) {
          const queuedIndex = pendingToolCalls.findIndex((toolCall) => toolCall.id === toolCallId);
          if (queuedIndex >= 0) {
            pendingToolCalls.splice(queuedIndex, 1);
          }
        }

        return context;
      }

      return pendingToolCalls.shift() ?? null;
    };

    parseJsonlLines(raw, warnings, (record) => {
      if (record.type === "session") {
        sessionId = getString(record.id) ?? sessionId;
        sessionTimestamp = extractTimestamp(record) ?? sessionTimestamp;
        sessionLabel = normalizeSessionLabel(getString(record.conversation_label) ?? "") ?? sessionLabel;
        addModelUsed(record.model);
        return;
      }

      if (record.type === "model_change") {
        addModelUsed(record.modelId);
        stats.skippedRecordTypes += 1;
        return;
      }

      if (typeof record.type === "string" && SKIPPED_RECORD_TYPES.has(record.type)) {
        stats.skippedRecordTypes += 1;
        return;
      }

      const message = asRecord(record.message);
      if (!message) {
        return;
      }

      stats.totalMessageRecords += 1;

      const role = normalizeOpenClawRole(message.role);
      if (role === "system") {
        stats.systemDropped += 1;
        return;
      }

      const timestamp = extractTimestamp(record) ?? extractTimestamp(message);

      if (role === "user") {
        const extractedLabel = extractConversationLabel(message.content);
        if (extractedLabel) {
          sessionLabel = extractedLabel;
        }

        const text = normalizeMessageText(message.content);
        if (!text) {
          return;
        }

        if (isPureBase64(text)) {
          stats.base64Dropped += 1;
          return;
        }

        pushMessage(messages, "user", text, timestamp);
        return;
      }

      if (role === "assistant") {
        const toolCalls = extractToolCallBlocks(message.content);
        for (const toolCall of toolCalls) {
          pendingToolCalls.push(toolCall);
          if (toolCall.id) {
            pendingToolCallsById.set(toolCall.id, toolCall);
          }
        }

        const assistantText = normalizeWhitespace(
          [
            ...extractAssistantTextParts(message.content),
            ...toolCalls.map((toolCall) => summarizeToolCall(toolCall)),
          ].join("\n"),
        );
        addModelUsed(message.model);

        if (!assistantText) {
          return;
        }

        if (isPureBase64(assistantText)) {
          stats.base64Dropped += 1;
          return;
        }

        pushMessage(messages, "assistant", truncateWithMarker(assistantText, 5000), timestamp);
        return;
      }

      if (role !== "toolResult") {
        return;
      }

      const toolContext = resolveToolContext(message);
      const toolName =
        getString(message.name) ??
        getString(message.tool) ??
        getString(record.name) ??
        getString(record.tool) ??
        toolContext?.name;
      const toolArgs = toolContext?.args ?? {};
      const toolText = normalizeMessageText(message.content);

      if (!toolText) {
        return;
      }

      if (isPureBase64(toolText)) {
        stats.base64Dropped += 1;
        return;
      }

      const decision = shouldKeepToolResult(toolName, toolText, TOOL_RESULT_POLICY);
      if (decision.keep) {
        stats.toolResultsKept += 1;
        pushMessage(
          messages,
          "assistant",
          decision.truncateTo ? truncateWithMarker(toolText, decision.truncateTo) : toolText,
          timestamp,
        );
        return;
      }

      stats.toolResultsDropped += 1;
      pushMessage(messages, "assistant", toolResultPlaceholder(toolName ?? "unknown", toolArgs), timestamp);
    });

    const fallbackTimestamp =
      messages.length > 0
        ? await applyMessageTimestampFallbacks(filePath, messages, { sessionTimestamp })
        : await resolveTimestampFallback(filePath, sessionTimestamp);

    if (verbose) {
      warnings.push(
        `Filtered transcript: ${stats.toolResultsDropped} tool results dropped, ${stats.toolResultsKept} kept, ${stats.systemDropped} system dropped, ${stats.base64Dropped} base64 dropped, ${messages.length}/${stats.totalMessageRecords} messages kept.`,
      );
    }

    return {
      messages,
      warnings,
      metadata: {
        sessionId,
        sessionLabel,
        startedAt: sessionTimestamp ?? messages[0]?.timestamp ?? fallbackTimestamp,
        modelsUsed: modelsUsed.length > 0 ? modelsUsed : undefined,
      },
    };
  }
}

/**
 * Shared OpenClaw transcript parser instance for adapter wiring.
 */
export const openClawTranscriptParser = new OpenClawTranscriptParser();
