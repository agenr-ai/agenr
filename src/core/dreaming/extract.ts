import type { LlmPort } from "../ports.js";
import { parseExtractionResponse } from "../ingestion/parser.js";
import type { ExtractionResult } from "../ingestion/extract.js";
import type { ParsedTranscript, TranscriptChunk } from "../types.js";
import type { DreamSessionStoreDurable } from "./session-store-guard.js";
import { buildDreamExtractChunkPrompt, buildDreamExtractSystemPrompt } from "./prompts.js";

const MAX_ATTEMPTS = 3;

/** Optional host context passed into dreaming extract prompts. */
export interface DreamEpisodeExtractOptions {
  /** Session workspace label for prompt context only; never auto-tags every entry. */
  sessionWorkspace?: string | null;
  /** Host-store durables already written during this session window. */
  existingSessionDurables?: DreamSessionStoreDurable[];
}

/**
 * Extracts durable candidates from one episode summary transcript.
 *
 * Dreaming uses its own prompt contract tuned for condensed episode evidence
 * rather than the ingest transcript prompt.
 *
 * @param transcript - Single-message transcript built from an episode summary.
 * @param llm - LLM port used for JSON extraction.
 * @param options - Optional session workspace context for the user prompt.
 * @returns Parsed durable entries and extraction warnings.
 */
export async function extractFromEpisodeSummary(
  transcript: ParsedTranscript,
  llm: LlmPort,
  options: DreamEpisodeExtractOptions = {},
): Promise<ExtractionResult> {
  if (transcript.messages.length === 0) {
    return {
      durables: [],
      chunks: 0,
      successfulChunks: 0,
      failedChunks: 0,
      chunkDetails: [],
      warnings: [],
    };
  }

  const chunk = buildSummaryChunk(transcript);
  const systemPrompt = buildDreamExtractSystemPrompt();
  const observedAt = transcript.metadata.endedAt ?? transcript.metadata.startedAt;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const raw = await llm.completeJson<unknown>(
        systemPrompt,
        buildDreamExtractChunkPrompt(chunk, {
          sessionWorkspace: options.sessionWorkspace ?? transcript.metadata.project,
          existingSessionDurables: options.existingSessionDurables,
        }),
      );
      const parsed = parseExtractionResponse(raw);
      if (observedAt) {
        for (const entry of parsed.durables) {
          entry.created_at = observedAt;
        }
      }

      return {
        durables: parsed.durables,
        chunks: 1,
        successfulChunks: 1,
        failedChunks: 0,
        chunkDetails: [{ chunkIndex: 0, messageRange: chunk.message_range, success: true }],
        warnings: parsed.warnings,
      };
    } catch {
      if (attempt === MAX_ATTEMPTS) {
        return {
          durables: [],
          chunks: 1,
          successfulChunks: 0,
          failedChunks: 1,
          chunkDetails: [{ chunkIndex: 0, messageRange: chunk.message_range, success: false }],
          warnings: [`Episode summary extraction failed after ${MAX_ATTEMPTS} attempts.`],
        };
      }

      await sleep(backoffMs(attempt));
    }
  }

  return {
    durables: [],
    chunks: 1,
    successfulChunks: 0,
    failedChunks: 1,
    chunkDetails: [{ chunkIndex: 0, messageRange: chunk.message_range, success: false }],
    warnings: ["Episode summary extraction failed."],
  };
}

/** Builds the single chunk used for whole-episode summary mining. */
function buildSummaryChunk(transcript: ParsedTranscript): TranscriptChunk {
  const message = transcript.messages[0];
  return {
    chunk_index: 0,
    message_range: [message?.index ?? 0, message?.index ?? 0],
    text: message?.text ?? "",
  };
}

/** Sleeps for the retry backoff interval. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Computes exponential backoff for extraction retries. */
function backoffMs(attempt: number): number {
  return Math.min(1_000, 100 * 2 ** (attempt - 1));
}
