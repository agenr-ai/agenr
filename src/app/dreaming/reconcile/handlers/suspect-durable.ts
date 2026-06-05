import { buildSuspectProposalRationale, describeSuspicionList, resolveExplicitMetadataRepair } from "../helpers/claim-key-inspection.js";
import { findClaimKeyOccupants } from "../helpers/durable.js";
import type { InspectedDurable } from "../helpers/partition.js";
import { persistReconcileProposal } from "../helpers/reconcile-proposal.js";
import { applyClaimKeyRepair } from "../pass-apply-handlers.js";
import type { ReconcilePassContext } from "../pass-context.js";
import { loadSuggestionIfContinuing } from "../pass-suggestion-handlers.js";

/**
 * Handles one durable with a suspect canonical claim key.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param item - Partitioned durable with its inspection outcome.
 */
export async function processSuspectDurable(ctx: ReconcilePassContext, item: InspectedDurable): Promise<void> {
  const { durable, inspection } = item;
  if (inspection.kind !== "suspect") {
    return;
  }

  const metadataRepair = resolveExplicitMetadataRepair(durable, inspection.inspection);
  if (metadataRepair && findClaimKeyOccupants(ctx.workingSet.projectedDurables, metadataRepair, durable.id).length === 0) {
    await applyClaimKeyRepair(
      ctx,
      durable.id,
      metadataRepair,
      {
        issueKind: "suspect_canonical_claim_key",
        oldClaimKey: durable.claim_key ?? null,
        source: "metadata_rewrite",
        confidence: 0.98,
        rationale: `Explicit durable metadata resolves ${describeSuspicionList(inspection.inspection)} to "${metadataRepair}".`,
      },
      {
        onIdentified: () => {
          ctx.telemetry.counts.identifiedMetadataRewrites += 1;
        },
        onApplied: () => {
          ctx.telemetry.counts.appliedMetadataRewrites += 1;
        },
      },
    );
    return;
  }

  const suggestionRecord = ctx.extraction.claimExtractionConfig.eligibleTypes.includes(durable.type)
    ? await loadSuggestionIfContinuing(ctx, durable)
    : { suggestion: null, warnings: [], previewOutcome: null };
  if (!suggestionRecord) {
    return;
  }

  const proposedClaimKeys = [
    metadataRepair,
    suggestionRecord.suggestion?.claimKey && suggestionRecord.suggestion.claimKey !== durable.claim_key ? suggestionRecord.suggestion.claimKey : null,
  ].filter((value): value is string => value !== null);
  const source = metadataRepair ? "metadata_rewrite" : (suggestionRecord.suggestion?.path ?? "heuristic");

  await persistReconcileProposal(ctx, {
    groupId: `claim-key-suspect:${durable.id}`,
    issueKind: "suspect_canonical_claim_key",
    scope: "single_durable",
    durableIds: [durable.id],
    currentClaimKeys: durable.claim_key ? [durable.claim_key] : [],
    proposedClaimKeys,
    rationale: buildSuspectProposalRationale(durable, inspection.inspection, metadataRepair, suggestionRecord.suggestion),
    confidence: metadataRepair ? 0.98 : (suggestionRecord.suggestion?.confidence ?? 0.5),
    source,
    eligibleForApply: proposedClaimKeys.length > 0,
    lifecycle: {
      proposedClaimKeys,
      source,
      rawClaimKey: durable.claim_key_raw ?? durable.claim_key ?? null,
    },
  });
}
