import { createDreamPort } from "../../adapters/db/dreaming-port.js";
import { normalizeManualClaimKeyUpdate } from "../../core/claim-key-lifecycle.js";
import {
  buildMixedClaimKeySettlementReason,
  isManualMixedClaimKeyProposal,
  type ManualMixedSettlementChoice,
} from "../../core/dreaming/domain/proposal-review.js";
import type { DurableUpdateInput } from "../../core/types.js";
import { resolveLocalFilesystemPath } from "../../filesystem-path.js";
import { backupDatabaseFile } from "../dreaming/service.js";
import type { DreamProposalReviewResult } from "../dreaming/runtime.js";
import { withInstanceDatabase, type WebInstanceContext } from "./instance-context.js";

/** Provenance source-file label stamped on manual settlement writes. */
const WEB_SOURCE_FILE = "agenr-web";

export type { ManualMixedSettlementChoice };

/**
 * Atomically settles one open mixed-key proposal that lacks a safe direct target.
 *
 * @param input - Proposal id, settlement choice, reason, and instance binding.
 * @returns Final proposal state plus backup path when one was created.
 * @throws Error When the proposal is not eligible for manual settlement.
 */
export async function settleManualMixedWebProposal(input: {
  proposalId: string;
  choice: ManualMixedSettlementChoice;
  reason: string;
  targetClaimKey?: string;
  retireDurableIds?: string[];
  context: WebInstanceContext;
}): Promise<DreamProposalReviewResult> {
  const note = input.reason.trim();
  if (note.length === 0) {
    throw new Error("A non-empty settlement note is required.");
  }

  const backupPath = await maybeBackup(input.context.dbPath);
  const reviewedAt = new Date().toISOString();
  const settlementReason = buildMixedClaimKeySettlementReason(
    input.choice,
    note,
    input.targetClaimKey?.trim() ?? "",
    input.retireDurableIds?.length ?? 0,
  );

  return withInstanceDatabase(input.context, async (database) => {
    const port = createDreamPort(database);
    const proposal = await port.getProposal(input.proposalId);
    if (!proposal) {
      throw new Error(`Proposal not found: ${input.proposalId}.`);
    }
    if (proposal.reviewStatus !== "open") {
      throw new Error(`Proposal ${proposal.id} was already reviewed as ${proposal.reviewStatus}.`);
    }
    if (!isManualMixedClaimKeyProposal(proposal)) {
      throw new Error(`Proposal ${proposal.id} is not eligible for manual mixed-key settlement.`);
    }

    const activeDurables = await port.getDurables(proposal.durableIds);
    const activeIds = new Set(activeDurables.map((durable) => durable.id));
    const inactiveDurableIds = proposal.durableIds.filter((id) => !activeIds.has(id));
    if (inactiveDurableIds.length > 0) {
      throw new Error(`Proposal ${proposal.id} can no longer settle missing or inactive durable ${inactiveDurableIds[0]}.`);
    }

    await port.withTransaction(async (tx) => {
      if (input.choice === "canonical") {
        const targetClaimKey = input.targetClaimKey?.trim() ?? "";
        if (targetClaimKey.length === 0) {
          throw new Error("A canonical claim key is required for this settlement choice.");
        }
        const patch = buildManualClaimKeyPatch(targetClaimKey);
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
function buildManualClaimKeyPatch(claimKey: string): DurableUpdateInput {
  try {
    const normalized = normalizeManualClaimKeyUpdate({
      claimKey,
      rawClaimKey: claimKey,
      supportSourceKind: "tool_call",
      supportLocator: `${WEB_SOURCE_FILE}#settle-mixed`,
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
