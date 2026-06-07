import * as clack from "@clack/prompts";
import { InvalidArgumentError, Option, type Command } from "commander";

import { createOpenAICrossEncoder, resolveCrossEncoderApiKey } from "../../adapters/cross-encoder/openai-cross-encoder.js";
import { createDatabase } from "../../adapters/db/client.js";
import { createRecallAdapter } from "../../adapters/db/recall-adapter.js";
import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { resolveModel } from "../../adapters/llm.js";
import { attachCrossEncoderPort } from "../../adapters/plugin-runtime/attach-cross-encoder.js";
import { projectClaimCentricRecallDurable } from "../../app/recall/index.js";
import { normalizeOptionalString, normalizeStringList, parseCsvList, parsePositiveInteger, parsePositiveNumber, parseUnitInterval } from "../shared/parse.js";
import { readConfig } from "../../config.js";
import type { CrossEncoderPort } from "../../core/ports.js";
import { recall, type RecallInput, type RecallOutput } from "../../core/recall/index.js";
import type { RecallExecutionOptions, RecallExecutionTraceSummary, RecallRankingPolicy } from "../../core/recall/trace.js";
import { DURABLE_KINDS, type DurableKind } from "../../core/types.js";
import { banner, ui } from "../../ui.js";

/** Commander options accepted by the `agenr recall` command. */
interface RecallCommandOptions {
  limit?: number;
  threshold?: number;
  budget?: number;
  types?: DurableKind[];
  tags?: string[];
  since?: string;
  until?: string;
  around?: string;
  aroundRadius?: number;
  asOf?: string;
  verbose?: boolean;
  crossEncoder?: "enabled" | "disabled";
  crossEncoderTopK?: number;
  crossEncoderAlpha?: number;
}

/** Normalized recall request assembled at the CLI boundary. */
interface NormalizedRecallCommand {
  request: RecallInput;
  verbose: boolean;
  rankingPolicy?: RecallRankingPolicy;
}

/**
 * Registers the `agenr recall` CLI command.
 *
 * @param program - Root Commander program to extend.
 */
export function registerRecallCommand(program: Command): void {
  program
    .command("recall <query>")
    .description("Search the knowledge database with the v1 hybrid recall pipeline")
    .addOption(new Option("--limit <n>", "Max results").argParser(parsePositiveInteger).default(10))
    .addOption(new Option("--threshold <n>", "Minimum score cutoff").argParser(parseUnitInterval).default(0))
    .addOption(new Option("--budget <n>", "Max token budget").argParser(parsePositiveInteger))
    .addOption(new Option("--types <types>", "Comma-separated durable types").argParser(parseDurableKinds))
    .addOption(new Option("--tags <tags>", "Comma-separated tags").argParser(parseCsvList))
    .option("--since <date>", "Only durables after this date (ISO or relative like 7d)")
    .option("--until <date>", "Only durables before this date")
    .option("--around <date>", "Bias results toward this date")
    .option("--as-of <date>", "Resolve current vs prior state at this reference time")
    .addOption(new Option("--around-radius <n>", "Gaussian radius in days").argParser(parsePositiveNumber).default(14))
    .addOption(new Option("--cross-encoder <state>", "Enable or disable the cross-encoder rerank stage").choices(["enabled", "disabled"]))
    .addOption(new Option("--cross-encoder-top-k <n>", "Top-K shortlist size for cross-encoder rerank").argParser(parsePositiveInteger))
    .addOption(new Option("--cross-encoder-alpha <n>", "Blend weight for cross-encoder vs prior score (0-1)").argParser(parseUnitInterval))
    .option("--verbose", "Show score breakdowns")
    .action(async (query: string, options: RecallCommandOptions) => {
      clack.intro(banner());

      let db: Awaited<ReturnType<typeof createDatabase>> | null = null;

      try {
        const commandInput = normalizeRecallCommand(query, options);
        const config = readConfig();
        const dbPath = config.dbPath;
        const embeddingClient = createEmbeddingClient(resolveEmbeddingApiKey(config), resolveEmbeddingModel(config));
        db = await createDatabase(dbPath);
        const recallPorts = createRecallAdapter(db, embeddingClient);
        const crossEncoder = commandInput.rankingPolicy?.crossEncoder === "disabled" ? undefined : tryCreateCrossEncoder(config);
        const adapter = attachCrossEncoderPort(recallPorts, crossEncoder);
        let lastTraceSummary: RecallExecutionTraceSummary | undefined;

        const spinner = clack.spinner();
        spinner.start("Searching knowledge...");
        const recallOptions: RecallExecutionOptions = {
          trace: {
            reportSummary(summary): void {
              lastTraceSummary = summary;
            },
          },
          ...(commandInput.rankingPolicy ? { rankingPolicy: commandInput.rankingPolicy } : {}),
        };
        const results = await recall(commandInput.request, adapter, recallOptions);
        spinner.stop(`Found ${results.length} ${pluralize(results.length, "result")}.`);
        if (lastTraceSummary?.degraded.active) {
          for (const notice of lastTraceSummary.degraded.notices) {
            clack.log.warn(notice);
          }
        }
        if (commandInput.verbose && lastTraceSummary) {
          const crossEncoder = lastTraceSummary.crossEncoder;
          if (crossEncoder.applied) {
            clack.log.info(
              `Cross-encoder reranked top-${crossEncoder.k} (alpha=${crossEncoder.alpha.toFixed(2)}, latencyMs=${crossEncoder.latencyMs}, rescored=${crossEncoder.rescoredIds.length}).`,
            );
          } else if (crossEncoder.degradedReason) {
            clack.log.info(`Cross-encoder skipped (${crossEncoder.degradedReason}).`);
          }
        }

        if (results.length === 0) {
          clack.outro("No matching durables found.");
          return;
        }

        for (const result of results) {
          clack.log.step(formatResult(result, commandInput.verbose, commandInput.request.asOf));
        }

        clack.outro(`Recall complete: ${results.length} ${pluralize(results.length, "result")}.`);
      } catch (error) {
        process.exitCode = 1;
        clack.log.error(formatUnknownError(error));
        clack.outro(ui.error("Recall failed"));
      } finally {
        await db?.close();
      }
    });
}

/**
 * Builds one normalized recall command object from parsed CLI values.
 *
 * @param query - Raw recall query text.
 * @param options - Parsed commander options.
 * @returns Normalized CLI command payload.
 */
function normalizeRecallCommand(query: string, options: RecallCommandOptions): NormalizedRecallCommand {
  const normalizedQuery = normalizeOptionalString(query);
  if (!normalizedQuery) {
    throw new InvalidArgumentError("Query cannot be empty.");
  }

  const rankingPolicy = buildRankingPolicy(options);

  return {
    request: {
      text: normalizedQuery,
      limit: options.limit,
      threshold: options.threshold,
      budget: options.budget,
      types: options.types,
      tags: normalizeStringList(options.tags),
      since: normalizeOptionalString(options.since),
      until: normalizeOptionalString(options.until),
      around: normalizeOptionalString(options.around),
      aroundRadius: options.aroundRadius,
      asOf: normalizeOptionalString(options.asOf),
    },
    verbose: options.verbose === true,
    ...(rankingPolicy ? { rankingPolicy } : {}),
  };
}

/**
 * Builds the ranking policy from CLI-supplied cross-encoder options.
 *
 * @param options - Parsed commander options.
 * @returns Ranking policy when any cross-encoder flag was provided.
 */
function buildRankingPolicy(options: RecallCommandOptions): RecallRankingPolicy | undefined {
  const policy: RecallRankingPolicy = {};
  if (options.crossEncoder !== undefined) {
    policy.crossEncoder = options.crossEncoder;
  }

  if (typeof options.crossEncoderTopK === "number") {
    policy.crossEncoderTopK = options.crossEncoderTopK;
  }

  if (typeof options.crossEncoderAlpha === "number") {
    policy.crossEncoderAlpha = options.crossEncoderAlpha;
  }

  return Object.keys(policy).length > 0 ? policy : undefined;
}

/**
 * Best-effort construction of an OpenAI cross-encoder adapter.
 *
 * The CLI wires the cross-encoder silently when an OpenAI credential is
 * available. Credential resolution failures are swallowed so that missing
 * keys simply leave the rerank disabled rather than aborting recall.
 *
 * @param config - Resolved agenr configuration loaded by the CLI.
 * @returns Cross-encoder port when credentials are available.
 */
function tryCreateCrossEncoder(config: ReturnType<typeof readConfig>): CrossEncoderPort | undefined {
  try {
    const apiKey = resolveCrossEncoderApiKey(config);
    const { modelId } = resolveModel(config, "cross_encoder");
    return createOpenAICrossEncoder({ apiKey, model: modelId });
  } catch {
    return undefined;
  }
}

/**
 * Formats one recall result for human-readable CLI output.
 *
 * @param result - Ranked recall result.
 * @param verbose - Whether to include detailed score breakdowns.
 * @returns Multi-line formatted CLI block.
 */
function formatResult(result: RecallOutput, verbose: boolean, asOf?: string): string {
  const projected = projectClaimCentricRecallDurable(result, {
    asOf,
  });
  const contentLength = verbose ? 200 : 120;
  const lines = [
    `${ui.bold(`[${result.score.toFixed(2)}]`)} ${result.durable.subject}`,
    `  ${truncateText(result.durable.content, contentLength)}`,
    `  type=${result.durable.type}  importance=${result.durable.importance}  expiry=${result.durable.expiry}  created=${formatDate(result.durable.created_at)}  state=${projected.memoryState}  claim_status=${formatClaimStatus(projected.claimStatus)}`,
    `  family=${projected.claimKey ?? projected.familyKey}  slot_policy=${projected.slotPolicy}  freshness=${projected.freshness.label}`,
  ];

  const provenance = formatProvenance(projected);
  if (provenance) {
    lines.push(`  provenance=${provenance}`);
  }
  lines.push(`  why=${projected.whySurfaced.summary}`);

  if (verbose) {
    const crossEncoderFragment = typeof result.scores.crossEncoder === "number" ? `  crossEncoder=${result.scores.crossEncoder.toFixed(2)}` : "";
    lines.push(
      `  vector=${result.scores.vector.toFixed(2)}  lexical=${result.scores.lexical.toFixed(2)}  recency=${result.scores.recency.toFixed(2)}  importance=${result.scores.importance.toFixed(2)}  relevance=${result.scores.relevance.toFixed(2)}  historicalLineage=${result.scores.historicalLineage.toFixed(2)}  claimKeyTrustPenalty=${result.scores.claimKeyTrustPenalty.toFixed(2)}  claimKeyRedundancyPenalty=${result.scores.claimKeyRedundancyPenalty.toFixed(2)}${crossEncoderFragment}`,
    );
  }

  return lines.join("\n");
}

/**
 * Parses and validates a comma-separated entry-type list.
 *
 * @param value - Raw commander option text.
 * @returns Normalized list of supported durable types.
 */
function parseDurableKinds(value: string): DurableKind[] {
  const parsed = parseCsvList(value);
  const invalid = parsed.filter((item) => !DURABLE_KINDS.includes(item as (typeof DURABLE_KINDS)[number]));
  if (invalid.length > 0) {
    throw new InvalidArgumentError(`Unsupported durable type(s): ${invalid.join(", ")}.`);
  }

  return parsed as DurableKind[];
}

/** Formats a timestamp as an ISO date string. */
function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().slice(0, 10);
}

/** Truncates long free-form text for concise CLI display. */
function truncateText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

/** Formats the normalized claim-status label for CLI output. */
function formatClaimStatus(status: ReturnType<typeof projectClaimCentricRecallDurable>["claimStatus"]): string {
  return status === "no_key" ? "no-key" : status;
}

/** Formats compact provenance metadata for one projected recall row. */
function formatProvenance(projected: ReturnType<typeof projectClaimCentricRecallDurable>): string {
  const parts = [
    projected.provenance.supersededById ? `superseded_by=${projected.provenance.supersededById}` : undefined,
    projected.provenance.supersessionKind ? `kind=${projected.provenance.supersessionKind}` : undefined,
    projected.provenance.supersessionReason ? `reason=${truncateText(projected.provenance.supersessionReason, 120)}` : undefined,
    projected.provenance.supportSourceKind ? `support=${projected.provenance.supportSourceKind}` : undefined,
    projected.provenance.supportMode ? `support_mode=${projected.provenance.supportMode}` : undefined,
    projected.provenance.supportObservedAt ? `observed=${projected.provenance.supportObservedAt}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return parts.join("  ");
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

/** Converts an unknown thrown value into a displayable error string. */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
