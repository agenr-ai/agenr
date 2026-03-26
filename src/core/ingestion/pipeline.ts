import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import type { DatabasePort, EmbeddingPort, LlmPort, TranscriptPort } from "../ports.js";
import { storeEntries } from "../store/pipeline.js";
import type { StoreResult } from "../types.js";
import { extractFromTranscript } from "./extract.js";

/**
 * Runtime controls for single-file ingestion.
 */
export interface IngestFileOptions {
  verbose?: boolean;
  dryRun?: boolean;
  /** Whole-file mode override. */
  wholeFile?: "auto" | "force" | "never";
  /** Context window tokens from the LLM model metadata. */
  contextWindowTokens?: number;
  /** Max output tokens from the LLM model metadata. */
  maxOutputTokens?: number;
  /** Skip embedding generation during store. */
  skipEmbeddings?: boolean;
}

/**
 * Aggregate result for a single transcript file ingest run.
 */
export interface IngestFileResult {
  file: string;
  /** Whether the file was skipped because the stored hash matched. */
  skipped: boolean;
  /** Number of messages parsed from the transcript. */
  messageCount: number;
  /** Number of entries extracted by the LLM. */
  entriesExtracted: number;
  /** Store pipeline counts when the file reached the store step. */
  storeResult: StoreResult | null;
  /** Extraction or parsing warnings accumulated during ingest. */
  warnings: string[];
  /** Fatal per-file failure message when ingest could not complete. */
  error?: string;
  /** End-to-end ingest duration in milliseconds. */
  durationMs: number;
}

/**
 * Ingests a single transcript file by parsing, extracting, and storing entries.
 *
 * @param filePath - Transcript file path to ingest.
 * @param ports - Core ports used by the ingest pipeline.
 * @param options - Optional execution controls for parsing, extraction, and storage.
 * @returns File-level ingest outcome with parse, extract, and store statistics.
 */
export async function ingestFile(
  filePath: string,
  ports: {
    transcript: TranscriptPort;
    llm: LlmPort;
    embedding: EmbeddingPort;
    db: DatabasePort;
  },
  options: IngestFileOptions = {},
): Promise<IngestFileResult> {
  const startedAt = Date.now();
  let messageCount = 0;
  let entriesExtracted = 0;
  const warnings: string[] = [];

  try {
    const ingestLogEntry = await ports.db.getIngestLogEntry(filePath);
    const fileHash = await computeFileHash(filePath);

    if (ingestLogEntry?.fileHash === fileHash) {
      return {
        file: filePath,
        skipped: true,
        messageCount: 0,
        entriesExtracted: 0,
        storeResult: null,
        warnings: [],
        durationMs: Date.now() - startedAt,
      };
    }

    const transcript = await ports.transcript.parseFile(filePath, { verbose: options.verbose });
    messageCount = transcript.messages.length;
    warnings.push(...transcript.warnings);

    const extraction = await extractFromTranscript(transcript, ports.llm, {
      verbose: options.verbose,
      wholeFile: options.wholeFile,
      contextWindowTokens: options.contextWindowTokens,
      maxOutputTokens: options.maxOutputTokens,
    });
    entriesExtracted = extraction.entries.length;
    warnings.push(...extraction.warnings);

    const storeResult = await storeEntries(extraction.entries, ports.db, ports.embedding, {
      dryRun: options.dryRun,
      verbose: options.verbose,
      skipEmbeddings: options.skipEmbeddings,
    });

    if (options.dryRun !== true) {
      await ports.db.insertIngestLogEntry(filePath, fileHash, storeResult.stored);
    }

    return {
      file: filePath,
      skipped: false,
      messageCount,
      entriesExtracted,
      storeResult,
      warnings,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(message);

    return {
      file: filePath,
      skipped: false,
      messageCount,
      entriesExtracted,
      storeResult: null,
      warnings,
      error: message,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function computeFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}
