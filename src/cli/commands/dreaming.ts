import { InvalidArgumentError, Option, type Command } from "commander";

import {
  loadDreamActionsRuntime,
  loadDreamBacklogRuntime,
  loadDreamHistoryRuntime,
  loadDreamProfileRuntime,
  loadDreamProposalsRuntime,
  loadDreamSummaryRuntime,
  loadDreamStatusRuntime,
  reviewDreamProposalRuntime,
  runDreamRuntime,
  type DreamRuntimeOptions,
} from "../../app/dreaming/runtime.js";
import { DREAM_TIERS, type DreamProposalReviewStatus, type DreamTier } from "../../core/dreaming/types.js";
import type { Durable } from "../../core/types.js";
import { normalizeOptionalString, parseNonNegativeInteger, parsePositiveInteger } from "../shared/parse.js";

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

/** Parsed commander options for `agenr dream backlog`. */
interface DreamBacklogCommandOptions {
  state?: DreamProposalReviewStatus | "all";
  issueKind?: string;
  eligibleOnly?: boolean;
  durableId?: string;
  limit?: number;
  offset?: number;
}

/** Parsed commander options for `agenr dream review`. */
interface DreamReviewCommandOptions {
  decision?: "apply" | "reject";
  reason?: string;
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

  dreamCommand
    .command("profile")
    .description("Show the active dreaming profile snapshot")
    .option("--json", "Emit machine-readable JSON output")
    .action(async (options: { json?: boolean }) => {
      try {
        const profile = await loadDreamProfileRuntime({ env: process.env });
        process.stdout.write(options.json ? `${JSON.stringify(profile, null, 2)}\n` : renderProfile(profile));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Dream profile failed: ${formatUnknownError(error)}\n`);
      }
    });

  dreamCommand
    .command("summary")
    .description("Show a human-readable summary of current dreamed memory")
    .option("--json", "Emit machine-readable JSON output")
    .action(async (options: { json?: boolean }) => {
      try {
        const summary = await loadDreamSummaryRuntime({ env: process.env });
        process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : renderSummary(summary));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Dream summary failed: ${formatUnknownError(error)}\n`);
      }
    });

  dreamCommand
    .command("actions <runId>")
    .description("Show actions recorded for a dreaming run")
    .option("--json", "Emit machine-readable JSON output")
    .action(async (runId: string, options: { json?: boolean }) => {
      try {
        const actions = await loadDreamActionsRuntime({ runId, env: process.env });
        process.stdout.write(options.json ? `${JSON.stringify(actions, null, 2)}\n` : renderActions(runId, actions));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Dream actions failed: ${formatUnknownError(error)}\n`);
      }
    });

  dreamCommand
    .command("proposals <runId>")
    .description("Show proposals recorded for a dreaming run")
    .option("--json", "Emit machine-readable JSON output")
    .action(async (runId: string, options: { json?: boolean }) => {
      try {
        const proposals = await loadDreamProposalsRuntime({ runId, env: process.env });
        process.stdout.write(options.json ? `${JSON.stringify(proposals, null, 2)}\n` : renderProposals(runId, proposals));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Dream proposals failed: ${formatUnknownError(error)}\n`);
      }
    });

  dreamCommand
    .command("backlog")
    .description("Show the dreaming proposal backlog across runs")
    .addOption(new Option("--state <state>", "Proposal state filter").choices(["open", "applied", "rejected", "all"]).default("open"))
    .option("--issue-kind <kind>", "Only proposals for one issue kind")
    .option("--eligible-only", "Only proposals that are already safe to apply")
    .option("--durable-id <id>", "Only proposals that mention one durable ID")
    .addOption(new Option("--limit <n>", "Maximum number of proposals to show").argParser(parsePositiveInteger).default(20))
    .addOption(new Option("--offset <n>", "Rows to skip before listing results").argParser(parseNonNegativeInteger).default(0))
    .option("--json", "Emit machine-readable JSON output")
    .action(async (options: DreamBacklogCommandOptions & { json?: boolean }) => {
      try {
        const backlog = await loadDreamBacklogRuntime({
          state: options.state,
          issueKind: normalizeOptionalString(options.issueKind),
          eligibleOnly: options.eligibleOnly === true,
          durableId: normalizeOptionalString(options.durableId),
          limit: options.limit,
          offset: options.offset,
          env: process.env,
        });
        process.stdout.write(options.json ? `${JSON.stringify(backlog, null, 2)}\n` : renderBacklog(backlog));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Dream backlog failed: ${formatUnknownError(error)}\n`);
      }
    });

  dreamCommand
    .command("review <proposalId>")
    .description("Apply or reject one open dreaming proposal")
    .addOption(new Option("--decision <decision>", "Review decision").choices(["apply", "reject"]).makeOptionMandatory(true))
    .option("--reason <text>", "Why this review decision was taken")
    .option("--json", "Emit machine-readable JSON output")
    .action(async (proposalId: string, options: DreamReviewCommandOptions & { json?: boolean }) => {
      try {
        const reason = normalizeOptionalString(options.reason);
        if (!reason) {
          throw new InvalidArgumentError("Review reason is required.");
        }

        const result = await reviewDreamProposalRuntime({
          proposalId,
          decision: options.decision ?? "reject",
          reason,
          env: process.env,
        });
        process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : renderProposalReviewResult(result));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Dream review failed: ${formatUnknownError(error)}\n`);
      }
    });
}

/** Normalizes CLI options for the dream run command. */
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

/** Renders the human-readable result for a dream run. */
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

/** Renders the human-readable dreaming status summary. */
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

/** Renders the human-readable dreaming run history. */
function renderHistory(history: Awaited<ReturnType<typeof loadDreamHistoryRuntime>>): string {
  if (history.length === 0) {
    return "No dreaming runs recorded.\n";
  }

  return history
    .map((run) => `${run.startedAt}  ${run.id}  tier=${run.tier}  status=${run.status}  dryRun=${run.dryRun}`)
    .join("\n")
    .concat("\n");
}

/** Renders the active dreaming profile snapshot. */
function renderProfile(profile: Awaited<ReturnType<typeof loadDreamProfileRuntime>>): string {
  if (!profile.snapshot) {
    return "No active dream profile snapshot.\n";
  }

  const lines = [
    "Dream profile",
    `  snapshot: ${profile.snapshot.id}`,
    `  as of: ${profile.snapshot.asOf}`,
    `  created: ${profile.snapshot.createdAt}`,
    `  run: ${profile.snapshot.runId ?? "none"}`,
    `  content hash: ${profile.snapshot.contentHash}`,
    "  profile durables:",
    ...renderDurableList(profile.profileDurables, "    "),
    "  directives:",
    ...renderDirectiveList(profile.directiveDurables, "    "),
  ];

  return `${lines.join("\n")}\n`;
}

/** Renders the compact dreaming summary view. */
function renderSummary(summary: Awaited<ReturnType<typeof loadDreamSummaryRuntime>>): string {
  if (!summary.snapshot) {
    return ["Dream summary", "  active profile: none", `  active durables: ${summary.health.total}`, `  open proposals: ${summary.openProposalCount}`]
      .join("\n")
      .concat("\n");
  }

  const grouped = groupDurablesByClaimFamily(summary.profileDurables);
  const lines = [
    "Dream summary",
    `  snapshot: ${summary.snapshot.id}`,
    `  snapshot age: ${formatSnapshotAge(summary.snapshot.createdAt)}`,
    `  run: ${summary.snapshot.runId ?? "none"}`,
    `  open proposals: ${summary.openProposalCount}`,
    "  profile by claim-key family:",
  ];

  for (const [family, durables] of grouped) {
    lines.push(`    ${family}`);
    lines.push(...renderDurableList(durables, "      "));
  }

  const standing = summary.profileDurables.filter((durable) => durable.type === "preference" || durable.type === "decision");
  lines.push("  standing preferences and constraints:");
  lines.push(...renderDurableList(standing, "    "));

  const temporal = summary.profileDurables.filter((durable) => durable.valid_from || durable.valid_to);
  lines.push("  active temporal facts:");
  lines.push(...renderDurableList(temporal, "    "));

  lines.push("  directive durables:");
  lines.push(...renderDirectiveList(summary.directiveDurables, "    "));

  return `${lines.join("\n")}\n`;
}

/** Renders durable rows with the provided indentation prefix. */
function renderDurableList(durables: Durable[], prefix: string): string[] {
  if (durables.length === 0) {
    return [`${prefix}(none)`];
  }

  return durables.map((durable) => {
    const validity = durable.valid_from || durable.valid_to ? ` valid=${durable.valid_from ?? "?"}->${durable.valid_to ?? "ongoing"}` : "";
    return `${prefix}- ${durable.subject} [${durable.id}] type=${durable.type} importance=${durable.importance} expiry=${durable.expiry}${validity}`;
  });
}

/** Renders directive durable rows with the provided indentation prefix. */
function renderDirectiveList(durables: Durable[], prefix: string): string[] {
  if (durables.length === 0) {
    return [`${prefix}(none)`];
  }

  return durables.map(
    (durable) =>
      `${prefix}- ${durable.subject} [${durable.id}] polarity=${durable.directive_polarity ?? "abstain"} trigger=${durable.directive_trigger ?? "always"}`,
  );
}

/** Groups durables by claim-key family for summary rendering. */
function groupDurablesByClaimFamily(durables: Durable[]): Map<string, Durable[]> {
  const grouped = new Map<string, Durable[]>();
  for (const durable of durables) {
    const family = claimFamily(durable);
    grouped.set(family, [...(grouped.get(family) ?? []), durable]);
  }

  return grouped;
}

/** Resolves the display claim-key family for one durable. */
function claimFamily(durable: Durable): string {
  const claimKey = durable.claim_key?.trim();
  if (!claimKey) {
    return `unkeyed/${durable.type}`;
  }

  const parts = claimKey.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : claimKey;
}

/** Formats a profile snapshot age for CLI output. */
function formatSnapshotAge(createdAt: string): string {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) {
    return "unknown";
  }

  const ageMinutes = Math.max(0, Math.round((Date.now() - createdMs) / 60_000));
  if (ageMinutes < 60) {
    return `${ageMinutes}m`;
  }

  const ageHours = Math.floor(ageMinutes / 60);
  const remainingMinutes = ageMinutes % 60;
  return remainingMinutes === 0 ? `${ageHours}h` : `${ageHours}h ${remainingMinutes}m`;
}

/** Renders the action log for one dreaming run. */
function renderActions(runId: string, actions: Awaited<ReturnType<typeof loadDreamActionsRuntime>>): string {
  if (actions.length === 0) {
    return `No dreaming actions recorded for run ${runId}.\n`;
  }

  const lines = [`Dream actions ${runId}`];
  for (const action of actions) {
    lines.push(`  ${action.createdAt}  ${action.actionType}  durables=${action.durableIds.join(", ") || "(none)"}`);
    lines.push(`    ${action.reasoning}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Renders proposals emitted by one dreaming run. */
function renderProposals(runId: string, proposals: Awaited<ReturnType<typeof loadDreamProposalsRuntime>>): string {
  if (proposals.length === 0) {
    return `No dreaming proposals recorded for run ${runId}.\n`;
  }

  const lines = [`Dream proposals ${runId}`];
  for (const proposal of proposals) {
    const eligible = proposal.eligibleForApply ? "eligible" : "not eligible";
    lines.push(
      `  ${proposal.id}  ${proposal.issueKind}  scope=${proposal.scope}  confidence=${proposal.confidence.toFixed(2)}  ${eligible}  ${proposal.reviewStatus}`,
    );
    lines.push(`    durables: ${proposal.durableIds.join(", ") || "(none)"}`);
    if (proposal.currentClaimKeys.length > 0 || proposal.proposedClaimKeys.length > 0) {
      lines.push(`    claim keys: ${proposal.currentClaimKeys.join(", ") || "(none)"} -> ${proposal.proposedClaimKeys.join(", ") || "(none)"}`);
    }
    if (proposal.reviewStatus !== "open") {
      lines.push(`    reviewed: ${proposal.reviewedAt ?? "n/a"}  applied: ${proposal.appliedActionCount}`);
      if (proposal.reviewReason) {
        lines.push(`    reason: ${proposal.reviewReason}`);
      }
    }
    lines.push(`    ${proposal.rationale}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Renders the open dreaming proposal backlog. */
function renderBacklog(backlog: Awaited<ReturnType<typeof loadDreamBacklogRuntime>>): string {
  if (backlog.length === 0) {
    return "No dreaming proposals matched the current filters.\n";
  }

  const lines = ["Dream backlog"];
  for (const item of backlog) {
    const eligible = item.proposal.eligibleForApply ? "eligible" : "not eligible";
    lines.push(
      `  ${item.proposal.issueKind}  scope=${item.proposal.scope}  confidence=${item.proposal.confidence.toFixed(2)}  ${eligible}  ${item.proposal.reviewStatus}`,
    );
    lines.push(`    ${item.proposal.id}  ${item.proposal.createdAt}`);
    lines.push(`    run: ${item.runPassType} ${item.runStatus} (${item.runDryRun ? "dry-run" : "apply"}) ${item.runStartedAt}`);
    lines.push(`    durables: ${item.proposal.durableIds.join(", ") || "(none)"}`);
    if (item.proposal.proposedClaimKeys.length > 0) {
      lines.push(`    proposed: ${item.proposal.proposedClaimKeys.join(", ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Renders the result of reviewing a dreaming proposal. */
function renderProposalReviewResult(result: Awaited<ReturnType<typeof reviewDreamProposalRuntime>>): string {
  return [
    `Proposal review ${result.proposal.id}`,
    `  status: ${result.proposal.reviewStatus}`,
    `  reviewed: ${result.proposal.reviewedAt ?? "n/a"}`,
    `  actions applied: ${result.proposal.appliedActionCount}`,
    `  durables: ${result.updatedDurableIds.join(", ") || "(none)"}`,
    `  backup: ${result.backupPath ?? "none"}`,
    `  reason: ${result.proposal.reviewReason ?? "n/a"}`,
  ]
    .join("\n")
    .concat("\n");
}

/** Formats unknown command errors for stderr output. */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
