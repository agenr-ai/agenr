import { InvalidArgumentError, Option, type Command } from "commander";

import { loadDreamHistoryRuntime, loadDreamStatusRuntime, runDreamRuntime, type DreamRuntimeOptions } from "../../app/dreaming/runtime.js";
import { DREAM_TIERS, type DreamTier } from "../../core/dreaming/types.js";
import { normalizeOptionalString, parsePositiveInteger } from "../shared/parse.js";

/** Parsed commander options for `agenr dream run`. */
interface DreamRunCommandOptions {
  tier?: DreamTier;
  apply?: boolean;
  project?: string;
  verbose?: boolean;
  json?: boolean;
}

/** Parsed commander options for `agenr dream history`. */
interface DreamHistoryCommandOptions {
  limit?: number;
}

/**
 * Registers the `agenr dream` command group and its subcommands.
 *
 * @param program - Root Commander program to extend.
 */
export function registerDreamingCommand(program: Command): void {
  const dreamCommand = program.command("dream").description("Run background dreaming synthesis and inspect dreaming history");

  dreamCommand
    .command("run")
    .description("Execute a dreaming run (dry-run by default)")
    .addOption(new Option("--tier <tier>", "Run tier: light, standard, or deep").choices([...DREAM_TIERS]).default("standard"))
    .option("--apply", "Apply changes instead of running in dry-run mode")
    .option("--project <id>", "Limit the run to one project scope")
    .option("--verbose", "Enable verbose progress logging")
    .option("--json", "Emit machine-readable JSON output")
    .action(async (options: DreamRunCommandOptions) => {
      const abortController = new AbortController();
      const onSigint = () => abortController.abort();
      process.on("SIGINT", onSigint);

      try {
        const commandInput = normalizeDreamRunCommand(options);
        const result = await runDreamRuntime({
          ...commandInput,
          signal: abortController.signal,
          env: process.env,
        });
        process.stdout.write(commandInput.json ? `${JSON.stringify(result, null, 2)}\n` : renderRunResult(result, commandInput.apply));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Dream run failed: ${formatUnknownError(error)}\n`);
      } finally {
        process.off("SIGINT", onSigint);
      }
    });

  dreamCommand
    .command("status")
    .description("Show dreaming health and the latest run")
    .option("--json", "Emit machine-readable JSON output")
    .action(async (options: { json?: boolean }) => {
      try {
        const status = await loadDreamStatusRuntime({ env: process.env });
        process.stdout.write(options.json ? `${JSON.stringify(status, null, 2)}\n` : renderStatus(status));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Dream status failed: ${formatUnknownError(error)}\n`);
      }
    });

  dreamCommand
    .command("history")
    .description("List recent dreaming runs")
    .addOption(new Option("--limit <n>", "Maximum number of runs to return").argParser(parsePositiveInteger).default(10))
    .option("--json", "Emit machine-readable JSON output")
    .action(async (options: DreamHistoryCommandOptions & { json?: boolean }) => {
      try {
        const history = await loadDreamHistoryRuntime({ env: process.env, limit: options.limit });
        process.stdout.write(options.json ? `${JSON.stringify(history, null, 2)}\n` : renderHistory(history));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Dream history failed: ${formatUnknownError(error)}\n`);
      }
    });
}

function normalizeDreamRunCommand(options: DreamRunCommandOptions): Omit<DreamRuntimeOptions, "dbPath" | "env" | "onProgress" | "logger" | "signal"> {
  const tier = options.tier ?? "standard";
  if (!DREAM_TIERS.includes(tier)) {
    throw new InvalidArgumentError(`Invalid tier "${tier}". Expected one of: ${DREAM_TIERS.join(", ")}.`);
  }

  return {
    tier,
    apply: options.apply === true,
    project: normalizeOptionalString(options.project),
    verbose: options.verbose === true,
    json: options.json === true,
  };
}

function renderRunResult(result: Awaited<ReturnType<typeof runDreamRuntime>>, applied: boolean): string {
  const mode = applied ? "apply" : "dry-run";
  return [
    `Dream run ${result.runId} (${mode})`,
    `  tier: ${result.tier}`,
    `  status: ${result.status}`,
    `  actions taken: ${result.actionsTaken}`,
    `  actions skipped: ${result.actionsSkipped}`,
    `  estimated cost: $${result.estimatedCostUsd.toFixed(4)}`,
    result.summary ? `  summary: ${result.summary}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n")
    .concat("\n");
}

function renderStatus(status: Awaited<ReturnType<typeof loadDreamStatusRuntime>>): string {
  const lines = [
    "Dream status",
    `  active durables: ${status.health.total}`,
    `  proposal backlog: ${status.health.proposalBacklogCount}`,
    `  eligible proposals: ${status.health.eligibleProposalBacklogCount}`,
  ];
  if (status.lastRun) {
    lines.push(`  last run: ${status.lastRun.id} (${status.lastRun.status}, tier=${status.lastRun.tier})`);
  } else {
    lines.push("  last run: none");
  }
  return `${lines.join("\n")}\n`;
}

function renderHistory(history: Awaited<ReturnType<typeof loadDreamHistoryRuntime>>): string {
  if (history.length === 0) {
    return "No dreaming runs recorded.\n";
  }

  return history
    .map((run) => `${run.startedAt}  ${run.id}  tier=${run.tier}  status=${run.status}  dryRun=${run.dryRun}`)
    .join("\n")
    .concat("\n");
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
