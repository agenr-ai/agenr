import {
  restoreExplicitClaimKeysAfterDedup,
  dedupBatch,
  extractFile,
  getDefaultDedupSimilarityThreshold,
  summarizeIngestClaimKeyHealth,
  storeExtractedResults,
  type DedupProgressEvent as CoreDedupProgressEvent,
  type DedupResult,
  type ExtractedFileResult,
  type IngestFileOptions,
  type IngestFileResult,
  type IngestClaimKeyHealthSummary,
  type IngestSource,
  type StoreExtractedResultsProgressEvent,
} from "../../core/ingestion/index.js";
import type { LlmPort } from "../../core/ports.js";
import {
  applyClaimExtractionResultToDurable,
  runBatchClaimExtraction,
  type ClaimExtractionConfig,
  type ClaimExtractionDiagnostic,
  type ClaimExtractionProgressEvent as CoreClaimExtractionProgressEvent,
} from "../../core/store/claim-extraction.js";
import type { StoreDurableInput } from "../../core/types.js";
import type { IngestPathPorts, IngestionLlmPort, UsageStats } from "./ports.js";

/** Default maximum number of files to extract in parallel. */
const DEFAULT_INGEST_CONCURRENCY = 10;

export { DEFAULT_INGEST_CONCURRENCY };

/** High-level ingest phases surfaced to callers for user-facing progress. */
export interface IngestStageProgressEvent {
  phase: "dedup_start" | "claim_extraction_start" | "store_start";
  totalDurables: number;
}

/** Application-layer dedup progress payload forwarded from core ingestion. */
export type DedupProgressEvent = CoreDedupProgressEvent;

/** Application-layer claim-extraction progress payload forwarded from core store logic. */
export type ClaimExtractionProgressEvent = CoreClaimExtractionProgressEvent;

/** Runtime options for application-layer path ingestion. */
export interface IngestPathOptions extends IngestFileOptions {
  /** Override claim extraction config for this ingest run. */
  claimExtractionConfig?: ClaimExtractionConfig;
  /** Optional warning sink for claim extraction or store pipeline warnings. */
  onWarning?: (warning: string) => void;
  /** Optional callback invoked when a file finishes extraction. */
  onExtractionProgress?: (completed: number, total: number) => void;
  /** Optional callback invoked when ingest advances into a new post-extraction stage. */
  onStageProgress?: (event: IngestStageProgressEvent) => void;
  /** Optional callback invoked as multi-entry dedup arbitrations finish. */
  onDedupProgress?: (event: DedupProgressEvent) => void;
  /** Optional callback invoked as eligible claim-extraction work finishes. */
  onClaimExtractionProgress?: (event: ClaimExtractionProgressEvent) => void;
  /** Optional callback invoked around ingest-specific bulk write phases. */
  onBulkWriteProgress?: (event: StoreExtractedResultsProgressEvent) => void;
}

/**
 * Extraction result paired with source metadata and LLM usage.
 */
export interface ExtractionExecutionResult {
  /** Source file metadata for the extraction run. */
  source: IngestSource;
  /** Core extraction result for the file. */
  result: ExtractedFileResult;
  /** Usage consumed by the extraction LLM client. */
  usage: UsageStats;
}

/**
 * Aggregate result emitted by the application-layer ingest service.
 */
export interface IngestPathResult {
  /** Files discovered under the requested target path. */
  files: string[];
  /** Per-file extraction runs in the original discovery order. */
  extractionRuns: ExtractionExecutionResult[];
  /** Aggregate within-batch dedup result for extracted entries. */
  dedupResult: DedupResult;
  /** Usage consumed by the dedup LLM client, when used. */
  dedupUsage: UsageStats;
  /** Final stored per-file ingest results keyed by source path. */
  storeResults: Map<string, IngestFileResult>;
  /** Compact claim-key health summary for the final store candidates. */
  claimKeyHealth: IngestClaimKeyHealthSummary | null;
}

/** Extracted durable annotated with its source file and flattened order. */
interface TaggedDurable {
  durable: StoreDurableInput;
  fileIndex: number;
  originalIndex: number;
}

/**
 * Discovers files, extracts them in parallel, runs cross-file dedup, and stores survivors.
 *
 * @param targetPath - File or directory path to ingest.
 * @param ports - Filesystem, transcript, database, embedding, and LLM ports.
 * @param options - Optional concurrency, progress hooks, and ingest controls.
 * @returns Aggregate ingest result for all discovered files.
 */
export async function ingestPath(targetPath: string, ports: IngestPathPorts, options: IngestPathOptions = {}): Promise<IngestPathResult> {
  const files = await ports.files.discoverFiles(targetPath);
  return ingestDiscoveredFiles(files, ports, options);
}

/**
 * Extracts, deduplicates, and stores a pre-discovered list of transcript files.
 *
 * @param files - Transcript files to ingest in order.
 * @param ports - Filesystem, transcript, database, embedding, and LLM ports.
 * @param options - Optional concurrency, progress hooks, and ingest controls.
 * @returns Aggregate ingest result for the supplied files.
 */
export async function ingestDiscoveredFiles(files: string[], ports: IngestPathPorts, options: IngestPathOptions = {}): Promise<IngestPathResult> {
  if (files.length === 0) {
    return {
      files: [],
      extractionRuns: [],
      dedupResult: buildEmptyDedupResult(),
      dedupUsage: createEmptyUsageStats(),
      storeResults: new Map(),
      claimKeyHealth: null,
    };
  }

  const extractionRuns = await runParallelExtractions(files, ports, options, options.concurrency ?? DEFAULT_INGEST_CONCURRENCY);
  const extractedResults = extractionRuns.map((run) => run.result);
  const extractedSuccesses = extractedResults.filter((result) => result.skipped !== true && result.error === undefined);
  const taggedDurables = collectTaggedDurables(extractedSuccesses);

  let dedupResult = buildEmptyDedupResult();
  let dedupUsage = createEmptyUsageStats();
  let resultsToStore = extractedSuccesses;
  let precomputedEmbeddings: number[][] | undefined;
  const claimKeyDiagnostics = new Map<number, ClaimExtractionDiagnostic>();

  if (taggedDurables.length > 0) {
    if (options.skipDedup !== true) {
      options.onStageProgress?.({
        phase: "dedup_start",
        totalDurables: taggedDurables.length,
      });
    }
    const dedupLlm = options.skipDedup === true ? createNoopLlmPort() : (ports.createDedupLlm?.() ?? ports.createExtractionLlm());
    dedupResult = await dedupBatch(
      taggedDurables.map((taggedDurable) => taggedDurable.durable),
      dedupLlm,
      ports.embedding,
      {
        concurrency: options.concurrency ?? DEFAULT_INGEST_CONCURRENCY,
        skip: options.skipDedup,
        verbose: options.verbose,
        onProgress: options.onDedupProgress,
      },
    );
    const preservedDedupResult: DedupResult = {
      ...dedupResult,
      survivors: restoreExplicitClaimKeysAfterDedup(
        taggedDurables.map((taggedDurable) => taggedDurable.durable),
        dedupResult,
      ),
    };
    resultsToStore = rebuildResultsWithSurvivors(extractedSuccesses, taggedDurables, preservedDedupResult);
    precomputedEmbeddings = dedupResult.embeddings;
    dedupUsage = isIngestionLlmPort(dedupLlm) ? cloneUsageStats(dedupLlm.metadata.usage) : createEmptyUsageStats();
  }

  if (ports.createClaimExtractionLlm && resultsToStore.length > 0) {
    const claimConfig: ClaimExtractionConfig = options.claimExtractionConfig ?? {
      enabled: true,
      confidenceThreshold: 0.8,
      eligibleTypes: ["fact", "preference", "decision", "lesson"],
    };
    if (claimConfig.enabled) {
      options.onStageProgress?.({
        phase: "claim_extraction_start",
        totalDurables: flattenDurables(resultsToStore).length,
      });
    }
    const extractedClaimKeys = await runBatchClaimExtraction(
      resultsToStore,
      {
        createLlm: ports.createClaimExtractionLlm,
        db: ports.db,
      },
      claimConfig,
      claimConfig.concurrency ?? options.concurrency ?? DEFAULT_INGEST_CONCURRENCY,
      options.onWarning,
      (entry, diagnostic) => {
        const flattenedIndex = findFlattenedDurableIndex(resultsToStore, entry);
        if (flattenedIndex >= 0) {
          claimKeyDiagnostics.set(flattenedIndex, diagnostic);
        }
      },
      options.onClaimExtractionProgress,
    );

    for (const [entry, extractedClaimKey] of extractedClaimKeys) {
      applyClaimExtractionResultToDurable(entry, extractedClaimKey);
    }
  }

  const claimKeyHealth =
    resultsToStore.length > 0
      ? summarizeIngestClaimKeyHealth(
          flattenDurables(resultsToStore),
          claimKeyDiagnostics,
          (
            options.claimExtractionConfig ?? {
              enabled: true,
              confidenceThreshold: 0.8,
              eligibleTypes: ["fact", "preference", "decision", "lesson"],
            }
          ).eligibleTypes,
        )
      : null;

  const storeResults =
    resultsToStore.length === 0
      ? new Map<string, IngestFileResult>()
      : await (async () => {
          options.onStageProgress?.({
            phase: "store_start",
            totalDurables: flattenDurables(resultsToStore).length,
          });
          return storeExtractedResults(
            resultsToStore,
            {
              db: ports.db,
              embedding: ports.embedding,
            },
            {
              dryRun: options.dryRun,
              verbose: options.verbose,
              precomputedEmbeddings,
              onWarning: options.onWarning,
              onBulkWriteProgress: options.onBulkWriteProgress,
            },
          );
        })();

  return {
    files,
    extractionRuns,
    dedupResult,
    dedupUsage,
    storeResults,
    claimKeyHealth,
  };
}

/** Runs file extraction workers in parallel while preserving input order. */
async function runParallelExtractions(
  files: string[],
  ports: IngestPathPorts,
  options: IngestPathOptions,
  concurrency: number,
): Promise<ExtractionExecutionResult[]> {
  const results = new Array<ExtractionExecutionResult>(files.length);
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(concurrency, files.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= files.length) {
          return;
        }

        const filePath = files[currentIndex];
        if (!filePath) {
          return;
        }

        const llm = ports.createExtractionLlm();
        const source = {
          filePath,
          fileHash: await ports.files.computeFileHash(filePath),
        };
        const result = await extractFile(
          source,
          {
            transcript: ports.transcript,
            llm,
            db: ports.db,
          },
          {
            ...options,
            contextWindowTokens: llm.metadata.contextWindowTokens,
            maxOutputTokens: llm.metadata.maxOutputTokens,
          },
        );

        results[currentIndex] = {
          source,
          result,
          usage: cloneUsageStats(llm.metadata.usage),
        };

        completed += 1;
        options.onExtractionProgress?.(completed, files.length);
      }
    }),
  );

  return results;
}

/** Creates a benign LLM port for skip-mode dedup runs. */
function createNoopLlmPort(): LlmPort {
  return {
    complete: async (): Promise<string> => '{"keep":[],"drop":[]}',
    completeJson: async <T>(): Promise<T> => ({}) as T,
  };
}

/** Builds an empty dedup result for batches with no extracted entries. */
function buildEmptyDedupResult(): DedupResult {
  return {
    survivors: [],
    survivorIndices: [],
    embeddings: [],
    inputCount: 0,
    removedCount: 0,
    clustersArbitrated: 0,
    singletonsPassedThrough: 0,
    llmCalls: 0,
    clusterDetails: [],
    warnings: [],
    similarityThreshold: getDefaultDedupSimilarityThreshold(),
  };
}

/** Flattens extracted file entries into the final store-candidate order. */
function flattenDurables(results: ExtractedFileResult[]): StoreDurableInput[] {
  return results.flatMap((result) => result.durables);
}

/** Resolves one flattened store-candidate index for a concrete entry object. */
function findFlattenedDurableIndex(results: ExtractedFileResult[], target: StoreDurableInput): number {
  let index = 0;
  for (const result of results) {
    for (const entry of result.durables) {
      if (entry === target) {
        return index;
      }

      index += 1;
    }
  }

  return -1;
}

/** Flattens extracted entries while tracking their source file and original order. */
function collectTaggedDurables(results: ExtractedFileResult[]): TaggedDurable[] {
  const taggedDurables: TaggedDurable[] = [];
  let originalIndex = 0;

  for (const [fileIndex, result] of results.entries()) {
    for (const entry of result.durables) {
      taggedDurables.push({
        durable: entry,
        fileIndex,
        originalIndex,
      });
      originalIndex += 1;
    }
  }

  return taggedDurables;
}

/** Rebuilds per-file extraction results using the dedup survivor set. */
function rebuildResultsWithSurvivors(results: ExtractedFileResult[], taggedDurables: TaggedDurable[], dedupResult: DedupResult): ExtractedFileResult[] {
  const survivorsByOriginalIndex = new Map<number, StoreDurableInput>();
  for (const [offset, originalIndex] of dedupResult.survivorIndices.entries()) {
    const survivor = dedupResult.survivors[offset];
    if (survivor) {
      survivorsByOriginalIndex.set(originalIndex, survivor);
    }
  }

  const entriesByFileIndex = new Map<number, StoreDurableInput[]>();
  for (const taggedDurable of taggedDurables) {
    const survivor = survivorsByOriginalIndex.get(taggedDurable.originalIndex);
    if (!survivor) {
      continue;
    }

    const entries = entriesByFileIndex.get(taggedDurable.fileIndex) ?? [];
    entries.push(survivor);
    entriesByFileIndex.set(taggedDurable.fileIndex, entries);
  }

  return results.map((result, fileIndex) => ({
    ...result,
    durables: entriesByFileIndex.get(fileIndex) ?? [],
  }));
}

/** Creates a zeroed usage snapshot. */
function createEmptyUsageStats(): UsageStats {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

/** Clones a usage snapshot so later mutations do not affect stored results. */
function cloneUsageStats(usage: UsageStats): UsageStats {
  return {
    calls: usage.calls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    totalCost: usage.totalCost,
  };
}

/** Checks whether an LLM port exposes ingestion metadata. */
function isIngestionLlmPort(llm: LlmPort): llm is IngestionLlmPort {
  return "metadata" in llm;
}
