import { randomUUID } from "node:crypto";

import {
  detectDuplicateExclusiveSlotGroups,
  isDuplicateSlotCollapseAutoApplyEligible,
  planDuplicateSlotCollapse,
  type DuplicateSlotCollapsePlan,
  type DuplicateSlotGroup,
} from "../../../../core/dreaming/domain/duplicate-slot-collapse.js";
import type { Durable } from "../../../../core/types.js";
import { MAX_AUTO_DUPLICATE_SLOT_COLLAPSES_PER_RUN } from "../constants.js";
import { persistReconcileProposal } from "../helpers/reconcile-proposal.js";
import type { ReconcilePassContext } from "../pass-context.js";

/** Supersession kind recorded on rows collapsed off one exclusive slot. */
const DUPLICATE_SLOT_COLLAPSE_SUPERSESSION_KIND = "duplicate_collapse";

export { DUPLICATE_SLOT_COLLAPSE_SUPERSESSION_KIND };

/** Stable proposal source for duplicate exclusive-slot collapse decisions. */
const DUPLICATE_SLOT_COLLAPSE_SOURCE = "duplicate_slot_collapse";

/**
 * Detects exclusive claim slots that hold more than one active durable in the
 * projected working set.
 *
 * @param ctx - Mutable reconcile pass context.
 * @returns Duplicate exclusive-slot groups eligible for collapse handling.
 */
export function detectDuplicateSlotCollapseGroups(ctx: ReconcilePassContext): DuplicateSlotGroup[] {
  return detectDuplicateExclusiveSlotGroups(ctx.workingSet.projectedDurables);
}

/**
 * Handles one duplicate exclusive-slot group: collapse automatically when the
 * group is uniform and trusted, otherwise stage an operator proposal.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param group - Detected duplicate exclusive-slot group.
 */
export async function processDuplicateSlotCollapseGroup(ctx: ReconcilePassContext, group: DuplicateSlotGroup): Promise<void> {
  const plan = planDuplicateSlotCollapse(group.durables);
  ctx.telemetry.counts.identifiedDuplicateSlotCollapses += 1;

  const autoEligible = isDuplicateSlotCollapseAutoApplyEligible(group.durables);
  const underCap = ctx.telemetry.counts.appliedDuplicateSlotCollapses + plan.losers.length <= MAX_AUTO_DUPLICATE_SLOT_COLLAPSES_PER_RUN;

  if (autoEligible && underCap) {
    await collapseDuplicateSlotGroup(ctx, group, plan);
    return;
  }

  await persistDuplicateSlotCollapseProposal(ctx, group, plan, autoEligible);
}

/** Persists one open duplicate-slot-collapse proposal for operator review. */
async function persistDuplicateSlotCollapseProposal(
  ctx: ReconcilePassContext,
  group: DuplicateSlotGroup,
  plan: DuplicateSlotCollapsePlan,
  autoEligible: boolean,
): Promise<void> {
  const blockerReason = autoEligible ? "the per-run auto-collapse cap was reached" : "the group mixes durable types or carries non-trusted claim-key statuses";

  await persistReconcileProposal(ctx, {
    groupId: `claim-key-duplicate-slot:${group.claimKey}`,
    issueKind: "duplicate_slot_collapse",
    scope: "cluster",
    durableIds: [plan.survivor.id, ...plan.losers.map((loser) => loser.id)],
    currentClaimKeys: [group.claimKey],
    proposedClaimKeys: [group.claimKey],
    rationale: buildDuplicateSlotCollapseRationale(group, plan, blockerReason),
    confidence: autoEligible ? 0.9 : 0.7,
    source: DUPLICATE_SLOT_COLLAPSE_SOURCE,
    eligibleForApply: true,
    lifecycle: {
      proposedClaimKeys: [group.claimKey],
      source: DUPLICATE_SLOT_COLLAPSE_SOURCE,
    },
    audit: {
      autoApplyBlocker: autoEligible ? "auto_collapse_cap" : "mixed_status_or_type",
    },
  });
}

/** Applies (or projects) one duplicate-slot collapse onto the working set. */
async function collapseDuplicateSlotGroup(ctx: ReconcilePassContext, group: DuplicateSlotGroup, plan: DuplicateSlotCollapsePlan): Promise<void> {
  const nowIso = ctx.options.now().toISOString();

  for (const loser of plan.losers) {
    markCollapsedInWorkingSet(ctx.workingSet.durablesById.get(loser.id), plan.survivor.id, nowIso);
    if (!ctx.options.apply) {
      continue;
    }

    const reasoning = buildDuplicateSlotCollapseRationale(group, plan, null);
    const superseded = await ctx.deps.port.supersedeDurable(
      loser.id,
      plan.survivor.id,
      DUPLICATE_SLOT_COLLAPSE_SUPERSESSION_KIND,
      `Duplicate exclusive-slot collapse onto survivor ${plan.survivor.id}.`,
    );
    if (!superseded) {
      continue;
    }

    await ctx.deps.port.updateDurable(loser.id, { valid_to: nowIso }, { includeInactive: true });
    markCollapsedInWorkingSet(ctx.workingSet.actualDurablesById.get(loser.id), plan.survivor.id, nowIso);
    ctx.telemetry.counts.appliedDuplicateSlotCollapses += 1;
    await ctx.deps.port.logRunAction({
      id: randomUUID(),
      runId: ctx.options.runId,
      actionType: "merge",
      durableIds: [loser.id, plan.survivor.id],
      reasoning,
      details: {
        issue_kind: "duplicate_slot_collapse",
        claim_key: group.claimKey,
        survivor_id: plan.survivor.id,
        superseded_id: loser.id,
        supersession_kind: DUPLICATE_SLOT_COLLAPSE_SUPERSESSION_KIND,
        valid_to: nowIso,
      },
      createdAt: nowIso,
    });
    ctx.telemetry.actionsTaken += 1;
  }
}

/** Marks one working-set clone as collapsed so health snapshots reflect the change. */
function markCollapsedInWorkingSet(durable: Durable | undefined, survivorId: string, nowIso: string): void {
  if (!durable) {
    return;
  }

  durable.superseded_by = survivorId;
  durable.valid_to = nowIso;
  durable.supersession_kind = DUPLICATE_SLOT_COLLAPSE_SUPERSESSION_KIND;
}

/** Builds the shared rationale string for one duplicate-slot collapse decision. */
function buildDuplicateSlotCollapseRationale(group: DuplicateSlotGroup, plan: DuplicateSlotCollapsePlan, blockerReason: string | null): string {
  const base =
    `Exclusive claim slot "${group.claimKey}" holds ${group.durables.length} active durables. ` +
    `Durable ${plan.survivor.id} was selected as the canonical survivor (trusted status, importance, recency, then id), ` +
    `superseding ${plan.losers.length} duplicate row${plan.losers.length === 1 ? "" : "s"}.`;
  if (!blockerReason) {
    return base;
  }

  return `${base} Auto-collapse was withheld because ${blockerReason}.`;
}
