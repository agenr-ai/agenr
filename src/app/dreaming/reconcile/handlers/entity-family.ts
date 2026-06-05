import type { ClaimKeyEntityFamilyCandidate } from "../../../../core/claim-key-entity-family.js";
import type { Durable } from "../../../../core/types.js";
import { resolveCrossTypeCollisionSiblingIds } from "../helpers/cross-type-collision-outcome.js";
import {
  buildEntityFamilyConvergenceAudit,
  buildEntityFamilyConvergenceRationale,
  collectEntityFamilyDurablesToRewrite,
  mapEntityFamilyClaimKeys,
  resolveEntityFamilyTargetClaimKey,
} from "../helpers/entity-family.js";
import { buildEntityFamilyPersistInput } from "../helpers/proposal.js";
import { expandCrossTypeCollisionDurableIds, persistCrossTypeCollisionProposal, persistReconcileProposal } from "../helpers/reconcile-proposal.js";
import { applyClaimKeyRepair } from "../pass-apply-handlers.js";
import type { ReconcilePassContext } from "../pass-context.js";
import type { EntityFamilyConvergenceAudit } from "../types.js";

interface EntityFamilyRewrite {
  durable: Durable;
  targetClaimKey: string;
  oldClaimKey: string;
  attribute: string;
}

type EntityFamilyDecision =
  | {
      kind: "propose_unresolved";
      audit: EntityFamilyConvergenceAudit;
      proposedClaimKeys: string[];
      source: "entity_family_canonical_candidate" | "entity_family_ambiguous";
      eligibleForApply: boolean;
    }
  | {
      kind: "propose_cross_type_collision";
      audit: EntityFamilyConvergenceAudit;
      targetClaimKey: string;
      activeSiblingIds: string[];
      proposedClaimKeys: string[];
    }
  | {
      kind: "auto_apply";
      audit: EntityFamilyConvergenceAudit;
      rewrites: EntityFamilyRewrite[];
    };

/**
 * Handles one entity-family convergence candidate cluster.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param candidate - Detected entity-family convergence candidate.
 */
export async function processEntityFamilyConvergenceCandidate(ctx: ReconcilePassContext, candidate: ClaimKeyEntityFamilyCandidate): Promise<void> {
  const decision = evaluateEntityFamilyDecision(ctx, candidate);
  await executeEntityFamilyDecision(ctx, candidate, decision);
}

function evaluateEntityFamilyDecision(ctx: ReconcilePassContext, candidate: ClaimKeyEntityFamilyCandidate): EntityFamilyDecision {
  const audit = buildEntityFamilyConvergenceAudit(candidate);
  const canonicalEntityPrefix = candidate.canonicalEntityPrefix;
  const durablesToRewrite = collectEntityFamilyDurablesToRewrite(ctx.workingSet.projectedDurables, candidate);

  if (!canonicalEntityPrefix || !candidate.autoConverge || durablesToRewrite.length === 0) {
    const proposedClaimKeys = canonicalEntityPrefix ? mapEntityFamilyClaimKeys(candidate.claimKeys, candidate.entityPrefixes, canonicalEntityPrefix) : [];
    return {
      kind: "propose_unresolved",
      audit,
      proposedClaimKeys,
      source: canonicalEntityPrefix ? "entity_family_canonical_candidate" : "entity_family_ambiguous",
      eligibleForApply: proposedClaimKeys.length === 1,
    };
  }

  const rewrites: EntityFamilyRewrite[] = [];
  for (const durable of durablesToRewrite) {
    const targetClaimKey = resolveEntityFamilyTargetClaimKey(durable, canonicalEntityPrefix);
    if (!targetClaimKey) {
      continue;
    }

    const activeSiblingIds = resolveCrossTypeCollisionSiblingIds(ctx.workingSet.projectedDurables, targetClaimKey, durable);
    if (activeSiblingIds.length > 0) {
      return {
        kind: "propose_cross_type_collision",
        audit,
        targetClaimKey,
        activeSiblingIds,
        proposedClaimKeys: mapEntityFamilyClaimKeys(candidate.claimKeys, candidate.entityPrefixes, canonicalEntityPrefix),
      };
    }

    const oldClaimKey = durable.claim_key?.trim();
    if (!oldClaimKey) {
      continue;
    }

    rewrites.push({
      durable,
      targetClaimKey,
      oldClaimKey,
      attribute: targetClaimKey.slice(canonicalEntityPrefix.length + 1),
    });
  }

  return {
    kind: "auto_apply",
    audit,
    rewrites,
  };
}

async function executeEntityFamilyDecision(ctx: ReconcilePassContext, candidate: ClaimKeyEntityFamilyCandidate, decision: EntityFamilyDecision): Promise<void> {
  switch (decision.kind) {
    case "propose_unresolved": {
      await persistReconcileProposal(ctx, {
        ...buildEntityFamilyPersistInput(candidate, {
          audit: decision.audit,
          proposedClaimKeys: decision.proposedClaimKeys,
          durableIds: candidate.durableIds,
          rationale: buildEntityFamilyConvergenceRationale(candidate),
          source: decision.source,
          eligibleForApply: decision.eligibleForApply,
        }),
        onPersisted: (passCtx) => {
          passCtx.telemetry.entityFamilyDecisionStats.proposedClusters += 1;
        },
      });
      return;
    }
    case "propose_cross_type_collision": {
      await persistCrossTypeCollisionProposal(ctx, {
        ...buildEntityFamilyPersistInput(candidate, {
          audit: decision.audit,
          proposedClaimKeys: decision.proposedClaimKeys,
          durableIds: expandCrossTypeCollisionDurableIds(candidate.durableIds, decision.activeSiblingIds),
          rationale:
            `${buildEntityFamilyConvergenceRationale(candidate)} ` +
            `Auto-convergence would collide with an active durable of a different type at "${decision.targetClaimKey}".`,
          source: "entity_family_collision",
          eligibleForApply: false,
        }),
        onPersisted: (passCtx) => {
          passCtx.telemetry.entityFamilyDecisionStats.proposedClusters += 1;
        },
      });
      return;
    }
    case "auto_apply": {
      let appliedDurables = 0;
      for (const rewrite of decision.rewrites) {
        await applyClaimKeyRepair(
          ctx,
          rewrite.durable.id,
          rewrite.targetClaimKey,
          {
            issueKind: "entity_family_convergence",
            oldClaimKey: rewrite.oldClaimKey,
            source: "entity_family_auto_convergence",
            confidence: candidate.confidence,
            rationale:
              `${buildEntityFamilyConvergenceRationale(candidate)} ` +
              `This durable keeps attribute "${rewrite.attribute}" while converging its entity prefix onto "${candidate.canonicalEntityPrefix}".`,
            entityFamilyAudit: decision.audit,
          },
          {
            onIdentified: () => {
              ctx.telemetry.counts.identifiedEntityFamilyConvergences += 1;
            },
            onApplied: () => {
              ctx.telemetry.counts.appliedEntityFamilyConvergences += 1;
              appliedDurables += 1;
            },
          },
        );
        if (ctx.telemetry.circuitBreaker) {
          return;
        }
      }

      if (appliedDurables > 0) {
        ctx.telemetry.entityFamilyDecisionStats.appliedClusters += 1;
        ctx.telemetry.entityFamilyDecisionStats.appliedDurables += appliedDurables;
      }
    }
  }
}
