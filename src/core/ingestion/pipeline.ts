import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import type { DatabasePort, EmbeddingPort, LlmPort, TranscriptPort } from "../ports.js";
import { type StoreEntriesOptions, type StorePipelineOptions, storeEntriesDetailed } from "../store/pipeline.js";
import type { StoreEntryInput, StoreResult } from "../types.js";
import { dedupBatch } from "./dedup.js";
import { extractFromTranscript } from "./extract.js";

/**
 * Runtime controls for single-file ingestion.
 */
export interface IngestFileOptions {
  verbose?: boolean;
  dryRun?: boolean;
  /** Whole-file mode override. */
  wholeFile?: "auto" | "force" | "never";
  /** Skip within-batch semantic dedup and pass extracted entries through. */
  skipDedup?: boolean;
  /** Context window tokens from the LLM model metadata. */
  contextWindowTokens?: number;
  /** Max output tokens from the LLM model metadata. */
  maxOutputTokens?: number;
  /** Skip embedding generation during store. */
  skipEmbeddings?: boolean;
  /** User-provided extraction context from config. */
  extractionContext?: string;
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
  /** Total extraction chunks attempted for the file. */
  chunkCount: number;
  /** Number of extraction chunks that completed successfully. */
  successfulChunks: number;
  /** Number of extraction chunks that failed after retries. */
  failedChunks: number;
  /** Per-chunk extraction outcomes for verbose diagnostics. */
  chunkDetails: Array<{
    chunkIndex: number;
    messageRange: [number, number];
    success: boolean;
  }>;
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
 * Parse and extract result for a single transcript file before the store phase runs.
 */
export interface ExtractedFileResult {
  file: string;
  skipped: boolean;
  messageCount: number;
  entries: StoreEntryInput[];
  chunkCount: number;
  successfulChunks: number;
  failedChunks: number;
  chunkDetails: Array<{
    chunkIndex: number;
    messageRange: [number, number];
    success: boolean;
  }>;
  warnings: string[];
  error?: string;
  durationMs: number;
  fileHash: string;
}

/**
 * Runtime switches for finalizing extracted file batches into stored entries.
 */
export interface StoreExtractedResultsOptions extends StorePipelineOptions {
  /** Precomputed embeddings keyed by surviving entry object identity. */
  precomputedEmbeddings?: Map<StoreEntryInput, number[]>;
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
    dedupLlm?: LlmPort;
    embedding: EmbeddingPort;
    db: DatabasePort;
  },
  options: IngestFileOptions = {},
): Promise<IngestFileResult> {
  const extracted = await extractFile(
    filePath,
    {
      transcript: ports.transcript,
      llm: ports.llm,
      db: ports.db,
    },
    options,
  );

  if (extracted.skipped || extracted.error) {
    return toIngestFileResult(extracted, null);
  }

  const dedupResult = await dedupBatch(extracted.entries, ports.dedupLlm ?? ports.llm, ports.embedding, {
    skip: options.skipDedup,
    verbose: options.verbose,
  });
  const precomputedEmbeddings = new Map(
    dedupResult.survivors.map((entry, index) => {
      const embedding = dedupResult.embeddings[index];
      if (!embedding) {
        throw new Error(`Missing precomputed embedding for dedup survivor ${index}.`);
      }

      return [entry, embedding];
    }),
  );
  const dedupedExtracted: ExtractedFileResult = {
    ...extracted,
    entries: dedupResult.survivors,
  };

  const storeResults = await storeExtractedResults(
    [dedupedExtracted],
    {
      db: ports.db,
      embedding: ports.embedding,
    },
    {
      dryRun: options.dryRun,
      verbose: options.verbose,
      skipEmbeddings: options.skipEmbeddings,
      precomputedEmbeddings,
    },
  );

  return storeResults.get(filePath) ?? toIngestFileResult(dedupedExtracted, emptyStoreResult());
}

async function computeFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Runs the parse and extract phase for a single file without storing any entries.
 *
 * @param filePath - Transcript file path to extract.
 * @param ports - Core ports used by the extract phase.
 * @param options - Optional execution controls for parsing and extraction.
 * @returns File-level extraction outcome with extracted entries and diagnostics.
 */
export async function extractFile(
  filePath: string,
  ports: {
    transcript: TranscriptPort;
    llm: LlmPort;
    db: DatabasePort;
  },
  options: IngestFileOptions = {},
): Promise<ExtractedFileResult> {
  const startedAt = Date.now();
  let messageCount = 0;
  let chunkCount = 0;
  let successfulChunks = 0;
  let failedChunks = 0;
  let chunkDetails: ExtractedFileResult["chunkDetails"] = [];
  const warnings: string[] = [];
  const fileHash = await computeFileHash(filePath);

  try {
    const ingestLogEntry = await ports.db.getIngestLogEntry(filePath);
    if (ingestLogEntry?.fileHash === fileHash) {
      return {
        file: filePath,
        skipped: true,
        messageCount: 0,
        entries: [],
        chunkCount: 0,
        successfulChunks: 0,
        failedChunks: 0,
        chunkDetails: [],
        warnings: [],
        durationMs: Date.now() - startedAt,
        fileHash,
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
      extractionContext: options.extractionContext,
    });
    chunkCount = extraction.chunks;
    successfulChunks = extraction.successfulChunks;
    failedChunks = extraction.failedChunks;
    chunkDetails = extraction.chunkDetails;
    warnings.push(...extraction.warnings);

    return {
      file: filePath,
      skipped: false,
      messageCount,
      entries: extraction.entries,
      chunkCount,
      successfulChunks,
      failedChunks,
      chunkDetails,
      warnings,
      durationMs: Date.now() - startedAt,
      fileHash,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(message);

    return {
      file: filePath,
      skipped: false,
      messageCount,
      entries: [],
      chunkCount,
      successfulChunks,
      failedChunks,
      chunkDetails,
      warnings,
      error: message,
      durationMs: Date.now() - startedAt,
      fileHash,
    };
  }
}

/**
 * Batches embedding and storage for entries extracted from multiple files.
 *
 * @param results - Successful extracted file results to finalize.
 * @param ports - Core ports used by the store phase.
 * @param options - Store pipeline controls, including dry-run handling.
 * @returns Final per-file ingest results keyed by source file path.
 */
export async function storeExtractedResults(
  results: ExtractedFileResult[],
  ports: {
    db: DatabasePort;
    embedding: EmbeddingPort;
  },
  options: StoreExtractedResultsOptions = {},
): Promise<Map<string, IngestFileResult>> {
  const storeStartedAt = Date.now();
  const finalResults = new Map<string, IngestFileResult>();
  const successfulResults = results.filter((result) => result.skipped !== true && result.error === undefined);
  const perFileStoreResults = new Map<string, StoreResult>();
  const allEntries: StoreEntryInput[] = [];
  const entryOwners: string[] = [];

  for (const result of successfulResults) {
    perFileStoreResults.set(result.file, emptyStoreResult());
    for (const entry of result.entries) {
      allEntries.push(entry);
      entryOwners.push(result.file);
    }
  }

  const storeOptions: StoreEntriesOptions = {
    ...options,
    precomputedEmbeddings: alignPrecomputedEmbeddings(allEntries, options.precomputedEmbeddings),
  };

  const storeResult = await storeEntriesDetailed(allEntries, ports.db, ports.embedding, storeOptions);
  for (const detail of storeResult.details) {
    const owner = entryOwners[detail.inputIndex];
    if (!owner) {
      continue;
    }

    const perFileStoreResult = perFileStoreResults.get(owner) ?? emptyStoreResult();
    switch (detail.outcome) {
      case "stored":
        perFileStoreResult.stored += 1;
        break;
      case "skipped":
        perFileStoreResult.skipped += 1;
        break;
      case "rejected":
        perFileStoreResult.rejected += 1;
        break;
      case "dry_run":
        break;
    }
    perFileStoreResults.set(owner, perFileStoreResult);
  }

  if (options.dryRun !== true) {
    for (const result of successfulResults) {
      const perFileStoreResult = perFileStoreResults.get(result.file) ?? emptyStoreResult();
      await ports.db.insertIngestLogEntry(result.file, result.fileHash, perFileStoreResult.stored);
    }
  }

  const storePhaseDurationMs = Date.now() - storeStartedAt;
  for (const result of successfulResults) {
    finalResults.set(result.file, toIngestFileResult(result, perFileStoreResults.get(result.file) ?? emptyStoreResult(), storePhaseDurationMs));
  }

  return finalResults;
}

function alignPrecomputedEmbeddings(entries: StoreEntryInput[], precomputedEmbeddings?: Map<StoreEntryInput, number[]>): number[][] | undefined {
  if (!precomputedEmbeddings) {
    return undefined;
  }

  return entries.map((entry, index) => {
    const vector = precomputedEmbeddings.get(entry);
    if (!vector) {
      throw new Error(`Missing precomputed embedding for extracted entry ${index}.`);
    }

    return vector;
  });
}

function emptyStoreResult(): StoreResult {
  return {
    stored: 0,
    skipped: 0,
    rejected: 0,
  };
}

function toIngestFileResult(result: ExtractedFileResult, storeResult: StoreResult | null, additionalDurationMs = 0): IngestFileResult {
  return {
    file: result.file,
    skipped: result.skipped,
    messageCount: result.messageCount,
    entriesExtracted: result.entries.length,
    chunkCount: result.chunkCount,
    successfulChunks: result.successfulChunks,
    failedChunks: result.failedChunks,
    chunkDetails: result.chunkDetails,
    storeResult,
    warnings: result.warnings,
    error: result.error,
    durationMs: result.durationMs + additionalDurationMs,
  };
}
