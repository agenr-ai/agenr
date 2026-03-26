import type { LlmPort } from "../ports.js";
import type { ParsedTranscript, StoreEntryInput, TranscriptChunk, TranscriptMessage } from "../types.js";
import { parseExtractionResponse } from "./parser.js";
import { buildChunkPrompt, buildExtractionSystemPrompt } from "./prompts.js";

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS_PER_CHUNK = 8_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 0;
const DEFAULT_OUTPUT_TOKENS = 8_192;
const SYSTEM_PROMPT_BUDGET_TOKENS = 4_000;
const DEFAULT_INTER_CHUNK_DELAY_MS = 150;
const MAX_ATTEMPTS = 3;

type PreviouslyExtractedSubject = {
  type: string;
  subject: string;
  summary: string;
};

/**
 * Runtime extraction controls for transcript processing.
 */
export interface ExtractionOptions {
  wholeFile?: "auto" | "force" | "never";
  verbose?: boolean;
  /** Delay between chunk extractions in milliseconds. */
  interChunkDelayMs?: number;
}

/**
 * Aggregate extraction outcome across a parsed transcript.
 */
export interface ExtractionResult {
  entries: StoreEntryInput[];
  chunks: number;
  successfulChunks: number;
  failedChunks: number;
  warnings: string[];
}

/**
 * Splits transcript messages into extraction chunks without breaking messages.
 *
 * @param messages - Normalized transcript messages.
 * @param maxTokensPerChunk - Soft token ceiling for each chunk.
 * @returns Chunked transcript segments aligned to message boundaries.
 */
export function chunkTranscript(messages: TranscriptMessage[], maxTokensPerChunk: number): TranscriptChunk[] {
  if (messages.length === 0) {
    return [];
  }

  const chunks: TranscriptChunk[] = [];
  let chunkStart = 0;
  let currentLines: string[] = [];
  let currentTokens = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const line = renderTranscriptMessage(message);
    const lineTokens = estimateTextTokens(line);
    const wouldOverflow = currentLines.length > 0 && currentTokens + lineTokens > maxTokensPerChunk;

    if (wouldOverflow) {
      chunks.push(buildChunk(messages, chunkStart, index - 1, chunks.length, currentLines));
      chunkStart = index;
      currentLines = [];
      currentTokens = 0;
    }

    currentLines.push(line);
    currentTokens += lineTokens;
  }

  if (currentLines.length > 0) {
    chunks.push(buildChunk(messages, chunkStart, messages.length - 1, chunks.length, currentLines));
  }

  return chunks;
}

/**
 * Extracts durable knowledge from a parsed transcript using an LLM port.
 *
 * @param transcript - Parsed transcript with normalized messages.
 * @param llm - LLM port implementation used for JSON extraction.
 * @param options - Extraction mode, retry pacing, and model-window metadata.
 * @returns Extracted entries, chunk counts, and accumulated warnings.
 */
export async function extractFromTranscript(
  transcript: ParsedTranscript,
  llm: LlmPort,
  options: ExtractionOptions & {
    contextWindowTokens?: number;
    maxOutputTokens?: number;
  } = {},
): Promise<ExtractionResult> {
  if (transcript.messages.length === 0) {
    return {
      entries: [],
      chunks: 0,
      successfulChunks: 0,
      failedChunks: 0,
      warnings: [],
    };
  }

  const wholeFile = resolveWholeFileMode(transcript.messages, options);
  const chunks = wholeFile
    ? [buildChunk(transcript.messages, 0, transcript.messages.length - 1, 0)]
    : chunkTranscript(transcript.messages, DEFAULT_MAX_TOKENS_PER_CHUNK);
  const systemPrompt = buildExtractionSystemPrompt({ wholeFile });
  const entries: StoreEntryInput[] = [];
  const warnings: string[] = [];
  const previouslyExtracted: PreviouslyExtractedSubject[] = [];
  let successfulChunks = 0;
  let failedChunks = 0;

  for (const [chunkOffset, chunk] of chunks.entries()) {
    const parsed = await extractChunkWithRetry(chunk, llm, systemPrompt, previouslyExtracted);

    if (parsed) {
      successfulChunks += 1;
      entries.push(...parsed.entries);
      warnings.push(...parsed.warnings.map((warning) => `Chunk ${chunk.chunk_index + 1}: ${warning}`));
      previouslyExtracted.push(...parsed.entries.map(toPreviouslyExtractedSubject));
    } else {
      failedChunks += 1;
      warnings.push(`Chunk ${chunk.chunk_index + 1}: extraction failed after ${MAX_ATTEMPTS} attempts.`);
    }

    const interChunkDelayMs = options.interChunkDelayMs ?? DEFAULT_INTER_CHUNK_DELAY_MS;
    if (chunkOffset < chunks.length - 1 && interChunkDelayMs > 0) {
      await sleep(interChunkDelayMs);
    }
  }

  return {
    entries,
    chunks: chunks.length,
    successfulChunks,
    failedChunks,
    warnings,
  };
}

async function extractChunkWithRetry(
  chunk: TranscriptChunk,
  llm: LlmPort,
  systemPrompt: string,
  previouslyExtracted: PreviouslyExtractedSubject[],
): Promise<ReturnType<typeof parseExtractionResponse> | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const raw = await llm.completeJson<unknown>(systemPrompt, buildChunkPrompt(chunk, { previouslyExtracted }));
      return parseExtractionResponse(raw);
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        return null;
      }

      await sleep(backoffMs(attempt));
    }
  }

  return null;
}

function resolveWholeFileMode(
  messages: TranscriptMessage[],
  options: ExtractionOptions & {
    contextWindowTokens?: number;
    maxOutputTokens?: number;
  },
): boolean {
  const wholeFileMode = options.wholeFile ?? "auto";
  if (wholeFileMode === "never") {
    return false;
  }

  const usableWindowTokens = calculateUsableWindowTokens(
    options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS,
  );
  const estimatedTranscriptTokens = estimateTranscriptTokens(messages);

  if (wholeFileMode === "force") {
    if (usableWindowTokens > 0 && estimatedTranscriptTokens > usableWindowTokens) {
      throw new Error(
        `Whole-file extraction was forced, but the transcript needs about ${estimatedTranscriptTokens} tokens and only ${usableWindowTokens} fit in the model window.`,
      );
    }

    return true;
  }

  if (usableWindowTokens <= 0) {
    return false;
  }

  return estimatedTranscriptTokens <= usableWindowTokens;
}

function calculateUsableWindowTokens(contextWindowTokens: number, maxOutputTokens: number): number {
  return contextWindowTokens - maxOutputTokens - SYSTEM_PROMPT_BUDGET_TOKENS;
}

function buildChunk(messages: TranscriptMessage[], startIndex: number, endIndex: number, chunkIndex: number, preRenderedLines?: string[]): TranscriptChunk {
  const chunkMessages = messages.slice(startIndex, endIndex + 1);
  const lines = preRenderedLines ?? chunkMessages.map(renderTranscriptMessage);
  const first = chunkMessages[0];
  const last = chunkMessages[chunkMessages.length - 1];

  if (!first || !last) {
    throw new Error("Cannot build a transcript chunk without messages.");
  }

  return {
    chunk_index: chunkIndex,
    text: lines.join("\n"),
    message_range: [first.index, last.index],
  };
}

function estimateTranscriptTokens(messages: TranscriptMessage[]): number {
  return messages.reduce((total, message) => total + estimateTextTokens(renderTranscriptMessage(message)), 0);
}

function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function renderTranscriptMessage(message: TranscriptMessage): string {
  return `[m${String(message.index).padStart(5, "0")}][${message.role}] ${message.text}`;
}

function toPreviouslyExtractedSubject(entry: StoreEntryInput): PreviouslyExtractedSubject {
  return {
    type: entry.type,
    subject: entry.subject,
    summary: summarizeContent(entry.content),
  };
}

function summarizeContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= 80) {
    return normalized;
  }

  return `${normalized.slice(0, 77).trimEnd()}...`;
}

function backoffMs(attempt: number): number {
  return 200 * 2 ** (attempt - 1);
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
