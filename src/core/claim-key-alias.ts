import { inspectClaimKey } from "./claim-key.js";
import {
  computeClaimKeyTokenOverlap,
  readClaimKeyAttributeHead,
  tokenizeClaimKeyAttributeTokens,
  tokenizeClaimKeyTextTokens,
  tokenizeOptionalClaimKeyTextTokens,
} from "./claim-key-lexical.js";
import type { ClaimKeySource, ClaimKeyStatus, Durable } from "./types.js";

const ATTRIBUTE_ALIAS_MIN_CONFIDENCE = 0.72;
/** Minimum deterministic confidence required before alias auto-apply may be considered. */
const CLAIM_KEY_ALIAS_AUTO_APPLY_THRESHOLD = 0.9;

export { CLAIM_KEY_ALIAS_AUTO_APPLY_THRESHOLD };
const ATTRIBUTE_ALIAS_MAX_KEYS_PER_ENTITY = 40;

/** Persisted proposal sources for same-entity claim-key alias convergence. */
export type ClaimKeyAliasProposalSource = "claim_key_alias_collision" | "claim_key_alias_llm_adjudicated" | "claim_key_alias_deterministic";

/** Evidence kinds emitted by same-entity claim-key alias detection. */
export type ClaimKeyAliasEvidenceKind =
  | "same_entity"
  | "attribute_token_overlap"
  | "attribute_head_overlap"
  | "subject_overlap"
  | "content_overlap"
  | "shared_tags"
  | "same_type"
  | "same_project"
  | "lifecycle_trust";

/** One evidence fragment supporting a same-slot claim-key alias candidate. */
export interface ClaimKeyAliasEvidence {
  kind: ClaimKeyAliasEvidenceKind;
  detail: string;
}

/** One claim-key profile inside an alias candidate. */
export interface ClaimKeyAliasKeyProfile {
  claimKey: string;
  attribute: string;
  durableIds: string[];
  typeSet: string[];
  projectSet: string[];
  trustedOrManualCount: number;
}

/** Candidate cluster of same-entity keys that likely describe the same slot. */
export interface ClaimKeyAliasCandidate {
  entityPrefix: string;
  durableIds: string[];
  claimKeys: string[];
  proposedClaimKey: string | null;
  confidence: number;
  deterministicAutoApplyEligible: boolean;
  unresolvedReason: string | null;
  evidence: ClaimKeyAliasEvidence[];
  keyProfiles: ClaimKeyAliasKeyProfile[];
}

/** Aggregated durable evidence for one claim key within alias detection. */
interface AliasProfile {
  claimKey: string;
  entity: string;
  attribute: string;
  durableIds: Set<string>;
  typeSet: Set<string>;
  projectSet: Set<string>;
  subjectTokens: Set<string>;
  contentTokens: Set<string>;
  tagTokens: Set<string>;
  trustedOrManualCount: number;
  durableCount: number;
  totalImportance: number;
  latestCreatedAt: string;
}

/** Pairwise alias support edge between two claim-key profiles. */
interface PairSupport {
  left: AliasProfile;
  right: AliasProfile;
  confidence: number;
  evidence: ClaimKeyAliasEvidence[];
}

/** Overlap signals computed for one claim-key profile pair. */
interface PairEvaluationContext {
  left: AliasProfile;
  right: AliasProfile;
  attributeOverlap: ReturnType<typeof computeClaimKeyTokenOverlap>;
  subjectOverlap: ReturnType<typeof computeClaimKeyTokenOverlap>;
  contentOverlap: ReturnType<typeof computeClaimKeyTokenOverlap>;
  tagOverlap: ReturnType<typeof computeClaimKeyTokenOverlap>;
  sharedAttributeHead: boolean;
}

/** One scoring rule in the pairwise alias confidence model. */
interface PairSignal {
  applies: (context: PairEvaluationContext) => boolean;
  score: number;
  buildEvidence: (context: PairEvaluationContext) => ClaimKeyAliasEvidence;
}

const PAIR_SIGNALS: PairSignal[] = [
  {
    applies: (context) => context.attributeOverlap.commonCount >= 2 && context.attributeOverlap.coefficient >= 0.5,
    score: 0.28,
    buildEvidence: (context) => ({
      kind: "attribute_token_overlap",
      detail: `Attributes share ${context.attributeOverlap.commonCount} stable tokens.`,
    }),
  },
  {
    applies: (context) => context.sharedAttributeHead,
    score: 0.12,
    buildEvidence: (context) => ({
      kind: "attribute_head_overlap",
      detail: `Attributes share head "${readClaimKeyAttributeHead(context.left.attribute)}".`,
    }),
  },
  {
    applies: (context) => context.subjectOverlap.commonCount >= 2 && context.subjectOverlap.coefficient >= 0.5,
    score: 0.16,
    buildEvidence: (context) => ({
      kind: "subject_overlap",
      detail: `Subjects share ${context.subjectOverlap.commonCount} stable tokens.`,
    }),
  },
  {
    applies: (context) => context.contentOverlap.commonCount >= 4 && context.contentOverlap.coefficient >= 0.45,
    score: 0.2,
    buildEvidence: (context) => ({
      kind: "content_overlap",
      detail: `Content shares ${context.contentOverlap.commonCount} stable tokens.`,
    }),
  },
  {
    applies: (context) => context.tagOverlap.commonCount >= 1,
    score: 0.06,
    buildEvidence: (context) => ({
      kind: "shared_tags",
      detail: `Durables share ${context.tagOverlap.commonCount} tag tokens.`,
    }),
  },
  {
    applies: (context) => setsEqual(context.left.typeSet, context.right.typeSet),
    score: 0.1,
    buildEvidence: (context) => ({
      kind: "same_type",
      detail: `Both keys are used by ${[...context.left.typeSet].sort().join(", ")} durables.`,
    }),
  },
  {
    applies: (context) => context.left.projectSet.size > 0 && setsEqual(context.left.projectSet, context.right.projectSet),
    score: 0.06,
    buildEvidence: (context) => ({
      kind: "same_project",
      detail: `Both keys share project scope ${[...context.left.projectSet].sort().join(", ")}.`,
    }),
  },
  {
    applies: (context) => context.left.trustedOrManualCount > 0 || context.right.trustedOrManualCount > 0,
    score: 0.04,
    buildEvidence: () => ({
      kind: "lifecycle_trust",
      detail: "At least one side has trusted or manual lifecycle metadata.",
    }),
  },
];

/**
 * Detects likely same-slot aliases among active canonical claim keys.
 *
 * The detector only compares keys that already share an entity prefix. Cross-entity
 * cleanup remains owned by entity-family convergence.
 *
 * @param durables - Active reconcile working-set durables.
 * @returns Conservative same-entity alias candidates ordered by confidence.
 */
export function detectClaimKeyAliasCandidates(durables: Durable[]): ClaimKeyAliasCandidate[] {
  const byEntity = buildAliasProfiles(durables);
  const candidates: ClaimKeyAliasCandidate[] = [];

  for (const profiles of byEntity.values()) {
    if (profiles.length < 2 || profiles.length > ATTRIBUTE_ALIAS_MAX_KEYS_PER_ENTITY) {
      continue;
    }

    const pairSupport = buildPairSupport(profiles);
    const components = buildConnectedComponents(pairSupport);
    for (const component of components) {
      const componentProfiles = component
        .map((claimKey) => profiles.find((profile) => profile.claimKey === claimKey))
        .filter((profile): profile is AliasProfile => Boolean(profile));
      if (componentProfiles.length < 2) {
        continue;
      }

      const componentSupport = pairSupport.filter((support) => component.includes(support.left.claimKey) && component.includes(support.right.claimKey));
      candidates.push(buildAliasCandidate(componentProfiles, componentSupport));
    }
  }

  return candidates
    .sort((left, right) => right.confidence - left.confidence || left.claimKeys.join(",").localeCompare(right.claimKeys.join(",")))
    .slice(0, 100);
}

/** Groups durable rows into per-claim-key alias profiles keyed by entity. */
function buildAliasProfiles(durables: Durable[]): Map<string, AliasProfile[]> {
  const profilesByKey = new Map<string, AliasProfile>();

  for (const durable of durables) {
    const claimKey = durable.claim_key?.trim();
    if (!claimKey) {
      continue;
    }

    const inspection = inspectClaimKey(claimKey);
    if (!inspection.canonical || !inspection.normalized || inspection.suspectReasons.length > 0) {
      continue;
    }

    const profile = getOrCreateProfile(profilesByKey, inspection.normalized.claimKey, inspection.normalized.entity, inspection.normalized.attribute);
    profile.durableIds.add(durable.id);
    profile.typeSet.add(durable.type);
    if (durable.project) {
      profile.projectSet.add(durable.project);
    }
    for (const token of tokenizeOptionalClaimKeyTextTokens(durable.subject)) {
      profile.subjectTokens.add(token);
    }
    for (const token of tokenizeOptionalClaimKeyTextTokens(durable.content)) {
      profile.contentTokens.add(token);
    }
    for (const tag of durable.tags) {
      for (const token of tokenizeClaimKeyTextTokens(tag)) {
        profile.tagTokens.add(token);
      }
    }
    if (isTrustedOrManual(durable.claim_key_status, durable.claim_key_source)) {
      profile.trustedOrManualCount += 1;
    }
    profile.durableCount += 1;
    profile.totalImportance += durable.importance;
    if (!profile.latestCreatedAt || durable.created_at > profile.latestCreatedAt) {
      profile.latestCreatedAt = durable.created_at;
    }
  }

  const byEntity = new Map<string, AliasProfile[]>();
  for (const profile of profilesByKey.values()) {
    const existing = byEntity.get(profile.entity) ?? [];
    existing.push(profile);
    byEntity.set(profile.entity, existing);
  }

  return byEntity;
}

/** Returns an existing or newly created alias profile for one claim key. */
function getOrCreateProfile(profilesByKey: Map<string, AliasProfile>, claimKey: string, entity: string, attribute: string): AliasProfile {
  const existing = profilesByKey.get(claimKey);
  if (existing) {
    return existing;
  }

  const created: AliasProfile = {
    claimKey,
    entity,
    attribute,
    durableIds: new Set<string>(),
    typeSet: new Set<string>(),
    projectSet: new Set<string>(),
    subjectTokens: new Set<string>(),
    contentTokens: new Set<string>(),
    tagTokens: new Set<string>(),
    trustedOrManualCount: 0,
    durableCount: 0,
    totalImportance: 0,
    latestCreatedAt: "",
  };
  profilesByKey.set(claimKey, created);
  return created;
}

/** Scores all profile pairs within an entity and returns qualifying support edges. */
function buildPairSupport(profiles: AliasProfile[]): PairSupport[] {
  const support: PairSupport[] = [];

  for (let index = 0; index < profiles.length; index += 1) {
    const left = profiles[index];
    if (!left) {
      continue;
    }

    for (let peerIndex = index + 1; peerIndex < profiles.length; peerIndex += 1) {
      const right = profiles[peerIndex];
      if (!right) {
        continue;
      }

      const pair = evaluatePair(left, right);
      if (pair) {
        support.push(pair);
      }
    }
  }

  return support.sort((left, right) => right.confidence - left.confidence);
}

/** Scores one profile pair and returns support when confidence clears the threshold. */
function evaluatePair(left: AliasProfile, right: AliasProfile): PairSupport | null {
  const context = buildPairEvaluationContext(left, right);
  const evidence: ClaimKeyAliasEvidence[] = [
    {
      kind: "same_entity",
      detail: `Both keys use entity prefix "${left.entity}".`,
    },
  ];
  let score = 0.2;

  for (const signal of PAIR_SIGNALS) {
    if (!signal.applies(context)) {
      continue;
    }
    score += signal.score;
    evidence.push(signal.buildEvidence(context));
  }

  const confidence = Math.min(0.98, Number(score.toFixed(3)));
  if (confidence < ATTRIBUTE_ALIAS_MIN_CONFIDENCE) {
    return null;
  }

  return { left, right, confidence, evidence };
}

/** Precomputes overlap signals used by pairwise alias scoring. */
function buildPairEvaluationContext(left: AliasProfile, right: AliasProfile): PairEvaluationContext {
  return {
    left,
    right,
    attributeOverlap: computeClaimKeyTokenOverlap(tokenizeClaimKeyAttributeTokens(left.attribute), tokenizeClaimKeyAttributeTokens(right.attribute)),
    subjectOverlap: computeClaimKeyTokenOverlap(left.subjectTokens, right.subjectTokens),
    contentOverlap: computeClaimKeyTokenOverlap(left.contentTokens, right.contentTokens),
    tagOverlap: computeClaimKeyTokenOverlap(left.tagTokens, right.tagTokens),
    sharedAttributeHead: readClaimKeyAttributeHead(left.attribute) === readClaimKeyAttributeHead(right.attribute),
  };
}

/**
 * Merges pairwise alias support into transitive clusters.
 *
 * If A aliases B and B aliases C, all three keys are grouped even when A and C
 * would not pass pairwise scoring on their own.
 */
function buildConnectedComponents(pairSupport: PairSupport[]): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const support of pairSupport) {
    getOrCreateSet(adjacency, support.left.claimKey).add(support.right.claimKey);
    getOrCreateSet(adjacency, support.right.claimKey).add(support.left.claimKey);
  }

  const components: string[][] = [];
  const visited = new Set<string>();
  for (const claimKey of adjacency.keys()) {
    if (visited.has(claimKey)) {
      continue;
    }
    const stack = [claimKey];
    const component: string[] = [];
    visited.add(claimKey);
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    components.push(component.sort());
  }
  return components;
}

/** Builds one alias candidate cluster from connected profiles and pair support. */
function buildAliasCandidate(profiles: AliasProfile[], pairSupport: PairSupport[]): ClaimKeyAliasCandidate {
  const proposedProfile = chooseCanonicalProfile(profiles);
  const multipleTrustedOrManual = profiles.filter((profile) => profile.trustedOrManualCount > 0).length > 1;
  const sameType = profiles.every((profile) => setsEqual(profile.typeSet, profiles[0]?.typeSet ?? new Set<string>()));
  const confidence = pairSupport.length > 0 ? Math.min(...pairSupport.map((support) => support.confidence)) : ATTRIBUTE_ALIAS_MIN_CONFIDENCE;
  const deterministicAutoApplyEligible = confidence >= CLAIM_KEY_ALIAS_AUTO_APPLY_THRESHOLD && sameType && !multipleTrustedOrManual && proposedProfile !== null;
  const evidence = dedupeEvidence(pairSupport.flatMap((support) => support.evidence));

  return {
    entityPrefix: profiles[0]?.entity ?? "",
    durableIds: normalizeStrings(profiles.flatMap((profile) => [...profile.durableIds])),
    claimKeys: normalizeStrings(profiles.map((profile) => profile.claimKey)),
    proposedClaimKey: proposedProfile?.claimKey ?? null,
    confidence,
    deterministicAutoApplyEligible,
    unresolvedReason: deterministicAutoApplyEligible
      ? null
      : buildUnresolvedReason({ multipleTrustedOrManual, sameType, hasProposedProfile: proposedProfile !== null, confidence }),
    evidence,
    keyProfiles: profiles
      .map((profile) => ({
        claimKey: profile.claimKey,
        attribute: profile.attribute,
        durableIds: [...profile.durableIds].sort(),
        typeSet: [...profile.typeSet].sort(),
        projectSet: [...profile.projectSet].sort(),
        trustedOrManualCount: profile.trustedOrManualCount,
      }))
      .sort((left, right) => left.claimKey.localeCompare(right.claimKey)),
  };
}

/** Picks the preferred canonical claim key from a profile cluster. */
function chooseCanonicalProfile(profiles: AliasProfile[]): AliasProfile | null {
  return (
    [...profiles].sort((left, right) => {
      if (right.trustedOrManualCount !== left.trustedOrManualCount) {
        return right.trustedOrManualCount - left.trustedOrManualCount;
      }
      if (right.durableCount !== left.durableCount) {
        return right.durableCount - left.durableCount;
      }
      if (right.totalImportance !== left.totalImportance) {
        return right.totalImportance - left.totalImportance;
      }
      if (right.latestCreatedAt !== left.latestCreatedAt) {
        return right.latestCreatedAt.localeCompare(left.latestCreatedAt);
      }
      return left.claimKey.localeCompare(right.claimKey);
    })[0] ?? null
  );
}

/** Explains why a cluster is not auto-apply eligible. */
function buildUnresolvedReason(input: { multipleTrustedOrManual: boolean; sameType: boolean; hasProposedProfile: boolean; confidence: number }): string {
  if (!input.hasProposedProfile) {
    return "No canonical target claim key could be selected.";
  }
  if (input.multipleTrustedOrManual) {
    return "Multiple trusted or manual claim keys are present, so operator review is required.";
  }
  if (!input.sameType) {
    return "Alias cluster spans multiple durable types.";
  }
  if (input.confidence < CLAIM_KEY_ALIAS_AUTO_APPLY_THRESHOLD) {
    return "Deterministic confidence is below the auto-apply threshold.";
  }
  return "Alias cluster requires review.";
}

/** Returns whether two string sets contain the same values. */
function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

/** Returns whether claim-key status or source counts as trusted or manual. */
function isTrustedOrManual(status: ClaimKeyStatus | undefined, source: ClaimKeySource | undefined): boolean {
  return status === "trusted" || source === "manual";
}

/** Removes duplicate evidence entries from one alias candidate. */
function dedupeEvidence(evidence: ClaimKeyAliasEvidence[]): ClaimKeyAliasEvidence[] {
  const seen = new Set<string>();
  const deduped: ClaimKeyAliasEvidence[] = [];
  for (const item of evidence) {
    const key = `${item.kind}:${item.detail}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }
  return deduped;
}

/** Returns an existing or newly created string set in a map. */
function getOrCreateSet(map: Map<string, Set<string>>, key: string): Set<string> {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const created = new Set<string>();
  map.set(key, created);
  return created;
}

/** Deduplicates, trims, and lexicographically sorts string values. */
function normalizeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}
