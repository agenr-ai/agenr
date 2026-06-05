import { describeClaimKeySuspicion, inspectClaimKey, isTrustedClaimKeyForCleanup, type ClaimKeyInspection } from "../../../../core/claim-key.js";
import type { ClaimExtractionResult } from "../../../../core/store/claim-extraction.js";
import type { Durable } from "../../../../core/types.js";
import { PROJECT_METADATA_ENTITY_ALIASES, USER_METADATA_ENTITY_ALIASES } from "../constants.js";
import { normalizeMetadataEntity } from "./utils.js";

export type ExistingClaimKeyInspection =
  | { kind: "missing" }
  | { kind: "ok"; inspection: ClaimKeyInspection }
  | { kind: "malformed"; inspection: ClaimKeyInspection }
  | { kind: "noncanonical"; inspection: ClaimKeyInspection; normalized: NonNullable<ClaimKeyInspection["normalized"]> }
  | { kind: "suspect"; inspection: ClaimKeyInspection };

export function inspectExistingClaimKey(durable: Durable): ExistingClaimKeyInspection {
  const rawClaimKey = durable.claim_key?.trim();
  if (!rawClaimKey) {
    return { kind: "missing" };
  }

  const inspection = inspectClaimKey(rawClaimKey);
  if (inspection.normalizationFailure) {
    return { kind: "malformed", inspection };
  }

  if (inspection.normalized && !inspection.canonical) {
    return {
      kind: "noncanonical",
      inspection,
      normalized: inspection.normalized,
    };
  }

  if (inspection.suspectReasons.length > 0) {
    return { kind: "suspect", inspection };
  }

  return { kind: "ok", inspection };
}

export function resolveExplicitMetadataRepair(durable: Durable, inspection: ClaimKeyInspection): string | null {
  const normalized = inspection.normalized;
  if (!normalized) {
    return null;
  }

  const userEntity = normalizeMetadataEntity(durable.user_id);
  const projectEntity = normalizeMetadataEntity(durable.project);
  if (USER_METADATA_ENTITY_ALIASES.has(normalized.entity) && userEntity) {
    const candidate = `${userEntity}/${normalized.attribute}`;
    return isTrustedClaimKeyForCleanup(candidate) ? candidate : null;
  }

  if (PROJECT_METADATA_ENTITY_ALIASES.has(normalized.entity) && projectEntity) {
    const candidate = `${projectEntity}/${normalized.attribute}`;
    return isTrustedClaimKeyForCleanup(candidate) ? candidate : null;
  }

  return null;
}

export function resolveMetadataBackfillClaimKey(durable: Durable, claimKey: string): string | null {
  return resolveExplicitMetadataRepair(durable, inspectClaimKey(claimKey));
}

export function describeSuspicionList(inspection: ClaimKeyInspection): string {
  if (!inspection.normalized || inspection.suspectReasons.length === 0) {
    return "it is low-trust";
  }

  return inspection.suspectReasons.map((reason) => describeClaimKeySuspicion(reason, inspection.normalized!)).join(", ");
}

/**
 * Builds the human-readable rationale for one suspect-canonical proposal.
 *
 * @param durable - Durable under review.
 * @param inspection - Parsed claim-key inspection for the durable.
 * @param metadataRepair - Metadata-derived repair candidate, when present.
 * @param suggestion - Optional claim-extraction preview.
 * @returns Proposal rationale text before lifecycle wrapping.
 */
export function buildSuspectProposalRationale(
  durable: Durable,
  inspection: ClaimKeyInspection,
  metadataRepair: string | null,
  suggestion: ClaimExtractionResult | null,
): string {
  const suspectReason = describeSuspicionList(inspection);
  const replacementHint =
    metadataRepair !== null
      ? ` Explicit metadata suggests "${metadataRepair}".`
      : suggestion?.claimKey
        ? ` Claim extraction preview suggested "${suggestion.claimKey}" at confidence ${suggestion.confidence.toFixed(2)}.`
        : "";

  return `Claim key "${durable.claim_key}" is structurally canonical but suspect because ${suspectReason}.${replacementHint}`;
}
