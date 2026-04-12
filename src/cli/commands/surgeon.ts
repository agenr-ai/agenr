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
import { type ImplementedSurgeonPass } from "../../core/surgeon/domain/run-presets.js";
import type { Logger } from "../../logger.js";
import { normalizeOptionalString, parseNonNegativeInteger, parsePositiveInteger, parsePositiveNumber } from "../shared/parse.js";
import { ui } from "../../ui.js";

/** Parsed commander options for `agenr surgeon run`. */
interface SurgeonRunCommandOptions {
  pass?: ImplementedSurgeonPass;
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
type NormalizedSurgeonRunCommand = Omit<SurgeonRuntimeOptions, "dbPath" | "env" | "onProgress" | "logger" | "signal">;

/**
 * Registers the `agenr surgeon` command group and its subcommands.
 *
 * @param program - Root Commander program to extend.
 */
export function registerSurgeonCommand(program: Command): void {
  const surgeonCommand = program.command("surgeon").description("Run surgeon maintenance passes and inspect surgeon history");

  surgeonCommand
    .command("run")
    .description("Execute the autonomous surgeon run or one explicit pass")
    .addOption(
      new Option("--pass <type>", "Run one surgeon pass: retirement, supersession, proposal_resolution, or claim_key_quality").argParser(
        parseImplementedSurgeonPass,
      ),
    )
    .addOption(new Option("--budget <usd>", "Cost cap for this run in USD").argParser(parsePositiveNumber))
    .addOption(new Option("--context-limit <tokens>", "Context limit override in tokens").argParser(parsePositiveInteger))
    .addOption(new Option("--skip-evaluated-days <n>", "Skip entries evaluated within the last N days").argParser(parseNonNegativeInteger))
    .option("--apply", "Apply changes instead of running in dry-run mode")
    .option("--model <id>", "Override the surgeon model ID")
    .option("--provider <name>", "Override the surgeon model provider")
    .option("--verbose", "Enable verbose trace logging")
    .option("--trace <path>", "Write compact surgeon trace JSONL to a file or existing directory")
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
        const display = createSurgeonRunDisplay(commandInput.verbose);
        const result = await runSurgeonRuntime({
          ...commandInput,
          signal: abortController.signal,
          env: process.env,
          onProgress: display.progressReporter,
          logger: display.logger,
        });

        display.dispose();
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
function parseImplementedSurgeonPass(value: string): Extract<SurgeonPassType, "claim_key_quality" | "proposal_resolution" | "retirement" | "supersession"> {
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
 * Builds one normalized surgeon run payload from parsed CLI options.
 *
 * @param options - Parsed commander options.
 * @returns Normalized runtime input used by the CLI command.
 */
function normalizeSurgeonRunCommand(options: SurgeonRunCommandOptions): NormalizedSurgeonRunCommand {
  return {
    pass: options.pass,
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
 * Formats the final output for `agenr surgeon run`.
 *
 * @param result - Completed surgeon run result.
 * @param apply - Whether the command ran in apply mode.
 * @returns Human-readable multi-line output block.
 */
function renderRunResult(result: SurgeonRuntimeResult, apply: boolean): string {
  if ("runId" in result) {
    return renderSingleRunResult(result, apply);
  }

  return renderAutonomousRunResult(result, apply);
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
    ui.header(`Surgeon Run ${result.runId}`),
    "",
    `${ui.label("Pass")}     ${result.passType}`,
    `${ui.label("Mode")}     ${apply ? ui.warn("apply") : ui.dim("dry-run")}`,
    `${ui.label("Status")}   ${colorizeStatus(result.status)}`,
    `${ui.label("Actions")}  ${result.actionsTaken} total, ${result.entriesRetired} retired`,
    `${ui.label("Usage")}    in ${result.inputTokens} / out ${result.outputTokens} / cost ${formatUsd(result.estimatedCostUsd)}`,
    `${ui.label("Summary")}  ${result.summary ?? ui.dim("n/a")}`,
    "",
  ].join("\n");
}

/**
 * Formats the final output for an autonomous multi-pass surgeon run.
 *
 * @param result - Completed autonomous run result.
 * @param apply - Whether the command ran in apply mode.
 * @returns Human-readable multi-line output block.
 */
function renderAutonomousRunResult(
  result: {
    cyclesCompleted: number;
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
    ui.header("Surgeon Run (autonomous)"),
    "",
    `${ui.label("Cycles")}   ${result.cyclesCompleted}`,
    `${ui.label("Passes")}   ${result.passes.map((pass) => pass.passType).join(" -> ") || ui.dim("none")}`,
    `${ui.label("Mode")}     ${apply ? ui.warn("apply") : ui.dim("dry-run")}`,
    `${ui.label("Status")}   ${colorizeStatus(result.status)}`,
    `${ui.label("Actions")}  ${result.actionsTaken} total, ${result.entriesRetired} retired`,
    `${ui.label("Usage")}    in ${result.inputTokens} / out ${result.outputTokens} / cost ${formatUsd(result.estimatedCostUsd)}`,
    `${ui.label("Summary")}  ${result.summary ?? ui.dim("n/a")}`,
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
    retirementAvailableActionableCount: number;
    retirementAvailableAllCount: number;
    recentlyEvaluatedCount: number;
  };
  lastRun: {
    passType: string;
    status: string;
    dryRun: boolean;
    estimatedCostUsd: number;
  } | null;
}): string {
  const ck = input.health.claimKeyLifecycle;
  const availableActionableCount =
    typeof input.health.retirementAvailableActionableCount === "number"
      ? input.health.retirementAvailableActionableCount
      : Math.max(0, input.health.retirementCandidateCount - input.health.recentlyEvaluatedCount);
  const availableAllCount =
    typeof input.health.retirementAvailableAllCount === "number" ? input.health.retirementAvailableAllCount : input.health.retirementCandidateCount;
  const hasExtendedRetirementCounts =
    typeof input.health.retirementAvailableActionableCount === "number" && typeof input.health.retirementAvailableAllCount === "number";
  const newCandidates = Math.max(0, input.health.retirementCandidateCount - input.health.recentlyEvaluatedCount);
  const candidateDetail = input.health.recentlyEvaluatedCount > 0 ? ` (${newCandidates} new, ${input.health.recentlyEvaluatedCount} recently evaluated)` : "";

  const backlogDetail =
    input.health.proposalBacklogCount > 0
      ? `${input.health.proposalBacklogCount} open, ${input.health.eligibleProposalBacklogCount} eligible, oldest ${ui.dim(input.health.oldestOpenProposalCreatedAt ?? "n/a")}`
      : ui.dim("0");

  const lastRunDetail = input.lastRun
    ? `${input.lastRun.passType} ${colorizeStatus(input.lastRun.status)} (${input.lastRun.dryRun ? "dry-run" : "apply"}) - ${formatUsd(input.lastRun.estimatedCostUsd)}`
    : ui.dim("none");

  return [
    ui.header("Surgeon Status"),
    "",
    `${ui.label("Entries")}        ${input.health.total}`,
    `${ui.label("Claim keys")}     ${ui.success(String(ck.trusted))} trusted, ${ck.tentative} tentative, ${ck.unresolved > 0 ? ui.warn(String(ck.unresolved)) : "0"} unresolved, ${ck.legacy} legacy, ${ck.noKey > 0 ? ui.warn(String(ck.noKey)) : "0"} no key`,
    `${ui.label("Backlog")}        ${backlogDetail}`,
    `${ui.label("Retirement")}     ${
      hasExtendedRetirementCounts
        ? `${availableActionableCount} actionable, ${availableAllCount} all-scope, ${input.health.retirementCandidateCount} raw${candidateDetail}`
        : `${input.health.retirementCandidateCount} candidates${candidateDetail}`
    }`,
    `${ui.label("Last run")}       ${lastRunDetail}`,
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
    return `${ui.header(`Surgeon History (last ${limit} runs)`)}\n\n${ui.dim("No surgeon runs recorded.")}\n`;
  }

  const lines = [ui.header(`Surgeon History (last ${limit} runs)`), ""];
  for (const run of runs) {
    const mode = run.dryRun ? ui.dim("dry-run") : ui.warn("apply");
    lines.push(
      `  ${ui.dim(run.startedAt)}  ${ui.bold(run.passType)}  ${colorizeStatus(run.status)}  ${mode}  ${run.actionsTaken} actions  ${formatUsd(run.estimatedCostUsd)}`,
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
    return `${ui.header(`Surgeon Actions ${runId}`)}\n\n${ui.dim("No surgeon actions recorded for this run.")}\n`;
  }

  const lines = [ui.header(`Surgeon Actions ${runId}`), ""];
  for (const action of actions) {
    lines.push(`  ${ui.dim(action.createdAt)}  ${ui.bold(action.actionType)}  entries=${action.entryIds.join(", ") || ui.dim("(none)")}`);
    lines.push(`    ${ui.dim(action.reasoning)}`);
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
    return `${ui.header(`Surgeon Proposals ${runId}`)}\n\n${ui.dim("No surgeon proposals recorded for this run.")}\n`;
  }

  const lines = [ui.header(`Surgeon Proposals ${runId}`), ""];
  for (const proposal of proposals) {
    const confidence = colorizeConfidence(proposal.confidence);
    const eligible = proposal.eligibleForApply ? ui.success("eligible") : ui.dim("not eligible");
    const status = colorizeProposalStatus(proposal.reviewStatus);
    lines.push(`  ${ui.dim(proposal.createdAt)}  ${ui.bold(proposal.issueKind)}  scope=${proposal.scope}  ${confidence}  ${eligible}  ${status}`);
    lines.push(`    entries: ${proposal.entryIds.join(", ") || ui.dim("(none)")}`);
    if (proposal.currentClaimKeys.length > 0 || proposal.proposedClaimKeys.length > 0) {
      lines.push(`    claim keys: ${proposal.currentClaimKeys.join(", ") || ui.dim("(none)")} -> ${proposal.proposedClaimKeys.join(", ") || ui.dim("(none)")}`);
    }
    if (proposal.reviewStatus !== "open") {
      lines.push(`    reviewed: ${ui.dim(proposal.reviewedAt ?? "n/a")}  applied: ${proposal.appliedActionCount}`);
      if (proposal.reviewReason) {
        lines.push(`    reason: ${ui.dim(proposal.reviewReason)}`);
      }
    }
    lines.push(`    ${ui.dim(proposal.rationale)}`);
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

  const headerSuffix = ui.dim(`(${filterParts.join(" ")})`);
  if (backlog.length === 0) {
    return `${ui.header("Surgeon Backlog")} ${headerSuffix}\n\n${ui.dim("No proposals matched the current filters.")}\n`;
  }

  const lines = [`${ui.header("Surgeon Backlog")} ${headerSuffix}`, ""];
  for (const item of backlog) {
    const confidence = colorizeConfidence(item.proposal.confidence);
    const eligible = item.proposal.eligibleForApply ? ui.success("eligible") : ui.dim("not eligible");
    const status = colorizeProposalStatus(item.proposal.reviewStatus);
    lines.push(`  ${ui.bold(item.proposal.issueKind)}  scope=${item.proposal.scope}  ${confidence}  ${eligible}  ${status}`);
    lines.push(`    ${ui.dim(item.proposal.id)}  ${ui.dim(item.proposal.createdAt)}`);
    lines.push(`    run: ${item.runPassType} ${colorizeStatus(item.runStatus)} (${item.runDryRun ? "dry-run" : "apply"}) ${ui.dim(item.runStartedAt)}`);
    lines.push(`    entries: ${item.proposal.entryIds.join(", ") || ui.dim("(none)")}`);
    if (item.proposal.proposedClaimKeys.length > 0) {
      lines.push(`    proposed: ${item.proposal.proposedClaimKeys.join(", ")}`);
    }
    lines.push("");
  }

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
    ui.header(`Proposal Review ${result.proposal.id}`),
    "",
    `${ui.label("Status")}    ${colorizeProposalStatus(result.proposal.reviewStatus)}`,
    `${ui.label("Reviewed")}  ${ui.dim(result.proposal.reviewedAt ?? "n/a")}`,
    `${ui.label("Actions")}   ${result.proposal.appliedActionCount} applied`,
    `${ui.label("Entries")}   ${result.updatedEntryIds.join(", ") || ui.dim("(none)")}`,
    `${ui.label("Backup")}    ${result.backupPath ? ui.dim(result.backupPath) : ui.dim("none")}`,
    `${ui.label("Reason")}    ${result.proposal.reviewReason ?? ui.dim("n/a")}`,
    "",
  ].join("\n");
}

/** Mutable display state shared by the progress reporter and the trace logger. */
interface SurgeonRunDisplay {
  /** Structured progress reporter for the surgeon runtime. */
  progressReporter: SurgeonProgressReporter;
  /** Logger that routes trace output through the display. */
  logger: Logger;
  /** Cleans up any active progress line before final output. */
  dispose(): void;
}

/**
 * Writes one formatted line to stderr. All surgeon progress uses this
 * instead of the shared logger so the output format is under CLI control.
 *
 * @param message - Pre-formatted message to write.
 */
function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Creates a stderr-based display that provides both a progress reporter and
 * a Logger for trace output. Phase transitions, claim-key-quality snapshots,
 * and agent trace events all flow through stderr with chalk formatting.
 *
 * @param verbose - Whether verbose trace detail is enabled.
 * @returns Display with progress reporter, logger, and cleanup handle.
 */
function createSurgeonRunDisplay(verbose: boolean): SurgeonRunDisplay {
  const progressReporter: SurgeonProgressReporter = (event: SurgeonProgressEvent): void => {
    if (event.kind === "phase") {
      handlePhaseEvent(event);
      return;
    }

    handleClaimKeyQualityEvent(event, verbose);
  };

  const logger: Logger = createDisplayLogger(verbose);

  return {
    progressReporter,
    logger,
    dispose(): void {
      /* no cleanup needed for line-based output */
    },
  };
}

/**
 * Handles one surgeon phase event by writing a structured line to stderr.
 *
 * @param event - Phase progress event.
 */
function handlePhaseEvent(event: Extract<SurgeonProgressEvent, { kind: "phase" }>): void {
  switch (event.phase) {
    case "start":
      writeStderr(`\n${ui.bold(`Surgeon run: ${event.passType}`)} ${ui.dim(`(${event.apply ? "apply" : "dry-run"})`)}`);
      return;
    case "backup_start":
      writeStderr(`  ${ui.dim("Creating DB backup...")}`);
      return;
    case "backup_complete":
      writeStderr(`  ${ui.success("Backup complete")}${event.backupPath ? ` ${ui.dim(event.backupPath)}` : ""}`);
      return;
    case "load_working_set_start":
      writeStderr(`  ${ui.dim("Loading working set...")}`);
      return;
    case "load_working_set_complete":
      writeStderr(`  ${ui.success("Working set loaded:")} ${formatOptionalCount(event.workingSetSize)} entries`);
      return;
    case "load_pass_context_start":
      writeStderr(`  ${ui.dim(`Loading ${event.passType} pass context...`)}`);
      return;
    case "load_pass_context_complete":
      writeStderr(`  ${ui.success("Pass context ready:")} ${formatOptionalCount(event.workingSetSize)} entries in scope`);
      return;
    case "pass_start":
      writeStderr(`  ${ui.bold(`Starting ${event.passType} pass`)}`);
      return;
    default:
      writeStderr(`  ${ui.dim(`Progress: ${event.phase}`)}`);
  }
}

/**
 * Handles one claim-key-quality progress event with moderate detail.
 *
 * @param event - Claim-key-quality progress snapshot.
 * @param verbose - Whether verbose detail is enabled.
 */
function handleClaimKeyQualityEvent(event: Extract<SurgeonProgressEvent, { kind: "claim_key_quality_progress" }>, verbose: boolean): void {
  if (event.stage === "health" && event.health) {
    const summary =
      `${event.health.totalEntries} entries, ` +
      `${event.health.missingCount} missing, ` +
      `${event.health.malformedOrNoncanonicalCount} invalid/noncanonical, ` +
      `${event.health.suspectCanonicalCount} suspect`;

    if (verbose) {
      const extra =
        `, ${event.health.entityFamilyGroupCount} entity families, ` +
        `${event.health.mixedGroupCount} mixed groups, ` +
        `coverage ${formatPercent(event.health.coveragePct)}`;
      writeStderr(`  ${ui.label("Health:")} ${summary}${extra}`);
    } else {
      writeStderr(`  ${ui.label("Health:")} ${summary}`);
    }
    return;
  }

  const stageLabel = formatClaimKeyQualityStage(event.stage);

  if (event.status === "started") {
    writeStderr(`  ${ui.dim(`${stageLabel}: ${event.total} ${event.unitLabel}`)}`);
    return;
  }

  const appliedTotal =
    event.counts.appliedNormalizations + event.counts.appliedBackfills + event.counts.appliedMetadataRewrites + event.counts.appliedEntityFamilyConvergences;

  if (event.status === "completed") {
    const completedMsg =
      `${stageLabel}: ${event.completed}/${event.total} ${event.unitLabel}, ` +
      `${appliedTotal} applied, ${event.counts.proposalsEmitted} proposals, ${formatElapsed(event.elapsedMs)}`;

    if (verbose) {
      const detail =
        ` (normalize ${event.counts.appliedNormalizations}/${event.counts.identifiedNormalizations}, ` +
        `backfill ${event.counts.appliedBackfills}/${event.counts.identifiedBackfills}, ` +
        `metadata ${event.counts.appliedMetadataRewrites}/${event.counts.identifiedMetadataRewrites}, ` +
        `family ${event.counts.appliedEntityFamilyConvergences}/${event.counts.identifiedEntityFamilyConvergences})`;
      writeStderr(`  ${ui.success(completedMsg)}${ui.dim(detail)}`);
    } else {
      writeStderr(`  ${ui.success(completedMsg)}`);
    }
    return;
  }

  // In-progress snapshot or preview_progress
  const previewTotal = formatOptionalCount(event.previewTotal);
  const previewCompleted = formatOptionalCount(event.previewCompleted);
  const previewSuffix = previewTotal > 0 ? `, preview ${previewCompleted}/${previewTotal}` : "";
  const progressMsg =
    `${stageLabel}: ${event.completed}/${event.total} ${event.unitLabel}${previewSuffix}, ` +
    `${appliedTotal} applied, ${event.counts.proposalsEmitted} proposals, ${formatElapsed(event.elapsedMs)}`;

  if (verbose) {
    const detail =
      ` (normalize ${event.counts.appliedNormalizations}/${event.counts.identifiedNormalizations}, ` +
      `backfill ${event.counts.appliedBackfills}/${event.counts.identifiedBackfills}, ` +
      `metadata ${event.counts.appliedMetadataRewrites}/${event.counts.identifiedMetadataRewrites}, ` +
      `family ${event.counts.appliedEntityFamilyConvergences}/${event.counts.identifiedEntityFamilyConvergences})`;
    writeStderr(`  ${ui.dim(progressMsg + detail)}`);
  } else {
    writeStderr(`  ${ui.dim(progressMsg)}`);
  }
}

/**
 * Creates a Logger that renders trace events to stderr, producing compact
 * summaries by default and full detail with `--verbose`.
 *
 * @param verbose - Whether verbose trace detail is enabled.
 * @returns Logger for the surgeon trace subsystem.
 */
function createDisplayLogger(verbose: boolean): Logger {
  const turnState = { turnNumber: 0, tools: [] as string[] };

  return {
    info(message: string): void {
      if (verbose) {
        writeStderr(`    ${ui.dim(message)}`);
        return;
      }

      const compact = formatCompactTraceLine(message, turnState);
      if (compact) {
        writeStderr(`    ${ui.dim(compact)}`);
      }
    },
    warn(message: string): void {
      writeStderr(`    ${ui.warn(message)}`);
    },
    error(message: string): void {
      writeStderr(`    ${ui.error(message)}`);
    },
    debug(message: string): void {
      if (verbose) {
        writeStderr(`    ${ui.dim(message)}`);
      }
    },
  };
}

/** Mutable turn tracking state for compact trace output. */
interface TurnTrackingState {
  turnNumber: number;
  tools: string[];
}

/**
 * Distills a raw trace logger message into a compact one-liner for the
 * default (non-verbose) display. Returns null when the message should be
 * suppressed entirely.
 *
 * @param message - Raw trace logger message.
 * @param state - Mutable turn tracking state.
 * @returns Compact message or null to suppress.
 */
function formatCompactTraceLine(message: string, state: TurnTrackingState): string | null {
  if (message.startsWith("surgeon turn started")) {
    state.turnNumber += 1;
    state.tools = [];
    return null;
  }

  // Track tool names for per-turn summary
  if (message.startsWith("tool ") && message.includes(" start")) {
    const toolName = message.split(" ")[1];
    if (toolName && !message.includes(" end")) {
      state.tools.push(toolName);
    }
    return null;
  }

  if (message.startsWith("tool ") && message.includes(" end")) {
    return null;
  }

  // Emit a compact turn summary at turn end
  if (message.startsWith("turn end")) {
    const costMatch = message.match(/costUsed=(\$[\d.]+)/);
    const cost = costMatch?.[1] ?? "";
    const toolList = state.tools.length > 0 ? state.tools.join(", ") : "no tools";
    return `Turn ${state.turnNumber}: ${toolList}${cost ? ` (${cost})` : ""}`;
  }

  // Emit surgeon actions as compact one-liners
  if (message.startsWith("action ")) {
    return message;
  }

  // Suppress assistant messages and agent end in compact mode
  if (message.startsWith("assistant ") || message.startsWith("agent end")) {
    return null;
  }

  return message;
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
 * Applies color to a surgeon run status string.
 *
 * @param status - Raw status string from the run result.
 * @returns Colorized status for CLI output.
 */
function colorizeStatus(status: string): string {
  switch (status) {
    case "completed":
      return ui.success(status);
    case "no_work":
      return ui.dim(status);
    case "failed":
      return ui.error(status);
    case "aborted":
    case "stalled":
    case "cost_capped":
    case "budget_exhausted":
      return ui.warn(status);
    default:
      return status;
  }
}

/**
 * Applies color to a proposal review status string.
 *
 * @param status - Raw review status.
 * @returns Colorized proposal status for CLI output.
 */
function colorizeProposalStatus(status: string): string {
  switch (status) {
    case "applied":
      return ui.success(status);
    case "rejected":
      return ui.error(status);
    case "open":
      return ui.warn(status);
    default:
      return status;
  }
}

/**
 * Applies color to a confidence score.
 *
 * @param confidence - Numeric confidence between 0 and 1.
 * @returns Colorized confidence string for CLI output.
 */
function colorizeConfidence(confidence: number): string {
  const label = `confidence=${confidence.toFixed(2)}`;
  if (confidence >= 0.8) {
    return ui.success(label);
  }
  if (confidence >= 0.5) {
    return ui.warn(label);
  }
  return ui.error(label);
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
