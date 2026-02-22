import { renderTranscriptLine } from "../parser.js";
import type { KnowledgeEntry, LlmClient, TranscriptChunk, TranscriptMessage } from "../types.js";

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-4.1-nano": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-3.5-turbo": 16_385,
  "gpt-5-nano": 400_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.3-codex": 200_000,
  "claude-3-haiku": 200_000,
  "claude-3-sonnet": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-5-haiku": 200_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-7-sonnet": 200_000,
  "claude-opus-4": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-haiku-4": 200_000,
  "gemini-1.5-pro": 1_000_000,
  "gemini-1.5-flash": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-2.0-pro": 1_000_000,
};

const MODEL_OUTPUT_TOKENS: Record<string, number> = {
  "gpt-4.1-nano": 32_768,
  "gpt-4.1-mini": 32_768,
  "gpt-4.1": 32_768,
  "gpt-4o": 16_384,
  "gpt-4o-mini": 16_384,
  "gpt-3.5-turbo": 4_096,
  "gpt-4-turbo": 16_384,
  "gpt-5-nano": 131_072,
  "gpt-5.2-codex": 131_072,
  "gpt-5.3-codex": 100_000,
  "claude-3-haiku": 8_192,
  "claude-3-sonnet": 8_192,
  "claude-3-opus": 8_192,
  "claude-3-5-haiku": 8_192,
  "claude-3-5-sonnet": 8_192,
  "claude-3-7-sonnet": 64_000,
  "claude-opus-4": 32_000,
  "claude-sonnet-4": 32_000,
  "claude-haiku-4": 16_000,
  "gemini-1.5-pro": 8_192,
  "gemini-1.5-flash": 8_192,
  "gemini-2.0-flash": 8_192,
  "gemini-2.0-pro": 8_192,
};

export const OUTPUT_BUDGET_TOKENS_DEFAULT = 16_384;
export const SYSTEM_PROMPT_BUDGET_TOKENS = 4_000;
export const CHARS_PER_TOKEN = 4;
export const MAX_ENTRIES_WARN_THRESHOLD = 500;

function getClientModelId(client: LlmClient): string | undefined {
  const modelId = client.resolvedModel?.modelId;
  if (typeof modelId === "string" && modelId.trim().length > 0) {
    return modelId;
  }
  return undefined;
}

function estimateTokens(messages: TranscriptMessage[]): number {
  const totalChars = messages.reduce((sum, message) => sum + renderTranscriptLine(message).length, 0);
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

export function getOutputTokens(client: LlmClient): number {
  const modelId = getClientModelId(client);
  if (!modelId) {
    return OUTPUT_BUDGET_TOKENS_DEFAULT;
  }
  const bare = modelId.includes("/") ? (modelId.split("/").at(-1) ?? modelId) : modelId;
  const normalized = bare
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
  return MODEL_OUTPUT_TOKENS[normalized] ?? OUTPUT_BUDGET_TOKENS_DEFAULT;
}

export function usableWindowTokens(contextWindow: number, outputTokens: number): number {
  return contextWindow - outputTokens - SYSTEM_PROMPT_BUDGET_TOKENS;
}

export function getContextWindowTokens(client: LlmClient, verbose?: boolean): number | undefined {
  const modelId = getClientModelId(client);
  if (!modelId) {
    if (verbose) {
      console.warn("[whole-file] No model ID resolved; falling back to chunked mode.");
    }
    return undefined;
  }
  const bare = modelId.includes("/") ? (modelId.split("/").at(-1) ?? modelId) : modelId;
  const normalized = bare
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
  const contextWindow = MODEL_CONTEXT_WINDOWS[normalized];

  if (contextWindow === undefined && verbose) {
    console.warn(
      `[whole-file] Unknown model "${modelId}": context window unknown, falling back to chunked mode.`,
    );
  }

  return contextWindow;
}

export function fileFitsInContext(messages: TranscriptMessage[], client: LlmClient, verbose?: boolean): boolean {
  const contextWindow = getContextWindowTokens(client, verbose);
  if (contextWindow === undefined) {
    return false;
  }
  const outputTokens = getOutputTokens(client);

  return estimateTokens(messages) <= usableWindowTokens(contextWindow, outputTokens);
}

export function resolveWholeFileMode(
  /**
   * @param wholeFile - Resolution mode. undefined is treated identically to "auto".
   */
  wholeFile: "auto" | "force" | "never" | undefined,
  messages: TranscriptMessage[],
  client: LlmClient,
  verbose?: boolean,
  onVerbose?: (line: string) => void,
): boolean {
  if (wholeFile === "never") {
    return false;
  }

  if (wholeFile === "force") {
    if (messages.length === 0) {
      throw new Error(
        "[whole-file] force mode requires messages to be provided. Pass messages from parseTranscriptFile.",
      );
    }

    const contextWindow = getContextWindowTokens(client, verbose);
    const estimatedTokens = estimateTokens(messages);
    const outputTokens = getOutputTokens(client);
    if (contextWindow !== undefined && estimatedTokens > usableWindowTokens(contextWindow, outputTokens)) {
      throw new Error(
        `[whole-file] force mode: estimated ${estimatedTokens} tokens exceeds usable window of ${usableWindowTokens(contextWindow, outputTokens)} tokens (${contextWindow} context - ${outputTokens} output budget - ${SYSTEM_PROMPT_BUDGET_TOKENS} system prompt). Use --chunk to force chunked mode instead.`,
      );
    }
    if (contextWindow === undefined && verbose) {
      console.warn(
        `[whole-file] force mode: unknown context window from getContextWindowTokens; proceeding without size validation for ~${estimatedTokens} estimated tokens.`,
      );
    }
    if (estimatedTokens > 500_000 && verbose) {
      console.warn(
        `[whole-file] force mode with ~${estimatedTokens} estimated tokens on a large-context model. This may be slow and expensive.`,
      );
    }
    return true;
  }

  if (messages.length === 0) {
    const message =
      "[whole-file] skipping whole-file: no messages parsed from file (falling back to chunked text)";
    if (onVerbose) {
      onVerbose(message);
    } else if (verbose) {
      console.warn(message);
    }
    return false;
  }

  return fileFitsInContext(messages, client, verbose);
}

export function buildWholeFileChunkFromMessages(messages: TranscriptMessage[]): TranscriptChunk {
  if (messages.length === 0) {
    throw new Error("[whole-file] cannot build whole-file chunk from empty messages");
  }

  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  return {
    chunk_index: 0,
    index: 0,
    totalChunks: 1,
    message_start: first.index,
    message_end: last.index,
    text: messages.map((message) => renderTranscriptLine(message)).join("\n"),
    context_hint: "whole-file (" + messages.length + " messages)",
    timestamp_start: first.timestamp,
    timestamp_end: last.timestamp,
  };
}

export function warnOnHighEntryCount(
  entries: KnowledgeEntry[],
  verbose?: boolean,
  onVerbose?: (line: string) => void,
): KnowledgeEntry[] {
  if (entries.length <= MAX_ENTRIES_WARN_THRESHOLD) {
    return entries;
  }

  if (verbose) {
    const message =
      `[whole-file] Received ${entries.length} entries, exceeding warning threshold of ${MAX_ENTRIES_WARN_THRESHOLD}. Keeping all entries for downstream dedup.`;
    if (onVerbose) {
      onVerbose(message);
    } else {
      console.warn(message);
    }
  }
  return entries;
}
