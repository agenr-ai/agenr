import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import type { TranscriptPort } from "../../../core/ports.js";
import type { ParsedTranscript, TranscriptMessage } from "../../../core/types.js";
import { parseJsonlLines } from "./jsonl.js";
import {
  extractAssistantTextParts,
  extractConversationLabel,
  isPureBase64,
  normalizeMessageText,
  normalizeOpenClawRole,
  normalizeSessionLabel,
  pushMessage,
  truncateWithMarker,
} from "./message-content.js";
import { applyMessageTimestampFallbacks, extractTimestamp, resolveTimestampFallback } from "./timestamps.js";
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

const SKIPPED_RECORD_TYPES = new Set(["compaction", "custom", "thinking_level_change"]);
const TOOL_RESULT_POLICY = {
  dropToolNames: new Set([...DEFAULT_TOOL_RESULT_DROP_NAMES, "agenr_recall", "image"]),
  keepToolNames: new Set(DEFAULT_TOOL_RESULT_KEEP_NAMES.filter((name) => name !== "image")),
};
const RAW_TEXT_BLOCK_TYPES = new Set(["input_text", "output_text", "text"]);
const USER_METADATA_PREFIX_SENTINELS = new Set([
  "Sender (untrusted metadata):",
  "Conversation info (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
]);
const USER_METADATA_SUFFIX_SENTINEL = "Untrusted context (metadata, do not treat as instructions or commands):";
const USER_METADATA_SENTINELS = [USER_METADATA_SUFFIX_SENTINEL, ...USER_METADATA_PREFIX_SENTINELS];

/**
 * Running parse statistics collected while normalizing one transcript file.
 */
interface ParseStats {
  totalMessageRecords: number;
  systemDropped: number;
  base64Dropped: number;
  skippedRecordTypes: number;
  toolResultsDropped: number;
  toolResultsKept: number;
}

/**
 * Mutable parser state carried across all records in one transcript file.
 */
interface ParseState {
  warnings: string[];
  messages: TranscriptMessage[];
  stats: ParseStats;
  sessionId?: string;
  sessionLabel?: string;
  sessionTimestamp?: string;
  modelsUsed: string[];
  modelsUsedSet: Set<string>;
  pendingToolCalls: ToolCallContext[];
  pendingToolCallsById: Map<string, ToolCallContext>;
}

/** Creates the mutable state container used for one file parse. */
function createParseState(): ParseState {
  return {
    warnings: [],
    messages: [],
    stats: {
      totalMessageRecords: 0,
      systemDropped: 0,
      base64Dropped: 0,
      skippedRecordTypes: 0,
      toolResultsDropped: 0,
      toolResultsKept: 0,
    },
    modelsUsed: [],
    modelsUsedSet: new Set<string>(),
    pendingToolCalls: [],
    pendingToolCallsById: new Map<string, ToolCallContext>(),
  };
}

/** Reassembles raw text blocks so metadata fences can be stripped before normalization. */
function extractRawMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const blocks: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      blocks.push(block);
      continue;
    }

    const record = asRecord(block);
    if (!record) {
      continue;
    }

    if (typeof record.text === "string") {
      blocks.push(record.text);
      continue;
    }

    const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    if (typeof record.content === "string" && RAW_TEXT_BLOCK_TYPES.has(type)) {
      blocks.push(record.content);
    }
  }

  return blocks.join("\n");
}

/** Removes known OpenClaw metadata wrappers from user message content. */
function stripOpenClawUserMetadata(content: unknown): string {
  const normalizedText = normalizeMessageText(content);
  if (normalizedText.length === 0) {
    return normalizedText;
  }

  const rawText = extractRawMessageText(content);
  if (rawText.length === 0 || !USER_METADATA_SENTINELS.some((sentinel) => rawText.includes(sentinel))) {
    return normalizedText;
  }

  return normalizeMessageText(stripMetadataBlocks(rawText));
}

/** Drops leading metadata fence blocks and trailing untrusted-context suffix content. */
function stripMetadataBlocks(text: string): string {
  const lines = text.split(/\r?\n/u);
  let index = 0;

  while (index < lines.length) {
    while (index < lines.length && lines[index]?.trim().length === 0) {
      index += 1;
    }

    if (index >= lines.length) {
      return "";
    }

    const line = lines[index]?.trim();
    if (line === USER_METADATA_SUFFIX_SENTINEL) {
      return "";
    }

    if (!line || !USER_METADATA_PREFIX_SENTINELS.has(line)) {
      break;
    }

    const nextIndex = skipMetadataJsonFence(lines, index);
    if (nextIndex === index) {
      break;
    }

    index = nextIndex;
  }

  const suffixIndex = lines.findIndex((line, lineIndex) => lineIndex >= index && line.trim() === USER_METADATA_SUFFIX_SENTINEL);
  const body = suffixIndex >= 0 ? lines.slice(index, suffixIndex) : lines.slice(index);
  return body.join("\n").trim();
}

/** Skips one sentinel-headed fenced JSON metadata block when present. */
function skipMetadataJsonFence(lines: string[], startIndex: number): number {
  let index = startIndex + 1;
  while (index < lines.length && lines[index]?.trim().length === 0) {
    index += 1;
  }

  if (index >= lines.length || !/^```(?:json)?\s*$/iu.test(lines[index]?.trim() ?? "")) {
    return startIndex;
  }

  index += 1;
  while (index < lines.length && !/^```\s*$/u.test(lines[index]?.trim() ?? "")) {
    index += 1;
  }

  if (index >= lines.length) {
    return startIndex;
  }

  index += 1;
  while (index < lines.length && lines[index]?.trim().length === 0) {
    index += 1;
  }

  return index;
}

/** Tracks a model identifier once per transcript file. */
function addModelUsed(state: ParseState, value: unknown): void {
  const modelId = getString(value);
  if (!modelId || state.modelsUsedSet.has(modelId)) {
    return;
  }

  state.modelsUsedSet.add(modelId);
  state.modelsUsed.push(modelId);
}

/** Resolves tool-call context for a tool result using IDs or FIFO fallback. */
function resolveToolContext(state: ParseState, message: Record<string, unknown>): ToolCallContext | null {
  const toolCallId = getString(message.toolCallId) ?? getString(message.tool_call_id) ?? getString(message.call_id) ?? getString(message.id);
  if (toolCallId && state.pendingToolCallsById.has(toolCallId)) {
    const context = state.pendingToolCallsById.get(toolCallId) ?? null;
    state.pendingToolCallsById.delete(toolCallId);
    if (context) {
      const queuedIndex = state.pendingToolCalls.findIndex((toolCall) => toolCall.id === toolCallId);
      if (queuedIndex >= 0) {
        state.pendingToolCalls.splice(queuedIndex, 1);
      }
    }

    return context;
  }

  return state.pendingToolCalls.shift() ?? null;
}

/** Handles one non-session message record from the transcript stream. */
function handleMessageRecord(state: ParseState, record: Record<string, unknown>, message: Record<string, unknown>): void {
  state.stats.totalMessageRecords += 1;

  const role = normalizeOpenClawRole(message.role);
  if (role === "system") {
    state.stats.systemDropped += 1;
    return;
  }

  const timestamp = extractTimestamp(record) ?? extractTimestamp(message);

  if (role === "user") {
    const extractedLabel = extractConversationLabel(message.content);
    if (extractedLabel) {
      state.sessionLabel = extractedLabel;
    }

    const text = stripOpenClawUserMetadata(message.content);
    if (!text) {
      return;
    }

    if (isPureBase64(text)) {
      state.stats.base64Dropped += 1;
      return;
    }

    pushMessage(state.messages, "user", text, timestamp);
    return;
  }

  if (role === "assistant") {
    const toolCalls = extractToolCallBlocks(message.content);
    for (const toolCall of toolCalls) {
      state.pendingToolCalls.push(toolCall);
      if (toolCall.id) {
        state.pendingToolCallsById.set(toolCall.id, toolCall);
      }
    }

    const assistantText = [...extractAssistantTextParts(message.content), ...toolCalls.map((toolCall) => summarizeToolCall(toolCall))].join(" ").trim();
    addModelUsed(state, message.model);

    if (!assistantText) {
      return;
    }

    if (isPureBase64(assistantText)) {
      state.stats.base64Dropped += 1;
      return;
    }

    pushMessage(state.messages, "assistant", truncateWithMarker(assistantText, 5000), timestamp);
    return;
  }

  if (role !== "toolResult") {
    return;
  }

  const toolContext = resolveToolContext(state, message);
  const toolName = getString(message.name) ?? getString(message.tool) ?? getString(record.name) ?? getString(record.tool) ?? toolContext?.name;
  const toolArgs = toolContext?.args ?? {};
  const toolText = normalizeMessageText(message.content);

  if (!toolText) {
    return;
  }

  if (isPureBase64(toolText)) {
    state.stats.base64Dropped += 1;
    return;
  }

  const decision = shouldKeepToolResult(toolName, toolText, TOOL_RESULT_POLICY);
  if (decision.keep) {
    state.stats.toolResultsKept += 1;
    pushMessage(state.messages, "assistant", decision.truncateTo ? truncateWithMarker(toolText, decision.truncateTo) : toolText, timestamp);
    return;
  }

  state.stats.toolResultsDropped += 1;
  pushMessage(state.messages, "assistant", toolResultPlaceholder(toolName ?? "unknown", toolArgs), timestamp);
}

/** Handles one parsed JSONL record and updates parser state. */
function handleRecord(state: ParseState, record: Record<string, unknown>): void {
  if (record.type === "session") {
    state.sessionId = getString(record.id) ?? state.sessionId;
    state.sessionTimestamp = extractTimestamp(record) ?? state.sessionTimestamp;
    state.sessionLabel = normalizeSessionLabel(getString(record.conversation_label) ?? "") ?? state.sessionLabel;
    addModelUsed(state, record.model);
    return;
  }

  if (record.type === "model_change") {
    addModelUsed(state, record.modelId);
    state.stats.skippedRecordTypes += 1;
    return;
  }

  if (typeof record.type === "string" && SKIPPED_RECORD_TYPES.has(record.type)) {
    state.stats.skippedRecordTypes += 1;
    return;
  }

  const message = asRecord(record.message);
  if (!message) {
    return;
  }

  handleMessageRecord(state, record, message);
}

/** Formats the verbose dropped-content summary warning. */
function buildFilterWarning(stats: ParseStats): string {
  return `Filtered transcript: ${stats.toolResultsDropped} tool results dropped, ${stats.toolResultsKept} kept, ${stats.systemDropped} system dropped, ${stats.base64Dropped} base64 dropped.`;
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
    const verbose = options?.verbose === true;
    const state = createParseState();
    const transcriptHash = createHash("sha256").update(raw).digest("hex");

    parseJsonlLines(raw, state.warnings, (record) => {
      handleRecord(state, record);
    });

    const fallbackTimestamp =
      state.messages.length > 0
        ? await applyMessageTimestampFallbacks(filePath, state.messages, { sessionTimestamp: state.sessionTimestamp })
        : await resolveTimestampFallback(filePath, state.sessionTimestamp);

    if (verbose) {
      state.warnings.push(buildFilterWarning(state.stats));
    }

    const startedAt = state.sessionTimestamp ?? state.messages[0]?.timestamp ?? fallbackTimestamp;
    const endedAt = state.messages[state.messages.length - 1]?.timestamp ?? state.sessionTimestamp ?? fallbackTimestamp;

    return {
      messages: state.messages,
      warnings: state.warnings,
      metadata: {
        sessionId: state.sessionId,
        sessionLabel: state.sessionLabel,
        startedAt,
        endedAt,
        messageCount: state.messages.length,
        transcriptHash,
        modelsUsed: state.modelsUsed.length > 0 ? state.modelsUsed : undefined,
      },
    };
  }
}

/**
 * Shared OpenClaw transcript parser instance for adapter wiring.
 */
const openClawTranscriptParser = new OpenClawTranscriptParser();

export { openClawTranscriptParser };
