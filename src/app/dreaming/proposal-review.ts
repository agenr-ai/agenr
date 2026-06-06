import { randomUUID } from "node:crypto";

import { buildClaimKeyLifecycleUpdateFields, buildReconcileAppliedClaimKeyLifecycleBundle } from "../../core/claim-key-lifecycle.js";
import type { DreamRunAction } from "../../core/dreaming/domain/action-types.js";
import { buildDreamProposalReviewReason, resolveDreamProposalApplyTarget } from "../../core/dreaming/domain/proposal-review.js";
import type { DreamRunProposal } from "../../core/dreaming/types.js";
import type { Durable, DurableUpdateInput } from "../../core/types.js";

/**
 * Persistence dependencies needed by dreaming proposal review helpers.
 */
export interface DreamProposalReviewDeps {
  updateDurable(durableId: string, fields: DurableUpdateInput): Promise<boolean>;
  logRunAction(action: DreamRunAction): Promise<void>;
}

/**
 * Loads the active durables still eligible for one proposal apply path.
 *
 * @param proposal - Proposal selected for application.
 * @param getDurable - Active-durable lookup function.
 * @returns Active durables plus missing-or-inactive identifiers.
 */
export async function loadActiveProposalDurables(
  proposal: Pick<DreamRunProposal, "durableIds">,
  getDurable: (durableId: string) => Promise<Durable | null>,
): Promise<{ activeDurables: Durable[]; inactiveDurableIds: string[] }> {
  const activeDurables: Durable[] = [];
  const inactiveDurableIds: string[] = [];

  for (const durableId of proposal.durableIds) {
    const durable = await getDurable(durableId);
    if (!durable) {
      inactiveDurableIds.push(durableId);
      continue;
    }

    activeDurables.push(durable);
  }

  return {
    activeDurables,
    inactiveDurableIds,
  };
}

/**
 * Applies one dreaming proposal to the provided active durables and records the matching audit action.
 *
 * @param input - Proposal, review metadata, and active target durables.
 * @param deps - Persistence helpers used for updates and action logging.
 * @returns Updated durable IDs and the resolved target claim key.
 */
export async function applyProposalToDurables(
  input: {
    proposal: DreamRunProposal;
    activeDurables: Durable[];
    reviewReason: string;
    reviewedAt: string;
    actionReviewStatus: "applied" | "dry_run";
    actionRunId?: string;
    requireAllUpdates?: boolean;
  },
  deps: DreamProposalReviewDeps,
): Promise<{ updatedDurableIds: string[]; targetClaimKey: string; reasoning: string }> {
  const targetClaimKey = resolveDreamProposalApplyTarget(input.proposal);
  const reasoning = buildDreamProposalReviewReason(input.proposal, input.reviewReason);
  const updatedDurableIds: string[] = [];

  for (const durable of input.activeDurables) {
    const lifecycle = buildReconcileAppliedClaimKeyLifecycleBundle({
      targetClaimKey,
      priorClaimKey: durable.claim_key ?? null,
      priorClaimKeyRaw: durable.claim_key_raw,
      source: input.proposal.source,
      confidence: input.proposal.confidence,
      rationale: reasoning,
    });
    const updated = await deps.updateDurable(durable.id, buildClaimKeyLifecycleUpdateFields(lifecycle));
    if (!updated && input.requireAllUpdates) {
      throw new Error(`Failed to apply proposal ${input.proposal.id} to durable ${durable.id}.`);
    }
    if (updated) {
      updatedDurableIds.push(durable.id);
    }
  }

  if (updatedDurableIds.length > 0) {
    await deps.logRunAction({
      id: randomUUID(),
      runId: input.actionRunId ?? input.proposal.runId,
      actionType: "update_durable",
      durableIds: updatedDurableIds,
      reasoning,
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
    updatedDurableIds,
    targetClaimKey,
    reasoning,
  };
}
