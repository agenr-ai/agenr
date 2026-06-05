import type { Durable } from "../../../../core/types.js";
import { buildMixedGroupRationale } from "../helpers/mixed-groups.js";
import { persistReconcileProposal } from "../helpers/reconcile-proposal.js";
import type { ReconcilePassContext } from "../pass-context.js";

/**
 * Handles one mixed subject/type group with inconsistent claim keys.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param group - Detected mixed-key group candidate.
 */
export async function processMixedKeyGroup(
  ctx: ReconcilePassContext,
  group: { groupKey: string; durables: Durable[]; proposedClaimKey: string | null },
): Promise<void> {
  const source = group.proposedClaimKey ? "mixed_group_consensus" : "mixed_group";

  await persistReconcileProposal(ctx, {
    groupId: `claim-key-mixed:${group.groupKey}`,
    issueKind: "mixed_claim_key_group",
    scope: "cluster",
    durableIds: group.durables.map((durable) => durable.id),
    currentClaimKeys: group.durables.flatMap((durable) => (durable.claim_key ? [durable.claim_key] : [])),
    proposedClaimKeys: group.proposedClaimKey ? [group.proposedClaimKey] : [],
    rationale: buildMixedGroupRationale(group),
    confidence: group.proposedClaimKey ? 0.8 : 0.55,
    source,
    eligibleForApply: group.proposedClaimKey !== null,
    lifecycle: {
      proposedClaimKeys: group.proposedClaimKey ? [group.proposedClaimKey] : [],
      source,
    },
  });
}
