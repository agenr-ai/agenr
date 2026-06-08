import type { ClaimKeyAliasCandidate } from "../claim-key-alias.js";
import type { LlmPort } from "../ports.js";

/** LLM verdict for one claim-key alias candidate. */
export interface ClaimKeyAliasAdjudication {
  sameSlot: boolean;
  canonicalClaimKey: string | null;
  confidence: number;
  rationale: string;
}

interface RawAliasAdjudication {
  same_slot?: unknown;
  canonical_claim_key?: unknown;
  confidence?: unknown;
  rationale?: unknown;
}

/**
 * Asks an LLM to adjudicate whether a deterministic claim-key alias cluster is one slot.
 *
 * @param candidate - Deterministic same-entity alias candidate.
 * @param llm - LLM port used for JSON adjudication.
 * @returns Normalized adjudication verdict.
 */
export async function adjudicateClaimKeyAliasCandidate(candidate: ClaimKeyAliasCandidate, llm: LlmPort): Promise<ClaimKeyAliasAdjudication> {
  const raw = await llm.completeJson<RawAliasAdjudication>(buildAliasAdjudicationSystemPrompt(), buildAliasAdjudicationUserPrompt(candidate));
  return normalizeAliasAdjudication(raw);
}

/** Builds the system prompt for same-slot alias adjudication. */
export function buildAliasAdjudicationSystemPrompt(): string {
  return [
    "You adjudicate claim-key alias cleanup for a memory system.",
    "A claim key names one durable slot in entity/attribute form.",
    "Decide whether the candidate keys describe the same slot, not merely related concepts.",
    "Be conservative. If either key can represent a distinct stable slot, return same_slot false.",
    'Return JSON only: {"same_slot": boolean, "canonical_claim_key": string|null, "confidence": number, "rationale": string}.',
  ].join("\n");
}

/** Builds the user prompt for one alias candidate. */
export function buildAliasAdjudicationUserPrompt(candidate: ClaimKeyAliasCandidate): string {
  return [
    `Entity prefix: ${candidate.entityPrefix}`,
    `Candidate keys: ${candidate.claimKeys.join(", ")}`,
    `Deterministic proposed canonical key: ${candidate.proposedClaimKey ?? "(none)"}`,
    `Deterministic confidence: ${candidate.confidence.toFixed(3)}`,
    "",
    "Evidence:",
    ...candidate.evidence.map((evidence) => `- ${evidence.kind}: ${evidence.detail}`),
    "",
    "Key profiles:",
    ...candidate.keyProfiles.map(
      (profile) =>
        `- ${profile.claimKey}: attribute=${profile.attribute}; durables=${profile.durableIds.join(", ")}; types=${profile.typeSet.join(", ") || "(none)"}; projects=${profile.projectSet.join(", ") || "(none)"}; trusted_or_manual=${profile.trustedOrManualCount}`,
    ),
  ].join("\n");
}

/** Normalizes raw model JSON into a bounded adjudication record. */
export function normalizeAliasAdjudication(raw: RawAliasAdjudication): ClaimKeyAliasAdjudication {
  const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0;
  const canonicalClaimKey = typeof raw.canonical_claim_key === "string" && raw.canonical_claim_key.trim().length > 0 ? raw.canonical_claim_key.trim() : null;
  const rationale = typeof raw.rationale === "string" && raw.rationale.trim().length > 0 ? raw.rationale.trim() : "No rationale provided.";

  return {
    sameSlot: raw.same_slot === true,
    canonicalClaimKey,
    confidence,
    rationale,
  };
}
