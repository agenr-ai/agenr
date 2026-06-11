import { InvalidArgumentError, Option, type Command } from "commander";

import { createDatabase } from "../../adapters/db/client.js";
import { createProcedureProposalRepository } from "../../adapters/db/procedure-proposal-repository.js";
import { createEmbeddingClient, resolveEmbeddingApiKey, resolveEmbeddingModel } from "../../adapters/embeddings.js";
import { applyProcedureProposal, rejectProcedureProposal } from "../../app/procedures/proposals/service.js";
import { PROCEDURE_PROPOSAL_STATUSES, type ProcedureProposalRecord, type ProcedureProposalStatus } from "../../app/procedures/proposals/repository.js";
import { readConfig } from "../../config.js";
import { normalizeOptionalString, parsePositiveInteger } from "../shared/parse.js";

const DEFAULT_PROCEDURES_DIR = "procedures";

/** Parsed commander options for `agenr procedures proposals`. */
interface ProcedureProposalsCommandOptions {
  status?: ProcedureProposalStatus | "all";
  limit?: number;
  json?: boolean;
}

/** Parsed commander options for `agenr procedures review`. */
interface ProcedureReviewCommandOptions {
  decision?: "apply" | "reject";
  reason?: string;
  path?: string;
  key?: string;
  procedures?: string;
  json?: boolean;
}

/**
 * Registers the `agenr procedures` command group and its subcommands.
 *
 * @param program - Root Commander program to extend.
 */
export function registerProceduresCommand(program: Command): void {
  const proceduresCommand = program.command("procedures").description("Inspect and review procedure proposals promoted from working memory");

  proceduresCommand
    .command("proposals")
    .description("List procedure proposals promoted from working-memory candidates")
    .addOption(new Option("--status <status>", "Filter by review status").choices([...PROCEDURE_PROPOSAL_STATUSES, "all"]).default("open"))
    .option("--limit <count>", "Maximum number of proposals to list", parsePositiveInteger)
    .option("--json", "Emit machine-readable JSON output")
    .action(async (options: ProcedureProposalsCommandOptions) => {
      let database: Awaited<ReturnType<typeof createDatabase>> | null = null;
      try {
        const config = readConfig();
        database = await createDatabase(config.dbPath);
        const repository = createProcedureProposalRepository(database);
        const proposals = await repository.listProposals({
          ...(options.status && options.status !== "all" ? { statuses: [options.status] } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        });
        process.stdout.write(options.json ? `${JSON.stringify(proposals, null, 2)}\n` : renderProposalList(proposals));
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Procedure proposals listing failed: ${formatUnknownError(error)}\n`);
      } finally {
        await database?.close();
      }
    });

  proceduresCommand
    .command("review <proposalId>")
    .description("Apply or reject one open procedure proposal; apply writes a draft YAML and syncs it")
    .addOption(new Option("--decision <decision>", "Review decision").choices(["apply", "reject"]).makeOptionMandatory(true))
    .option("--reason <text>", "Why this review decision was taken")
    .option("--path <relativePath>", "Relative YAML path to write inside the procedures directory on apply")
    .option("--key <procedureKey>", "Explicit procedure key for the applied draft")
    .option("--procedures <dir>", "Procedures workspace directory", DEFAULT_PROCEDURES_DIR)
    .option("--json", "Emit machine-readable JSON output")
    .action(async (proposalId: string, options: ProcedureReviewCommandOptions) => {
      let database: Awaited<ReturnType<typeof createDatabase>> | null = null;
      try {
        const reason = normalizeOptionalString(options.reason);
        if (!reason) {
          throw new InvalidArgumentError("Review reason is required.");
        }

        const config = readConfig();
        database = await createDatabase(config.dbPath);
        const repository = createProcedureProposalRepository(database);
        const now = new Date().toISOString();

        if (options.decision === "reject") {
          const result = await rejectProcedureProposal({ repository }, { proposalId, reason, now });
          if (!result.ok) {
            throw new Error(describeReviewFailure(result.failure));
          }

          process.stdout.write(options.json ? `${JSON.stringify(result.proposal, null, 2)}\n` : `Rejected proposal ${result.proposal.id}.\n`);
          return;
        }

        const embedding = createEmbeddingClient(resolveEmbeddingApiKey(config), resolveEmbeddingModel(config));
        const result = await applyProcedureProposal(
          {
            repository,
            embedding,
            proceduresDir: options.procedures ?? DEFAULT_PROCEDURES_DIR,
            dbPath: config.dbPath,
          },
          {
            proposalId,
            reason,
            ...(options.key ? { procedureKey: options.key } : {}),
            ...(options.path ? { relativePath: options.path } : {}),
            now,
          },
        );
        if (!result.ok) {
          throw new Error(describeReviewFailure(result.failure));
        }

        process.stdout.write(
          options.json
            ? `${JSON.stringify({ proposal: result.proposal, relativePath: result.relativePath }, null, 2)}\n`
            : `Applied proposal ${result.proposal.id}: wrote ${result.relativePath} and synced procedures.\n`,
        );
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`Procedure proposal review failed: ${formatUnknownError(error)}\n`);
      } finally {
        await database?.close();
      }
    });
}

/** Renders one human-readable proposal list. */
function renderProposalList(proposals: ProcedureProposalRecord[]): string {
  if (proposals.length === 0) {
    return "No procedure proposals found.\n";
  }

  const lines = proposals.map((proposal) => {
    const parts = [`${proposal.id}`, `[${proposal.status}]`, proposal.subject, `(working set ${proposal.workingSetId}, created ${proposal.createdAt})`];
    if (proposal.appliedProcedurePath) {
      parts.push(`-> ${proposal.appliedProcedurePath}`);
    }

    return parts.join(" ");
  });

  return `${lines.join("\n")}\n`;
}

/** Describes one stable review failure for CLI output. */
function describeReviewFailure(failure: { kind: string } & Record<string, unknown>): string {
  switch (failure.kind) {
    case "not_found":
      return "Proposal not found.";
    case "already_reviewed":
      return `Proposal was already reviewed (status: ${String(failure.status)}).`;
    case "invalid_draft":
      return `Draft procedure failed validation: ${String(failure.message)}`;
    default:
      return `Review failed (${failure.kind}).`;
  }
}

/** Converts unknown thrown values into readable error messages. */
function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
