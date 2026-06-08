import { CLAIM_KEY_ALIAS_AUTO_APPLY_THRESHOLD, detectClaimKeyAliasCandidates, type ClaimKeyAliasCandidate } from "../../../../core/claim-key-alias.js";
import { normalizeClaimKey } from "../../../../core/claim-key.js";
import { adjudicateClaimKeyAliasCandidate, type ClaimKeyAliasAdjudication } from "../../../../core/dreaming/claim-key-alias-adjudication.js";
import { claimExtractionUsage } from "../helpers/claim-extraction.js";
import { resolveCrossTypeCollisionSiblingIds } from "../helpers/cross-type-collision-outcome.js";
import { buildClaimKeyAliasPersistInput } from "../helpers/proposal.js";
import { expandCrossTypeCollisionDurableIds, persistCrossTypeCollisionProposal, persistReconcileProposal } from "../helpers/reconcile-proposal.js";
import { applyClaimKeyRepair } from "../pass-apply-handlers.js";
import type { ReconcilePassContext } from "../pass-context.js";
import type { ClaimKeyAliasConvergenceAudit, ClaimExtractionPreviewLlm } from "../types.js";

/** One durable rewrite selected for alias convergence auto-apply. */
interface AliasRewrite {
  durableId: string;
  oldClaimKey: string | null;
}

/** Decision selected for one same-entity alias convergence candidate. */
type AliasDecision =
  | {
      kind: "propose";
      audit: ClaimKeyAliasConvergenceAudit;
      blocker: string;
    }
  | {
      kind: "propose_cross_type_collision";
      audit: ClaimKeyAliasConvergenceAudit;
      targetClaimKey: string;
      activeSiblingIds: string[];
    }
  | {
      kind: "auto_apply";
      audit: ClaimKeyAliasConvergenceAudit;
      targetClaimKey: string;
      rewrites: AliasRewrite[];
    };

/** Detects same-entity claim-key alias candidates for deep reconcile runs. */
export function detectDeepClaimKeyAliasCandidates(ctx: ReconcilePassContext): ClaimKeyAliasCandidate[] {
  if (ctx.options.tier !== "deep" || ctx.workingSet.selection.includeInactive) {
    return [];
  }

  return detectClaimKeyAliasCandidates(ctx.workingSet.projectedDurables);
}

/**
 * Handles one same-entity claim-key alias convergence candidate.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param candidate - Detected same-entity alias candidate.
 */
export async function processClaimKeyAliasConvergenceCandidate(ctx: ReconcilePassContext, candidate: ClaimKeyAliasCandidate): Promise<void> {
  const adjudication = await adjudicateIfAvailable(ctx, candidate);
  if (ctx.telemetry.terminalStatus !== "completed") {
    if (ctx.telemetry.terminalStatus === "cost_capped") {
      const audit = buildClaimKeyAliasConvergenceAudit(candidate, adjudication);
      await executeAliasDecision(ctx, candidate, {
        kind: "propose",
        audit,
        blocker: "LLM adjudication stopped after reaching the reconcile cost cap.",
      });
    }
    return;
  }

  const decision = evaluateAliasDecision(ctx, candidate, adjudication);
  await executeAliasDecision(ctx, candidate, decision);
}

/** Evaluates whether an alias candidate should be proposed or auto-applied. */
function evaluateAliasDecision(ctx: ReconcilePassContext, candidate: ClaimKeyAliasCandidate, adjudication: ClaimKeyAliasAdjudication | null): AliasDecision {
  const audit = buildClaimKeyAliasConvergenceAudit(candidate, adjudication);
  const targetClaimKey = resolveAutoApplyTarget(candidate, adjudication);
  if (!targetClaimKey) {
    return {
      kind: "propose",
      audit,
      blocker: resolveProposalBlocker(candidate, adjudication),
    };
  }

  const rewrites = collectAliasRewrites(ctx, candidate, targetClaimKey);
  for (const rewrite of rewrites) {
    const durable = ctx.workingSet.durablesById.get(rewrite.durableId);
    if (!durable) {
      continue;
    }

    const activeSiblingIds = resolveCrossTypeCollisionSiblingIds(ctx.workingSet.projectedDurables, targetClaimKey, durable);
    if (activeSiblingIds.length > 0) {
      return {
        kind: "propose_cross_type_collision",
        audit,
        targetClaimKey,
        activeSiblingIds,
      };
    }
  }

  return {
    kind: "auto_apply",
    audit,
    targetClaimKey,
    rewrites,
  };
}

/** Executes a previously evaluated alias convergence decision. */
async function executeAliasDecision(ctx: ReconcilePassContext, candidate: ClaimKeyAliasCandidate, decision: AliasDecision): Promise<void> {
  switch (decision.kind) {
    case "propose": {
      await persistAliasProposal(ctx, candidate, decision.audit, decision.blocker);
      return;
    }
    case "propose_cross_type_collision": {
      await persistCrossTypeCollisionProposal(ctx, {
        ...buildClaimKeyAliasPersistInput(candidate, {
          audit: decision.audit,
          proposedClaimKeys: [decision.targetClaimKey],
          durableIds: expandCrossTypeCollisionDurableIds(candidate.durableIds, decision.activeSiblingIds),
          rationale: buildAliasRationale(candidate, decision.audit.llmAdjudication, "Cross-type collision blocks automatic alias convergence."),
          source: "claim_key_alias_collision",
          eligibleForApply: false,
        }),
        onPersisted: (passCtx) => {
          passCtx.telemetry.aliasConvergenceDecisionStats.proposedClusters += 1;
        },
      });
      return;
    }
    case "auto_apply": {
      let appliedDurables = 0;
      for (const rewrite of decision.rewrites) {
        await applyClaimKeyRepair(
          ctx,
          rewrite.durableId,
          decision.targetClaimKey,
          {
            issueKind: "claim_key_alias_convergence",
            oldClaimKey: rewrite.oldClaimKey,
            source: "claim_key_alias_auto_convergence",
            confidence: Math.min(candidate.confidence, decision.audit.llmAdjudication?.confidence ?? 0),
            rationale: buildAliasRationale(candidate, decision.audit.llmAdjudication, `Converged same-entity alias onto "${decision.targetClaimKey}".`),
            aliasConvergenceAudit: decision.audit,
          },
          {
            onIdentified: () => {
              ctx.telemetry.counts.identifiedAliasConvergences += 1;
            },
            onApplied: () => {
              ctx.telemetry.counts.appliedAliasConvergences += 1;
              appliedDurables += 1;
            },
          },
        );
        if (ctx.telemetry.circuitBreaker) {
          return;
        }
      }

      if (appliedDurables > 0) {
        ctx.telemetry.aliasConvergenceDecisionStats.appliedClusters += 1;
        ctx.telemetry.aliasConvergenceDecisionStats.appliedDurables += appliedDurables;
      }
    }
  }
}

function collectAliasRewrites(ctx: ReconcilePassContext, candidate: ClaimKeyAliasCandidate, targetClaimKey: string): AliasRewrite[] {
  return candidate.durableIds.flatMap((durableId) => {
    const durable = ctx.workingSet.durablesById.get(durableId);
    if (!durable || durable.claim_key === targetClaimKey) {
      return [];
    }
    return [{ durableId, oldClaimKey: durable.claim_key ?? null }];
  });
}

async function adjudicateIfAvailable(ctx: ReconcilePassContext, candidate: ClaimKeyAliasCandidate): Promise<ClaimKeyAliasAdjudication | null> {
  if (!ctx.extraction.claimExtractionConfig.enabled || typeof ctx.deps.createClaimExtractionLlm !== "function") {
    return null;
  }

  if (claimExtractionUsage(ctx.extraction.claimExtractionLlms).estimatedCostUsd >= ctx.options.costCapUsd) {
    ctx.telemetry.terminalStatus = "cost_capped";
    ctx.telemetry.terminalError = "Cost cap exhausted before adjudicating claim-key aliases.";
    return null;
  }

  const llm = createTrackedAliasAdjudicationLlm(ctx);
  if (!llm) {
    return null;
  }

  try {
    const adjudication = await adjudicateClaimKeyAliasCandidate(candidate, llm);
    if (claimExtractionUsage(ctx.extraction.claimExtractionLlms).estimatedCostUsd >= ctx.options.costCapUsd) {
      ctx.telemetry.terminalStatus = "cost_capped";
      ctx.telemetry.terminalError = "Cost cap exceeded while adjudicating claim-key aliases.";
    }
    return adjudication;
  } catch (error) {
    return {
      sameSlot: false,
      canonicalClaimKey: null,
      confidence: 0,
      rationale: error instanceof Error ? error.message : String(error),
    };
  }
}

function createTrackedAliasAdjudicationLlm(ctx: ReconcilePassContext): ClaimExtractionPreviewLlm | null {
  const llm = ctx.deps.createClaimExtractionLlm ? ctx.deps.createClaimExtractionLlm() : null;
  if (llm && !ctx.extraction.claimExtractionLlms.includes(llm)) {
    ctx.extraction.claimExtractionLlms.push(llm);
  }
  return llm;
}

function resolveAutoApplyTarget(candidate: ClaimKeyAliasCandidate, adjudication: ClaimKeyAliasAdjudication | null): string | null {
  if (!candidate.deterministicAutoApplyEligible || !candidate.proposedClaimKey || !adjudication?.sameSlot) {
    return null;
  }
  if (candidate.confidence < CLAIM_KEY_ALIAS_AUTO_APPLY_THRESHOLD || adjudication.confidence < CLAIM_KEY_ALIAS_AUTO_APPLY_THRESHOLD) {
    return null;
  }

  const deterministicTarget = normalizeClaimKey(candidate.proposedClaimKey);
  const adjudicatedTarget = adjudication.canonicalClaimKey ? normalizeClaimKey(adjudication.canonicalClaimKey) : null;
  if (!deterministicTarget.ok || !adjudicatedTarget?.ok || deterministicTarget.value.claimKey !== adjudicatedTarget.value.claimKey) {
    return null;
  }

  return deterministicTarget.value.claimKey;
}

async function persistAliasProposal(
  ctx: ReconcilePassContext,
  candidate: ClaimKeyAliasCandidate,
  audit: ClaimKeyAliasConvergenceAudit,
  blocker: string,
): Promise<void> {
  const proposedClaimKeys = candidate.proposedClaimKey ? [candidate.proposedClaimKey] : [];
  await persistReconcileProposal(ctx, {
    ...buildClaimKeyAliasPersistInput(candidate, {
      audit,
      proposedClaimKeys,
      durableIds: candidate.durableIds,
      rationale: buildAliasRationale(candidate, audit.llmAdjudication, blocker),
      source: audit.llmAdjudication ? "claim_key_alias_llm_adjudicated" : "claim_key_alias_deterministic",
      eligibleForApply: false,
      autoApplyBlocker: blocker,
    }),
    onPersisted: (passCtx) => {
      passCtx.telemetry.aliasConvergenceDecisionStats.proposedClusters += 1;
    },
  });
}

function resolveProposalBlocker(candidate: ClaimKeyAliasCandidate, adjudication: ClaimKeyAliasAdjudication | null): string {
  if (!candidate.deterministicAutoApplyEligible) {
    return candidate.unresolvedReason ?? "Deterministic alias candidate is not auto-apply eligible.";
  }
  if (!adjudication) {
    return "LLM adjudication was unavailable.";
  }
  if (!adjudication.sameSlot) {
    return "LLM adjudication did not confirm that the keys describe the same slot.";
  }
  if (adjudication.confidence < CLAIM_KEY_ALIAS_AUTO_APPLY_THRESHOLD) {
    return "LLM adjudication confidence is below the auto-apply threshold.";
  }
  return "LLM adjudication did not confirm the deterministic canonical key.";
}

function buildClaimKeyAliasConvergenceAudit(candidate: ClaimKeyAliasCandidate, adjudication: ClaimKeyAliasAdjudication | null): ClaimKeyAliasConvergenceAudit {
  return {
    entityPrefix: candidate.entityPrefix,
    currentClaimKeys: [...candidate.claimKeys],
    proposedClaimKey: candidate.proposedClaimKey,
    deterministicConfidence: candidate.confidence,
    deterministicAutoApplyEligible: candidate.deterministicAutoApplyEligible,
    unresolvedReason: candidate.unresolvedReason,
    llmAdjudication: adjudication,
    evidence: candidate.evidence.map((evidence) => ({ ...evidence })),
    keyProfiles: candidate.keyProfiles.map((profile) => ({
      ...profile,
      durableIds: [...profile.durableIds],
      typeSet: [...profile.typeSet],
      projectSet: [...profile.projectSet],
    })),
  };
}

function buildAliasRationale(candidate: ClaimKeyAliasCandidate, adjudication: ClaimKeyAliasAdjudication | null, decision: string): string {
  return (
    `Deep dreaming found same-entity claim-key aliases under "${candidate.entityPrefix}" with keys ${candidate.claimKeys.join(", ")}. ` +
    `Proposed canonical key: ${candidate.proposedClaimKey ?? "(none)"}. ` +
    `Deterministic confidence ${candidate.confidence.toFixed(2)}. ` +
    (adjudication ? `LLM adjudication: ${adjudication.rationale} ` : "") +
    decision
  ).trim();
}
