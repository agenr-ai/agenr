import { recordCollisionOutcome } from "../helpers/effects.js";
import { findClaimKeyOccupants } from "../helpers/durable.js";
import { buildMalformedClaimKeyPersistInput } from "../helpers/proposal.js";
import type { InspectedDurable } from "../helpers/partition.js";
import { persistReconcileProposal } from "../helpers/reconcile-proposal.js";
import { applyClaimKeyRepair } from "../pass-apply-handlers.js";
import type { ReconcilePassContext } from "../pass-context.js";
import { loadSuggestion } from "../pass-suggestion-handlers.js";

/**
 * Handles one durable with a malformed or noncanonical claim key.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param item - Partitioned durable with its inspection outcome.
 */
export async function processInvalidOrNoncanonicalDurable(ctx: ReconcilePassContext, item: InspectedDurable): Promise<void> {
  const { durable, inspection } = item;
  if (inspection.kind !== "malformed" && inspection.kind !== "noncanonical") {
    return;
  }

  if (inspection.kind === "malformed") {
    const suggestionRecord = await loadSuggestion(ctx, durable);
    await persistReconcileProposal(ctx, buildMalformedClaimKeyPersistInput(durable, inspection, suggestionRecord));
    return;
  }

  const targetClaimKey = inspection.normalized.claimKey;
  const collision = findClaimKeyOccupants(ctx.workingSet.projectedDurables, targetClaimKey, durable.id);
  if (collision.length > 0) {
    ctx.telemetry.counts.skippedCollision += 1;
    recordCollisionOutcome(ctx);
    await persistReconcileProposal(ctx, {
      groupId: `claim-key-normalize:${durable.id}`,
      issueKind: "noncanonical_claim_key",
      scope: "single_durable",
      durableIds: [durable.id],
      currentClaimKeys: [durable.claim_key ?? ""],
      proposedClaimKeys: [targetClaimKey],
      rationale:
        `Canonical normalization would change "${durable.claim_key}" to "${targetClaimKey}", ` +
        `but that canonical key is already occupied by ${collision.length} other matched durable${collision.length === 1 ? "" : "s"}.`,
      confidence: 0.99,
      source: "normalize",
      eligibleForApply: true,
      lifecycle: {
        proposedClaimKeys: [targetClaimKey],
        source: "normalize",
        rawClaimKey: durable.claim_key ?? null,
      },
    });
    return;
  }

  await applyClaimKeyRepair(
    ctx,
    durable.id,
    targetClaimKey,
    {
      issueKind: "noncanonical_claim_key",
      oldClaimKey: durable.claim_key ?? null,
      source: "normalize",
      confidence: 0.99,
      rationale: `Canonical normalization preserves the slot while rewriting "${durable.claim_key}" to "${targetClaimKey}".`,
    },
    {
      onIdentified: () => {
        ctx.telemetry.counts.identifiedNormalizations += 1;
      },
      onApplied: () => {
        ctx.telemetry.counts.appliedNormalizations += 1;
      },
      registerTrustedReuse: true,
    },
  );
}
