import path from "node:path";

import { resolveEmbeddingApiKey, resolveEmbeddingModel, createEmbeddingClient } from "../../adapters/embeddings.js";
import { createLlmClient, resolveLlmApiKey, resolveModel } from "../../adapters/llm.js";
import { openClawTranscriptParser } from "../../adapters/openclaw/transcript/parser.js";
import { createDatabase } from "../../adapters/db/client.js";
import { readConfig, resolveDbPath } from "../../config.js";
import { discoverFiles, ingestFile, type IngestFileOptions, type IngestFileResult } from "../../core/ingestion/index.js";
import type { EmbeddingPort } from "../../core/ports.js";
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
  program
    .command("ingest <path>")
    .description("Ingest OpenClaw session files into the knowledge database")
    .option("--verbose", "Show detailed progress")
    .option("--dry-run", "Parse and extract without storing")
    .addOption(new Option("--whole-file <mode>", "Whole-file mode: auto|force|never").choices(["auto", "force", "never"]).default("auto"))
    .option("--skip-embeddings", "Skip embedding computation")
    .action(async (targetPath: string, options: IngestCommandOptions) => {
      const startedAt = Date.now();
      let db: Awaited<ReturnType<typeof createDatabase>> | null = null;

      try {
        const config = readConfig();
        const dbPath = resolveDbPath(config);
        db = await createDatabase(dbPath);

        const { provider, modelId } = resolveModel(config, "extraction");
        const llmApiKey = resolveLlmApiKey(config, provider);
        const llm = createLlmClient(provider, modelId, { apiKey: llmApiKey });
        const embedding = options.skipEmbeddings
          ? createNoopEmbeddingPort()
          : createEmbeddingClient(resolveEmbeddingApiKey(config), resolveEmbeddingModel(config));

        const files = await discoverFiles(targetPath);
        if (files.length === 0) {
          console.log(`No transcript files found at ${path.resolve(targetPath)}.`);
          return;
        }

        console.log(`Ingesting ${files.length} ${pluralize(files.length, "file")}...`);

        const totals = {
          stored: 0,
          deduped: 0,
          rejected: 0,
          skippedFiles: 0,
          failedFiles: 0,
          warnings: 0,
        };

        for (const file of files) {
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
          } else if (result.error) {
            totals.failedFiles += 1;
          } else if (result.storeResult) {
            totals.stored += result.storeResult.stored;
            totals.deduped += result.storeResult.skipped;
            totals.rejected += result.storeResult.rejected;
          }

          printFileResult(result, options);
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

        const dryRunSuffix = options.dryRun ? " Dry run only." : "";
        console.log(`\nDone: ${summaryParts.join(", ")}. (${formatDurationMs(Date.now() - startedAt)})${dryRunSuffix}`);
      } catch (error) {
        process.exitCode = 1;
        console.error(`Error: ${formatError(error)}`);
      } finally {
        await db?.close();
      }
    });
}

function printFileResult(result: IngestFileResult, options: IngestCommandOptions): void {
  const fileLabel = options.verbose ? result.file : path.basename(result.file);

  if (result.skipped) {
    console.log(`  ${fileLabel}: skipped (unchanged)`);
    return;
  }

  if (result.error) {
    console.log(`  ${fileLabel}: failed (${result.error})`);
    return;
  }

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
  if (options.dryRun) {
    details.push("dry run");
  }
  if (options.verbose) {
    details.push(formatDurationMs(result.durationMs));
  }

  console.log(`  ${fileLabel}: ${details.join(" -> ")}`);

  if (options.verbose) {
    for (const warning of result.warnings) {
      console.log(`    warning: ${warning}`);
    }
  }
}

function createNoopEmbeddingPort(): EmbeddingPort {
  return {
    embed: async (texts: string[]): Promise<number[][]> => texts.map(() => []),
  };
}

function formatDurationMs(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pluralize(value: number, singular: string): string {
  return value === 1 ? singular : `${singular}s`;
}
