import path from "node:path";

import * as clack from "@clack/prompts";
import { type Command } from "commander";

import { createDatabase } from "../../adapters/db/client.js";
import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { localProcedureFiles } from "../../adapters/files/procedure-files.js";
import { executeProcedureSync, prepareProcedureSync, type ProcedureSyncExecutionItem, type ProcedureSyncPlanItem } from "../../app/procedures/sync/index.js";
import { readConfig } from "../../config.js";
import { setVerbose } from "../../logger.js";
import { banner, formatLabel, ui } from "../../ui.js";
import { normalizeOptionalString } from "../shared/parse.js";

const DEFAULT_PROCEDURE_SYNC_PATH = "procedures";

/**
 * Parsed commander options for `agenr ingest procedures`.
 */
interface IngestProceduresCommandOptions {
  verbose?: boolean;
  dryRun?: boolean;
}

/**
 * Normalized CLI payload for `agenr ingest procedures`.
 */
interface NormalizedIngestProceduresCommand {
  targetPath: string;
  verbose: boolean;
  dryRun: boolean;
}

/**
 * Registers the `agenr ingest procedures` CLI command.
 *
 * @param parent - Parent Commander command that owns the `ingest` namespace.
 */
export function registerIngestProceduresCommand(parent: Command): void {
  parent
    .command("procedures [path]")
    .description("Sync repo-authored procedure YAML files into the knowledge database")
    .option("--dry-run", "Discover, validate, normalize, and diff without writing")
    .option("--verbose", "Show detailed per-file planning and execution output")
    .action(async (targetPath: string | undefined, options: IngestProceduresCommandOptions) => {
      let database: Awaited<ReturnType<typeof createDatabase>> | null = null;
      const commandInput = normalizeIngestProceduresCommand(targetPath, options);

      setVerbose(commandInput.verbose);
      clack.intro(banner());

      try {
        const config = readConfig();
        const dbPath = config.dbPath;
        const resolvedTargetPath = path.resolve(commandInput.targetPath);
        database = await createDatabase(dbPath);

        if (commandInput.verbose) {
          clack.log.step(`Preparing procedure sync for ${resolvedTargetPath}...`);
        }

        const plan = await prepareProcedureSync(commandInput.targetPath, {
          files: localProcedureFiles,
          db: database,
        });

        if (plan.files.length === 0) {
          clack.log.warn(`No procedure files found at ${resolvedTargetPath}.`);
          clack.outro("Nothing to sync.");
          return;
        }

        printProcedureSyncSummary({
          targetPath: resolvedTargetPath,
          dbPath,
          dryRun: commandInput.dryRun,
          plan,
        });

        if (commandInput.verbose) {
          printVerboseProcedurePlan(plan.items);
        }

        if (commandInput.dryRun) {
          if (plan.totals.invalid > 0) {
            process.exitCode = 1;
          }
          clack.outro(`Dry run complete: ${formatProcedurePlanTail(plan)}.`);
          return;
        }

        if (plan.totals.invalid > 0) {
          throw new Error(`Procedure sync blocked: ${plan.totals.invalid} invalid file(s) must be fixed before writing.`);
        }

        const embedding = createEmbeddingClient(resolveEmbeddingApiKey(config), resolveEmbeddingModel(config));
        const spinner = commandInput.verbose ? null : clack.spinner();
        spinner?.start(`Syncing procedures... (${countPlannedWrites(plan.items)} writes planned)`);

        const execution = await executeProcedureSync(plan, {
          db: database,
          embedding,
        });

        spinner?.stop("Procedure sync complete.");

        if (commandInput.verbose) {
          printVerboseProcedureExecution(execution.items);
        }

        clack.outro(`Done: ${formatProcedureExecutionTail(execution)}.`);
      } catch (error) {
        process.exitCode = 1;
        clack.log.error(formatUnknownError(error));
        clack.outro(ui.error("Procedure sync failed"));
      } finally {
        await database?.close();
      }
    });
}

/**
 * Builds one normalized procedure-sync payload from parsed CLI options.
 *
 * @param targetPath - Raw optional path argument.
 * @param options - Parsed commander options.
 * @returns Normalized CLI command input.
 */
function normalizeIngestProceduresCommand(targetPath: string | undefined, options: IngestProceduresCommandOptions): NormalizedIngestProceduresCommand {
  return {
    targetPath: normalizeOptionalString(targetPath) ?? DEFAULT_PROCEDURE_SYNC_PATH,
    verbose: options.verbose === true,
    dryRun: options.dryRun === true,
  };
}

/**
 * Prints the aggregate sync plan summary before any writes begin.
 *
 * @param params - Summary display inputs.
 */
function printProcedureSyncSummary(params: {
  targetPath: string;
  dbPath: string;
  dryRun: boolean;
  plan: Awaited<ReturnType<typeof prepareProcedureSync>>;
}): void {
  const lines = [
    formatLabel("Target", params.targetPath),
    formatLabel("Database", params.dbPath),
    formatLabel("Files", `${params.plan.totals.discovered} ${pluralize(params.plan.totals.discovered, "file")} discovered`),
    formatLabel(
      "Plan",
      `${params.plan.totals.create} create | ${params.plan.totals.updateSourceOnly} source update | ${params.plan.totals.supersede} supersede | ${params.plan.totals.unchanged} unchanged | ${params.plan.totals.invalid} invalid`,
    ),
  ];

  if (params.dryRun) {
    lines.push(formatLabel("Mode", "dry run"));
  }

  clack.log.info(lines.join("\n"));
}

/**
 * Prints verbose per-file planning details.
 *
 * @param items - Discovery-order plan items.
 */
function printVerboseProcedurePlan(items: ProcedureSyncPlanItem[]): void {
  for (const item of items) {
    switch (item.action) {
      case "invalid":
        clack.log.error(`[invalid] ${item.filePath}: ${item.error}`);
        break;
      case "create":
        clack.log.step(`[create] ${item.candidate.procedure.procedure_key}: ${item.candidate.filePath}`);
        break;
      case "update_source_only":
        clack.log.step(`[update_source_only] ${item.candidate.procedure.procedure_key}: ${item.candidate.filePath} -> reuse ${item.existing.id}`);
        break;
      case "supersede":
        clack.log.step(`[supersede] ${item.candidate.procedure.procedure_key}: ${item.existing.id} -> new revision`);
        break;
      case "unchanged":
        clack.log.step(`[unchanged] ${item.candidate.procedure.procedure_key}: ${item.candidate.filePath}`);
        break;
    }
  }
}

/**
 * Prints verbose per-file execution details.
 *
 * @param items - Per-file execution items.
 */
function printVerboseProcedureExecution(items: ProcedureSyncExecutionItem[]): void {
  for (const item of items) {
    switch (item.action) {
      case "created":
        clack.log.step(`[created] ${item.procedureKey}: ${item.procedureId}`);
        break;
      case "updated_source_only":
        clack.log.step(`[updated_source_only] ${item.procedureKey}: ${item.procedureId}`);
        break;
      case "superseded":
        clack.log.step(`[superseded] ${item.procedureKey}: ${item.previousProcedureId} -> ${item.procedureId}`);
        break;
      case "unchanged":
        clack.log.step(`[unchanged] ${item.procedureKey}: ${item.procedureId}`);
        break;
    }
  }
}

/**
 * Counts the number of plan items that will issue writes.
 *
 * @param items - Discovery-order plan items.
 * @returns Planned write count.
 */
function countPlannedWrites(items: ProcedureSyncPlanItem[]): number {
  return items.filter((item) => item.action === "create" || item.action === "update_source_only" || item.action === "supersede").length;
}

/**
 * Formats the compact dry-run summary tail.
 *
 * @param plan - Procedure sync plan.
 * @returns Human-readable summary tail.
 */
function formatProcedurePlanTail(plan: Awaited<ReturnType<typeof prepareProcedureSync>>): string {
  return [
    `${plan.totals.create} create`,
    `${plan.totals.updateSourceOnly} source update`,
    `${plan.totals.supersede} supersede`,
    `${plan.totals.unchanged} unchanged`,
    `${plan.totals.invalid} invalid`,
  ].join(", ");
}

/**
 * Formats the compact execution summary tail.
 *
 * @param execution - Procedure sync execution result.
 * @returns Human-readable summary tail.
 */
function formatProcedureExecutionTail(execution: Awaited<ReturnType<typeof executeProcedureSync>>): string {
  return [
    `${execution.totals.created} created`,
    `${execution.totals.updatedSourceOnly} source updated`,
    `${execution.totals.superseded} superseded`,
    `${execution.totals.unchanged} unchanged`,
  ].join(", ");
}

/**
 * Returns a singular or plural noun based on the provided count.
 *
 * @param value - Numeric count that determines singular or plural output.
 * @param singular - Singular form of the noun.
 * @param plural - Optional explicit plural form for irregular nouns.
 * @returns Singular or pluralized noun.
 */
function pluralize(value: number, singular: string, plural?: string): string {
  return value === 1 ? singular : (plural ?? `${singular}s`);
}

/**
 * Converts unknown thrown values into readable error messages.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable message.
 */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
