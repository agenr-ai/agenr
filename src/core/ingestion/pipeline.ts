import type { DatabasePort, EmbeddingPort, LlmPort, TranscriptPort } from "../ports.js";
import { applyClaimExtractionResultToEntry, runBatchClaimExtraction, type ClaimExtractionConfig } from "../store/claim-extraction.js";
import { type StoreEntriesDetailedResult, type StoreEntriesOptions, type StorePipelineOptions, storeEntriesDetailed } from "../store/pipeline.js";
import type { StoreEntryInput, StoreResult } from "../types.js";
import { annotateExplicitClaimKeyEntry, restoreExplicitClaimKeysAfterDedup } from "./claim-key-preservation.js";
import { dedupBatch, getDefaultDedupConcurrency } from "./dedup.js";
import { extractFromTranscript } from "./extract.js";
import { resolveStableTranscriptSourceFile, resolveTranscriptProject, resolveTranscriptUserId } from "./source-metadata.js";

/**
 * Runtime controls for single-file ingestion.
 */
export interface IngestFileOptions {
  verbose?: boolean;
  dryRun?: boolean;
  /** Maximum number of parallel workers for ingest phases that honor concurrency. */
  concurrency?: number;
  /** Whole-file mode override. */
  wholeFile?: "auto" | "force" | "never";
  /** Skip within-batch semantic dedup and pass extracted entries through. */
  skipDedup?: boolean;
  /** Context window tokens from the LLM model metadata. */
  contextWindowTokens?: number;
  /** Max output tokens from the LLM model metadata. */
  maxOutputTokens?: number;
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
 * Stable source metadata required to ingest one transcript file.
 */
export interface IngestSource {
  /** Absolute or relative transcript file path. */
  filePath: string;
  /** Stable content hash computed by the caller. */
  fileHash: string;
}

/**
 * Runtime switches for finalizing extracted file batches into stored entries.
 */
export interface StoreExtractedResultsOptions extends StorePipelineOptions {
  /** Precomputed embeddings aligned to the flattened successful entry order. */
  precomputedEmbeddings?: number[][];
  /** Optional progress hook for ingest-specific bulk write phases. */
  onBulkWriteProgress?: (event: StoreExtractedResultsProgressEvent) => void;
  /** Optional warning sink for store and claim-extraction warnings. */
  onWarning?: (warning: string) => void;
}

/**
 * Progress event emitted around ingest bulk-write preparation and rebuild phases.
 */
export interface StoreExtractedResultsProgressEvent {
  phase: "prepare_start" | "store_complete" | "finalize_start" | "finalize_complete";
  durationMs?: number;
}

/**
 * Ingests a single transcript file by parsing, extracting, and storing entries.
 *
 * @param source - Source file path and precomputed content hash.
 * @param ports - Core ports used by the ingest pipeline.
 * @param options - Optional execution controls for parsing, extraction, and storage.
 * @returns File-level ingest outcome with parse, extract, and store statistics.
 */
export async function ingestFile(
  source: IngestSource,
  ports: {
    transcript: TranscriptPort;
    llm: LlmPort;
    dedupLlm?: LlmPort;
    embedding: EmbeddingPort;
    db: DatabasePort;
    claimExtractionLlm?: () => LlmPort;
  },
  options: IngestFileOptions & { claimExtractionConfig?: ClaimExtractionConfig } = {},
): Promise<IngestFileResult> {
  const extracted = await extractFile(
    source,
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
    concurrency: options.concurrency ?? getDefaultDedupConcurrency(),
    skip: options.skipDedup,
    verbose: options.verbose,
  });
  const dedupedEntries = restoreExplicitClaimKeysAfterDedup(extracted.entries, dedupResult);
  const dedupedExtracted: ExtractedFileResult = {
    ...extracted,
    entries: dedupedEntries,
  };

  if (ports.claimExtractionLlm) {
    const extractedClaimKeys = await runBatchClaimExtraction(
      [dedupedExtracted],
      {
        createLlm: ports.claimExtractionLlm,
        db: ports.db,
      },
      options.claimExtractionConfig ?? {
        enabled: true,
        confidenceThreshold: 0.8,
        eligibleTypes: ["fact", "preference", "decision", "lesson"],
      },
      options.claimExtractionConfig?.concurrency ?? 10,
    );

    for (const [entry, extractedClaimKey] of extractedClaimKeys) {
      applyClaimExtractionResultToEntry(entry, extractedClaimKey);
    }
  }

  const storeResults = await storeExtractedResults(
    [dedupedExtracted],
    {
      db: ports.db,
      embedding: ports.embedding,
    },
    {
      dryRun: options.dryRun,
      verbose: options.verbose,
      precomputedEmbeddings: dedupResult.embeddings,
    },
  );

  return storeResults.get(source.filePath) ?? toIngestFileResult(dedupedExtracted, emptyStoreResult());
}

/**
 * Runs the parse and extract phase for a single file without storing any entries.
 *
 * @param source - Source file path and precomputed content hash.
 * @param ports - Core ports used by the extract phase.
 * @param options - Optional execution controls for parsing and extraction.
 * @returns File-level extraction outcome with extracted entries and diagnostics.
 */
export async function extractFile(
  source: IngestSource,
  ports: {
    transcript: TranscriptPort;
    llm: LlmPort;
    db: DatabasePort;
  },
  options: IngestFileOptions = {},
): Promise<ExtractedFileResult> {
  const startedAt = Date.now();
  const filePath = source.filePath;
  let messageCount = 0;
  let chunkCount = 0;
  let successfulChunks = 0;
  let failedChunks = 0;
  let chunkDetails: ExtractedFileResult["chunkDetails"] = [];
  const warnings: string[] = [];
  const fileHash = source.fileHash;

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
    const extractedEntries = extraction.entries.map((entry, entryIndex) => {
      const sourceFile = resolveStableTranscriptSourceFile(filePath, transcript, entry.source_file);
      return annotateExplicitClaimKeyEntry(
        {
          ...entry,
          source_file: sourceFile,
          user_id: resolveTranscriptUserId(transcript, entry.user_id),
          project: resolveTranscriptProject(transcript, entry),
        },
        {
          sourceKind: "tool_call",
          locator: `${sourceFile}#entry:${entryIndex + 1}`,
          observedAt: entry.created_at,
          mode: "explicit",
        },
      );
    });

    return {
      file: filePath,
      skipped: false,
      messageCount,
      entries: extractedEntries,
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
    precomputedEmbeddings: options.precomputedEmbeddings,
    onWarning: options.onWarning,
  };

  const shouldUseBulkWrites = options.dryRun !== true && allEntries.length > 0;
  let storeResult: StoreEntriesDetailedResult;

  if (shouldUseBulkWrites) {
    options.onBulkWriteProgress?.({ phase: "prepare_start" });
    await ports.db.prepareForBulkWrites();
  }

  try {
    storeResult = await storeEntriesDetailed(allEntries, ports.db, ports.embedding, storeOptions);
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

    if (shouldUseBulkWrites) {
      options.onBulkWriteProgress?.({ phase: "store_complete" });
    }

    if (options.dryRun !== true) {
      for (const result of successfulResults) {
        const perFileStoreResult = perFileStoreResults.get(result.file) ?? emptyStoreResult();
        await ports.db.insertIngestLogEntry(result.file, result.fileHash, perFileStoreResult.stored);
      }
    }
  } finally {
    if (shouldUseBulkWrites) {
      options.onBulkWriteProgress?.({ phase: "finalize_start" });
      const finalizeStartedAt = Date.now();
      await ports.db.finalizeBulkWrites();
      options.onBulkWriteProgress?.({
        phase: "finalize_complete",
        durationMs: Date.now() - finalizeStartedAt,
      });
    }
  }

  const storePhaseDurationMs = Date.now() - storeStartedAt;
  for (const result of successfulResults) {
    finalResults.set(result.file, toIngestFileResult(result, perFileStoreResults.get(result.file) ?? emptyStoreResult(), storePhaseDurationMs));
  }

  return finalResults;
}

/** Creates an empty store result accumulator. */
function emptyStoreResult(): StoreResult {
  return {
    stored: 0,
    skipped: 0,
    rejected: 0,
  };
}

/** Combines extraction output and store statistics into the final file result shape. */
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
