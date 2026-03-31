import fs from "node:fs/promises";
import path from "node:path";

import * as clack from "@clack/prompts";
import { InvalidArgumentError, Option, type Command } from "commander";

import { createDatabase } from "../../adapters/db/client.js";
import { EMBEDDING_MODEL, createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { createLlmClient, resolveLlmApiKey, resolveModel } from "../../adapters/llm.js";
import { loadOpenClawSessionRegistry } from "../../adapters/openclaw/session/session-registry.js";
import { openClawTranscriptFiles } from "../../adapters/openclaw/session/transcript-files.js";
import { openClawTranscriptParser } from "../../adapters/openclaw/transcript/parser.js";
import { backfillEpisodeEmbeddings, createEpisodeIngestPlan, executeEpisodeIngestPlan, prepareEpisodeIngest } from "../../app/episode-ingest/index.js";
import { readConfig, resolveDbPath } from "../../config.js";
import { setVerbose } from "../../logger.js";
import { banner, formatLabel, ui } from "../../ui.js";
import type { SqlDatabase } from "../../adapters/db/client.js";
import type { EpisodeIngestLlmPort, EpisodeIngestModelInfo, EpisodeIngestPorts, EpisodeIngestSessionResult } from "../../app/episode-ingest/index.js";
import type { AgenrConfig } from "../../config.js";

const CLI_EPISODE_GENERATOR_VERSION = "cli-episodic-summary-v1";
const DEFAULT_EPISODE_INGEST_CONCURRENCY = 10;
const MIN_EPISODE_INGEST_CONCURRENCY = 1;
const MAX_EPISODE_INGEST_CONCURRENCY = 20;
const RELEVANCE_SAMPLE_SIZE = 5;
const EMBEDDING_SMALL_COST_PER_MILLION_TOKENS_USD = 0.02;

/** CLI flags accepted by the `agenr ingest episodes` command. */
interface IngestEpisodesCommandOptions {
  verbose?: boolean;
  dryRun?: boolean;
  regenerate?: boolean;
  embedOnly?: boolean;
  noEmbed?: boolean;
  recent?: string;
  concurrency?: number;
  db?: string;
  model?: string;
}

/**
 * Registers the `agenr ingest episodes` CLI command.
 *
 * @param parent - Parent Commander command that owns the `ingest` namespace.
 */
export function registerIngestEpisodesCommand(parent: Command): void {
  parent
    .command("episodes [path]")
    .description("Generate and ingest episodic summaries for OpenClaw session transcripts")
    .option("--db <path>", "Database path override (default: agenr config)")
    .option("--recent <duration>", "Only process sessions ending within this period (for example 30d or 90d)")
    .option("--regenerate", "Re-generate summaries for sessions that already have episodes")
    .option("--embed-only", "Backfill embeddings for episodes that are missing them")
    .option("--no-embed", "Skip embedding generated episode summaries")
    .option("--dry-run", "Discover, filter, and estimate without generating or writing")
    .option("--verbose", "Show detailed per-session progress")
    .addOption(
      new Option("--concurrency <n>", "Max parallel summary generations").argParser(parseEpisodeIngestConcurrency).default(DEFAULT_EPISODE_INGEST_CONCURRENCY),
    )
    .option("--model <ref>", "Override summary generation model (provider/model or model)")
    .action(async (targetPath: string | undefined, options: IngestEpisodesCommandOptions) => {
      const startedAt = Date.now();
      let db: SqlDatabase | null = null;

      setVerbose(options.verbose === true);
      clack.intro(banner());

      try {
        const now = new Date();
        const config = readConfig();
        const dbPath = resolveEpisodeDbPath(config, options.db);
        validateEpisodeIngestOptions(options, targetPath);

        db = await createDatabase(dbPath);

        if (options.embedOnly === true) {
          await runEpisodeEmbeddingBackfill({
            db,
            config,
            dbPath,
            options,
            startedAt,
          });
          return;
        }

        const normalizedTargetPath = targetPath?.trim();
        if (!normalizedTargetPath) {
          throw new InvalidArgumentError("Path is required unless --embed-only is set.");
        }

        const { provider, modelId } = resolveEpisodeModel(config, options.model);
        const modelInfo = createEpisodeIngestSummaryModelInfo(provider, modelId);
        const resolvedTargetPath = path.resolve(normalizedTargetPath);
        const sessionsDir = await resolveSessionsDirectory(resolvedTargetPath);
        const ports = await createEpisodeIngestPorts(db, sessionsDir);
        const embeddingSetup = resolveEpisodeEmbeddingSetup(config, options);

        if (options.verbose === true) {
          clack.log.step(`Preparing episode ingest for ${resolvedTargetPath}...`);
        }

        const preflightSpinner = options.verbose === true ? null : clack.spinner();
        preflightSpinner?.start("Parsing transcripts...");

        let preflight;
        try {
          preflight = await prepareEpisodeIngest(resolvedTargetPath, ports, {
            regenerate: options.regenerate,
            now,
            preflightConcurrency: options.concurrency ?? DEFAULT_EPISODE_INGEST_CONCURRENCY,
            onPreflightProgress: preflightSpinner
              ? (completed, total) => {
                  preflightSpinner.message(`Parsing transcripts... (${completed}/${total})`);
                }
              : undefined,
          });
        } catch (error) {
          preflightSpinner?.stop("Preflight failed.");
          throw error;
        }

        preflightSpinner?.stop(`Preflight complete: ${preflight.totals.discovered} files parsed.`);

        if (preflight.files.length === 0) {
          clack.log.warn(`No OpenClaw transcript files found at ${resolvedTargetPath}.`);
          clack.outro("Nothing to ingest.");
          return;
        }

        const shouldContinue = await handleRelevanceWarning(db, preflight.files, resolvedTargetPath, options.dryRun === true);
        if (!shouldContinue) {
          clack.outro("Cancelled.");
          return;
        }

        const plan = createEpisodeIngestPlan(preflight, modelInfo, {
          recent: options.recent,
          now,
        });

        printEpisodeIngestSummary({
          dbPath,
          embeddingStatus: embeddingSetup.statusLabel,
          modelRef: modelInfo.modelRef,
          targetPath: resolvedTargetPath,
          preflight,
          plan,
          options,
        });

        if (options.dryRun === true) {
          clack.outro(
            `Dry run complete: ${plan.candidates.length} ${pluralize(plan.candidates.length, "candidate")} ready (${formatPreflightTail(preflight)}).`,
          );
          return;
        }

        if (plan.candidates.length === 0) {
          clack.outro(`Nothing to do: ${formatPreflightTail(preflight)}.`);
          return;
        }

        const llmApiKey = resolveLlmApiKey(config, provider);
        const executionPorts: EpisodeIngestPorts = {
          ...ports,
          embedding: embeddingSetup.port,
          createSummaryLlm: () => createEpisodeIngestSummaryLlm(provider, modelId, llmApiKey),
        };

        const spinner = options.verbose === true ? null : clack.spinner();
        spinner?.start(`Generating episodes... (0/${plan.candidates.length})`);

        const execution = await executeEpisodeIngestPlan(plan, executionPorts, {
          concurrency: options.concurrency ?? DEFAULT_EPISODE_INGEST_CONCURRENCY,
          genVersion: CLI_EPISODE_GENERATOR_VERSION,
          onProgress: (completed, total, session) => {
            if (spinner) {
              spinner.message(`Generating episodes... (${completed}/${total})`);
            } else {
              reportEpisodeProgress(completed, total, session);
            }
          },
        });

        spinner?.stop("Episode ingest complete.");

        if (options.verbose !== true) {
          for (const session of execution.sessions.filter((result) => result.action === "failed")) {
            clack.log.error(formatEpisodeProgressLine(undefined, undefined, session));
          }
        }

        if (execution.usage.calls > 0) {
          clack.log.info(
            [
              formatLabel(
                "Tokens",
                `${execution.usage.inputTokens.toLocaleString()} in / ${execution.usage.outputTokens.toLocaleString()} out / ${execution.usage.totalTokens.toLocaleString()} total`,
              ),
              formatLabel("Cost", formatCost(execution.usage.totalCost)),
              formatLabel("LLM calls", `${execution.usage.calls}`),
            ].join("\n"),
          );
        }

        clack.outro(
          [
            `Done: ${formatExecutionTail(execution.sessions)}.`,
            `Preflight: ${formatPreflightTail(preflight)}.`,
            `(${formatCost(execution.usage.totalCost)}, ${formatDurationMs(Date.now() - startedAt)})`,
          ].join(" "),
        );
      } catch (error) {
        process.exitCode = 1;
        clack.log.error(formatUnknownError(error));
        clack.outro(ui.error("Episode ingest failed"));
      } finally {
        await db?.close();
      }
    });
}

/** Creates the adapter bundle used by the episode-ingest services. */
async function createEpisodeIngestPorts(db: SqlDatabase, sessionsDir: string): Promise<EpisodeIngestPorts> {
  const sessionRegistry = await loadOpenClawSessionRegistry(sessionsDir);

  return {
    files: openClawTranscriptFiles,
    transcript: openClawTranscriptParser,
    episodes: db,
    sessionRegistry,
  };
}

/** Validates mutually exclusive CLI flags and required arguments. */
function validateEpisodeIngestOptions(options: IngestEpisodesCommandOptions, targetPath: string | undefined): void {
  if (options.embedOnly === true && options.noEmbed === true) {
    throw new InvalidArgumentError("--embed-only cannot be combined with --no-embed.");
  }

  if (options.embedOnly !== true && !targetPath?.trim()) {
    throw new InvalidArgumentError("Path is required unless --embed-only is set.");
  }
}

/** Runs the embedding-only backfill flow for episodes missing vectors. */
async function runEpisodeEmbeddingBackfill(params: {
  db: SqlDatabase;
  config: AgenrConfig | undefined;
  dbPath: string;
  options: IngestEpisodesCommandOptions;
  startedAt: number;
}): Promise<void> {
  const embeddingModel = resolveEmbeddingModel(params.config);
  const embeddingPort = createEmbeddingClient(resolveEmbeddingApiKey(params.config), embeddingModel);
  const ports: EpisodeIngestPorts = {
    files: openClawTranscriptFiles,
    transcript: openClawTranscriptParser,
    episodes: params.db,
    embedding: embeddingPort,
  };
  const missingEpisodes = await params.db.listEpisodesWithoutEmbeddings();

  printEpisodeEmbeddingBackfillSummary({
    dbPath: params.dbPath,
    model: embeddingModel,
    missing: missingEpisodes.length,
    concurrency: params.options.concurrency ?? DEFAULT_EPISODE_INGEST_CONCURRENCY,
    dryRun: params.options.dryRun === true,
  });

  if (missingEpisodes.length === 0) {
    clack.outro("Nothing to do: no active episodes are missing embeddings.");
    return;
  }

  if (params.options.dryRun === true) {
    clack.outro(`Dry run complete: ${missingEpisodes.length} ${pluralize(missingEpisodes.length, "episode")} need embeddings.`);
    return;
  }

  const spinner = params.options.verbose === true ? null : clack.spinner();
  spinner?.start(`Embedding episodes... (0/${missingEpisodes.length})`);

  const result = await backfillEpisodeEmbeddings(ports, {
    concurrency: params.options.concurrency ?? DEFAULT_EPISODE_INGEST_CONCURRENCY,
    onProgress: (completed, total, episode, status) => {
      if (spinner) {
        spinner.message(`Embedding episodes... (${completed}/${total})`);
      } else {
        clack.log.step(`${completed}/${total} ${episode.sourceId ?? episode.id}: ${status}`);
      }
    },
  });

  spinner?.stop("Episode embedding backfill complete.");

  const estimatedCost = estimateEpisodeEmbeddingCost(result.estimatedInputTokens, embeddingModel);
  const summaryParts = [`Done: ${result.embedded} ${pluralize(result.embedded, "episode")} embedded.`];
  if (result.failed > 0) {
    summaryParts.push(`${result.failed} failed.`);
  }

  clack.outro(`${summaryParts.join(" ")} (${formatCost(estimatedCost)}, ${formatDurationMs(Date.now() - params.startedAt)})`);
}

/** Resolves the optional episode-summary embedding client for normal ingest. */
export function resolveEpisodeEmbeddingSetup(
  config: AgenrConfig | undefined,
  options: IngestEpisodesCommandOptions,
): {
  port?: EpisodeIngestPorts["embedding"];
  statusLabel: string;
} {
  if (options.noEmbed === true) {
    return {
      statusLabel: "skipped (--no-embed)",
    };
  }

  try {
    const model = resolveEmbeddingModel(config);
    return {
      port: createEmbeddingClient(resolveEmbeddingApiKey(config), model),
      statusLabel: `enabled (${model})`,
    };
  } catch (error) {
    return {
      statusLabel: `skipped (${formatUnknownError(error)})`,
    };
  }
}

/** Creates a Stage 2 model-info payload from one provider/model pair. */
function createEpisodeIngestSummaryModelInfo(provider: string, modelId: string): EpisodeIngestModelInfo {
  const client = createEpisodeIngestSummaryLlm(provider, modelId);
  return {
    modelRef: client.metadata.modelRef,
    pricing: client.metadata.pricing,
  };
}

/** Wraps the shared pi-ai client in the Stage 2 metadata shape expected by the app service. */
function createEpisodeIngestSummaryLlm(provider: string, modelId: string, apiKey?: string): EpisodeIngestLlmPort {
  const client = createLlmClient(provider, modelId, apiKey ? { apiKey } : {});
  return {
    complete: client.complete,
    completeJson: client.completeJson,
    metadata: {
      modelRef: `${provider}/${modelId}`,
      pricing: {
        input: client.metadata.model.cost?.input ?? 0,
        output: client.metadata.model.cost?.output ?? 0,
        cacheRead: client.metadata.model.cost?.cacheRead ?? 0,
        cacheWrite: client.metadata.model.cost?.cacheWrite ?? 0,
      },
      usage: client.metadata.usage,
    },
  };
}

/** Resolves the sessions directory used for `sessions.json` registry lookup. */
async function resolveSessionsDirectory(targetPath: string): Promise<string> {
  const stat = await fs.stat(targetPath);
  return stat.isFile() ? path.dirname(targetPath) : targetPath;
}

/** Resolves the effective database path for one episode-ingest run. */
function resolveEpisodeDbPath(config: AgenrConfig | undefined, overridePath: string | undefined): string {
  const normalizedOverride = overridePath?.trim();
  if (!normalizedOverride) {
    return resolveDbPath(config);
  }

  if (normalizedOverride === ":memory:" || normalizedOverride.startsWith("file:")) {
    return normalizedOverride;
  }

  return path.resolve(normalizedOverride);
}

/** Resolves the effective episode summary model, applying an optional CLI override. */
function resolveEpisodeModel(config: AgenrConfig | undefined, overrideRef: string | undefined): { provider: string; modelId: string } {
  const resolved = resolveModel(config, "episode");
  const normalizedOverride = overrideRef?.trim();
  if (!normalizedOverride) {
    return resolved;
  }

  const separatorIndex = normalizedOverride.indexOf("/");
  if (separatorIndex < 0) {
    return {
      provider: resolved.provider,
      modelId: normalizedOverride,
    };
  }

  const provider = normalizedOverride.slice(0, separatorIndex).trim();
  const modelId = normalizedOverride.slice(separatorIndex + 1).trim();
  if (!provider || !modelId) {
    throw new InvalidArgumentError(`Model override must look like "provider/model" or "model". Received: ${overrideRef}.`);
  }

  return {
    provider,
    modelId,
  };
}

/** Checks sampled transcript paths against existing ingest provenance and optionally prompts before continuing. */
async function handleRelevanceWarning(db: SqlDatabase, files: string[], targetPath: string, dryRun: boolean): Promise<boolean> {
  if (files.length === 0) {
    return true;
  }

  const entryCount = await countRows(db, "SELECT COUNT(*) AS count FROM entries");
  if (entryCount === 0) {
    return true;
  }

  const samples = files.slice(0, RELEVANCE_SAMPLE_SIZE);
  const hasMatch = await hasRelevantProvenanceMatch(db, samples);
  if (hasMatch) {
    return true;
  }

  clack.log.warn(
    [
      `None of the sampled session files from ${targetPath} matched existing ingest provenance in the database.`,
      "These sessions may belong to a different agenr instance or user.",
    ].join(" "),
  );

  if (dryRun || process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return true;
  }

  const confirmed = await clack.confirm({
    message: "Continue with episode ingest anyway?",
  });

  return !clack.isCancel(confirmed) && confirmed === true;
}

/** Returns whether sampled transcript paths overlap known entry-ingest provenance. */
async function hasRelevantProvenanceMatch(db: SqlDatabase, sampleFiles: string[]): Promise<boolean> {
  if (sampleFiles.length === 0) {
    return false;
  }

  const exactPlaceholders = sampleFiles.map(() => "?").join(", ");
  const ingestLogMatches = await countRows(db, `SELECT COUNT(*) AS count FROM ingest_log WHERE file_path IN (${exactPlaceholders})`, sampleFiles);
  if (ingestLogMatches > 0) {
    return true;
  }

  const basenames = Array.from(new Set(sampleFiles.map((filePath) => path.basename(filePath))));
  const basenameClauses = basenames.map(() => "(source_file = ? OR source_file LIKE ?)").join(" OR ");
  const basenameArgs = basenames.flatMap((basename) => [basename, `%/${basename}`]);
  const entryMatches = await countRows(db, `SELECT COUNT(*) AS count FROM entries WHERE source_file IS NOT NULL AND (${basenameClauses})`, basenameArgs);

  return entryMatches > 0;
}

/** Executes a count query and normalizes the first-row result into a number. */
async function countRows(db: SqlDatabase, sql: string, args: Array<string | number> = []): Promise<number> {
  const result = await db.execute({
    sql,
    args,
  });
  const row = result.rows[0];
  if (!row) {
    return 0;
  }

  const value = row["count"];
  if (typeof value === "number") {
    return value;
  }

  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

/** Prints the Stage 1 and Stage 2 summary before any LLM execution starts. */
function printEpisodeIngestSummary(params: {
  dbPath: string;
  embeddingStatus: string;
  modelRef: string;
  targetPath: string;
  preflight: Awaited<ReturnType<typeof prepareEpisodeIngest>>;
  plan: ReturnType<typeof createEpisodeIngestPlan>;
  options: IngestEpisodesCommandOptions;
}): void {
  const { dbPath, embeddingStatus, modelRef, targetPath, preflight, plan, options } = params;
  const lines = [
    formatLabel("Target", targetPath),
    formatLabel("Database", dbPath),
    formatLabel("Model", modelRef),
    formatLabel("Embeddings", embeddingStatus),
    formatLabel("Files", `${preflight.totals.discovered} ${pluralize(preflight.totals.discovered, "file")} discovered`),
    formatLabel("Candidates", `${plan.candidates.length} selected from ${preflight.totals.candidates} preflight candidates`),
    formatLabel("Preflight", formatPreflightTail(preflight)),
    formatLabel("Estimated", formatEstimate(plan)),
    formatLabel("Concurrency", `${options.concurrency ?? DEFAULT_EPISODE_INGEST_CONCURRENCY}`),
  ];

  if (options.recent?.trim()) {
    lines.push(formatLabel("Recent", `${options.recent.trim()}${plan.recentCutoff ? ` (cutoff ${plan.recentCutoff})` : ""}`));
  }

  if (options.regenerate === true) {
    lines.push(formatLabel("Regenerate", "enabled"));
  }

  if (options.dryRun === true) {
    lines.push(formatLabel("Mode", "dry run"));
  }

  clack.log.info(lines.join("\n"));
}

/** Prints the embedding-only backfill summary before execution starts. */
function printEpisodeEmbeddingBackfillSummary(params: { dbPath: string; model: string; missing: number; concurrency: number; dryRun: boolean }): void {
  const lines = [
    formatLabel("Database", params.dbPath),
    formatLabel("Embeddings", params.model),
    formatLabel("Episodes", `${params.missing} missing embeddings`),
    formatLabel("Concurrency", `${params.concurrency}`),
  ];

  if (params.dryRun) {
    lines.push(formatLabel("Mode", "dry run"));
  }

  clack.log.info(lines.join("\n"));
}

/** Formats the Stage 2 estimate for compact CLI output. */
function formatEstimate(plan: ReturnType<typeof createEpisodeIngestPlan>): string {
  return [
    `${plan.estimate.inputTokens.toLocaleString()} in`,
    `${plan.estimate.outputTokens.toLocaleString()} out`,
    `${formatCost(plan.estimate.estimatedCostUsd)} at ${plan.model.modelRef}`,
  ].join(" / ");
}

/** Formats the aggregate Stage 1 preflight tail used in summary and outro text. */
function formatPreflightTail(preflight: Awaited<ReturnType<typeof prepareEpisodeIngest>>): string {
  const parts = [`${preflight.totals.skippedExists} existing`];
  if (preflight.totals.skippedShort > 0) {
    parts.push(`${preflight.totals.skippedShort} short`);
  }
  if (preflight.totals.skippedActive > 0) {
    parts.push(`${preflight.totals.skippedActive} active`);
  }
  if (preflight.totals.invalid > 0) {
    parts.push(`${preflight.totals.invalid} invalid`);
  }
  if (preflight.totals.candidates > 0) {
    parts.push(`${preflight.totals.candidates} ready`);
  }
  return parts.join(", ");
}

/** Formats the aggregate execution tail shown after Stage 2 completes. */
function formatExecutionTail(sessions: EpisodeIngestSessionResult[]): string {
  const written = sessions.filter((session) => session.action === "written").length;
  const updated = sessions.filter((session) => session.action === "updated").length;
  const unchanged = sessions.filter((session) => session.action === "unchanged").length;
  const failed = sessions.filter((session) => session.action === "failed").length;

  const parts = [`${written} ${pluralize(written, "written session", "written sessions")}`, `${updated} updated`, `${unchanged} unchanged`];
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }

  return parts.join(", ");
}

/** Emits one verbose progress line for a completed Stage 2 candidate. */
function reportEpisodeProgress(completed: number, total: number, session: EpisodeIngestSessionResult): void {
  clack.log.step(formatEpisodeProgressLine(completed, total, session));
}

/** Formats one Stage 2 per-session progress line. */
function formatEpisodeProgressLine(completed: number | undefined, total: number | undefined, session: EpisodeIngestSessionResult): string {
  const prefix = completed !== undefined && total !== undefined ? `${completed}/${total} ` : "";
  const fileLabel = path.basename(session.filePath);
  const details = session.action === "failed" ? `failed (${session.error ?? "unknown error"})` : session.action;
  const usage = session.usage.totalCost > 0 ? ` ${formatCost(session.usage.totalCost)}` : "";
  return `${prefix}${fileLabel}: ${details}${usage}`;
}

/** Formats a duration in milliseconds as seconds with one decimal place. */
function formatDurationMs(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

/** Formats a USD cost value for CLI output. */
function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/** Estimates embedding cost for known models from coarse token counts. */
function estimateEpisodeEmbeddingCost(inputTokens: number, model: string): number {
  if (model !== EMBEDDING_MODEL) {
    return 0;
  }

  return (inputTokens / 1_000_000) * EMBEDDING_SMALL_COST_PER_MILLION_TOKENS_USD;
}

/** Returns a singular or plural noun based on the provided count. */
function pluralize(value: number, singular: string, plural?: string): string {
  return value === 1 ? singular : (plural ?? `${singular}s`);
}

/** Converts unknown thrown values into displayable error strings. */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parses and validates the episode-ingest concurrency option. */
function parseEpisodeIngestConcurrency(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError("Concurrency must be an integer.");
  }

  if (parsed < MIN_EPISODE_INGEST_CONCURRENCY || parsed > MAX_EPISODE_INGEST_CONCURRENCY) {
    throw new InvalidArgumentError(`Concurrency must be between ${MIN_EPISODE_INGEST_CONCURRENCY} and ${MAX_EPISODE_INGEST_CONCURRENCY}.`);
  }

  return parsed;
}
