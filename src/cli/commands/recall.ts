import * as clack from "@clack/prompts";
import { InvalidArgumentError, Option, type Command } from "commander";

import { createDatabase } from "../../adapters/db/client.js";
import { createRecallAdapter } from "../../adapters/db/recall-adapter.js";
import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { projectClaimCentricRecallEntry } from "../../app/recall/index.js";
import { normalizeOptionalString, normalizeStringList, parseCsvList, parsePositiveInteger, parsePositiveNumber, parseUnitInterval } from "../shared/parse.js";
import { readConfig } from "../../config.js";
import { recall, type RecallInput, type RecallOutput } from "../../core/recall/index.js";
import type { RecallExecutionTraceSummary } from "../../core/recall/trace.js";
import { ENTRY_TYPES, type EntryType } from "../../core/types.js";
import { banner, ui } from "../../ui.js";

/** Commander options accepted by the `agenr recall` command. */
interface RecallCommandOptions {
  limit?: number;
  threshold?: number;
  budget?: number;
  types?: EntryType[];
  tags?: string[];
  since?: string;
  until?: string;
  around?: string;
  aroundRadius?: number;
  verbose?: boolean;
}

/** Normalized recall request assembled at the CLI boundary. */
interface NormalizedRecallCommand {
  request: RecallInput;
  verbose: boolean;
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
    .addOption(new Option("--types <types>", "Comma-separated entry types").argParser(parseEntryTypes))
    .addOption(new Option("--tags <tags>", "Comma-separated tags").argParser(parseCsvList))
    .option("--since <date>", "Only entries after this date (ISO or relative like 7d)")
    .option("--until <date>", "Only entries before this date")
    .option("--around <date>", "Bias results toward this date")
    .addOption(new Option("--around-radius <n>", "Gaussian radius in days").argParser(parsePositiveNumber).default(14))
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
        const adapter = createRecallAdapter(db, embeddingClient);
        let lastTraceSummary: RecallExecutionTraceSummary | undefined;

        const spinner = clack.spinner();
        spinner.start("Searching knowledge...");
        const results = await recall(commandInput.request, adapter, {
          trace: {
            reportSummary(summary): void {
              lastTraceSummary = summary;
            },
          },
        });
        spinner.stop(`Found ${results.length} ${pluralize(results.length, "result")}.`);
        if (lastTraceSummary?.degraded.active) {
          for (const notice of lastTraceSummary.degraded.notices) {
            clack.log.warn(notice);
          }
        }

        if (results.length === 0) {
          clack.outro("No matching entries found.");
          return;
        }

        for (const result of results) {
          clack.log.step(formatResult(result, commandInput.verbose));
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
    },
    verbose: options.verbose === true,
  };
}

/**
 * Formats one recall result for human-readable CLI output.
 *
 * @param result - Ranked recall result.
 * @param verbose - Whether to include detailed score breakdowns.
 * @returns Multi-line formatted CLI block.
 */
function formatResult(result: RecallOutput, verbose: boolean): string {
  const projected = projectClaimCentricRecallEntry(result);
  const contentLength = verbose ? 200 : 120;
  const lines = [
    `${ui.bold(`[${result.score.toFixed(2)}]`)} ${result.entry.subject}`,
    `  ${truncateText(result.entry.content, contentLength)}`,
    `  type=${result.entry.type}  importance=${result.entry.importance}  expiry=${result.entry.expiry}  created=${formatDate(result.entry.created_at)}  state=${projected.memoryState}  claim_status=${formatClaimStatus(projected.claimStatus)}`,
    `  family=${projected.claimKey ?? projected.familyKey}  freshness=${projected.freshness.label}`,
  ];

  const provenance = formatProvenance(projected);
  if (provenance) {
    lines.push(`  provenance=${provenance}`);
  }
  lines.push(`  why=${projected.whySurfaced.summary}`);

  if (verbose) {
    lines.push(
      `  vector=${result.scores.vector.toFixed(2)}  lexical=${result.scores.lexical.toFixed(2)}  recency=${result.scores.recency.toFixed(2)}  importance=${result.scores.importance.toFixed(2)}  relevance=${result.scores.relevance.toFixed(2)}  historicalLineage=${result.scores.historicalLineage.toFixed(2)}  claimKeyTrustPenalty=${result.scores.claimKeyTrustPenalty.toFixed(2)}  claimKeyRedundancyPenalty=${result.scores.claimKeyRedundancyPenalty.toFixed(2)}`,
    );
  }

  return lines.join("\n");
}

/**
 * Parses and validates a comma-separated entry-type list.
 *
 * @param value - Raw commander option text.
 * @returns Normalized list of supported entry types.
 */
function parseEntryTypes(value: string): EntryType[] {
  const parsed = parseCsvList(value);
  const invalid = parsed.filter((item) => !ENTRY_TYPES.includes(item as (typeof ENTRY_TYPES)[number]));
  if (invalid.length > 0) {
    throw new InvalidArgumentError(`Unsupported entry type(s): ${invalid.join(", ")}.`);
  }

  return parsed as EntryType[];
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
function formatClaimStatus(status: ReturnType<typeof projectClaimCentricRecallEntry>["claimStatus"]): string {
  return status === "no_key" ? "no-key" : status;
}

/** Formats compact provenance metadata for one projected recall row. */
function formatProvenance(projected: ReturnType<typeof projectClaimCentricRecallEntry>): string {
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
