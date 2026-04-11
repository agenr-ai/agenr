import { InvalidArgumentError, Option, type Command } from "commander";

import { type SurgeonProgressEvent, type SurgeonProgressReporter } from "../../app/surgeon/progress.js";
import {
  loadSurgeonBacklogRuntime,
  loadSurgeonActionsRuntime,
  loadSurgeonHistoryRuntime,
  loadSurgeonProposalsRuntime,
  loadSurgeonStatusRuntime,
  reviewSurgeonProposalRuntime,
  runSurgeonRuntime,
  type SurgeonRuntimeOptions,
  type SurgeonRuntimeResult,
} from "../../app/surgeon/runtime.js";
import { isImplementedSurgeonPass, isSurgeonPassType, type SurgeonPassType } from "../../core/surgeon/domain/pass-types.js";
import { isSurgeonRunPreset, type ImplementedSurgeonPass, type SurgeonRunPreset } from "../../core/surgeon/domain/run-presets.js";
import {
  collectStringValue,
  normalizeOptionalString,
  normalizeStringList,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parsePositiveNumber,
} from "../shared/parse.js";
import { createLogger } from "../../logger.js";

/** Parsed commander options for `agenr surgeon run`. */
interface SurgeonRunCommandOptions {
  pass?: ImplementedSurgeonPass;
  preset?: SurgeonRunPreset;
  project?: string;
  type?: string;
  claimKeyPrefix?: string;
  entryId?: string[];
  includeInactive?: boolean;
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

/** Parsed commander options for `agenr surgeon backlog`. */
interface SurgeonBacklogCommandOptions {
  state?: "open" | "applied" | "rejected" | "all";
  issueKind?: string;
  eligibleOnly?: boolean;
  entryId?: string;
  limit?: number;
  offset?: number;
}

/** Parsed commander options for `agenr surgeon review`. */
interface SurgeonReviewCommandOptions {
  decision?: "apply" | "reject";
  reason?: string;
}

/** Normalized CLI payload for `agenr surgeon run`. */
type NormalizedSurgeonRunCommand = Omit<SurgeonRuntimeOptions, "dbPath" | "env" | "onProgress" | "signal">;

/**
 * Registers the `agenr surgeon` command group and its subcommands.
 *
 * @param program - Root Commander program to extend.
 */
export function registerSurgeonCommand(program: Command): void {
  const surgeonCommand = program.command("surgeon").description("Run surgeon maintenance passes and inspect surgeon history");

  surgeonCommand
    .command("run")
    .description("Execute a surgeon maintenance pass or composed preset")
    .addOption(new Option("--pass <type>", "Surgeon pass: retirement (default), supersession, or claim_key_quality").argParser(parseImplementedSurgeonPass))
    .addOption(new Option("--preset <name>", "Composed surgeon preset: claim-key-only, structural, or full").argParser(parseSurgeonRunPreset))
    .option("--project <name>", "Restrict the run to one project")
    .option("--type <entryType>", "Restrict claim-key-quality cleanup to one entry type")
    .option("--claim-key-prefix <prefix>", "Restrict claim-key-quality cleanup to one claim-key entity prefix")
    .option("--entry-id <id>", "Restrict claim-key-quality cleanup to one or more entry IDs", collectStringValue, [])
    .option("--include-inactive", "Allow claim-key-quality cleanup to include retired or superseded rows")
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
        const commandInput = normalizeSurgeonRunCommand(options);
        validateRunCommandOptions(commandInput);
        const reportProgress = createCliSurgeonProgressReporter(commandInput.verbose);
        const result = await runSurgeonRuntime({
          ...commandInput,
          signal: abortController.signal,
          env: process.env,
          onProgress: reportProgress,
        });

        process.stdout.write(commandInput.json ? `${JSON.stringify(result, null, 2)}\n` : renderRunResult(result, commandInput.apply));
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
    .command("backlog")
    .description("Show proposal backlog across surgeon runs")
    .addOption(new Option("--state <state>", "Proposal state filter").choices(["open", "applied", "rejected", "all"]).default("open"))
    .option("--issue-kind <kind>", "Only proposals for one issue kind")
    .option("--eligible-only", "Only proposals that are already safe to apply")
    .option("--entry-id <id>", "Only proposals that mention one entry ID")
    .addOption(new Option("--limit <n>", "Maximum number of proposals to show").argParser(parsePositiveInteger).default(20))
    .addOption(new Option("--offset <n>", "Rows to skip before listing results").argParser(parseNonNegativeInteger).default(0))
    .action(async (options: SurgeonBacklogCommandOptions) => {
      try {
        const backlog = await loadSurgeonBacklogRuntime({
          state: options.state,
          issueKind: normalizeOptionalString(options.issueKind),
          eligibleOnly: options.eligibleOnly === true,
          entryId: normalizeOptionalString(options.entryId),
          limit: options.limit,
          offset: options.offset,
          env: process.env,
        });

        process.stdout.write(
          renderBacklog(backlog, {
            state: options.state ?? "open",
            eligibleOnly: options.eligibleOnly === true,
            issueKind: normalizeOptionalString(options.issueKind),
            entryId: normalizeOptionalString(options.entryId),
            limit: options.limit ?? 20,
            offset: options.offset ?? 0,
          }),
        );
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Failed to load surgeon backlog: ${formatUnknownError(error)}\n`);
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

  surgeonCommand
    .command("proposals <runId>")
    .description("Show proposals recorded for a surgeon run")
    .action(async (runId: string) => {
      try {
        const proposals = await loadSurgeonProposalsRuntime({
          runId,
          env: process.env,
        });

        process.stdout.write(renderProposals(runId, proposals));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Failed to load surgeon proposals: ${formatUnknownError(error)}\n`);
      }
    });

  surgeonCommand
    .command("review <proposalId>")
    .description("Apply or reject one open proposal")
    .addOption(new Option("--decision <decision>", "Review decision").choices(["apply", "reject"]).makeOptionMandatory(true))
    .option("--reason <text>", "Why this review decision was taken")
    .action(async (proposalId: string, options: SurgeonReviewCommandOptions) => {
      try {
        const reason = normalizeOptionalString(options.reason);
        if (!reason) {
          throw new InvalidArgumentError("Review reason is required.");
        }

        const result = await reviewSurgeonProposalRuntime({
          proposalId,
          decision: options.decision ?? "reject",
          reason,
          env: process.env,
        });

        process.stdout.write(renderProposalReviewResult(result));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Failed to review surgeon proposal: ${formatUnknownError(error)}\n`);
      }
    });
}

/**
 * Validates that the CLI-selected surgeon pass is implemented.
 *
 * @param value - Raw commander option value.
 * @returns Supported implemented surgeon pass.
 */
function parseImplementedSurgeonPass(value: string): Extract<SurgeonPassType, "claim_key_quality" | "retirement" | "supersession"> {
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
 * Validates a composed surgeon preset identifier.
 *
 * @param value - Raw commander option value.
 * @returns Supported surgeon preset identifier.
 */
function parseSurgeonRunPreset(value: string): SurgeonRunPreset {
  const normalized = value.trim().toLowerCase();
  if (!isSurgeonRunPreset(normalized)) {
    throw new InvalidArgumentError(`Invalid surgeon preset: ${value}`);
  }

  return normalized;
}

/**
 * Validates option combinations before invoking the runtime layer.
 *
 * @param options - Parsed run command options.
 */
function validateRunCommandOptions(options: NormalizedSurgeonRunCommand): void {
  if (options.pass && options.preset) {
    throw new InvalidArgumentError("Specify either --pass or --preset, not both.");
  }

  if (!hasClaimKeyTargeting(options)) {
    return;
  }

  const selection = options.preset ?? options.pass ?? "retirement";
  if (selection === "claim_key_quality" || selection === "claim-key-only") {
    return;
  }

  throw new InvalidArgumentError(
    "Claim-key-quality selectors (--type, --claim-key-prefix, --entry-id, --include-inactive) require --pass claim_key_quality or --preset claim-key-only.",
  );
}

/**
 * Builds one normalized surgeon run payload from parsed CLI options.
 *
 * @param options - Parsed commander options.
 * @returns Normalized runtime input used by the CLI command.
 */
function normalizeSurgeonRunCommand(options: SurgeonRunCommandOptions): NormalizedSurgeonRunCommand {
  return {
    pass: options.pass,
    preset: options.preset,
    project: normalizeOptionalString(options.project),
    type: normalizeOptionalString(options.type),
    claimKeyPrefix: normalizeOptionalString(options.claimKeyPrefix),
    entryIds: normalizeStringList(options.entryId),
    includeInactive: options.includeInactive === true,
    budget: normalizeOptionalBudget(options.budget),
    contextLimit: options.contextLimit,
    skipEvaluatedDays: options.skipEvaluatedDays,
    apply: options.apply === true,
    model: normalizeOptionalString(options.model),
    provider: normalizeOptionalString(options.provider),
    verbose: options.verbose === true,
    tracePath: normalizeOptionalString(options.trace),
    json: options.json === true,
  };
}

/**
 * Checks whether the CLI request uses claim-key-quality-only targeting flags.
 *
 * @param options - Parsed run options.
 * @returns True when claim-key targeting is requested.
 */
function hasClaimKeyTargeting(options: NormalizedSurgeonRunCommand): boolean {
  if (options.type) {
    return true;
  }

  if (options.claimKeyPrefix) {
    return true;
  }

  if ((options.entryIds ?? []).length > 0) {
    return true;
  }

  return options.includeInactive === true;
}

/**
 * Formats the final output for `agenr surgeon run`.
 *
 * @param result - Completed surgeon run result.
 * @param apply - Whether the command ran in apply mode.
 * @returns Human-readable multi-line output block.
 */
function renderRunResult(result: SurgeonRuntimeResult, apply: boolean): string {
  if ("preset" in result) {
    return renderPresetRunResult(result, apply);
  }

  return renderSingleRunResult(result, apply);
}

/**
 * Formats the final output for one single-pass surgeon run.
 *
 * @param result - Completed surgeon run result.
 * @param apply - Whether the command ran in apply mode.
 * @returns Human-readable multi-line output block.
 */
function renderSingleRunResult(
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
 * Formats the final output for a composed surgeon preset run.
 *
 * @param result - Completed surgeon preset result.
 * @param apply - Whether the command ran in apply mode.
 * @returns Human-readable multi-line output block.
 */
function renderPresetRunResult(
  result: {
    preset: string;
    passes: Array<{ passType: string }>;
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
    `Surgeon preset ${result.preset}`,
    `Passes: ${result.passes.map((pass) => pass.passType).join(" -> ") || "none"}`,
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
    claimKeyLifecycle: {
      trusted: number;
      tentative: number;
      unresolved: number;
      legacy: number;
      noKey: number;
    };
    proposalBacklogCount: number;
    eligibleProposalBacklogCount: number;
    oldestOpenProposalCreatedAt: string | null;
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
  const claimKeyLine =
    `Claim keys: trusted ${input.health.claimKeyLifecycle.trusted} | tentative ${input.health.claimKeyLifecycle.tentative} | ` +
    `unresolved ${input.health.claimKeyLifecycle.unresolved} | legacy ${input.health.claimKeyLifecycle.legacy} | no key ${input.health.claimKeyLifecycle.noKey}`;
  const backlogLine =
    input.health.proposalBacklogCount > 0
      ? `Proposal backlog: ${input.health.proposalBacklogCount} open | ${input.health.eligibleProposalBacklogCount} eligible to apply | oldest ${input.health.oldestOpenProposalCreatedAt ?? "n/a"}`
      : "Proposal backlog: 0";

  return [
    "Surgeon Status",
    "",
    `Entries: ${input.health.total}`,
    claimKeyLine,
    backlogLine,
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
 * Formats one run's unresolved proposal trail.
 *
 * @param runId - Persisted surgeon run ID.
 * @param proposals - Proposal rows loaded for the run.
 * @returns Human-readable proposal block.
 */
function renderProposals(
  runId: string,
  proposals: Array<{
    createdAt: string;
    issueKind: string;
    scope: string;
    entryIds: string[];
    currentClaimKeys: string[];
    proposedClaimKeys: string[];
    confidence: number;
    eligibleForApply: boolean;
    rationale: string;
    reviewStatus: string;
    reviewedAt: string | null;
    reviewReason: string | null;
    appliedActionCount: number;
  }>,
): string {
  if (proposals.length === 0) {
    return `Surgeon Proposals ${runId}\n\nNo surgeon proposals recorded for this run.\n`;
  }

  const lines = [`Surgeon Proposals ${runId}`, ""];
  for (const proposal of proposals) {
    lines.push(
      `${proposal.createdAt}  ${proposal.issueKind}  scope=${proposal.scope}  confidence=${proposal.confidence.toFixed(2)}  eligible=${proposal.eligibleForApply}  status=${proposal.reviewStatus}`,
    );
    lines.push(`  entries=${proposal.entryIds.join(", ") || "(none)"}`);
    if (proposal.currentClaimKeys.length > 0 || proposal.proposedClaimKeys.length > 0) {
      lines.push(`  claim_keys current=${proposal.currentClaimKeys.join(", ") || "(none)"} -> proposed=${proposal.proposedClaimKeys.join(", ") || "(none)"}`);
    }
    if (proposal.reviewStatus !== "open") {
      lines.push(`  reviewed_at=${proposal.reviewedAt ?? "n/a"}  applied_actions=${proposal.appliedActionCount}`);
      if (proposal.reviewReason) {
        lines.push(`  review_reason=${proposal.reviewReason}`);
      }
    }
    lines.push(`  ${proposal.rationale}`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Formats the global proposal backlog across runs.
 *
 * @param backlog - Joined backlog rows returned by the runtime.
 * @param filters - Active filter metadata for the header.
 * @returns Human-readable backlog block.
 */
function renderBacklog(
  backlog: Array<{
    proposal: {
      id: string;
      createdAt: string;
      issueKind: string;
      scope: string;
      entryIds: string[];
      proposedClaimKeys: string[];
      confidence: number;
      eligibleForApply: boolean;
      reviewStatus: string;
    };
    runPassType: string;
    runStartedAt: string;
    runStatus: string;
    runDryRun: boolean;
  }>,
  filters: {
    state: string;
    eligibleOnly: boolean;
    issueKind?: string;
    entryId?: string;
    limit: number;
    offset: number;
  },
): string {
  const filterParts = [`state=${filters.state}`, `limit=${filters.limit}`, `offset=${filters.offset}`];
  if (filters.eligibleOnly) {
    filterParts.push("eligible_only=true");
  }
  if (filters.issueKind) {
    filterParts.push(`issue_kind=${filters.issueKind}`);
  }
  if (filters.entryId) {
    filterParts.push(`entry_id=${filters.entryId}`);
  }
  if (backlog.length === 0) {
    return `Surgeon Backlog (${filterParts.join(" ")})\n\nNo proposals matched the current filters.\n`;
  }

  const lines = [`Surgeon Backlog (${filterParts.join(" ")})`, ""];
  for (const item of backlog) {
    lines.push(
      `${item.proposal.id}  ${item.proposal.createdAt}  ${item.proposal.issueKind}  scope=${item.proposal.scope}  confidence=${item.proposal.confidence.toFixed(2)}  eligible=${item.proposal.eligibleForApply}  status=${item.proposal.reviewStatus}`,
    );
    lines.push(`  run=${item.runPassType} ${item.runStatus} (${item.runDryRun ? "dry-run" : "apply"}) started=${item.runStartedAt}`);
    lines.push(`  proposal_id=${item.proposal.id}  entries=${item.proposal.entryIds.join(", ") || "(none)"}`);
    if (item.proposal.proposedClaimKeys.length > 0) {
      lines.push(`  proposed=${item.proposal.proposedClaimKeys.join(", ")}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Formats the result of one proposal review/apply decision.
 *
 * @param result - Runtime output after proposal review completes.
 * @returns Human-readable review result block.
 */
function renderProposalReviewResult(result: {
  proposal: {
    id: string;
    reviewStatus: string;
    reviewedAt: string | null;
    reviewReason: string | null;
    appliedActionCount: number;
  };
  updatedEntryIds: string[];
  backupPath: string | null;
}): string {
  return [
    `Surgeon Proposal Review ${result.proposal.id}`,
    "",
    `Status: ${result.proposal.reviewStatus}`,
    `Reviewed at: ${result.proposal.reviewedAt ?? "n/a"}`,
    `Applied actions: ${result.proposal.appliedActionCount}`,
    `Updated entries: ${result.updatedEntryIds.join(", ") || "(none)"}`,
    `Backup: ${result.backupPath ?? "none"}`,
    `Reason: ${result.proposal.reviewReason ?? "n/a"}`,
    "",
  ].join("\n");
}

/**
 * Creates the stderr reporter used for surgeon run liveness updates.
 *
 * @param verbose - Whether verbose progress detail is enabled.
 * @returns Structured progress reporter for one CLI invocation.
 */
function createCliSurgeonProgressReporter(verbose: boolean): SurgeonProgressReporter {
  const logger = createLogger("surgeon");

  return (event: SurgeonProgressEvent): void => {
    logger.info(formatProgressEvent(event, verbose));
  };
}

/**
 * Formats one structured surgeon progress event for human stderr output.
 *
 * @param event - Progress event emitted by runtime or pass code.
 * @param verbose - Whether verbose detail is enabled.
 * @returns One single-line progress message.
 */
function formatProgressEvent(event: SurgeonProgressEvent, verbose: boolean): string {
  if (event.kind === "phase") {
    switch (event.phase) {
      case "start":
        return `Starting surgeon run: ${event.passType} (${event.apply ? "apply" : "dry-run"}).`;
      case "backup_start":
        return "Creating DB backup before apply run.";
      case "backup_complete":
        return `DB backup complete: ${event.backupPath ?? "backup created"}.`;
      case "load_working_set_start":
        return "Loading claim-key-quality working set.";
      case "load_working_set_complete":
        return `Working set loaded: ${formatOptionalCount(event.workingSetSize)} entries.`;
      case "load_pass_context_start":
        return `Loading ${event.passType} pass context.`;
      case "load_pass_context_complete":
        return `Pass context ready: ${formatOptionalCount(event.workingSetSize)} entries in scope.`;
      case "pass_start":
        return `Starting ${event.passType} pass.`;
      default:
        return `Progress update: ${event.phase}.`;
    }
  }

  if (event.stage === "health" && event.health) {
    const base =
      `Claim-key-quality health: ${event.health.totalEntries} entries | missing ${event.health.missingCount} | ` +
      `invalid/noncanonical ${event.health.malformedOrNoncanonicalCount} | suspect ${event.health.suspectCanonicalCount} | ` +
      `entity families ${event.health.entityFamilyGroupCount} | mixed groups ${event.health.mixedGroupCount}`;

    if (!verbose) {
      return `${base} | exact-key multi-active ${event.health.exactKeyMultiActiveClusterCount}`;
    }

    return (
      `${base} | eligible missing ${event.health.eligibleMissingCount} | coverage ${formatPercent(event.health.coveragePct)} | ` +
      `exact-key multi-active ${event.health.exactKeyMultiActiveClusterCount}`
    );
  }

  const stageLabel = formatClaimKeyQualityStage(event.stage);
  if (event.status === "started") {
    const previewQueued = formatOptionalCount(event.previewQueued);
    const previewTotal = formatOptionalCount(event.previewTotal);
    if (previewTotal > 0) {
      const concurrency = event.previewConcurrency ? ` | preview concurrency ${event.previewConcurrency}` : "";
      return `Claim-key-quality stage ${stageLabel}: ${event.total} ${event.unitLabel} | preview queued ${previewQueued}/${previewTotal}${concurrency}.`;
    }

    return `Claim-key-quality stage ${stageLabel}: ${event.total} ${event.unitLabel}.`;
  }

  const appliedTotal =
    event.counts.appliedNormalizations + event.counts.appliedBackfills + event.counts.appliedMetadataRewrites + event.counts.appliedEntityFamilyConvergences;
  const previewTotal = formatOptionalCount(event.previewTotal);
  const previewCompleted = formatOptionalCount(event.previewCompleted);
  const stageProgress =
    event.status === "preview_progress" && previewTotal > 0
      ? `Claim-key-quality ${stageLabel} preview ${previewCompleted}/${previewTotal} ${event.unitLabel} | decided ${event.completed}/${event.total}`
      : previewTotal > 0
        ? `Claim-key-quality ${stageLabel} decided ${event.completed}/${event.total} ${event.unitLabel} | preview ${previewCompleted}/${previewTotal}`
        : `Claim-key-quality ${stageLabel} ${event.completed}/${event.total} ${event.unitLabel}`;
  const base =
    `${stageProgress} | ` +
    `scanned ${event.processedEntries}/${event.totalEntries} entries | applied ${appliedTotal} | proposals ${event.counts.proposalsEmitted} | ` +
    `elapsed ${formatElapsed(event.elapsedMs)}`;

  if (!verbose) {
    return base;
  }

  return (
    `${base} | normalize ${event.counts.appliedNormalizations}/${event.counts.identifiedNormalizations} | ` +
    `backfill ${event.counts.appliedBackfills}/${event.counts.identifiedBackfills} | ` +
    `metadata ${event.counts.appliedMetadataRewrites}/${event.counts.identifiedMetadataRewrites} | ` +
    `family ${event.counts.appliedEntityFamilyConvergences}/${event.counts.identifiedEntityFamilyConvergences} | ` +
    `skipped no-claim ${event.counts.skippedNoClaim} low-confidence ${event.counts.skippedLowConfidence} ` +
    `collision ${event.counts.skippedCollision} ambiguous ${event.counts.skippedAmbiguous}`
  );
}

/**
 * Formats one claim-key-quality stage identifier for CLI display.
 *
 * @param stage - Structured stage identifier.
 * @returns Human-readable stage label.
 */
function formatClaimKeyQualityStage(stage: Extract<SurgeonProgressEvent, { kind: "claim_key_quality_progress" }>["stage"]): string {
  switch (stage) {
    case "health":
      return "health";
    case "invalid_noncanonical":
      return "invalid/noncanonical";
    case "missing":
      return "missing";
    case "suspect_canonical":
      return "suspect-but-canonical";
    case "entity_family_convergence":
      return "entity-family convergence";
    case "mixed_key_groups":
      return "mixed-key groups";
    default:
      return stage;
  }
}

/**
 * Formats one ratio as a percentage string with one decimal place.
 *
 * @param value - Ratio between zero and one.
 * @returns Human-readable percentage string.
 */
function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Formats elapsed milliseconds into a short progress-friendly duration.
 *
 * @param elapsedMs - Milliseconds elapsed since run start.
 * @returns Human-readable elapsed duration.
 */
function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
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
 * Converts an unknown thrown value into a readable error string.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable error message.
 */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Normalizes the optional CLI budget value while keeping the existing zero-default behavior.
 *
 * @param value - Parsed budget flag value.
 * @returns Numeric budget cap used by the runtime layer.
 */
function normalizeOptionalBudget(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Formats optional progress counts with a stable zero fallback for missing events.
 *
 * @param value - Optional emitted count.
 * @returns Finite count value for CLI rendering.
 */
function formatOptionalCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
