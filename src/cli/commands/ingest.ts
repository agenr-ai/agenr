import path from "node:path";

import * as clack from "@clack/prompts";
import { resolveEmbeddingApiKey, resolveEmbeddingModel, createEmbeddingClient } from "../../adapters/embeddings.js";
import { createLlmClient, resolveLlmApiKey, resolveModel } from "../../adapters/llm.js";
import { openClawTranscriptParser } from "../../adapters/openclaw/transcript/parser.js";
import { createDatabase } from "../../adapters/db/client.js";
import { readConfig, resolveDbPath } from "../../config.js";
import { discoverFiles, ingestFile, type IngestFileOptions, type IngestFileResult } from "../../core/ingestion/index.js";
import type { EmbeddingPort } from "../../core/ports.js";
import { setVerbose } from "../../logger.js";
import { banner, formatLabel, ui } from "../../ui.js";
import { Option, type Command } from "commander";

type WholeFileMode = NonNullable<IngestFileOptions["wholeFile"]>;

interface IngestCommandOptions {
  verbose?: boolean;
  dryRun?: boolean;
  wholeFile?: WholeFileMode;
  skipEmbeddings?: boolean;
}

interface FileUsageSummary {
  fileCost: number;
  fileCalls: number;
  runningCost: number;
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
    .option("--skip-embeddings", "Skip embedding computation");

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
      const llm = createLlmClient(provider, modelId, { apiKey: llmApiKey });
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
        ].join("\n"),
      );

      if (options.dryRun === true) {
        clack.log.warn("Dry run mode - no entries will be stored.");
      }

      const totals = {
        stored: 0,
        deduped: 0,
        rejected: 0,
        skippedFiles: 0,
        failedFiles: 0,
        warnings: 0,
      };
      const spinner = clack.spinner();

      for (const [index, file] of files.entries()) {
        const spinnerLabel = path.basename(file);
        spinner.start(`Ingesting ${spinnerLabel}...`);
        const costBefore = llm.metadata.usage.totalCost;
        const callsBefore = llm.metadata.usage.calls;

        const result = await ingestFile(
          file,
          {
            transcript: openClawTranscriptParser,
            llm,
            embedding,
            db,
          },
          {
            verbose: options.verbose,
            dryRun: options.dryRun,
            wholeFile: options.wholeFile,
            skipEmbeddings: options.skipEmbeddings,
            contextWindowTokens: llm.metadata.contextWindowTokens,
            maxOutputTokens: llm.metadata.maxOutputTokens,
            extractionContext: config.extractionContext,
          },
        );
        const usage: FileUsageSummary = {
          fileCost: Math.max(0, llm.metadata.usage.totalCost - costBefore),
          fileCalls: Math.max(0, llm.metadata.usage.calls - callsBefore),
          runningCost: llm.metadata.usage.totalCost,
        };

        totals.warnings += result.warnings.length;

        if (result.skipped) {
          totals.skippedFiles += 1;
          if (options.verbose === true) {
            spinner.stop(spinnerLabel);
            printVerboseFileDetails(result, options, usage);
            clack.log.step(buildSkippedMessage(spinnerLabel));
          } else {
            spinner.stop(buildSkippedMessage(spinnerLabel));
          }
        } else if (result.error) {
          totals.failedFiles += 1;
          if (options.verbose === true) {
            spinner.error(spinnerLabel);
            printVerboseFileDetails(result, options, usage);
            clack.log.error(buildFailureMessage(spinnerLabel, result, options, usage, index === 0));
          } else {
            spinner.error(buildFailureMessage(spinnerLabel, result, options, usage, index === 0));
          }
        } else {
          const storeResult = result.storeResult ?? { stored: 0, skipped: 0, rejected: 0 };
          totals.stored += storeResult.stored;
          totals.deduped += storeResult.skipped;
          totals.rejected += storeResult.rejected;
          if (options.verbose === true) {
            spinner.stop(spinnerLabel);
            printVerboseFileDetails(result, options, usage);
            clack.log.step(buildSuccessMessage(spinnerLabel, result, options, usage, index === 0));
          } else {
            spinner.stop(buildSuccessMessage(spinnerLabel, result, options, usage, index === 0));
          }
        }
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

      const usage = llm.metadata.usage;
      if (usage.calls > 0) {
        clack.log.info(
          [
            formatLabel(
              "Tokens",
              `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out / ${usage.totalTokens.toLocaleString()} total`,
            ),
            formatLabel("Cost", formatCost(usage.totalCost)),
            formatLabel("LLM calls", `${usage.calls}`),
          ].join("\n"),
        );
      }

      const dryRunSuffix = options.dryRun === true ? " Dry run only." : "";
      clack.outro(`Done: ${summaryParts.join(", ")}. (${formatCost(usage.totalCost)}, ${formatDurationMs(Date.now() - startedAt)})${dryRunSuffix}`);
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
  const storeResult = result.storeResult ?? { stored: 0, skipped: 0, rejected: 0 };
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
  const storeResult = result.storeResult ?? { stored: 0, skipped: 0, rejected: 0 };
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
