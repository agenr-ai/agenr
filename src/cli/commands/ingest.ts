import path from "node:path";

import * as clack from "@clack/prompts";
import { createDatabase } from "../../adapters/db/client.js";
import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { createLlmClient, resolveLlmApiKey, resolveModel, type UsageStats } from "../../adapters/llm.js";
import { openClawTranscriptParser } from "../../adapters/openclaw/transcript/parser.js";
import { readConfig, resolveDbPath } from "../../config.js";
import {
  dedupBatch,
  discoverFiles,
  extractFile,
  getDefaultDedupSimilarityThreshold,
  storeExtractedResults,
  type DedupResult,
  type ExtractedFileResult,
  type IngestFileOptions,
  type IngestFileResult,
  type StoreExtractedResultsProgressEvent,
} from "../../core/ingestion/index.js";
import type { DatabasePort, EmbeddingPort, LlmPort, TranscriptPort } from "../../core/ports.js";
import type { StoreEntryInput, StoreResult } from "../../core/types.js";
import { setVerbose } from "../../logger.js";
import { banner, formatLabel, ui } from "../../ui.js";
import { InvalidArgumentError, Option, type Command } from "commander";

const DEFAULT_INGEST_CONCURRENCY = 10;
const MIN_INGEST_CONCURRENCY = 1;
const MAX_INGEST_CONCURRENCY = 16;

/** Non-null whole-file extraction mode accepted by the ingest CLI. */
type WholeFileMode = NonNullable<IngestFileOptions["wholeFile"]>;
/** Concrete LLM client shape returned by the CLI adapter factory. */
type CliLlmClient = ReturnType<typeof createLlmClient>;

/** Commander options accepted by the `agenr ingest` command. */
interface IngestCommandOptions {
  verbose?: boolean;
  dryRun?: boolean;
  wholeFile?: WholeFileMode;
  skipDedup?: boolean;
  skipEmbeddings?: boolean;
  concurrency?: number;
}

/** Per-file LLM usage summary used in CLI output. */
interface FileUsageSummary {
  fileCost: number;
  fileCalls: number;
  runningCost: number;
}

/** Extraction result paired with the usage consumed for that file. */
interface ExtractionExecutionResult {
  result: ExtractedFileResult;
  usage: UsageStats;
}

/** Ports and factories needed to execute one extraction worker. */
interface ExtractionPorts {
  transcript: TranscriptPort;
  db: DatabasePort;
  createLlm: () => CliLlmClient;
}

/** Extracted entry annotated with its source file and original flattened index. */
interface TaggedEntry {
  entry: StoreEntryInput;
  fileIndex: number;
  originalIndex: number;
}

/**
 * Registers the `agenr ingest` CLI command.
 *
 * @param program - Root Commander program to extend.
 */
export function registerIngestCommand(program: Command): void {
  const ingestCommand = program
    .command("ingest <path>")
    .description("Ingest OpenClaw session files into the knowledge database")
    .option("--verbose", "Show detailed progress")
    .option("--dry-run", "Parse and extract without storing")
    .addOption(new Option("--whole-file <mode>", "Whole-file mode: auto|force|never").choices(["auto", "force", "never"]).default("auto"))
    .option("--skip-dedup", "Skip within-batch semantic dedup")
    .option("--skip-embeddings", "Store entries without persisted embeddings")
    .addOption(new Option("--concurrency <n>", "Max files to extract in parallel").argParser(parseConcurrency).default(DEFAULT_INGEST_CONCURRENCY));

  ingestCommand.action(async (targetPath: string, options: IngestCommandOptions) => {
    const startedAt = Date.now();
    let db: Awaited<ReturnType<typeof createDatabase>> | null = null;

    setVerbose(options.verbose === true);
    clack.intro(banner());

    try {
      const config = readConfig();
      const dbPath = resolveDbPath(config);
      db = await createDatabase(dbPath);

      const { provider, modelId } = resolveModel(config, "extraction");
      const { provider: dedupProvider, modelId: dedupModelId } = resolveModel(config, "dedup");
      const llmApiKey = resolveLlmApiKey(config, provider);
      const llmTemplate = createLlmClient(provider, modelId, { apiKey: llmApiKey });
      let dedupLlm: CliLlmClient | null = null;
      const needsRealEmbeddings = options.skipDedup !== true || options.skipEmbeddings !== true;
      const sharedEmbedding = needsRealEmbeddings
        ? createEmbeddingClient(resolveEmbeddingApiKey(config), resolveEmbeddingModel(config))
        : createNoopEmbeddingPort();
      const storeEmbedding = options.skipEmbeddings === true ? createNoopEmbeddingPort() : sharedEmbedding;

      if (options.verbose === true) {
        clack.log.step(`Discovering transcript files in ${path.resolve(targetPath)}...`);
      }

      const files = await discoverFiles(targetPath);
      if (files.length === 0) {
        clack.log.warn(`No transcript files found at ${path.resolve(targetPath)}.`);
        clack.outro("Nothing to ingest.");
        return;
      }

      clack.log.info(
        [
          formatLabel("Extraction model", `${provider}/${modelId}`),
          formatLabel("Dedup model", options.skipDedup === true ? "skipped" : `${dedupProvider}/${dedupModelId}`),
          formatLabel("Database", dbPath),
          formatLabel("Files", `${files.length} ${pluralize(files.length, "file")} found`),
          formatLabel("Whole-file", options.wholeFile ?? "auto"),
          formatLabel("Within-batch dedup", options.skipDedup === true ? "skipped" : "enabled"),
          formatLabel("Embeddings", options.skipEmbeddings === true ? "not stored" : "stored"),
          formatLabel("Concurrency", `${options.concurrency ?? DEFAULT_INGEST_CONCURRENCY}`),
        ].join("\n"),
      );

      if (options.dryRun === true) {
        clack.log.warn("Dry run mode - no entries will be stored.");
      }

      const spinner = clack.spinner();
      spinner.start(`Extracting transcripts... (0/${files.length} complete)`);

      const extractionRuns = await runParallelExtractions(
        files,
        {
          transcript: openClawTranscriptParser,
          db,
          createLlm: () => createLlmClient(provider, modelId, { apiKey: llmApiKey }),
        },
        {
          verbose: options.verbose,
          wholeFile: options.wholeFile,
          contextWindowTokens: llmTemplate.metadata.contextWindowTokens,
          maxOutputTokens: llmTemplate.metadata.maxOutputTokens,
          extractionContext: config.extractionContext,
        },
        options.concurrency ?? DEFAULT_INGEST_CONCURRENCY,
        (completed, total) => {
          spinner.message(`Extracting transcripts... (${completed}/${total} complete)`);
        },
      );

      spinner.stop(`Extraction complete (${files.length}/${files.length}).`);

      const extractedResults = extractionRuns.map(({ result }) => result);
      const extractedSuccesses = extractedResults.filter((result) => result.skipped !== true && result.error === undefined);
      const taggedEntries = collectTaggedEntries(extractedSuccesses);
      const dedupStartedAt = Date.now();
      let dedupResult = buildEmptyDedupResult();
      let dedupUsage = createEmptyUsageStats();
      let resultsToStore = extractedSuccesses;
      let precomputedEmbeddings: Map<StoreEntryInput, number[]> | undefined;
      let storeResults = new Map<string, IngestFileResult>();

      if (extractedSuccesses.length > 0) {
        const dedupSpinnerMessage =
          options.skipDedup === true
            ? `Preparing ${taggedEntries.length} extracted ${pluralize(taggedEntries.length, "entry", "entries")} for store...`
            : `Deduplicating ${taggedEntries.length} extracted ${pluralize(taggedEntries.length, "entry", "entries")}...`;
        spinner.start(dedupSpinnerMessage);

        if (taggedEntries.length > 0) {
          const llm =
            options.skipDedup === true
              ? createNoopLlmPort()
              : (dedupLlm ??= createLlmClient(dedupProvider, dedupModelId, { apiKey: resolveLlmApiKey(config, dedupProvider) }));
          dedupResult = await dedupBatch(
            taggedEntries.map((taggedEntry) => taggedEntry.entry),
            llm,
            sharedEmbedding,
            {
              skip: options.skipDedup,
              verbose: options.verbose,
            },
          );
          resultsToStore = rebuildResultsWithSurvivors(extractedSuccesses, taggedEntries, dedupResult);
          precomputedEmbeddings = buildPrecomputedEmbeddingMap(dedupResult);
        }

        dedupUsage = dedupLlm ? cloneUsageStats(dedupLlm.metadata.usage) : createEmptyUsageStats();
        spinner.stop(`Dedup phase complete (${formatDurationMs(Date.now() - dedupStartedAt)}).`);
        printDedupSummary(dedupResult, taggedEntries, options, dedupUsage.totalCost);
      }

      if (resultsToStore.length > 0) {
        const entryCount = resultsToStore.reduce((total, result) => total + result.entries.length, 0);
        const useVerboseBulkWriteProgress = options.verbose === true && options.dryRun !== true && entryCount > 0;

        if (!useVerboseBulkWriteProgress) {
          spinner.start(
            entryCount > 0
              ? `Storing ${entryCount} ${pluralize(entryCount, "entry", "entries")} from ${resultsToStore.length} ${pluralize(resultsToStore.length, "file")}...`
              : `Finalizing ${resultsToStore.length} ${pluralize(resultsToStore.length, "file")}...`,
          );
        }

        storeResults = await storeExtractedResults(
          resultsToStore,
          {
            db,
            embedding: storeEmbedding,
          },
          {
            dryRun: options.dryRun,
            verbose: options.verbose,
            skipEmbeddings: options.skipEmbeddings,
            precomputedEmbeddings,
            onBulkWriteProgress: useVerboseBulkWriteProgress ? reportBulkWriteProgress : undefined,
          },
        );

        if (!useVerboseBulkWriteProgress) {
          spinner.stop(entryCount > 0 ? "Store phase complete." : "Finalize phase complete.");
        }
      }

      const totals = {
        stored: 0,
        deduped: dedupResult.removedCount,
        rejected: 0,
        skippedFiles: 0,
        failedFiles: 0,
        warnings: 0,
      };
      const usageTotals = extractionRuns.reduce((total, run) => addUsageStats(total, run.usage), createEmptyUsageStats());
      addUsageStats(usageTotals, dedupUsage);
      let runningCost = 0;

      for (const [index, extractionRun] of extractionRuns.entries()) {
        runningCost += extractionRun.usage.totalCost;
        const usage = toFileUsageSummary(extractionRun.usage, runningCost);
        const extractedResult = extractionRun.result;
        const result = getDisplayResult(extractedResult, storeResults);

        totals.warnings += result.warnings.length;

        if (result.skipped) {
          totals.skippedFiles += 1;
          if (options.verbose === true) {
            printVerboseFileDetails(result, options, usage);
            clack.log.step(buildSkippedMessage(path.basename(result.file)));
          } else {
            clack.log.step(buildSkippedMessage(path.basename(result.file)));
          }
          continue;
        }

        if (result.error) {
          totals.failedFiles += 1;
          if (options.verbose === true) {
            printVerboseFileDetails(result, options, usage);
          }
          clack.log.error(buildFailureMessage(path.basename(result.file), result, options, usage, index === 0));
          continue;
        }

        const storeResult = result.storeResult ?? emptyStoreResult();
        totals.stored += storeResult.stored;
        totals.deduped += storeResult.skipped;
        totals.rejected += storeResult.rejected;

        if (options.verbose === true) {
          printVerboseFileDetails(result, options, usage);
        }
        clack.log.step(buildSuccessMessage(path.basename(result.file), result, options, usage, index === 0));
      }

      const summaryParts = [`${totals.stored} ${pluralize(totals.stored, "entry", "entries")} stored`, `${totals.deduped} deduped`];

      if (totals.rejected > 0) {
        summaryParts.push(`${totals.rejected} rejected`);
      }
      if (totals.skippedFiles > 0) {
        summaryParts.push(`${totals.skippedFiles} ${pluralize(totals.skippedFiles, "file")} skipped`);
      }
      if (totals.failedFiles > 0) {
        summaryParts.push(`${totals.failedFiles} ${pluralize(totals.failedFiles, "file")} failed`);
      }
      if (totals.warnings > 0) {
        summaryParts.push(`${totals.warnings} ${pluralize(totals.warnings, "warning")}`);
      }

      if (usageTotals.calls > 0) {
        clack.log.info(
          [
            formatLabel(
              "Tokens",
              `${usageTotals.inputTokens.toLocaleString()} in / ${usageTotals.outputTokens.toLocaleString()} out / ${usageTotals.totalTokens.toLocaleString()} total`,
            ),
            formatLabel("Cost", formatCost(usageTotals.totalCost)),
            formatLabel("LLM calls", `${usageTotals.calls}`),
          ].join("\n"),
        );
      }

      const dryRunSuffix = options.dryRun === true ? " Dry run only." : "";
      clack.outro(`Done: ${summaryParts.join(", ")}. (${formatCost(usageTotals.totalCost)}, ${formatDurationMs(Date.now() - startedAt)})${dryRunSuffix}`);
    } catch (error) {
      process.exitCode = 1;
      clack.log.error(formatUnknownError(error));
      clack.outro(ui.error("Ingest failed"));
    } finally {
      await db?.close();
    }
  });
}

/** Prints verbose per-file ingest diagnostics and warnings. */
function printVerboseFileDetails(result: IngestFileResult, options: IngestCommandOptions, usage: FileUsageSummary): void {
  if (options.verbose !== true) {
    return;
  }

  const fileLabel = result.file;

  if (result.skipped) {
    clack.log.step(`${fileLabel}: skipped because the ingest hash matched.`);
    return;
  }

  if (result.error) {
    for (const chunkDetail of result.chunkDetails) {
      clack.log.step(formatChunkDetail(result.file, chunkDetail));
    }

    const lines = [
      `${fileLabel}: ${result.messageCount} ${pluralize(result.messageCount, "message")} parsed before failure`,
      `${fileLabel}: extraction ${result.successfulChunks}/${result.chunkCount} chunks succeeded`,
    ];
    const usageLine = formatVerboseUsageLine(fileLabel, usage);
    if (usageLine) {
      lines.push(usageLine);
    }
    lines.push(`${fileLabel}: duration ${formatDurationMs(result.durationMs)}`);

    clack.log.step(lines.join("\n"));

    for (const warning of result.warnings) {
      if (warning !== result.error) {
        clack.log.warn(`${fileLabel}: ${warning}`);
      }
    }

    return;
  }

  for (const chunkDetail of result.chunkDetails) {
    clack.log.step(formatChunkDetail(result.file, chunkDetail));
  }

  const lines = [
    `${fileLabel}: ${result.messageCount} ${pluralize(result.messageCount, "message")} parsed`,
    `${fileLabel}: extraction ${result.successfulChunks}/${result.chunkCount} chunks succeeded`,
    `${fileLabel}: store ${formatStoreSummary(result)}`,
  ];
  const usageLine = formatVerboseUsageLine(fileLabel, usage);
  if (usageLine) {
    lines.push(usageLine);
  }
  lines.push(`${fileLabel}: duration ${formatDurationMs(result.durationMs)}`);

  clack.log.step(lines.join("\n"));

  for (const warning of result.warnings) {
    clack.log.warn(`${fileLabel}: ${warning}`);
  }
}

/** Builds the one-line success summary shown for a completed file. */
function buildSuccessMessage(
  fileLabel: string,
  result: IngestFileResult,
  options: IngestCommandOptions,
  usage: FileUsageSummary,
  isFirstFile: boolean,
): string {
  const storeResult = result.storeResult ?? emptyStoreResult();
  const details = [
    `${result.messageCount} ${pluralize(result.messageCount, "message")}`,
    `${result.entriesExtracted} extracted`,
    `${storeResult.stored} stored`,
  ];

  if (storeResult.skipped > 0) {
    details.push(`${storeResult.skipped} dedup`);
  }
  if (storeResult.rejected > 0) {
    details.push(`${storeResult.rejected} rejected`);
  }
  if (result.failedChunks > 0) {
    details.push(`${result.failedChunks} chunk ${pluralize(result.failedChunks, "failure")}`);
  }
  if (options.dryRun === true) {
    details.push("dry run");
  }
  if (options.verbose === true) {
    details.push(formatDurationMs(result.durationMs));
  }

  return `${fileLabel}: ${details.join(" -> ")}${formatFileCost(usage.fileCost, usage.runningCost, isFirstFile)}`;
}

/** Builds the one-line summary for an unchanged skipped file. */
function buildSkippedMessage(fileLabel: string): string {
  return `${fileLabel}: skipped (unchanged)`;
}

/** Builds the one-line failure summary shown for a file. */
function buildFailureMessage(
  fileLabel: string,
  result: IngestFileResult,
  options: IngestCommandOptions,
  usage: FileUsageSummary,
  isFirstFile: boolean,
): string {
  const errorMessage = result.error ?? "unknown error";

  if (options.verbose !== true) {
    return `${fileLabel}: failed (${errorMessage})${formatFileCost(usage.fileCost, usage.runningCost, isFirstFile)}`;
  }

  const details = [`failed (${errorMessage})`, formatDurationMs(result.durationMs)];
  return `${fileLabel}: ${details.join(" -> ")}${formatFileCost(usage.fileCost, usage.runningCost, isFirstFile)}`;
}

/** Formats store counts for verbose per-file output. */
function formatStoreSummary(result: IngestFileResult): string {
  const storeResult = result.storeResult ?? emptyStoreResult();
  const parts = [`${storeResult.stored} stored`, `${storeResult.skipped} deduped`, `${storeResult.rejected} rejected`];

  if (result.failedChunks > 0) {
    parts.push(`${result.failedChunks} chunk ${pluralize(result.failedChunks, "failure")}`);
  }

  return parts.join(", ");
}

/** Formats one chunk-level extraction outcome for verbose logging. */
function formatChunkDetail(filePath: string, chunkDetail: { chunkIndex: number; messageRange: [number, number]; success: boolean }): string {
  const status = chunkDetail.success ? "ok" : "failed after retries";
  return `${filePath}: chunk ${chunkDetail.chunkIndex + 1} messages ${chunkDetail.messageRange[0]}-${chunkDetail.messageRange[1]} ${status}`;
}

/** Creates an embedding port that returns empty vectors for every input. */
function createNoopEmbeddingPort(): EmbeddingPort {
  return {
    embed: async (texts: string[]): Promise<number[][]> => texts.map(() => []),
  };
}

/** Formats a duration in milliseconds as seconds with one decimal place. */
function formatDurationMs(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/** Formats a USD cost value for CLI output. */
function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/** Formats per-file and running LLM cost suffixes for result lines. */
function formatFileCost(fileCost: number, runningCost: number, isFirstFile: boolean): string {
  if (fileCost === 0) {
    return "";
  }

  if (isFirstFile) {
    return ` (${formatCost(fileCost)})`;
  }

  return ` (${formatCost(fileCost)}, running ${formatCost(runningCost)})`;
}

/** Formats the verbose usage line for a single file when usage is non-zero. */
function formatVerboseUsageLine(fileLabel: string, usage: FileUsageSummary): string | undefined {
  if (usage.fileCost === 0 && usage.fileCalls === 0) {
    return undefined;
  }

  return `${fileLabel}: cost ${formatCost(usage.fileCost)} (${usage.fileCalls} ${pluralize(usage.fileCalls, "LLM call")})`;
}

/** Converts an unknown thrown value into a displayable error string. */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns a singular or plural noun based on the provided count.
 *
 * @param value - Numeric count that determines singular or plural output.
 * @param singular - Singular form of the noun.
 * @param plural - Optional explicit plural form for irregular nouns.
 * @returns Singular or pluralized noun.
 */
export function pluralize(value: number, singular: string, plural?: string): string {
  return value === 1 ? singular : (plural ?? `${singular}s`);
}

/** Runs file extraction workers in parallel while preserving input order. */
async function runParallelExtractions(
  files: string[],
  ports: ExtractionPorts,
  options: IngestFileOptions,
  concurrency: number,
  onProgress?: (completed: number, total: number) => void,
): Promise<ExtractionExecutionResult[]> {
  if (files.length === 0) {
    return [];
  }

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

        const llm = ports.createLlm();
        const result = await extractFile(
          files[currentIndex],
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
          result,
          usage: cloneUsageStats(llm.metadata.usage),
        };

        completed += 1;
        onProgress?.(completed, files.length);
      }
    }),
  );

  return results;
}

/** Resolves the final display result for one extracted file. */
function getDisplayResult(result: ExtractedFileResult, storeResults: Map<string, IngestFileResult>): IngestFileResult {
  if (result.skipped || result.error) {
    return toIngestFileResult(result, null);
  }

  return storeResults.get(result.file) ?? toIngestFileResult(result, emptyStoreResult());
}

/** Creates an LLM port that returns benign placeholder dedup responses. */
function createNoopLlmPort(): LlmPort {
  return {
    complete: async (): Promise<string> => '{"keep":[],"drop":[]}',
    completeJson: async <T>(): Promise<T> => ({}) as T,
  };
}

/** Creates an empty dedup result for batches with no extracted entries. */
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
    similarityThreshold: getDefaultDedupSimilarityThreshold(),
  };
}

/** Flattens extracted entries while tracking their source file and order. */
function collectTaggedEntries(results: ExtractedFileResult[]): TaggedEntry[] {
  const taggedEntries: TaggedEntry[] = [];
  let originalIndex = 0;

  for (const [fileIndex, result] of results.entries()) {
    for (const entry of result.entries) {
      taggedEntries.push({
        entry,
        fileIndex,
        originalIndex,
      });
      originalIndex += 1;
    }
  }

  return taggedEntries;
}

/** Rebuilds per-file extraction results using the dedup survivor set. */
function rebuildResultsWithSurvivors(results: ExtractedFileResult[], taggedEntries: TaggedEntry[], dedupResult: DedupResult): ExtractedFileResult[] {
  const survivorsByOriginalIndex = new Map<number, StoreEntryInput>();
  for (const [offset, originalIndex] of dedupResult.survivorIndices.entries()) {
    const survivor = dedupResult.survivors[offset];
    if (survivor) {
      survivorsByOriginalIndex.set(originalIndex, survivor);
    }
  }

  const entriesByFileIndex = new Map<number, StoreEntryInput[]>();
  for (const taggedEntry of taggedEntries) {
    const survivor = survivorsByOriginalIndex.get(taggedEntry.originalIndex);
    if (!survivor) {
      continue;
    }

    const entries = entriesByFileIndex.get(taggedEntry.fileIndex) ?? [];
    entries.push(survivor);
    entriesByFileIndex.set(taggedEntry.fileIndex, entries);
  }

  return results.map((result, fileIndex) => ({
    ...result,
    entries: entriesByFileIndex.get(fileIndex) ?? [],
  }));
}

/** Keys dedup survivor embeddings by entry object identity for store reuse. */
function buildPrecomputedEmbeddingMap(dedupResult: DedupResult): Map<StoreEntryInput, number[]> {
  return new Map(
    dedupResult.survivors.map((entry, index) => {
      const embedding = dedupResult.embeddings[index];
      if (!embedding) {
        throw new Error(`Missing dedup embedding for survivor index ${index}.`);
      }

      return [entry, embedding];
    }),
  );
}

/** Prints the aggregate and optional verbose within-batch dedup summary. */
function printDedupSummary(dedupResult: DedupResult, taggedEntries: TaggedEntry[], options: IngestCommandOptions, dedupCost: number): void {
  if (taggedEntries.length === 0) {
    clack.log.step("Dedup: 0 entries extracted, nothing to arbitrate.");
    return;
  }

  if (options.skipDedup === true) {
    clack.log.step(`Dedup: skipped (--skip-dedup), ${taggedEntries.length} ${pluralize(taggedEntries.length, "entry", "entries")} passed through.`);
    return;
  }

  clack.log.step(
    `Dedup: ${dedupResult.inputCount} ${pluralize(dedupResult.inputCount, "entry", "entries")} -> ${dedupResult.clustersArbitrated} similar ${pluralize(dedupResult.clustersArbitrated, "cluster")} found (similarity > ${formatThreshold(dedupResult.similarityThreshold)})`,
  );
  clack.log.step(
    `Dedup: ${dedupResult.clustersArbitrated} ${pluralize(dedupResult.clustersArbitrated, "cluster")} arbitrated (${dedupResult.llmCalls} ${pluralize(dedupResult.llmCalls, "LLM call")})`,
  );
  clack.log.step(
    `Dedup: ${dedupResult.survivors.length} ${pluralize(dedupResult.survivors.length, "entry", "entries")} survived, ${dedupResult.removedCount} removed (${formatCost(dedupCost)})`,
  );

  if (options.verbose !== true) {
    return;
  }

  for (const [clusterIndex, detail] of dedupResult.clusterDetails.entries()) {
    clack.log.step(formatDedupClusterDetail(clusterIndex, detail, taggedEntries));
  }

  clack.log.step(
    `Dedup: ${dedupResult.singletonsPassedThrough} ${pluralize(dedupResult.singletonsPassedThrough, "singleton")} passed through (no similar neighbors)`,
  );
}

/** Formats one verbose dedup cluster arbitration detail block. */
function formatDedupClusterDetail(clusterIndex: number, detail: DedupResult["clusterDetails"][number], taggedEntries: TaggedEntry[]): string {
  const localIndexByOriginal = new Map<number, number>();
  detail.entryIndices.forEach((entryIndex, localIndex) => {
    localIndexByOriginal.set(entryIndex, localIndex);
  });

  const lines = [
    `Dedup cluster ${clusterIndex + 1} (${detail.entryIndices.length} ${pluralize(detail.entryIndices.length, "entry", "entries")}, max similarity ${detail.maxSimilarity.toFixed(2)}):`,
  ];

  for (const [localIndex, originalIndex] of detail.entryIndices.entries()) {
    const taggedEntry = taggedEntries.find((entry) => entry.originalIndex === originalIndex);
    const entry = taggedEntry?.entry;
    if (!entry) {
      continue;
    }

    lines.push(
      `  [${localIndex}] ${entry.type}|${entry.importance ?? 7} ${JSON.stringify(entry.subject)}: ${JSON.stringify(truncateText(entry.content, 180))}`,
    );
  }

  const keptLocal = detail.kept.map((index) => localIndexByOriginal.get(index)).filter(isDefined);
  const droppedLocal = detail.dropped.map((index) => localIndexByOriginal.get(index)).filter(isDefined);
  lines.push(`  -> ${formatDedupDecisionLine(keptLocal, droppedLocal, detail.merged)}`);

  if (detail.mergedContent) {
    lines.push(`  -> Merged: ${JSON.stringify(truncateText(detail.mergedContent, 220))}`);
  }

  return lines.join("\n");
}

/** Formats the keep/drop decision line for a verbose dedup cluster. */
function formatDedupDecisionLine(kept: number[], dropped: number[], merged: boolean): string {
  if (dropped.length === 0) {
    return `Kept ${formatIndexList(kept)} (genuinely different knowledge)`;
  }

  const mergedSuffix = merged ? ", merged content" : "";
  return `Kept ${formatIndexList(kept)}, dropped ${formatIndexList(dropped)}${mergedSuffix}`;
}

/** Formats a list of local cluster indexes for CLI output. */
function formatIndexList(indexes: number[]): string {
  return `[${indexes.join(",")}]`;
}

/** Converts an extracted file result into the CLI display result shape. */
function toIngestFileResult(result: ExtractedFileResult, storeResult: StoreResult | null): IngestFileResult {
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
    durationMs: result.durationMs,
  };
}

/** Creates an empty store result accumulator for CLI aggregation. */
function emptyStoreResult(): StoreResult {
  return {
    stored: 0,
    skipped: 0,
    rejected: 0,
  };
}

/** Reports ingest bulk-write lifecycle events through the CLI logger. */
function reportBulkWriteProgress(event: StoreExtractedResultsProgressEvent): void {
  switch (event.phase) {
    case "prepare_start":
      clack.log.step("Store: dropping FTS triggers and vector index for bulk writes...");
      break;
    case "store_complete":
      clack.log.step("Store phase complete.");
      break;
    case "finalize_start":
      clack.log.step("Store: rebuilding FTS and vector index...");
      break;
    case "finalize_complete":
      clack.log.step(`Store: indexes rebuilt (${formatDurationMs(event.durationMs ?? 0)}).`);
      break;
  }
}

/** Formats a similarity threshold with two decimal places. */
function formatThreshold(value: number): string {
  return value.toFixed(2);
}

/** Truncates long free-form text for concise CLI output. */
function truncateText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

/** Narrows away `undefined` values in filtered arrays. */
function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** Clones usage totals so worker-local clients can be discarded safely. */
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

/** Creates a zeroed usage accumulator for CLI accounting. */
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

/** Adds one usage record into a running total. */
function addUsageStats(total: UsageStats, usage: UsageStats): UsageStats {
  total.calls += usage.calls;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
  total.totalTokens += usage.totalTokens;
  total.totalCost += usage.totalCost;
  return total;
}

/** Converts raw usage totals into the per-file summary used in output. */
function toFileUsageSummary(usage: UsageStats, runningCost: number): FileUsageSummary {
  return {
    fileCost: usage.totalCost,
    fileCalls: usage.calls,
    runningCost,
  };
}

/** Parses and validates the ingest concurrency CLI option. */
function parseConcurrency(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError("Concurrency must be an integer.");
  }

  if (parsed < MIN_INGEST_CONCURRENCY || parsed > MAX_INGEST_CONCURRENCY) {
    throw new InvalidArgumentError(`Concurrency must be between ${MIN_INGEST_CONCURRENCY} and ${MAX_INGEST_CONCURRENCY}.`);
  }

  return parsed;
}
