import type { ClaimKeyEntityFamilyCandidate, ClaimKeyEntityFamilyEvidence, ClaimKeyEntityFamilyPairSupport } from "../../../../core/claim-key-entity-family.js";
import { inspectClaimKey } from "../../../../core/claim-key.js";
import type { Durable } from "../../../../core/types.js";
import type { EntityFamilyConvergenceAudit } from "../types.js";
import { normalizeStringArray } from "./utils.js";

/** Builds persisted audit data for an entity-family convergence candidate. */
export function buildEntityFamilyConvergenceAudit(candidate: ClaimKeyEntityFamilyCandidate): EntityFamilyConvergenceAudit {
  return {
    competingEntityPrefixes: [...candidate.entityPrefixes],
    canonicalEntityPrefix: candidate.canonicalEntityPrefix,
    canonicalSelectionReasons: [...candidate.canonicalSelectionReasons],
    unresolvedReason: candidate.unresolvedReason,
    evidence: flattenEntityFamilyEvidence(candidate.pairSupport),
    pairSupport: candidate.pairSupport.map((support) => ({
      entityPrefixes: [...support.entityPrefixes] as [string, string],
      supportingDurableIds: [...support.supportingDurableIds],
      sharedAttributes: [...support.sharedAttributes],
      confidence: support.confidence,
      autoSafe: support.autoSafe,
      preferredCanonicalEntityPrefix: support.preferredCanonicalEntityPrefix,
      evidence: support.evidence.map((evidence) => ({ ...evidence })),
    })),
  };
}

/** Flattens pairwise entity-family evidence into a de-duplicated evidence list. */
export function flattenEntityFamilyEvidence(pairSupport: ClaimKeyEntityFamilyPairSupport[]): ClaimKeyEntityFamilyEvidence[] {
  const evidenceByKey = new Map<string, ClaimKeyEntityFamilyEvidence>();

  for (const support of pairSupport) {
    for (const evidence of support.evidence) {
      const evidenceKey = `${evidence.kind}:${evidence.detail}`;
      if (!evidenceByKey.has(evidenceKey)) {
        evidenceByKey.set(evidenceKey, { ...evidence });
      }
    }
  }

  return [...evidenceByKey.values()];
}

/**
 * Returns durables in the working set that should rewrite onto the canonical entity prefix.
 *
 * @param projectedDurables - Projected working-set durables.
 * @param candidate - Detected entity-family convergence candidate.
 * @returns Durables whose entity prefix differs from the canonical candidate.
 */
export function collectEntityFamilyDurablesToRewrite(projectedDurables: Durable[], candidate: ClaimKeyEntityFamilyCandidate): Durable[] {
  const canonicalEntityPrefix = candidate.canonicalEntityPrefix;
  if (!canonicalEntityPrefix) {
    return [];
  }

  return projectedDurables.filter((durable) => {
    const claimKey = durable.claim_key?.trim();
    if (!claimKey) {
      return false;
    }

    const claimKeyInspection = inspectClaimKey(claimKey);
    if (
      !claimKeyInspection.normalized ||
      claimKeyInspection.suspectReasons.length > 0 ||
      !candidate.entityPrefixes.includes(claimKeyInspection.normalized.entity)
    ) {
      return false;
    }

    return claimKeyInspection.normalized.entity !== canonicalEntityPrefix;
  });
}

/**
 * Resolves the converged claim key for one durable under a canonical entity prefix.
 *
 * @param durable - Durable whose claim key should converge.
 * @param canonicalEntityPrefix - Selected canonical entity prefix.
 * @returns Converged claim key, or null when the durable cannot be rewritten safely.
 */
export function resolveEntityFamilyTargetClaimKey(durable: Durable, canonicalEntityPrefix: string): string | null {
  const claimKey = durable.claim_key?.trim();
  if (!claimKey) {
    return null;
  }

  const claimKeyInspection = inspectClaimKey(claimKey);
  if (!claimKeyInspection.normalized) {
    return null;
  }

  return `${canonicalEntityPrefix}/${claimKeyInspection.normalized.attribute}`;
}

/** Rewrites claim keys from competing entity prefixes onto the canonical prefix. */
export function mapEntityFamilyClaimKeys(claimKeys: string[], entityPrefixes: string[], canonicalEntityPrefix: string): string[] {
  const entityPrefixSet = new Set(entityPrefixes);
  return normalizeStringArray(
    claimKeys.flatMap((claimKey) => {
      const inspection = inspectClaimKey(claimKey);
      if (!inspection.normalized || !entityPrefixSet.has(inspection.normalized.entity) || inspection.normalized.entity === canonicalEntityPrefix) {
        return [];
      }

      return [`${canonicalEntityPrefix}/${inspection.normalized.attribute}`];
    }),
  );
}

/** Builds human-readable rationale text for an entity-family convergence candidate. */
export function buildEntityFamilyConvergenceRationale(candidate: ClaimKeyEntityFamilyCandidate): string {
  const evidenceText = flattenEntityFamilyEvidence(candidate.pairSupport)
    .map((evidence) => evidence.detail)
    .join(" ");
  const canonicalText = candidate.canonicalEntityPrefix
    ? ` Canonical entity prefix candidate: "${candidate.canonicalEntityPrefix}".`
    : " No single canonical entity prefix is safe to choose automatically.";
  const reasonText = candidate.unresolvedReason ? ` ${candidate.unresolvedReason}` : "";
  const selectionText =
    candidate.canonicalSelectionReasons.length > 0 ? ` Canonical selection signals: ${candidate.canonicalSelectionReasons.join(", ")}.` : "";

  return (
    `Claim-key entity families ${candidate.entityPrefixes.join(", ")} show repeated same-slot overlap and grounding support. ` +
    evidenceText +
    canonicalText +
    selectionText +
    reasonText
  ).trim();
}
