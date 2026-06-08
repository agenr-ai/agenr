import { randomUUID } from "node:crypto";

import {
  applyClaimKeyLifecycle,
  buildClaimKeyLifecycleUpdateFields,
  buildReconcileAppliedClaimKeyLifecycleBundle as buildAppliedClaimKeyLifecycleBundle,
} from "../../../core/claim-key-lifecycle.js";
import { isTrustedClaimKeyForCleanup } from "../../../core/claim-key.js";
import { buildAppliedClaimKeyActionDetails } from "./helpers/audit.js";
import { refreshDurableInspectionTally } from "./helpers/claim-key-health-tally.js";
import { restoreClaimKeyLifecycle, snapshotClaimKeyLifecycle } from "./helpers/durable.js";
import { recordRepairOutcome } from "./helpers/effects.js";
import type { ReconcilePassContext } from "./pass-context.js";
import type { ClaimKeyUpdateInput } from "./types.js";

/**
 * Optional counter and lifecycle hooks for one claim-key repair apply.
 */
export interface ApplyClaimKeyRepairOptions {
  onIdentified?: () => void;
  onApplied?: () => void;
  onProjected?: () => void;
  registerTrustedReuse?: boolean;
}

/**
 * Applies or projects one claim-key rewrite for a durable in the working set.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param durableId - Durable identifier to update.
 * @param claimKey - Canonical claim key to persist.
 * @param input - Lifecycle metadata and audit details for the rewrite.
 * @returns Whether the projected and applied states changed.
 */
export async function maybeApplyClaimKeyUpdate(
  ctx: ReconcilePassContext,
  durableId: string,
  claimKey: string,
  input: ClaimKeyUpdateInput,
): Promise<{ projected: boolean; applied: boolean }> {
  const projected = ctx.workingSet.durablesById.get(durableId);
  const actual = ctx.workingSet.actualDurablesById.get(durableId);
  if (!projected || !actual) {
    return { projected: false, applied: false };
  }

  const previousProjected = snapshotClaimKeyLifecycle(projected);
  const lifecycle = buildAppliedClaimKeyLifecycleBundle({
    targetClaimKey: claimKey,
    priorClaimKey: input.oldClaimKey,
    priorClaimKeyRaw: projected.claim_key_raw ?? actual.claim_key_raw,
    rawClaimKey: input.rawClaimKey,
    source: input.source,
    confidence: input.confidence,
    rationale: input.rationale,
    support: input.support,
    compactness: input.compactness,
  });

  applyClaimKeyLifecycle(projected, lifecycle);
  if (!ctx.options.apply) {
    refreshClaimKeyInspectionState(ctx, durableId, "projected");
    return { projected: true, applied: false };
  }

  const updated = await ctx.deps.port.updateDurable(durableId, buildClaimKeyLifecycleUpdateFields(lifecycle), {
    includeInactive: ctx.workingSet.selection.includeInactive,
  });
  if (!updated) {
    restoreClaimKeyLifecycle(projected, previousProjected);
    return { projected: false, applied: false };
  }

  refreshClaimKeyInspectionState(ctx, durableId, "projected");
  applyClaimKeyLifecycle(actual, lifecycle);
  refreshClaimKeyInspectionState(ctx, durableId, "actual");
  await ctx.deps.port.logRunAction({
    id: randomUUID(),
    runId: ctx.options.runId,
    actionType: "update_durable",
    durableIds: [durableId],
    reasoning: input.rationale,
    details: buildAppliedClaimKeyActionDetails({
      issueKind: input.issueKind,
      oldClaimKey: input.oldClaimKey,
      newClaimKey: claimKey,
      proposalSource: input.source,
      confidence: input.confidence,
      lifecycle,
      promotion: input.promotion,
      support: input.support,
      shadow: input.shadow,
      compactness: input.compactness,
      entityFamilyAudit: input.entityFamilyAudit,
      aliasConvergenceAudit: input.aliasConvergenceAudit,
    }),
    createdAt: ctx.options.now().toISOString(),
  });
  ctx.telemetry.actionsTaken += 1;
  return { projected: true, applied: true };
}

/**
 * Applies or projects one claim-key repair and records shared repair telemetry.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param durableId - Durable identifier to update.
 * @param claimKey - Canonical claim key to persist.
 * @param input - Lifecycle metadata and audit details for the rewrite.
 * @param options - Counter hooks and optional trusted-reuse registration.
 * @returns Whether the projected and applied states changed.
 */
export async function applyClaimKeyRepair(
  ctx: ReconcilePassContext,
  durableId: string,
  claimKey: string,
  input: ClaimKeyUpdateInput,
  options: ApplyClaimKeyRepairOptions = {},
): Promise<{ projected: boolean; applied: boolean }> {
  options.onIdentified?.();
  const updateResult = await maybeApplyClaimKeyUpdate(ctx, durableId, claimKey, input);
  if (updateResult.applied) {
    options.onApplied?.();
  }
  if (updateResult.projected) {
    options.onProjected?.();
    if (options.registerTrustedReuse && isTrustedClaimKeyForCleanup(claimKey)) {
      ctx.workingSet.trustedReusableDurableIds.add(durableId);
    }
    recordRepairOutcome(ctx, claimKey, updateResult.projected);
  }

  return updateResult;
}

/** Refreshes claim-key inspection maps and tallies after a durable changes. */
function refreshClaimKeyInspectionState(ctx: ReconcilePassContext, durableId: string, scope: "projected" | "actual"): void {
  const durable = scope === "projected" ? ctx.workingSet.durablesById.get(durableId) : ctx.workingSet.actualDurablesById.get(durableId);
  const inspectionById = scope === "projected" ? ctx.workingSet.projectedInspectionById : ctx.workingSet.actualInspectionById;
  const tally = scope === "projected" ? ctx.workingSet.projectedInspectionTally : ctx.workingSet.actualInspectionTally;
  const previous = inspectionById.get(durableId);
  if (!durable || !previous) {
    return;
  }

  inspectionById.set(durableId, refreshDurableInspectionTally(durable, previous, ctx.extraction.claimExtractionConfig.eligibleTypes, tally));
}
