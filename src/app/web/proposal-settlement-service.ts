import { createDreamPort } from "../../adapters/db/dreaming-port.js";
import { normalizeManualClaimKeyUpdate } from "../../core/claim-key-lifecycle.js";
import {
  buildManualProposalSettlementReason,
  isManualProposalSettlementEligible,
  type ManualProposalSettlementChoice,
} from "../../core/dreaming/domain/proposal-review.js";
import type { DurableUpdateInput } from "../../core/types.js";
import { resolveLocalFilesystemPath } from "../../filesystem-path.js";
import { backupDatabaseFile } from "../dreaming/service.js";
import type { DreamProposalReviewResult } from "../dreaming/runtime.js";
import { withInstanceDatabase, type WebInstanceContext } from "./instance-context.js";

/** Provenance source-file label stamped on manual settlement writes. */
const WEB_SOURCE_FILE = "agenr-web";

export type { ManualProposalSettlementChoice };

/**
 * Atomically settles one open proposal that lacks a safe direct target.
 *
 * @param input - Proposal id, settlement choice, reason, and instance binding.
 * @returns Final proposal state plus backup path when one was created.
 * @throws Error When the proposal is not eligible for manual settlement.
 */
export async function settleManualWebProposal(input: {
  proposalId: string;
  choice: ManualProposalSettlementChoice;
  reason: string;
  targetClaimKey?: string;
  retireDurableIds?: string[];
  context: WebInstanceContext;
}): Promise<DreamProposalReviewResult> {
  return settleManualProposal({
    ...input,
    buildReason: (proposal) =>
      buildManualProposalSettlementReason(
        proposal.issueKind,
        input.choice,
        input.reason.trim(),
        input.targetClaimKey?.trim() ?? "",
        normalizeStringIds(input.retireDurableIds ?? []).length,
      ),
    supportLocator: `${WEB_SOURCE_FILE}#settle-proposal`,
    validateProposal: (proposal) => {
      if (!isManualProposalSettlementEligible(proposal)) {
        throw new Error(`Proposal ${proposal.id} is not eligible for manual settlement.`);
      }
    },
  });
}

/**
 * Shared settlement implementation for proposal types that require explicit operator judgment.
 *
 * @param input - Settlement request, validation policy, and persistence context.
 * @returns Final proposal state plus backup path when one was created.
 */
async function settleManualProposal(input: {
  proposalId: string;
  choice: ManualProposalSettlementChoice;
  reason: string;
  targetClaimKey?: string;
  retireDurableIds?: string[];
  context: WebInstanceContext;
  buildReason: (proposal: { issueKind: string }) => string;
  supportLocator: string;
  validateProposal: (proposal: { id: string; issueKind: string; eligibleForApply: boolean; proposedClaimKeys: string[] }) => void;
}): Promise<DreamProposalReviewResult> {
  const note = input.reason.trim();
  if (note.length === 0) {
    throw new Error("A non-empty settlement note is required.");
  }

  const backupPath = await maybeBackup(input.context.dbPath);
  const reviewedAt = new Date().toISOString();

  return withInstanceDatabase(input.context, async (database) => {
    const port = createDreamPort(database);
    const proposal = await port.getProposal(input.proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: ${input.proposalId}.`);
    }
    if (proposal.reviewStatus !== "open") {
      throw new Error(`Proposal ${proposal.id} was already reviewed as ${proposal.reviewStatus}.`);
    }
    input.validateProposal(proposal);
    const settlementReason = input.buildReason(proposal);

    const activeDurables = await port.getDurables(proposal.durableIds);
    const activeIds = new Set(activeDurables.map((durable) => durable.id));

    await port.withTransaction(async (tx) => {
      if (input.choice === "canonical") {
        const targetClaimKey = input.targetClaimKey?.trim() ?? "";
        if (targetClaimKey.length === 0) {
          throw new Error("A canonical claim key is required for this settlement choice.");
        }
        const patch = buildManualClaimKeyPatch(targetClaimKey, input.supportLocator);
        for (const durable of activeDurables) {
          if (durable.claim_key !== targetClaimKey) {
            const updated = await tx.updateDurable(durable.id, patch);
            if (!updated) {
              throw new Error(`Failed to write canonical claim key to durable ${durable.id}.`);
            }
          }
        }
      } else if (input.choice === "retire") {
        const retireIds = normalizeStringIds(input.retireDurableIds ?? []);
        if (retireIds.length === 0) {
          throw new Error("Select at least one durable to retire.");
        }
        for (const durableId of retireIds) {
          if (!activeIds.has(durableId)) {
            throw new Error(`Durable ${durableId} is not part of proposal ${proposal.id}.`);
          }
          const updated = await tx.closeDurableValidity(durableId, settlementReason);
          if (!updated) {
            throw new Error(`Failed to retire durable ${durableId}.`);
          }
        }
      }

      const reviewed = await tx.reviewProposal({
        proposalId: proposal.id,
        status: "rejected",
        reason: settlementReason,
        reviewedAt,
        appliedActionCount: 0,
      });
      if (!reviewed) {
        throw new Error(`Proposal ${proposal.id} could not be marked rejected because it is no longer open.`);
      }
    });

    const reviewedProposal = await port.getProposal(proposal.id);
    if (!reviewedProposal) {
      throw new Error(`Proposal ${proposal.id} disappeared after settlement.`);
    }

    return {
      proposal: reviewedProposal,
      updatedDurableIds: [],
      backupPath,
    };
  });
}

/** Normalizes a console-supplied claim key into a durable metadata patch. */
function buildManualClaimKeyPatch(claimKey: string, supportLocator: string): DurableUpdateInput {
  try {
    const normalized = normalizeManualClaimKeyUpdate({
      claimKey,
      rawClaimKey: claimKey,
      supportSourceKind: "tool_call",
      supportLocator,
      supportObservedAt: new Date().toISOString(),
      supportMode: "explicit",
    });
    return normalized.updateFields;
  } catch {
    throw new Error("Claim key must use the canonical entity/attribute format.");
  }
}

/** Normalizes a list of durable ids, dropping blanks. */
function normalizeStringIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

/** Creates a database backup when the path is a real local file. */
async function maybeBackup(dbPath: string): Promise<string | null> {
  if (dbPath === ":memory:" || resolveLocalFilesystemPath(dbPath) === null) {
    return null;
  }

  return backupDatabaseFile(dbPath);
}
