import path from "node:path";

import * as clack from "@clack/prompts";
import { createDatabase } from "../../adapters/db/client.js";
import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { createLlmClient, resolveLlmApiKey, resolveModel, type UsageStats } from "../../adapters/llm.js";
import { openClawTranscriptParser } from "../../adapters/openclaw/transcript/parser.js";
import { readConfig, resolveDbPath } from "../../config.js";
import {
  discoverFiles,
  extractFile,
  storeExtractedResults,
  type ExtractedFileResult,
  type IngestFileOptions,
  type IngestFileResult,
} from "../../core/ingestion/index.js";
import type { DatabasePort, EmbeddingPort, TranscriptPort } from "../../core/ports.js";
import type { StoreResult } from "../../core/types.js";
import { setVerbose } from "../../logger.js";
import { banner, formatLabel, ui } from "../../ui.js";
import { InvalidArgumentError, Option, type Command } from "commander";

const DEFAULT_INGEST_CONCURRENCY = 10;
const MIN_INGEST_CONCURRENCY = 1;
const MAX_INGEST_CONCURRENCY = 16;

type WholeFileMode = NonNullable<IngestFileOptions["wholeFile"]>;
type CliLlmClient = ReturnType<typeof createLlmClient>;

interface IngestCommandOptions {
  verbose?: boolean;
  dryRun?: boolean;
  wholeFile?: WholeFileMode;
  skipEmbeddings?: boolean;
  concurrency?: number;
}

interface FileUsageSummary {
  fileCost: number;
  fileCalls: number;
  runningCost: number;
}

interface ExtractionExecutionResult {
  result: ExtractedFileResult;
  usage: UsageStats;
}

interface ExtractionPorts {
  transcript: TranscriptPort;
  db: DatabasePort;
  createLlm: () => CliLlmClient;
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
    .option("--skip-embeddings", "Skip embedding computation")
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
      const llmApiKey = resolveLlmApiKey(config, provider);
      const llmTemplate = createLlmClient(provider, modelId, { apiKey: llmApiKey });
      const embedding =
        options.skipEmbeddings === true ? createNoopEmbeddingPort() : createEmbeddingClient(resolveEmbeddingApiKey(config), resolveEmbeddingModel(config));

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
          formatLabel("Model", `${provider}/${modelId}`),
          formatLabel("Database", dbPath),
          formatLabel("Files", `${files.length} ${pluralize(files.length, "file")} found`),
          formatLabel("Whole-file", options.wholeFile ?? "auto"),
          formatLabel("Embeddings", options.skipEmbeddings === true ? "skipped" : "enabled"),
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
      const resultsToStore = extractedResults.filter((result) => result.skipped !== true && result.error === undefined);
      let storeResults = new Map<string, IngestFileResult>();

      if (resultsToStore.length > 0) {
        const entryCount = resultsToStore.reduce((total, result) => total + result.entries.length, 0);
        spinner.start(
          entryCount > 0
            ? `Storing ${entryCount} ${pluralize(entryCount, "entry", "entries")} from ${resultsToStore.length} ${pluralize(resultsToStore.length, "file")}...`
            : `Finalizing ${resultsToStore.length} ${pluralize(resultsToStore.length, "file")}...`,
        );
        storeResults = await storeExtractedResults(
          resultsToStore,
          {
            db,
            embedding,
          },
          {
            dryRun: options.dryRun,
            verbose: options.verbose,
            skipEmbeddings: options.skipEmbeddings,
          },
        );
        spinner.stop(entryCount > 0 ? "Store phase complete." : "Finalize phase complete.");
      }

      const totals = {
        stored: 0,
        deduped: 0,
        rejected: 0,
        skippedFiles: 0,
        failedFiles: 0,
        warnings: 0,
      };
      const usageTotals = extractionRuns.reduce(sumUsageStats, createEmptyUsageStats());
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

function buildSkippedMessage(fileLabel: string): string {
  return `${fileLabel}: skipped (unchanged)`;
}

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

function formatStoreSummary(result: IngestFileResult): string {
  const storeResult = result.storeResult ?? emptyStoreResult();
  const parts = [`${storeResult.stored} stored`, `${storeResult.skipped} deduped`, `${storeResult.rejected} rejected`];

  if (result.failedChunks > 0) {
    parts.push(`${result.failedChunks} chunk ${pluralize(result.failedChunks, "failure")}`);
  }

  return parts.join(", ");
}

function formatChunkDetail(filePath: string, chunkDetail: { chunkIndex: number; messageRange: [number, number]; success: boolean }): string {
  const status = chunkDetail.success ? "ok" : "failed after retries";
  return `${filePath}: chunk ${chunkDetail.chunkIndex + 1} messages ${chunkDetail.messageRange[0]}-${chunkDetail.messageRange[1]} ${status}`;
}

function createNoopEmbeddingPort(): EmbeddingPort {
  return {
    embed: async (texts: string[]): Promise<number[][]> => texts.map(() => []),
  };
}

function formatDurationMs(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function formatFileCost(fileCost: number, runningCost: number, isFirstFile: boolean): string {
  if (fileCost === 0) {
    return "";
  }

  if (isFirstFile) {
    return ` (${formatCost(fileCost)})`;
  }

  return ` (${formatCost(fileCost)}, running ${formatCost(runningCost)})`;
}

function formatVerboseUsageLine(fileLabel: string, usage: FileUsageSummary): string | undefined {
  if (usage.fileCost === 0 && usage.fileCalls === 0) {
    return undefined;
  }

  return `${fileLabel}: cost ${formatCost(usage.fileCost)} (${usage.fileCalls} ${pluralize(usage.fileCalls, "LLM call")})`;
}

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

function getDisplayResult(result: ExtractedFileResult, storeResults: Map<string, IngestFileResult>): IngestFileResult {
  if (result.skipped || result.error) {
    return toIngestFileResult(result, null);
  }

  return storeResults.get(result.file) ?? toIngestFileResult(result, emptyStoreResult());
}

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

function emptyStoreResult(): StoreResult {
  return {
    stored: 0,
    skipped: 0,
    rejected: 0,
  };
}

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

function sumUsageStats(total: UsageStats, usage: ExtractionExecutionResult): UsageStats {
  total.calls += usage.usage.calls;
  total.inputTokens += usage.usage.inputTokens;
  total.outputTokens += usage.usage.outputTokens;
  total.cacheReadTokens += usage.usage.cacheReadTokens;
  total.cacheWriteTokens += usage.usage.cacheWriteTokens;
  total.totalTokens += usage.usage.totalTokens;
  total.totalCost += usage.usage.totalCost;
  return total;
}

function toFileUsageSummary(usage: UsageStats, runningCost: number): FileUsageSummary {
  return {
    fileCost: usage.totalCost,
    fileCalls: usage.calls,
    runningCost,
  };
}

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
