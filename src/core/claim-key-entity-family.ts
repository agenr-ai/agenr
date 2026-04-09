/* eslint-disable jsdoc/require-jsdoc */

import { inspectClaimKey, normalizeClaimKeySegment } from "./claim-key.js";
import type { ClaimKeySource, ClaimKeyStatus, Entry } from "./types.js";

const ENTITY_FAMILY_GROUNDING_STOP_TOKENS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "with",
]);
const MAX_ATTRIBUTE_BUCKET_SIZE = 12;
const MAX_EVIDENCE_VALUES = 6;
const CANONICAL_SELECTION_MARGIN = 3;
const SINGLETON_ALIAS_MAX_FAMILY_SIZE = 2;
const SINGLETON_ALIAS_MIN_DOMINANT_TRUSTED_COUNT = 3;
const SINGLETON_ALIAS_MIN_CONFIDENCE_DELTA = 0.05;
const SINGLETON_ALIAS_SCOPE_TOKENS = new Set([
  "agent",
  "app",
  "branch",
  "build",
  "cluster",
  "daemon",
  "device",
  "env",
  "environment",
  "gateway",
  "host",
  "machine",
  "node",
  "plugin",
  "project",
  "repo",
  "repository",
  "server",
  "service",
  "session",
  "system",
  "workspace",
]);

/**
 * Structured evidence kinds emitted by entity-family convergence detection.
 */
export type ClaimKeyEntityFamilyEvidenceKind =
  | "shared_attribute_overlap"
  | "shared_attribute_head_overlap"
  | "shared_tag_grounding"
  | "shared_source_context_grounding"
  | "shared_subject_grounding"
  | "lexical_separator_variant"
  | "lexical_token_reordering"
  | "lexical_initialism_expansion"
  | "lexical_token_subset";

/**
 * One structured evidence fragment supporting a potential entity-family convergence.
 */
export interface ClaimKeyEntityFamilyEvidence {
  kind: ClaimKeyEntityFamilyEvidenceKind;
  detail: string;
}

/**
 * One pairwise alias-support edge between two entity prefixes.
 */
export interface ClaimKeyEntityFamilyPairSupport {
  entityPrefixes: [string, string];
  supportingEntryIds: string[];
  sharedAttributes: string[];
  confidence: number;
  autoSafe: boolean;
  preferredCanonicalEntityPrefix: string | null;
  evidence: ClaimKeyEntityFamilyEvidence[];
}

/**
 * Structured result describing one likely split entity family across claim keys.
 */
export interface ClaimKeyEntityFamilyCandidate {
  entityPrefixes: string[];
  entryIds: string[];
  claimKeys: string[];
  canonicalEntityPrefix: string | null;
  canonicalSelectionReasons: string[];
  confidence: number;
  autoConverge: boolean;
  unresolvedReason: string | null;
  pairSupport: ClaimKeyEntityFamilyPairSupport[];
}

/**
 * Minimal keyed-row shape used to summarize claim-key entity-prefix families.
 */
export interface ClaimKeyEntityPrefixObservation {
  claim_key?: string;
  claim_key_status?: ClaimKeyStatus;
  claim_key_source?: ClaimKeySource;
}

/**
 * Aggregate active corpus counts for one entity prefix.
 */
export interface ClaimKeyEntityPrefixStats {
  entityPrefix: string;
  activeEntryCount: number;
  trustedEntryCount: number;
  tentativeEntryCount: number;
  unresolvedEntryCount: number;
  legacyEntryCount: number;
  deterministicRepairEntryCount: number;
  manualEntryCount: number;
  modelEntryCount: number;
  jsonRetryEntryCount: number;
  surgeonFamilyReuseEntryCount: number;
}

/**
 * Evidence kinds emitted by singleton-alias family detection.
 */
export type ClaimKeySingletonAliasEvidenceKind =
  | "dominant_trusted_family"
  | "singleton_family_size"
  | "low_trust_creation_path"
  | "lexical_separator_variant"
  | "lexical_token_subset";

/**
 * One structured evidence fragment supporting a suspicious singleton alias family.
 */
export interface ClaimKeySingletonAliasEvidence {
  kind: ClaimKeySingletonAliasEvidenceKind;
  detail: string;
}

/**
 * Structured dominant-family singleton-alias candidate.
 */
export interface ClaimKeySingletonAliasCandidate {
  aliasEntityPrefix: string;
  dominantEntityPrefix: string;
  aliasFamilySize: number;
  dominantFamilySize: number;
  dominantTrustedCount: number;
  aliasLowTrustCount: number;
  confidence: number;
  canonicalReuseSafe: boolean;
  evidence: ClaimKeySingletonAliasEvidence[];
}

interface TrustedClaimKeyEntityProfile {
  entityPrefix: string;
  entryIds: Set<string>;
  claimKeys: Set<string>;
  attributeSet: Set<string>;
  attributeHeadSet: Set<string>;
  tags: Set<string>;
  sourceContextTokens: Set<string>;
  subjectTokens: Set<string>;
  entryCount: number;
  totalQualityScore: number;
  tokenList: string[];
  sortedTokenSignature: string;
  compactSignature: string;
}

interface EntityLexicalRelation {
  kind: ClaimKeyEntityFamilyEvidenceKind | null;
  detail: string | null;
  autoSafe: boolean;
  preferredCanonicalEntityPrefix: string | null;
  strengthScore: number;
}

interface CanonicalSelectionResult {
  canonicalEntityPrefix: string | null;
  reasons: string[];
  unresolvedReason: string | null;
}

interface SingletonAliasLexicalRelation {
  kind: ClaimKeySingletonAliasEvidenceKind | null;
  detail: string | null;
  canonicalReuseSafe: boolean;
  scopeLike: boolean;
  strengthScore: number;
}

/**
 * Detects likely split claim-key entity families across trusted canonical claim keys.
 *
 * The detector is intentionally conservative. It requires repeated same-slot overlap
 * and additional lexical or grounding support before it will emit a convergence
 * candidate, and it only marks a family as auto-convergeable when every alias in the
 * family can be mapped through a low-risk lexical variant.
 *
 * @param entries - Working-set entries to inspect.
 * @returns Conservatively detected entity-family convergence candidates.
 */
export function detectClaimKeyEntityFamilyCandidates(entries: Entry[]): ClaimKeyEntityFamilyCandidate[] {
  const profiles = buildTrustedClaimKeyEntityProfiles(entries);
  if (profiles.size < 2) {
    return [];
  }

  const pairSupport = buildPairSupport(profiles);
  if (pairSupport.length === 0) {
    return [];
  }

  const adjacency = new Map<string, Set<string>>();
  for (const support of pairSupport) {
    const [leftEntity, rightEntity] = support.entityPrefixes;
    getOrCreateSet(adjacency, leftEntity).add(rightEntity);
    getOrCreateSet(adjacency, rightEntity).add(leftEntity);
  }

  const visited = new Set<string>();
  const families: ClaimKeyEntityFamilyCandidate[] = [];
  for (const entityPrefix of adjacency.keys()) {
    if (visited.has(entityPrefix)) {
      continue;
    }

    const component = collectConnectedEntityComponent(entityPrefix, adjacency, visited);
    if (component.length < 2) {
      continue;
    }

    const componentSet = new Set(component);
    const componentSupport = pairSupport.filter((support) => {
      const [leftEntity, rightEntity] = support.entityPrefixes;
      return componentSet.has(leftEntity) && componentSet.has(rightEntity);
    });
    const canonicalSelection = selectCanonicalEntityPrefix(component, componentSupport, profiles);
    const canonicalEntityPrefix = canonicalSelection.canonicalEntityPrefix;
    const autoConverge =
      canonicalEntityPrefix !== null &&
      component
        .filter((entity) => entity !== canonicalEntityPrefix)
        .every((entity) => {
          const support = findPairSupport(componentSupport, canonicalEntityPrefix, entity);
          return support?.autoSafe === true;
        });

    const componentProfiles = component.map((entity) => profiles.get(entity)).filter((profile): profile is TrustedClaimKeyEntityProfile => Boolean(profile));
    const entryIds = normalizeStringArray(componentProfiles.flatMap((profile) => [...profile.entryIds]));
    const claimKeys = normalizeStringArray(componentProfiles.flatMap((profile) => [...profile.claimKeys]));
    const confidence = componentSupport.length > 0 ? Math.max(...componentSupport.map((support) => support.confidence)) : 0.75;

    families.push({
      entityPrefixes: [...component].sort((left, right) => left.localeCompare(right)),
      entryIds,
      claimKeys,
      canonicalEntityPrefix,
      canonicalSelectionReasons: canonicalSelection.reasons,
      confidence,
      autoConverge,
      unresolvedReason:
        canonicalSelection.unresolvedReason ??
        (autoConverge ? null : "Entity-family evidence is strong enough to stage, but not every alias mapping is low-risk."),
      pairSupport: componentSupport.sort((left, right) => {
        const leftKey = left.entityPrefixes.join("::");
        const rightKey = right.entityPrefixes.join("::");
        return leftKey.localeCompare(rightKey);
      }),
    });
  }

  return families.sort((left, right) => {
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }

    const leftKey = left.entityPrefixes.join("::");
    const rightKey = right.entityPrefixes.join("::");
    return leftKey.localeCompare(rightKey);
  });
}

/**
 * Summarizes active claim-key rows into per-prefix corpus stats.
 *
 * @param observations - Keyed entry observations to aggregate.
 * @returns Sorted per-prefix counts used by write-time and health detectors.
 */
export function summarizeClaimKeyEntityPrefixStats(observations: ClaimKeyEntityPrefixObservation[]): ClaimKeyEntityPrefixStats[] {
  const counts = new Map<string, ClaimKeyEntityPrefixStats>();

  for (const observation of observations) {
    const rawClaimKey = observation.claim_key?.trim();
    if (!rawClaimKey) {
      continue;
    }

    const inspection = inspectClaimKey(rawClaimKey);
    if (!inspection.normalized) {
      continue;
    }

    const entityPrefix = inspection.normalized.entity;
    const existing =
      counts.get(entityPrefix) ??
      ({
        entityPrefix,
        activeEntryCount: 0,
        trustedEntryCount: 0,
        tentativeEntryCount: 0,
        unresolvedEntryCount: 0,
        legacyEntryCount: 0,
        deterministicRepairEntryCount: 0,
        manualEntryCount: 0,
        modelEntryCount: 0,
        jsonRetryEntryCount: 0,
        surgeonFamilyReuseEntryCount: 0,
      } satisfies ClaimKeyEntityPrefixStats);

    existing.activeEntryCount += 1;
    switch (observation.claim_key_status) {
      case "trusted":
        existing.trustedEntryCount += 1;
        break;
      case "tentative":
        existing.tentativeEntryCount += 1;
        break;
      case "unresolved":
        existing.unresolvedEntryCount += 1;
        break;
      default:
        existing.legacyEntryCount += 1;
        break;
    }

    switch (observation.claim_key_source) {
      case "deterministic_repair":
        existing.deterministicRepairEntryCount += 1;
        break;
      case "manual":
        existing.manualEntryCount += 1;
        break;
      case "model":
        existing.modelEntryCount += 1;
        break;
      case "json_retry":
        existing.jsonRetryEntryCount += 1;
        break;
      case "surgeon_family_reuse":
        existing.surgeonFamilyReuseEntryCount += 1;
        break;
      default:
        break;
    }

    counts.set(entityPrefix, existing);
  }

  return [...counts.values()].sort((left, right) => {
    if (right.activeEntryCount !== left.activeEntryCount) {
      return right.activeEntryCount - left.activeEntryCount;
    }

    if (right.trustedEntryCount !== left.trustedEntryCount) {
      return right.trustedEntryCount - left.trustedEntryCount;
    }

    return left.entityPrefix.localeCompare(right.entityPrefix);
  });
}

/**
 * Detects narrow dominant-family singleton aliases such as one low-trust full-name
 * repair appearing next to an established short-name family.
 *
 * @param observations - Active keyed rows to inspect.
 * @returns Conservative singleton-alias candidates ordered by confidence.
 */
export function detectClaimKeySingletonAliasCandidates(observations: ClaimKeyEntityPrefixObservation[]): ClaimKeySingletonAliasCandidate[] {
  return detectClaimKeySingletonAliasCandidatesFromStats(summarizeClaimKeyEntityPrefixStats(observations));
}

/**
 * Detects singleton-alias candidates from pre-aggregated entity-prefix stats.
 *
 * @param stats - Active per-prefix corpus counts.
 * @returns Conservative singleton-alias candidates ordered by confidence.
 */
export function detectClaimKeySingletonAliasCandidatesFromStats(stats: ClaimKeyEntityPrefixStats[]): ClaimKeySingletonAliasCandidate[] {
  const candidatesByAlias = new Map<string, ClaimKeySingletonAliasCandidate[]>();
  const dominantFamilies = stats.filter((profile) => profile.trustedEntryCount >= SINGLETON_ALIAS_MIN_DOMINANT_TRUSTED_COUNT);
  const aliasFamilies = stats.filter((profile) => {
    return (
      profile.activeEntryCount > 0 &&
      profile.activeEntryCount <= SINGLETON_ALIAS_MAX_FAMILY_SIZE &&
      profile.trustedEntryCount < profile.activeEntryCount &&
      buildLowTrustEntryCount(profile) >= 1
    );
  });

  for (const aliasProfile of aliasFamilies) {
    for (const dominantProfile of dominantFamilies) {
      if (aliasProfile.entityPrefix === dominantProfile.entityPrefix || dominantProfile.activeEntryCount <= aliasProfile.activeEntryCount) {
        continue;
      }

      const candidate = evaluateSingletonAliasCandidate(aliasProfile, dominantProfile);
      if (!candidate) {
        continue;
      }

      const existing = candidatesByAlias.get(aliasProfile.entityPrefix) ?? [];
      existing.push(candidate);
      candidatesByAlias.set(aliasProfile.entityPrefix, existing);
    }
  }

  return [...candidatesByAlias.values()]
    .flatMap(selectBestSingletonAliasCandidate)
    .sort((left, right) => right.confidence - left.confidence || left.aliasEntityPrefix.localeCompare(right.aliasEntityPrefix));
}

function buildTrustedClaimKeyEntityProfiles(entries: Entry[]): Map<string, TrustedClaimKeyEntityProfile> {
  const profiles = new Map<string, TrustedClaimKeyEntityProfile>();

  for (const entry of entries) {
    const rawClaimKey = entry.claim_key?.trim();
    if (!rawClaimKey) {
      continue;
    }

    const inspection = inspectClaimKey(rawClaimKey);
    if (!inspection.canonical || !inspection.normalized || inspection.suspectReasons.length > 0) {
      continue;
    }

    const entityPrefix = inspection.normalized.entity;
    const attribute = inspection.normalized.attribute;
    const profile = getOrCreateProfile(profiles, entityPrefix);
    profile.entryIds.add(entry.id);
    profile.claimKeys.add(inspection.normalized.claimKey);
    profile.attributeSet.add(attribute);
    const [attributeHead = attribute] = attribute.split("_");
    if (attributeHead) {
      profile.attributeHeadSet.add(attributeHead);
    }
    for (const tag of entry.tags) {
      const normalizedTag = normalizeClaimKeySegment(tag);
      if (normalizedTag) {
        profile.tags.add(normalizedTag);
      }
    }
    for (const token of tokenizeGrounding(entry.source_context)) {
      profile.sourceContextTokens.add(token);
    }
    for (const token of tokenizeGrounding(entry.subject)) {
      profile.subjectTokens.add(token);
    }
    profile.entryCount += 1;
    profile.totalQualityScore += entry.quality_score;
  }

  return profiles;
}

function getOrCreateProfile(profiles: Map<string, TrustedClaimKeyEntityProfile>, entityPrefix: string): TrustedClaimKeyEntityProfile {
  const existing = profiles.get(entityPrefix);
  if (existing) {
    return existing;
  }

  const tokenList = entityPrefix.split("_").filter((token) => token.length > 0);
  const created: TrustedClaimKeyEntityProfile = {
    entityPrefix,
    entryIds: new Set<string>(),
    claimKeys: new Set<string>(),
    attributeSet: new Set<string>(),
    attributeHeadSet: new Set<string>(),
    tags: new Set<string>(),
    sourceContextTokens: new Set<string>(),
    subjectTokens: new Set<string>(),
    entryCount: 0,
    totalQualityScore: 0,
    tokenList,
    sortedTokenSignature: [...tokenList].sort().join("_"),
    compactSignature: tokenList.join(""),
  };
  profiles.set(entityPrefix, created);
  return created;
}

function buildPairSupport(profiles: Map<string, TrustedClaimKeyEntityProfile>): ClaimKeyEntityFamilyPairSupport[] {
  const candidatePairs = new Set<string>();
  const attributeBuckets = new Map<string, string[]>();

  for (const profile of profiles.values()) {
    for (const attribute of profile.attributeSet) {
      const bucket = attributeBuckets.get(attribute);
      if (bucket) {
        bucket.push(profile.entityPrefix);
      } else {
        attributeBuckets.set(attribute, [profile.entityPrefix]);
      }
    }
  }

  for (const entities of attributeBuckets.values()) {
    const normalizedEntities = normalizeStringArray(entities);
    if (normalizedEntities.length < 2 || normalizedEntities.length > MAX_ATTRIBUTE_BUCKET_SIZE) {
      continue;
    }

    for (let index = 0; index < normalizedEntities.length; index += 1) {
      const leftEntity = normalizedEntities[index];
      if (!leftEntity) {
        continue;
      }

      for (let peerIndex = index + 1; peerIndex < normalizedEntities.length; peerIndex += 1) {
        const rightEntity = normalizedEntities[peerIndex];
        if (!rightEntity) {
          continue;
        }

        candidatePairs.add(buildPairKey(leftEntity, rightEntity));
      }
    }
  }

  const support: ClaimKeyEntityFamilyPairSupport[] = [];
  for (const pairKey of candidatePairs) {
    const [leftEntity = "", rightEntity = ""] = pairKey.split("::");
    const leftProfile = profiles.get(leftEntity);
    const rightProfile = profiles.get(rightEntity);
    if (!leftProfile || !rightProfile) {
      continue;
    }

    const pairSupport = evaluateEntityFamilyPairSupport(leftProfile, rightProfile);
    if (pairSupport) {
      support.push(pairSupport);
    }
  }

  return support;
}

function evaluateEntityFamilyPairSupport(
  leftProfile: TrustedClaimKeyEntityProfile,
  rightProfile: TrustedClaimKeyEntityProfile,
): ClaimKeyEntityFamilyPairSupport | null {
  const sharedAttributes = intersectSets(leftProfile.attributeSet, rightProfile.attributeSet);
  if (sharedAttributes.length === 0) {
    return null;
  }

  const sharedAttributeHeads = intersectSets(leftProfile.attributeHeadSet, rightProfile.attributeHeadSet);
  const sharedTags = intersectSets(leftProfile.tags, rightProfile.tags);
  const sharedSourceContextTokens = intersectSets(leftProfile.sourceContextTokens, rightProfile.sourceContextTokens);
  const sharedSubjectTokens = intersectSets(leftProfile.subjectTokens, rightProfile.subjectTokens);
  const lexicalRelation = evaluateEntityLexicalRelation(leftProfile, rightProfile);

  const groundingScore = (sharedTags.length > 0 ? 1 : 0) + (sharedSourceContextTokens.length >= 3 ? 1 : 0) + (sharedSubjectTokens.length >= 2 ? 1 : 0);
  const groundingAnchorCount = (sharedTags.length > 0 ? 1 : 0) + (sharedSourceContextTokens.length >= 3 ? 1 : 0);

  const qualifies =
    sharedAttributes.length >= 3 ||
    (sharedAttributes.length >= 2 && (lexicalRelation.kind !== null || groundingAnchorCount >= 1)) ||
    (sharedAttributes.length === 1 && lexicalRelation.kind !== null && groundingAnchorCount >= 1);
  if (!qualifies) {
    return null;
  }

  const evidence: ClaimKeyEntityFamilyEvidence[] = [
    {
      kind: "shared_attribute_overlap",
      detail: `Shared attributes: ${sharedAttributes.slice(0, MAX_EVIDENCE_VALUES).join(", ")}`,
    },
  ];
  if (sharedAttributeHeads.length >= 2) {
    evidence.push({
      kind: "shared_attribute_head_overlap",
      detail: `Shared attribute families: ${sharedAttributeHeads.slice(0, MAX_EVIDENCE_VALUES).join(", ")}`,
    });
  }
  if (sharedTags.length > 0) {
    evidence.push({
      kind: "shared_tag_grounding",
      detail: `Shared tags: ${sharedTags.slice(0, MAX_EVIDENCE_VALUES).join(", ")}`,
    });
  }
  if (sharedSourceContextTokens.length >= 2) {
    evidence.push({
      kind: "shared_source_context_grounding",
      detail: `Shared source-context tokens: ${sharedSourceContextTokens.slice(0, MAX_EVIDENCE_VALUES).join(", ")}`,
    });
  }
  if (sharedSubjectTokens.length >= 2) {
    evidence.push({
      kind: "shared_subject_grounding",
      detail: `Shared subject tokens: ${sharedSubjectTokens.slice(0, MAX_EVIDENCE_VALUES).join(", ")}`,
    });
  }
  if (lexicalRelation.kind && lexicalRelation.detail) {
    evidence.push({
      kind: lexicalRelation.kind,
      detail: lexicalRelation.detail,
    });
  }

  const confidence = Math.min(
    0.98,
    0.48 + Math.min(sharedAttributes.length, 3) * 0.12 + Math.min(groundingScore, 3) * 0.08 + lexicalRelation.strengthScore * 0.05,
  );

  return {
    entityPrefixes: [leftProfile.entityPrefix, rightProfile.entityPrefix],
    supportingEntryIds: normalizeStringArray([...leftProfile.entryIds, ...rightProfile.entryIds]),
    sharedAttributes,
    confidence,
    autoSafe: lexicalRelation.autoSafe && (sharedAttributes.length >= 2 || (sharedAttributes.length === 1 && groundingAnchorCount >= 1 && groundingScore >= 2)),
    preferredCanonicalEntityPrefix: lexicalRelation.preferredCanonicalEntityPrefix,
    evidence,
  };
}

function evaluateEntityLexicalRelation(leftProfile: TrustedClaimKeyEntityProfile, rightProfile: TrustedClaimKeyEntityProfile): EntityLexicalRelation {
  const leftTokens = leftProfile.tokenList;
  const rightTokens = rightProfile.tokenList;
  if (leftProfile.compactSignature === rightProfile.compactSignature && leftProfile.entityPrefix !== rightProfile.entityPrefix) {
    const preferredCanonicalEntityPrefix =
      leftTokens.length === rightTokens.length ? null : leftTokens.length > rightTokens.length ? leftProfile.entityPrefix : rightProfile.entityPrefix;
    return {
      kind: "lexical_separator_variant",
      detail:
        preferredCanonicalEntityPrefix === null
          ? "Entity prefixes collapse to the same compact lexical form."
          : `Entity prefixes collapse to the same compact lexical form; "${preferredCanonicalEntityPrefix}" preserves clearer token boundaries.`,
      autoSafe: true,
      preferredCanonicalEntityPrefix,
      strengthScore: 3,
    };
  }

  if (
    leftProfile.sortedTokenSignature.length > 0 &&
    leftProfile.sortedTokenSignature === rightProfile.sortedTokenSignature &&
    leftProfile.entityPrefix !== rightProfile.entityPrefix
  ) {
    return {
      kind: "lexical_token_reordering",
      detail: "Entity prefixes use the same lexical tokens in a different order.",
      autoSafe: true,
      preferredCanonicalEntityPrefix: null,
      strengthScore: 2,
    };
  }

  const leftInitialism = buildInitialism(leftTokens);
  const rightInitialism = buildInitialism(rightTokens);
  if (leftInitialism.length >= 2 && leftInitialism === rightProfile.entityPrefix) {
    return {
      kind: "lexical_initialism_expansion",
      detail: `Entity prefix "${rightProfile.entityPrefix}" matches the initialism of "${leftProfile.entityPrefix}".`,
      autoSafe: false,
      preferredCanonicalEntityPrefix: leftProfile.entityPrefix,
      strengthScore: 1,
    };
  }
  if (rightInitialism.length >= 2 && rightInitialism === leftProfile.entityPrefix) {
    return {
      kind: "lexical_initialism_expansion",
      detail: `Entity prefix "${leftProfile.entityPrefix}" matches the initialism of "${rightProfile.entityPrefix}".`,
      autoSafe: false,
      preferredCanonicalEntityPrefix: rightProfile.entityPrefix,
      strengthScore: 1,
    };
  }

  if (isTokenSubset(leftTokens, rightTokens)) {
    return {
      kind: "lexical_token_subset",
      detail: `"${leftProfile.entityPrefix}" is a lexical subset of "${rightProfile.entityPrefix}".`,
      autoSafe: false,
      preferredCanonicalEntityPrefix: rightProfile.entityPrefix,
      strengthScore: 1,
    };
  }
  if (isTokenSubset(rightTokens, leftTokens)) {
    return {
      kind: "lexical_token_subset",
      detail: `"${rightProfile.entityPrefix}" is a lexical subset of "${leftProfile.entityPrefix}".`,
      autoSafe: false,
      preferredCanonicalEntityPrefix: leftProfile.entityPrefix,
      strengthScore: 1,
    };
  }

  return {
    kind: null,
    detail: null,
    autoSafe: false,
    preferredCanonicalEntityPrefix: null,
    strengthScore: 0,
  };
}

function selectCanonicalEntityPrefix(
  entityPrefixes: string[],
  pairSupport: ClaimKeyEntityFamilyPairSupport[],
  profiles: Map<string, TrustedClaimKeyEntityProfile>,
): CanonicalSelectionResult {
  const scoreByEntity = new Map<string, number>();
  const reasonsByEntity = new Map<string, string[]>();

  for (const entityPrefix of entityPrefixes) {
    const profile = profiles.get(entityPrefix);
    if (!profile) {
      continue;
    }

    let score =
      Math.min(profile.attributeSet.size, 6) * 2 + Math.min(profile.entryCount, 6) + Math.round(profile.totalQualityScore / Math.max(profile.entryCount, 1));
    const reasons: string[] = [];

    if (profile.attributeSet.size >= 2) {
      reasons.push("broader trusted attribute coverage");
    }

    for (const support of pairSupport) {
      if (support.preferredCanonicalEntityPrefix === entityPrefix) {
        score += 4;
      } else if (support.preferredCanonicalEntityPrefix !== null) {
        score -= 2;
      }
    }

    const formSpecificity = scoreEntityFormSpecificity(entityPrefix, entityPrefixes, profiles);
    score += formSpecificity.score;
    if (formSpecificity.reason) {
      reasons.push(formSpecificity.reason);
    }

    const lexicalVotes = pairSupport.filter((support) => support.preferredCanonicalEntityPrefix === entityPrefix).length;
    if (lexicalVotes > 0) {
      reasons.push(`lexical alias evidence prefers "${entityPrefix}"`);
    }

    scoreByEntity.set(entityPrefix, score);
    reasonsByEntity.set(entityPrefix, normalizeStringArray(reasons));
  }

  const ranked = [...scoreByEntity.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const [bestCandidate, secondCandidate] = ranked;
  if (!bestCandidate) {
    return {
      canonicalEntityPrefix: null,
      reasons: [],
      unresolvedReason: "No canonical entity prefix could be selected from the detected family.",
    };
  }

  const [bestEntityPrefix, bestScore] = bestCandidate;
  const secondScore = secondCandidate?.[1] ?? Number.NEGATIVE_INFINITY;
  const bestProfile = profiles.get(bestEntityPrefix);
  if (!bestProfile) {
    return {
      canonicalEntityPrefix: null,
      reasons: [],
      unresolvedReason: "No canonical entity prefix could be selected from the detected family.",
    };
  }

  const directPeerSupport = entityPrefixes
    .filter((entityPrefix) => entityPrefix !== bestEntityPrefix)
    .map((entityPrefix) => findPairSupport(pairSupport, bestEntityPrefix, entityPrefix));
  const hasDirectSupportToAllPeers = directPeerSupport.every((support) => support !== null);
  const hasLexicalSupportToAllPeers = directPeerSupport.every((support) => support?.evidence.some((evidence) => evidence.kind.startsWith("lexical_")) === true);
  const lexicalVotes = pairSupport.filter((support) => support.preferredCanonicalEntityPrefix === bestEntityPrefix).length;
  if (!hasDirectSupportToAllPeers || !hasLexicalSupportToAllPeers || lexicalVotes === 0 || bestScore - secondScore < CANONICAL_SELECTION_MARGIN) {
    return {
      canonicalEntityPrefix: null,
      reasons: [],
      unresolvedReason: "Multiple plausible canonical entity prefixes remain after conservative scoring.",
    };
  }

  return {
    canonicalEntityPrefix: bestEntityPrefix,
    reasons: reasonsByEntity.get(bestEntityPrefix) ?? [],
    unresolvedReason: null,
  };
}

function scoreEntityFormSpecificity(
  entityPrefix: string,
  entityPrefixes: string[],
  profiles: Map<string, TrustedClaimKeyEntityProfile>,
): { score: number; reason: string | null } {
  const profile = profiles.get(entityPrefix);
  if (!profile) {
    return { score: 0, reason: null };
  }

  let score = 0;
  let reason: string | null = null;
  const compactPeers = entityPrefixes
    .filter((peerEntityPrefix) => peerEntityPrefix !== entityPrefix)
    .map((peerEntityPrefix) => profiles.get(peerEntityPrefix))
    .filter((peerProfile): peerProfile is TrustedClaimKeyEntityProfile => Boolean(peerProfile))
    .filter((peerProfile) => peerProfile.compactSignature === profile.compactSignature);
  if (profile.tokenList.length >= 2 && compactPeers.some((peerProfile) => peerProfile.tokenList.length < profile.tokenList.length)) {
    score += 2;
    reason = "less abbreviated lexical form";
  }

  if (entityPrefix.length <= 3 && compactPeers.length === 0) {
    score -= 1;
  }

  return { score, reason };
}

function collectConnectedEntityComponent(startingEntityPrefix: string, adjacency: Map<string, Set<string>>, visited: Set<string>): string[] {
  const queue = [startingEntityPrefix];
  const component: string[] = [];
  visited.add(startingEntityPrefix);

  while (queue.length > 0) {
    const entityPrefix = queue.shift();
    if (!entityPrefix) {
      continue;
    }

    component.push(entityPrefix);
    const peers = adjacency.get(entityPrefix);
    if (!peers) {
      continue;
    }

    for (const peer of peers) {
      if (visited.has(peer)) {
        continue;
      }

      visited.add(peer);
      queue.push(peer);
    }
  }

  return component;
}

function findPairSupport(
  pairSupport: ClaimKeyEntityFamilyPairSupport[],
  leftEntityPrefix: string,
  rightEntityPrefix: string,
): ClaimKeyEntityFamilyPairSupport | null {
  for (const support of pairSupport) {
    const [leftEntity, rightEntity] = support.entityPrefixes;
    if ((leftEntity === leftEntityPrefix && rightEntity === rightEntityPrefix) || (leftEntity === rightEntityPrefix && rightEntity === leftEntityPrefix)) {
      return support;
    }
  }

  return null;
}

function evaluateSingletonAliasCandidate(
  aliasProfile: ClaimKeyEntityPrefixStats,
  dominantProfile: ClaimKeyEntityPrefixStats,
): ClaimKeySingletonAliasCandidate | null {
  const lexicalRelation = evaluateSingletonAliasLexicalRelation(aliasProfile.entityPrefix, dominantProfile.entityPrefix);
  if (!lexicalRelation.kind || !lexicalRelation.detail || lexicalRelation.scopeLike) {
    return null;
  }

  const dominantTrustedCount = dominantProfile.trustedEntryCount;
  if (dominantTrustedCount < SINGLETON_ALIAS_MIN_DOMINANT_TRUSTED_COUNT) {
    return null;
  }

  const aliasLowTrustCount = buildLowTrustEntryCount(aliasProfile);
  if (aliasLowTrustCount === 0) {
    return null;
  }

  const evidence: ClaimKeySingletonAliasEvidence[] = [
    {
      kind: "singleton_family_size",
      detail: `"${aliasProfile.entityPrefix}" has ${aliasProfile.activeEntryCount} active keyed ${pluralize(aliasProfile.activeEntryCount, "entry")}.`,
    },
    {
      kind: "dominant_trusted_family",
      detail: `"${dominantProfile.entityPrefix}" already has ${dominantTrustedCount} trusted ${pluralize(dominantTrustedCount, "entry")}.`,
    },
    {
      kind: "low_trust_creation_path",
      detail: describeLowTrustAliasFamily(aliasProfile),
    },
    {
      kind: lexicalRelation.kind,
      detail: lexicalRelation.detail,
    },
  ];

  const confidence = Math.min(
    0.98,
    0.58 +
      Math.min(dominantTrustedCount, 6) * 0.05 +
      Math.min(aliasLowTrustCount, 2) * 0.05 +
      Math.min(dominantProfile.activeEntryCount - aliasProfile.activeEntryCount, 6) * 0.02 +
      lexicalRelation.strengthScore * 0.08,
  );

  return {
    aliasEntityPrefix: aliasProfile.entityPrefix,
    dominantEntityPrefix: dominantProfile.entityPrefix,
    aliasFamilySize: aliasProfile.activeEntryCount,
    dominantFamilySize: dominantProfile.activeEntryCount,
    dominantTrustedCount,
    aliasLowTrustCount,
    confidence,
    canonicalReuseSafe:
      lexicalRelation.canonicalReuseSafe &&
      aliasProfile.activeEntryCount === 1 &&
      aliasLowTrustCount === aliasProfile.activeEntryCount &&
      dominantTrustedCount >= SINGLETON_ALIAS_MIN_DOMINANT_TRUSTED_COUNT,
    evidence,
  };
}

function selectBestSingletonAliasCandidate(candidates: ClaimKeySingletonAliasCandidate[]): ClaimKeySingletonAliasCandidate[] {
  const ranked = [...candidates].sort(
    (left, right) => right.confidence - left.confidence || left.dominantEntityPrefix.localeCompare(right.dominantEntityPrefix),
  );
  const [best, runnerUp] = ranked;
  if (!best) {
    return [];
  }

  if (runnerUp && best.confidence - runnerUp.confidence < SINGLETON_ALIAS_MIN_CONFIDENCE_DELTA) {
    return [];
  }

  return [best];
}

function evaluateSingletonAliasLexicalRelation(aliasEntityPrefix: string, dominantEntityPrefix: string): SingletonAliasLexicalRelation {
  const aliasTokens = aliasEntityPrefix.split("_").filter((token) => token.length > 0);
  const dominantTokens = dominantEntityPrefix.split("_").filter((token) => token.length > 0);

  const aliasCompactSignature = aliasTokens.join("");
  const dominantCompactSignature = dominantTokens.join("");
  if (aliasCompactSignature === dominantCompactSignature && aliasEntityPrefix !== dominantEntityPrefix) {
    return {
      kind: "lexical_separator_variant",
      detail: `Entity prefixes "${aliasEntityPrefix}" and "${dominantEntityPrefix}" collapse to the same compact lexical form.`,
      canonicalReuseSafe: true,
      scopeLike: false,
      strengthScore: 3,
    };
  }

  if (!isTokenSubset(dominantTokens, aliasTokens)) {
    return {
      kind: null,
      detail: null,
      canonicalReuseSafe: false,
      scopeLike: false,
      strengthScore: 0,
    };
  }

  const dominantTokenSet = new Set(dominantTokens);
  const addedTokens = aliasTokens.filter((token) => !dominantTokenSet.has(token));
  const scopeLike = addedTokens.length !== 1 || addedTokens.some((token) => SINGLETON_ALIAS_SCOPE_TOKENS.has(token));
  if (scopeLike) {
    return {
      kind: null,
      detail: null,
      canonicalReuseSafe: false,
      scopeLike: true,
      strengthScore: 0,
    };
  }

  return {
    kind: "lexical_token_subset",
    detail: `"${aliasEntityPrefix}" extends "${dominantEntityPrefix}" by the added token "${addedTokens[0]}".`,
    canonicalReuseSafe: true,
    scopeLike: false,
    strengthScore: 2,
  };
}

function buildLowTrustEntryCount(profile: ClaimKeyEntityPrefixStats): number {
  const deterministicOnlyCount = Math.max(0, profile.deterministicRepairEntryCount - profile.tentativeEntryCount);
  return profile.tentativeEntryCount + profile.unresolvedEntryCount + deterministicOnlyCount;
}

function describeLowTrustAliasFamily(profile: ClaimKeyEntityPrefixStats): string {
  const reasons: string[] = [];
  if (profile.deterministicRepairEntryCount > 0) {
    reasons.push(`${profile.deterministicRepairEntryCount} deterministic repair ${pluralize(profile.deterministicRepairEntryCount, "entry")}`);
  }
  if (profile.tentativeEntryCount > 0) {
    reasons.push(`${profile.tentativeEntryCount} tentative ${pluralize(profile.tentativeEntryCount, "entry")}`);
  }
  if (profile.unresolvedEntryCount > 0) {
    reasons.push(`${profile.unresolvedEntryCount} unresolved ${pluralize(profile.unresolvedEntryCount, "entry")}`);
  }

  if (reasons.length === 0) {
    return `"${profile.entityPrefix}" is not fully trusted yet.`;
  }

  return `"${profile.entityPrefix}" is low-trust because it has ${reasons.join(", ")}.`;
}

function buildInitialism(tokens: string[]): string {
  if (tokens.length < 2) {
    return "";
  }

  return tokens.map((token) => token[0] ?? "").join("");
}

function isTokenSubset(subsetTokens: string[], supersetTokens: string[]): boolean {
  if (subsetTokens.length === 0 || subsetTokens.length >= supersetTokens.length) {
    return false;
  }

  const superset = new Set(supersetTokens);
  return subsetTokens.every((token) => superset.has(token));
}

function tokenizeGrounding(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const normalized = normalizeClaimKeySegment(value);
  if (!normalized) {
    return [];
  }

  return normalized.split("_").filter((token) => token.length >= 2 && !ENTITY_FAMILY_GROUNDING_STOP_TOKENS.has(token));
}

function intersectSets(left: Set<string>, right: Set<string>): string[] {
  const intersection: string[] = [];
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];

  for (const value of small) {
    if (large.has(value)) {
      intersection.push(value);
    }
  }

  return intersection.sort((first, second) => first.localeCompare(second));
}

function normalizeStringArray(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function buildPairKey(leftEntityPrefix: string, rightEntityPrefix: string): string {
  return [leftEntityPrefix, rightEntityPrefix].sort((left, right) => left.localeCompare(right)).join("::");
}

function getOrCreateSet<K>(map: Map<K, Set<string>>, key: K): Set<string> {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }

  const created = new Set<string>();
  map.set(key, created);
  return created;
}

function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
