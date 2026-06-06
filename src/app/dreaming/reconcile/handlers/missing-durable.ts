import type { Durable } from "../../../../core/types.js";
import { persistProposalWhenCrossTypeCollision } from "../helpers/cross-type-collision-outcome.js";
import { buildTrustedGroupReusePersistInput } from "../helpers/proposal.js";
import { findTrustedGroupReuseCandidate } from "../helpers/durable.js";
import { evaluateMissingDurablePreview, executeMissingDurablePreviewDecision } from "../helpers/missing-backfill.js";
import {
  recordMissingBackfillAutoApplyApplied,
  recordMissingBackfillAutoApplyIdentified,
  recordMissingBackfillTrustedGroupReuseAutoApplied,
  recordMissingBackfillTrustedGroupReuseProposed,
} from "../helpers/missing-backfill-stats.js";
import type { InspectedDurable } from "../helpers/partition.js";
import { applyClaimKeyRepair } from "../pass-apply-handlers.js";
import type { ReconcilePassContext } from "../pass-context.js";
import { loadSuggestionIfContinuing } from "../pass-suggestion-handlers.js";

/**
 * Processes one durable with a missing claim key.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param item - Partitioned durable with its inspection outcome.
 */
export async function processMissingDurable(ctx: ReconcilePassContext, item: InspectedDurable): Promise<void> {
  const { durable, inspection } = item;
  if (inspection.kind !== "missing") {
    return;
  }

  const trustedGroupReuse = findTrustedGroupReuseCandidate(ctx.workingSet.projectedDurables, ctx.workingSet.trustedReusableDurableIds, durable);
  if (trustedGroupReuse) {
    await executeTrustedGroupReuse(ctx, durable, trustedGroupReuse);
    return;
  }

  const suggestionRecord = await loadSuggestionIfContinuing(ctx, durable);
  if (!suggestionRecord) {
    return;
  }

  const decision = evaluateMissingDurablePreview(durable, suggestionRecord, ctx);
  await executeMissingDurablePreviewDecision(ctx, durable, decision);
}

/** Applies or proposes trusted-group reuse for a durable with a missing claim key. */
async function executeTrustedGroupReuse(
  ctx: ReconcilePassContext,
  durable: Durable,
  trustedGroupReuse: NonNullable<ReturnType<typeof findTrustedGroupReuseCandidate>>,
): Promise<void> {
  const persistedCollision = await persistProposalWhenCrossTypeCollision(ctx, trustedGroupReuse.claimKey, durable, () => ({
    ...buildTrustedGroupReusePersistInput(durable, trustedGroupReuse),
    onPersisted: (passCtx) => {
      recordMissingBackfillTrustedGroupReuseProposed(passCtx);
    },
  }));
  if (persistedCollision) {
    return;
  }

  await applyClaimKeyRepair(
    ctx,
    durable.id,
    trustedGroupReuse.claimKey,
    {
      issueKind: "missing_claim_key",
      oldClaimKey: null,
      source: "trusted_group_reuse",
      confidence: 0.99,
      rationale:
        `Matched subject/type durables already use trusted canonical key "${trustedGroupReuse.claimKey}", ` +
        `so the missing key can safely reuse that established family from ${trustedGroupReuse.supportingDurableIds.length} supporting durable${trustedGroupReuse.supportingDurableIds.length === 1 ? "" : "s"}.`,
    },
    {
      onIdentified: () => {
        recordMissingBackfillAutoApplyIdentified(ctx);
      },
      onApplied: () => {
        recordMissingBackfillAutoApplyApplied(ctx);
      },
      onProjected: () => {
        recordMissingBackfillTrustedGroupReuseAutoApplied(ctx);
      },
    },
  );
}
