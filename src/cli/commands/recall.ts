import * as clack from "@clack/prompts";
import { InvalidArgumentError, Option, type Command } from "commander";

import { createDatabase } from "../../adapters/db/client.js";
import { createRecallAdapter } from "../../adapters/db/recall-adapter.js";
import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { readConfig, resolveDbPath } from "../../config.js";
import { recall, type RecallInput, type RecallOutput } from "../../core/recall/index.js";
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
        const config = readConfig();
        const dbPath = resolveDbPath(config);
        const embeddingClient = createEmbeddingClient(resolveEmbeddingApiKey(config), resolveEmbeddingModel(config));
        db = await createDatabase(dbPath);
        const adapter = createRecallAdapter(db, embeddingClient);

        const spinner = clack.spinner();
        spinner.start("Searching knowledge...");
        const results = await recall(buildRecallInput(query, options), adapter);
        spinner.stop(`Found ${results.length} ${pluralize(results.length, "result")}.`);

        if (results.length === 0) {
          clack.outro("No matching entries found.");
          return;
        }

        for (const result of results) {
          clack.log.step(formatResult(result, options.verbose === true));
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
 * Builds the core recall input shape from parsed CLI options.
 *
 * @param query - Raw recall query text.
 * @param options - Parsed commander options.
 * @returns Core recall input payload.
 */
function buildRecallInput(query: string, options: RecallCommandOptions): RecallInput {
  return {
    text: query,
    limit: options.limit,
    threshold: options.threshold,
    budget: options.budget,
    types: options.types,
    tags: options.tags,
    since: normalizeOptionalString(options.since),
    until: normalizeOptionalString(options.until),
    around: normalizeOptionalString(options.around),
    aroundRadius: options.aroundRadius,
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
  const contentLength = verbose ? 200 : 120;
  const lines = [
    `${ui.bold(`[${result.score.toFixed(2)}]`)} ${result.entry.subject}`,
    `  ${truncateText(result.entry.content, contentLength)}`,
    `  type=${result.entry.type}  importance=${result.entry.importance}  expiry=${result.entry.expiry}  created=${formatDate(result.entry.created_at)}`,
  ];

  if (verbose) {
    lines.push(
      `  vector=${result.scores.vector.toFixed(2)}  lexical=${result.scores.lexical.toFixed(2)}  recency=${result.scores.recency.toFixed(2)}  importance=${result.scores.importance.toFixed(2)}  relevance=${result.scores.relevance.toFixed(2)}`,
    );
  }

  return lines.join("\n");
}

/**
 * Parses a comma-separated CLI list into trimmed non-empty values.
 *
 * @param value - Raw commander option text.
 * @returns Normalized list of string values.
 */
function parseCsvList(value: string): string[] {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (items.length === 0) {
    throw new InvalidArgumentError("Expected at least one comma-separated value.");
  }

  return Array.from(new Set(items));
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

/**
 * Parses a positive integer CLI option.
 *
 * @param value - Raw commander option text.
 * @returns Parsed integer value.
 */
function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive integer.");
  }

  return parsed;
}

/**
 * Parses a positive numeric CLI option.
 *
 * @param value - Raw commander option text.
 * @returns Parsed numeric value.
 */
function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive number.");
  }

  return parsed;
}

/**
 * Parses a unit-interval CLI option.
 *
 * @param value - Raw commander option text.
 * @returns Parsed number in the inclusive 0-1 range.
 */
function parseUnitInterval(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError("Value must be between 0 and 1.");
  }

  return parsed;
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

/** Normalizes optional CLI string inputs into trimmed values. */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
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
