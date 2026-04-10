import { InvalidArgumentError, Option, type Command } from "commander";

import {
  ClaimKeyScenarioConfigurationError,
  listClaimKeyScenariosRuntime,
  runClaimKeyScenariosRuntime,
  type ClaimKeyScenario,
  type ClaimKeyScenarioKind,
  type ClaimKeyScenarioRunOptions,
  type ClaimKeyScenarioSummary,
} from "../../app/scenarios/claim-keys/index.js";
import { collectStringValue, normalizeStringList } from "../shared/parse.js";

/**
 * Dependency overrides used by CLI tests.
 */
export interface ScenarioCommandDeps {
  listScenarios?: (options: Pick<ClaimKeyScenarioRunOptions, "rootDir" | "ids" | "kind" | "tags">) => Promise<ClaimKeyScenario[]>;
  runScenarios?: (options: ClaimKeyScenarioRunOptions) => Promise<ClaimKeyScenarioSummary>;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

/**
 * Parsed commander options for `agenr scenarios list`.
 */
interface ScenarioListCommandOptions {
  kind?: ClaimKeyScenarioKind;
  tag?: string[];
  json?: boolean;
}

/**
 * Parsed commander options for `agenr scenarios run`.
 */
interface ScenarioRunCommandOptions {
  id?: string[];
  kind?: ClaimKeyScenarioKind;
  tag?: string[];
  preserveOnFailure?: boolean;
  preserve?: boolean;
  verbose?: boolean;
  json?: boolean;
  failFast?: boolean;
}

/** Normalized `agenr scenarios list` input passed into the runtime layer. */
interface NormalizedScenarioListCommand {
  kind?: ClaimKeyScenarioKind;
  tags?: string[];
  json: boolean;
}

/** Normalized `agenr scenarios run` input passed into the runtime layer. */
interface NormalizedScenarioRunCommand {
  ids?: string[];
  kind?: ClaimKeyScenarioKind;
  tags?: string[];
  preserveOnFailure: boolean;
  preserveAlways: boolean;
  verbose: boolean;
  json: boolean;
  failFast: boolean;
}

/**
 * Registers the `agenr scenarios` command group.
 *
 * @param program - Root commander program to extend.
 * @param deps - Optional dependency overrides used by tests.
 */
export function registerScenariosCommand(program: Command, deps: ScenarioCommandDeps = {}): void {
  const scenariosCommand = program.command("scenarios").description("List and run repo-local claim-key sandbox scenarios");
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const listScenarios = deps.listScenarios ?? listClaimKeyScenariosRuntime;
  const runScenarios = deps.runScenarios ?? runClaimKeyScenariosRuntime;

  scenariosCommand
    .command("list")
    .description("List available claim-key scenarios")
    .addOption(new Option("--kind <kind>", "Filter by scenario kind").argParser(parseScenarioKind))
    .option("--tag <tag>", "Filter by tag", collectStringValue, [])
    .option("--json", "Emit machine-readable JSON output")
    .action(async (options: ScenarioListCommandOptions) => {
      try {
        const commandInput = normalizeScenarioListCommand(options);
        const scenarios = await listScenarios({
          kind: commandInput.kind,
          tags: commandInput.tags,
        });

        stdout.write(commandInput.json ? `${JSON.stringify(scenarios, null, 2)}\n` : renderScenarioList(scenarios));
      } catch (error) {
        process.exitCode = error instanceof ClaimKeyScenarioConfigurationError ? 2 : 1;
        stderr.write(`Scenario list failed: ${formatUnknownError(error)}\n`);
      }
    });

  scenariosCommand
    .command("run")
    .description("Run claim-key sandbox scenarios")
    .option("--id <scenarioId>", "Run one or more scenario IDs", collectStringValue, [])
    .addOption(new Option("--kind <kind>", "Filter by scenario kind").argParser(parseScenarioKind))
    .option("--tag <tag>", "Filter by tag", collectStringValue, [])
    .option("--preserve-on-failure", "Preserve the sandbox directory when a scenario fails")
    .option("--preserve", "Always preserve the sandbox directory")
    .option("--verbose", "Show extra runtime detail")
    .option("--json", "Emit machine-readable JSON output")
    .option("--fail-fast", "Stop after the first failing scenario")
    .action(async (options: ScenarioRunCommandOptions) => {
      try {
        const commandInput = normalizeScenarioRunCommand(options);
        const summary = await runScenarios({
          ids: commandInput.ids,
          kind: commandInput.kind,
          tags: commandInput.tags,
          preserveOnFailure: commandInput.preserveOnFailure,
          preserveAlways: commandInput.preserveAlways,
          verbose: commandInput.verbose,
          failFast: commandInput.failFast,
        });

        if (summary.failedCount > 0) {
          process.exitCode = 1;
        }

        stdout.write(commandInput.json ? `${JSON.stringify(summary, null, 2)}\n` : renderScenarioRunSummary(summary));
      } catch (error) {
        process.exitCode = error instanceof ClaimKeyScenarioConfigurationError ? 2 : 1;
        stderr.write(`Scenario run failed: ${formatUnknownError(error)}\n`);
      }
    });
}

/**
 * Builds one normalized list-command payload from parsed CLI options.
 *
 * @param options - Parsed commander options.
 * @returns Normalized list-command input.
 */
function normalizeScenarioListCommand(options: ScenarioListCommandOptions): NormalizedScenarioListCommand {
  return {
    kind: options.kind,
    tags: normalizeStringList(options.tag),
    json: options.json === true,
  };
}

/**
 * Builds one normalized run-command payload from parsed CLI options.
 *
 * @param options - Parsed commander options.
 * @returns Normalized run-command input.
 */
function normalizeScenarioRunCommand(options: ScenarioRunCommandOptions): NormalizedScenarioRunCommand {
  return {
    ids: normalizeStringList(options.id),
    kind: options.kind,
    tags: normalizeStringList(options.tag),
    preserveOnFailure: options.preserveOnFailure === true,
    preserveAlways: options.preserve === true,
    verbose: options.verbose === true,
    json: options.json === true,
    failFast: options.failFast === true,
  };
}

/**
 * Renders the human-readable `agenr scenarios list` output.
 *
 * @param scenarios - Loaded scenarios selected for the list output.
 * @returns Rendered terminal text.
 */
function renderScenarioList(scenarios: ClaimKeyScenario[]): string {
  if (scenarios.length === 0) {
    return "No matching claim-key scenarios.\n";
  }

  const lines = scenarios.map((scenario) => {
    const tags = scenario.tags && scenario.tags.length > 0 ? ` tags=${scenario.tags.join(",")}` : "";
    const description = scenario.description ? ` - ${scenario.description}` : "";
    return `${scenario.id} [${scenario.kind}]${tags} ${scenario.filePath}${description}`;
  });

  return `${lines.join("\n")}\n`;
}

/**
 * Renders the human-readable `agenr scenarios run` output.
 *
 * @param summary - Aggregate scenario run summary.
 * @returns Rendered terminal text.
 */
function renderScenarioRunSummary(summary: ClaimKeyScenarioSummary): string {
  if (summary.matchedCount === 0) {
    return "No matching claim-key scenarios.\n";
  }

  const lines = [`Running ${summary.matchedCount} claim-key scenario${summary.matchedCount === 1 ? "" : "s"}...`, ""];

  for (const result of summary.results) {
    lines.push(`${result.status === "passed" ? "PASS" : "FAIL"}  ${result.scenarioId}`);
    if (result.status === "failed") {
      for (const diff of result.diffSummary) {
        lines.push(`  ${diff}`);
      }

      if (result.preservedSandboxPath) {
        lines.push(`  preserved sandbox: ${result.preservedSandboxPath}`);
      }
    }
  }

  lines.push("");
  lines.push(`${summary.passedCount} passed, ${summary.failedCount} failed`);
  lines.push(`artifacts: ${summary.artifactRoot}`);

  return `${lines.join("\n")}\n`;
}

/**
 * Parses and validates one scenario kind flag.
 *
 * @param value - Raw commander option value.
 * @returns Supported scenario kind.
 */
function parseScenarioKind(value: string): ClaimKeyScenarioKind {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "ingest" && normalized !== "store" && normalized !== "surgeon") {
    throw new InvalidArgumentError(`Invalid scenario kind: ${value}`);
  }

  return normalized;
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
