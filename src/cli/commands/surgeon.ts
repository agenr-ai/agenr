import { InvalidArgumentError, Option, type Command } from "commander";

import { loadSurgeonActionsRuntime, loadSurgeonHistoryRuntime, loadSurgeonStatusRuntime, runSurgeonRuntime } from "../../app/surgeon/runtime.js";
import { isImplementedSurgeonPass, isSurgeonPassType, type SurgeonPassType } from "../../core/surgeon/domain/pass-types.js";

/** Parsed commander options for `agenr surgeon run`. */
interface SurgeonRunCommandOptions {
  pass?: Extract<SurgeonPassType, "retirement" | "supersession">;
  budget?: number;
  contextLimit?: number;
  skipEvaluatedDays?: number;
  apply?: boolean;
  model?: string;
  provider?: string;
  verbose?: boolean;
  trace?: string;
  json?: boolean;
}

/** Parsed commander options for `agenr surgeon history`. */
interface SurgeonHistoryCommandOptions {
  limit?: number;
}

/**
 * Registers the `agenr surgeon` command group and its subcommands.
 *
 * @param program - Root Commander program to extend.
 */
export function registerSurgeonCommand(program: Command): void {
  const surgeonCommand = program.command("surgeon").description("Run surgeon maintenance passes and inspect surgeon history");

  surgeonCommand
    .command("run")
    .description("Execute a surgeon maintenance pass")
    .addOption(new Option("--pass <type>", "Surgeon pass: retirement (default) or supersession").argParser(parseImplementedSurgeonPass).default("retirement"))
    .addOption(new Option("--budget <usd>", "Cost cap for this run in USD").argParser(parsePositiveNumber))
    .addOption(new Option("--context-limit <tokens>", "Context limit override in tokens").argParser(parsePositiveInteger))
    .addOption(new Option("--skip-evaluated-days <n>", "Skip entries evaluated within the last N days").argParser(parseNonNegativeInteger))
    .option("--apply", "Apply changes instead of running in dry-run mode")
    .option("--model <id>", "Override the surgeon model ID")
    .option("--provider <name>", "Override the surgeon model provider")
    .option("--verbose", "Enable verbose trace logging")
    .option("--trace <path>", "Write surgeon trace events to a file")
    .option("--json", "Emit machine-readable JSON output")
    .action(async (options: SurgeonRunCommandOptions) => {
      const abortController = new AbortController();
      let abortRequested = false;

      const onSigint = () => {
        if (abortRequested) {
          process.exit(1);
        }

        abortRequested = true;
        process.stderr.write("\nSurgeon run aborting... (press Ctrl+C again to force exit)\n");
        abortController.abort();
      };

      process.on("SIGINT", onSigint);

      try {
        const result = await runSurgeonRuntime({
          pass: options.pass ?? "retirement",
          budget: options.budget ?? 0,
          contextLimit: options.contextLimit,
          skipEvaluatedDays: options.skipEvaluatedDays,
          apply: options.apply === true,
          model: options.model,
          provider: options.provider,
          verbose: options.verbose === true,
          tracePath: options.trace,
          json: options.json === true,
          signal: abortController.signal,
          env: process.env,
        });

        process.stdout.write(options.json === true ? `${JSON.stringify(result, null, 2)}\n` : renderRunResult(result, options.apply === true));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Surgeon run failed: ${formatUnknownError(error)}\n`);
      } finally {
        process.off("SIGINT", onSigint);
      }
    });

  surgeonCommand
    .command("status")
    .description("Show corpus health and the latest surgeon run")
    .action(async () => {
      try {
        const result = await loadSurgeonStatusRuntime({
          env: process.env,
        });

        process.stdout.write(renderStatus(result));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Failed to load surgeon status: ${formatUnknownError(error)}\n`);
      }
    });

  surgeonCommand
    .command("history")
    .description("Show recent surgeon runs")
    .addOption(new Option("--limit <n>", "Maximum number of runs to show").argParser(parsePositiveInteger).default(10))
    .action(async (options: SurgeonHistoryCommandOptions) => {
      try {
        const limit = options.limit ?? 10;
        const runs = await loadSurgeonHistoryRuntime({
          limit,
          env: process.env,
        });

        process.stdout.write(renderHistory(runs, limit));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Failed to load surgeon history: ${formatUnknownError(error)}\n`);
      }
    });

  surgeonCommand
    .command("actions <runId>")
    .description("Show actions recorded for a surgeon run")
    .action(async (runId: string) => {
      try {
        const actions = await loadSurgeonActionsRuntime({
          runId,
          env: process.env,
        });

        process.stdout.write(renderActions(runId, actions));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Failed to load surgeon actions: ${formatUnknownError(error)}\n`);
      }
    });
}

/**
 * Validates that the CLI-selected surgeon pass is implemented.
 *
 * @param value - Raw commander option value.
 * @returns Supported implemented surgeon pass.
 */
function parseImplementedSurgeonPass(value: string): Extract<SurgeonPassType, "retirement" | "supersession"> {
  const normalized = value.trim().toLowerCase();
  if (!isSurgeonPassType(normalized)) {
    throw new InvalidArgumentError(`Invalid surgeon pass: ${value}`);
  }

  if (!isImplementedSurgeonPass(normalized)) {
    throw new InvalidArgumentError(`Surgeon pass is not implemented: ${value}`);
  }

  return normalized;
}

/**
 * Formats the final output for `agenr surgeon run`.
 *
 * @param result - Completed surgeon run result.
 * @param apply - Whether the command ran in apply mode.
 * @returns Human-readable multi-line output block.
 */
function renderRunResult(
  result: {
    runId: string;
    passType: string;
    status: string;
    actionsTaken: number;
    entriesRetired: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    summary: string | null;
  },
  apply: boolean,
): string {
  return [
    `Surgeon run ${result.runId}`,
    `Pass: ${result.passType}`,
    `Mode: ${apply ? "apply" : "dry-run"}`,
    `Status: ${result.status}`,
    `Actions: ${result.actionsTaken} total | retired ${result.entriesRetired}`,
    `Usage: input ${result.inputTokens} | output ${result.outputTokens} | cost ${formatUsd(result.estimatedCostUsd)}`,
    `Summary: ${result.summary ?? "n/a"}`,
    "",
  ].join("\n");
}

/**
 * Formats the current corpus health and latest run summary.
 *
 * @param input - Status runtime output.
 * @returns Human-readable status block.
 */
function renderStatus(input: {
  health: {
    total: number;
    retirementCandidateCount: number;
    recentlyEvaluatedCount: number;
  };
  lastRun: {
    passType: string;
    status: string;
    dryRun: boolean;
    estimatedCostUsd: number;
  } | null;
}): string {
  const newCandidates = Math.max(0, input.health.retirementCandidateCount - input.health.recentlyEvaluatedCount);
  const candidateLine =
    input.health.recentlyEvaluatedCount > 0
      ? `Retirement candidates: ${input.health.retirementCandidateCount} total (${newCandidates} new, ${input.health.recentlyEvaluatedCount} recently evaluated)`
      : `Retirement candidates: ${input.health.retirementCandidateCount}`;

  return [
    "Surgeon Status",
    "",
    `Entries: ${input.health.total}`,
    candidateLine,
    `Last surgeon run: ${input.lastRun ? `${input.lastRun.passType} ${input.lastRun.status} (${input.lastRun.dryRun ? "dry-run" : "apply"})` : "none"}`,
    `Last surgeon cost: ${input.lastRun ? formatUsd(input.lastRun.estimatedCostUsd) : "n/a"}`,
    "",
  ].join("\n");
}

/**
 * Formats recent surgeon runs for the history command.
 *
 * @param runs - Persisted surgeon runs.
 * @param limit - Requested history limit.
 * @returns Human-readable history block.
 */
function renderHistory(
  runs: Array<{
    startedAt: string;
    passType: string;
    status: string;
    dryRun: boolean;
    actionsTaken: number;
    estimatedCostUsd: number;
  }>,
  limit: number,
): string {
  if (runs.length === 0) {
    return `Surgeon History (last ${limit} runs)\n\nNo surgeon runs recorded.\n`;
  }

  const lines = [`Surgeon History (last ${limit} runs)`, ""];
  for (const run of runs) {
    lines.push(
      `${run.startedAt}  ${run.passType}  ${run.status}  ${run.dryRun ? "dry-run" : "apply"}  actions=${run.actionsTaken}  cost=${formatUsd(run.estimatedCostUsd)}`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Formats one run's action audit trail.
 *
 * @param runId - Persisted surgeon run ID.
 * @param actions - Action rows loaded for the run.
 * @returns Human-readable actions block.
 */
function renderActions(
  runId: string,
  actions: Array<{
    createdAt: string;
    actionType: string;
    entryIds: string[];
    reasoning: string;
  }>,
): string {
  if (actions.length === 0) {
    return `Surgeon Actions ${runId}\n\nNo surgeon actions recorded for this run.\n`;
  }

  const lines = [`Surgeon Actions ${runId}`, ""];
  for (const action of actions) {
    lines.push(`${action.createdAt}  ${action.actionType}  entries=${action.entryIds.join(", ") || "(none)"}`);
    lines.push(`  ${action.reasoning}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Formats USD values with four fractional digits.
 *
 * @param value - Numeric USD amount.
 * @returns Currency string.
 */
function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/**
 * Parses a strictly positive integer commander option.
 *
 * @param value - Raw commander option text.
 * @returns Parsed integer.
 */
function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive integer.");
  }

  return parsed;
}

/**
 * Parses a non-negative integer commander option.
 *
 * @param value - Raw commander option text.
 * @returns Parsed integer.
 */
function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Value must be a non-negative integer.");
  }

  return parsed;
}

/**
 * Parses a strictly positive numeric commander option.
 *
 * @param value - Raw commander option text.
 * @returns Parsed number.
 */
function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive number.");
  }

  return parsed;
}

/**
 * Converts an unknown thrown value into a readable error string.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable error message.
 */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
