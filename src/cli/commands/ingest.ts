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

      for (const file of files) {
        const spinnerLabel = path.basename(file);
        spinner.start(`Ingesting ${spinnerLabel}...`);

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
          },
        );

        totals.warnings += result.warnings.length;

        if (result.skipped) {
          totals.skippedFiles += 1;
          spinner.stop(`${spinnerLabel}: skipped (unchanged)`);
        } else if (result.error) {
          totals.failedFiles += 1;
          spinner.error(`${spinnerLabel}: failed (${result.error})`);
        } else {
          const storeResult = result.storeResult ?? { stored: 0, skipped: 0, rejected: 0 };
          totals.stored += storeResult.stored;
          totals.deduped += storeResult.skipped;
          totals.rejected += storeResult.rejected;
          spinner.stop(buildSuccessMessage(spinnerLabel, result, options));
        }

        printVerboseFileDetails(result, options);
      }

      const summaryParts = [`${totals.stored} ${pluralize(totals.stored, "entry")} stored`, `${totals.deduped} deduped`];

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

      const dryRunSuffix = options.dryRun === true ? " Dry run only." : "";
      clack.outro(`Done: ${summaryParts.join(", ")}. (${formatDurationMs(Date.now() - startedAt)})${dryRunSuffix}`);
    } catch (error) {
      process.exitCode = 1;
      clack.log.error(formatUnknownError(error));
      clack.outro(ui.error("Ingest failed"));
    } finally {
      await db?.close();
    }
  });
}

function printVerboseFileDetails(result: IngestFileResult, options: IngestCommandOptions): void {
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

    clack.log.step(
      [
        `${fileLabel}: ${result.messageCount} ${pluralize(result.messageCount, "message")} parsed before failure`,
        `${fileLabel}: extraction ${result.successfulChunks}/${result.chunkCount} chunks succeeded`,
        `${fileLabel}: duration ${formatDurationMs(result.durationMs)}`,
      ].join("\n"),
    );

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

  clack.log.step(
    [
      `${fileLabel}: ${result.messageCount} ${pluralize(result.messageCount, "message")} parsed`,
      `${fileLabel}: extraction ${result.successfulChunks}/${result.chunkCount} chunks succeeded`,
      `${fileLabel}: store ${formatStoreSummary(result)}`,
      `${fileLabel}: duration ${formatDurationMs(result.durationMs)}`,
    ].join("\n"),
  );

  for (const warning of result.warnings) {
    clack.log.warn(`${fileLabel}: ${warning}`);
  }
}

function buildSuccessMessage(fileLabel: string, result: IngestFileResult, options: IngestCommandOptions): string {
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

  return `${fileLabel}: ${details.join(" -> ")}`;
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

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pluralize(value: number, singular: string): string {
  return value === 1 ? singular : `${singular}s`;
}
