import { randomUUID } from "node:crypto";

import { buildClaimKeyLifecycleUpdateFields, buildSurgeonAppliedClaimKeyLifecycleBundle } from "../../core/claim-key-lifecycle.js";
import { buildSurgeonProposalReviewReason, resolveSurgeonProposalApplyTarget } from "../../core/surgeon/domain/proposal-review.js";
import type { SurgeonRunAction } from "../../core/surgeon/domain/action-types.js";
import type { SurgeonRunProposal } from "../../core/surgeon/types.js";
import type { Entry, EntryUpdateInput } from "../../core/types.js";

/**
 * Persistence dependencies needed by surgeon proposal review helpers.
 */
export interface SurgeonProposalReviewDeps {
  updateEntry(entryId: string, fields: EntryUpdateInput): Promise<boolean>;
  logRunAction(action: SurgeonRunAction): Promise<void>;
}

/**
 * Loads the active entries still eligible for one proposal apply path.
 *
 * @param proposal - Proposal selected for application.
 * @param getEntry - Active-entry lookup function.
 * @returns Active entries plus missing-or-inactive identifiers.
 */
export async function loadActiveProposalEntries(
  proposal: Pick<SurgeonRunProposal, "entryIds">,
  getEntry: (entryId: string) => Promise<Entry | null>,
): Promise<{ activeEntries: Entry[]; inactiveEntryIds: string[] }> {
  const activeEntries: Entry[] = [];
  const inactiveEntryIds: string[] = [];

  for (const entryId of proposal.entryIds) {
    const entry = await getEntry(entryId);
    if (!entry) {
      inactiveEntryIds.push(entryId);
      continue;
    }

    activeEntries.push(entry);
  }

  return {
    activeEntries,
    inactiveEntryIds,
  };
}

/**
 * Applies one surgeon proposal to the provided active entries and records the matching audit action.
 *
 * @param input - Proposal, review metadata, and active target entries.
 * @param deps - Persistence helpers used for updates and action logging.
 * @returns Updated entry IDs and the resolved target claim key.
 */
export async function applyProposalToEntries(
  input: {
    proposal: SurgeonRunProposal;
    activeEntries: Entry[];
    reviewReason: string;
    reviewedAt: string;
    actionReviewStatus: "applied" | "dry_run";
    actionRunId?: string;
    requireAllUpdates?: boolean;
  },
  deps: SurgeonProposalReviewDeps,
): Promise<{ updatedEntryIds: string[]; targetClaimKey: string; reasoning: string }> {
  const targetClaimKey = resolveSurgeonProposalApplyTarget(input.proposal);
  const reasoning = buildSurgeonProposalReviewReason(input.proposal, input.reviewReason);
  const updatedEntryIds: string[] = [];

  for (const entry of input.activeEntries) {
    const lifecycle = buildSurgeonAppliedClaimKeyLifecycleBundle({
      targetClaimKey,
      priorClaimKey: entry.claim_key ?? null,
      priorClaimKeyRaw: entry.claim_key_raw,
      source: input.proposal.source,
      confidence: input.proposal.confidence,
      rationale: reasoning,
    });
    const updated = await deps.updateEntry(entry.id, buildClaimKeyLifecycleUpdateFields(lifecycle));
    if (!updated && input.requireAllUpdates) {
      throw new Error(`Failed to apply proposal ${input.proposal.id} to entry ${entry.id}.`);
    }
    if (updated) {
      updatedEntryIds.push(entry.id);
    }
  }

  if (updatedEntryIds.length > 0) {
    await deps.logRunAction({
      id: randomUUID(),
      runId: input.actionRunId ?? input.proposal.runId,
      actionType: "update_entry",
      entryIds: updatedEntryIds,
      reasoning,
      recallDelta: null,
      details: {
        proposal_id: input.proposal.id,
        proposal_issue_kind: input.proposal.issueKind,
        proposal_source: input.proposal.source,
        proposal_review_status: input.actionReviewStatus,
        target_claim_key: targetClaimKey,
      },
      createdAt: input.reviewedAt,
    });
  }

  return {
    updatedEntryIds,
    targetClaimKey,
    reasoning,
  };
}
