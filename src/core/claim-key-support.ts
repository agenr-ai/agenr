import { inspectClaimKey, isTrustedClaimKeyForCleanup, normalizeClaimKeySegment, compactClaimKey } from "./claim-key.js";
import type { Entry, EntryType } from "./types.js";

const MAX_AUTO_APPLY_ATTRIBUTE_TOKENS = 4;
const GROUNDING_STOP_TOKENS = new Set([
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
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "this",
  "to",
  "we",
  "with",
]);
const AWKWARD_AUTO_APPLY_ATTRIBUTE_TOKENS = new Set(["to", "for", "from", "with", "about", "into", "onto", "between", "during"]);
const POLICY_TEMPLATE_ATTRIBUTE_TOKENS = new Set(["policy", "default", "workflow", "process", "strategy", "guardrail", "rule", "boundary"]);
const AUTHORITATIVE_TEMPLATE_ATTRIBUTE_TOKENS = new Set(["source", "truth", "guide", "runbook", "reference"]);
const ARCHITECTURE_TEMPLATE_ATTRIBUTE_TOKENS = new Set([
  "adapter",
  "boundary",
  "architecture",
  "backend",
  "storage",
  "model",
  "support",
  "contract",
  "interface",
  "surface",
]);
const STABLE_FAMILY_SLOT_ATTRIBUTE_HEADS = new Set([
  "access",
  "boundary",
  "condition",
  "contract",
  "dependency",
  "mode",
  "owner",
  "order",
  "path",
  "policy",
  "preference",
  "preservation",
  "process",
  "requirement",
  "role",
  "rule",
  "schedule",
  "sequencing",
  "setting",
  "status",
  "strategy",
  "support",
  "surface",
  "timezone",
  "version",
  "window",
  "workflow",
  "workspace",
]);

/**
 * Conservative promotion families reused by ingest and surgeon near-miss handling.
 */
export type ClaimKeySupportAutoApplyClass =
  | "trusted_exact_reuse_grounded"
  | "trusted_family_template_grounded"
  | "trusted_family_stable_slot"
  | "trusted_family_grounded_alignment";

/**
 * Normalized trusted claim-key hint row used for support and family-reuse checks.
 */
export interface ClaimKeySupportHintEntry {
  id: string;
  claimKey: string;
  entity: string;
  attribute: string;
  type?: EntryType;
  tags: string[];
  sourceContextTokens: string[];
  subjectTokens: string[];
  createdAt: string;
}

/**
 * Stable trusted hint seed used by claim-key support evaluation.
 */
export interface ClaimKeySupportHintSeed {
  entries: ClaimKeySupportHintEntry[];
}

/**
 * Lexical alignment observed between one entry and one candidate claim key.
 */
export interface ClaimKeySupportLexicalAlignment {
  entity: boolean;
  attribute: boolean;
  any: boolean;
  strongEntityAttribute: boolean;
  entityOverlapCount: number;
  attributeOverlapCount: number;
}

/**
 * Structured support evaluation for one candidate claim key.
 */
export interface ClaimKeySupportEvaluation {
  autoApplyClass: ClaimKeySupportAutoApplyClass | null;
  supportedProposal: boolean;
  trustedExactReuse: boolean;
  trustedEntityFamilyReuse: boolean;
  tagGrounding: boolean;
  sourceContextGrounding: boolean;
  localGrounding: boolean;
  entityLexicalAlignment: boolean;
  attributeLexicalAlignment: boolean;
  strongEntityAttributeLexicalAlignment: boolean;
  lexicalAlignment: boolean;
  templateSupport: boolean;
  stableSlotSupport: boolean;
  familyReuseCount: number;
  groundedFamilyReuseCount: number;
  relaxedStableSlotFamilyGate: boolean;
  supportingEntryIds: string[];
  supportEvidence: string[];
  rationaleFragments: string[];
}

/**
 * Compactness and auto-apply safety for one candidate claim key.
 */
export interface ClaimKeyCompactnessEvaluation {
  claimKey: string;
  compactedFrom: string | null;
  compactionReason: string | null;
  compactEnoughForAutoApply: boolean;
  blockerReason: string | null;
}

/**
 * Minimal entry shape needed for shared claim-key support evaluation.
 */
export interface ClaimKeySupportEntryLike {
  id?: string;
  type?: EntryType;
  subject: string;
  content: string;
  tags?: string[];
  source_context?: string;
}

/**
 * Builds a trusted support seed from already-stored entries with trusted canonical claim keys.
 *
 * @param entries - Candidate stored entries that may contribute trusted claim-key evidence.
 * @returns Ordered support seed used for family reuse and grounding checks.
 */
export function buildTrustedClaimKeySupportSeed(
  entries: Array<Pick<Entry, "id" | "claim_key" | "importance" | "created_at" | "type" | "tags" | "source_context" | "subject">>,
): ClaimKeySupportHintSeed {
  const claimKeyStats = new Map<string, { count: number; maxImportance: number; latestCreatedAt: string }>();
  const trustedEntries: ClaimKeySupportHintEntry[] = [];

  for (const entry of entries) {
    const claimKey = entry.claim_key?.trim();
    if (!claimKey || !isTrustedClaimKeyForCleanup(claimKey)) {
      continue;
    }

    const inspection = inspectClaimKey(claimKey);
    if (!inspection.normalized) {
      continue;
    }

    const existing = claimKeyStats.get(claimKey);
    if (existing) {
      existing.count += 1;
      existing.maxImportance = Math.max(existing.maxImportance, entry.importance);
      existing.latestCreatedAt = existing.latestCreatedAt.localeCompare(entry.created_at) >= 0 ? existing.latestCreatedAt : entry.created_at;
      continue;
    }

    claimKeyStats.set(claimKey, {
      count: 1,
      maxImportance: entry.importance,
      latestCreatedAt: entry.created_at,
    });
    trustedEntries.push({
      id: entry.id,
      claimKey: inspection.normalized.claimKey,
      entity: inspection.normalized.entity,
      attribute: inspection.normalized.attribute,
      type: entry.type,
      tags: normalizeGroundingTags(entry.tags),
      sourceContextTokens: tokenizeGroundingText(entry.source_context),
      subjectTokens: tokenizeGroundingText(entry.subject),
      createdAt: entry.created_at,
    });
  }

  const orderedClaimKeys = [...claimKeyStats.entries()]
    .sort((left, right) => {
      const countDelta = right[1].count - left[1].count;
      if (countDelta !== 0) {
        return countDelta;
      }

      const importanceDelta = right[1].maxImportance - left[1].maxImportance;
      if (importanceDelta !== 0) {
        return importanceDelta;
      }

      const createdAtDelta = right[1].latestCreatedAt.localeCompare(left[1].latestCreatedAt);
      if (createdAtDelta !== 0) {
        return createdAtDelta;
      }

      return left[0].localeCompare(right[0]);
    })
    .map(([claimKey]) => claimKey);
  const orderedEntries = orderedClaimKeys.flatMap((claimKey) =>
    trustedEntries
      .filter((entry) => entry.claimKey === claimKey)
      .sort((left, right) => {
        const createdAtDelta = right.createdAt.localeCompare(left.createdAt);
        if (createdAtDelta !== 0) {
          return createdAtDelta;
        }

        return left.id.localeCompare(right.id);
      }),
  );

  return {
    entries: orderedEntries,
  };
}

/**
 * Builds a support seed from canonical claim-key examples when full trusted rows are unavailable.
 *
 * @param claimKeys - Canonical or near-canonical claim-key examples.
 * @returns Support seed suitable for exact/family reuse checks during ingest.
 */
export function buildClaimKeySupportSeedFromExamples(claimKeys: string[]): ClaimKeySupportHintSeed {
  const entries = claimKeys.flatMap((claimKey, index) => {
    const inspection = inspectClaimKey(claimKey);
    if (!inspection.normalized || !isTrustedClaimKeyForCleanup(inspection.normalized.claimKey)) {
      return [];
    }

    return [
      {
        id: `example:${index + 1}`,
        claimKey: inspection.normalized.claimKey,
        entity: inspection.normalized.entity,
        attribute: inspection.normalized.attribute,
        tags: [],
        sourceContextTokens: [],
        subjectTokens: [],
        createdAt: "1970-01-01T00:00:00.000Z",
      } satisfies ClaimKeySupportHintEntry,
    ];
  });

  return { entries };
}

/**
 * Evaluates conservative support for one candidate claim key using trusted exact-key and family evidence.
 *
 * @param entry - Entry being classified.
 * @param targetClaimKey - Canonical candidate claim key to inspect.
 * @param trustedHints - Trusted seed built from canonical claim-key evidence.
 * @returns Structured support metadata for auto-apply or review routing.
 */
export function evaluateClaimKeySupport(
  entry: ClaimKeySupportEntryLike,
  targetClaimKey: string,
  trustedHints: ClaimKeySupportHintSeed,
): ClaimKeySupportEvaluation {
  const inspection = inspectClaimKey(targetClaimKey);
  const normalized = inspection.normalized;
  if (!normalized) {
    return createEmptyClaimKeySupportEvaluation();
  }

  const entryTagSet = new Set(normalizeGroundingTags(entry.tags));
  const entrySourceTokens = new Set(tokenizeGroundingText(entry.source_context));
  const relevantEntries = trustedHints.entries.filter((trustedEntry) => {
    if (entry.id && trustedEntry.id === entry.id) {
      return false;
    }

    return trustedEntry.claimKey === normalized.claimKey || trustedEntry.entity === normalized.entity;
  });
  const exactReuseEntries = relevantEntries.filter((trustedEntry) => trustedEntry.claimKey === normalized.claimKey);
  const familyReuseEntries = relevantEntries.filter(
    (trustedEntry) => trustedEntry.claimKey !== normalized.claimKey && trustedEntry.entity === normalized.entity,
  );
  const groundedExactReuseEntries = exactReuseEntries.filter((trustedEntry) => {
    const grounding = inspectGroundingOverlap(entryTagSet, entrySourceTokens, trustedEntry);
    return grounding.tagGrounding || grounding.sourceContextGrounding;
  });
  const groundedFamilyReuseEntries = familyReuseEntries.filter((trustedEntry) => {
    const grounding = inspectGroundingOverlap(entryTagSet, entrySourceTokens, trustedEntry);
    return grounding.tagGrounding || grounding.sourceContextGrounding;
  });
  const tagGrounding = relevantEntries.some((trustedEntry) => inspectGroundingOverlap(entryTagSet, entrySourceTokens, trustedEntry).tagGrounding);
  const sourceContextGrounding = relevantEntries.some(
    (trustedEntry) => inspectGroundingOverlap(entryTagSet, entrySourceTokens, trustedEntry).sourceContextGrounding,
  );
  const localGrounding = tagGrounding || sourceContextGrounding;
  const lexicalAlignment = inspectCandidateLexicalAlignment(entry, normalized.entity, normalized.attribute);
  const templateSupport = matchesConservativeTemplateSupport(entry, normalized.attribute);
  const stableSlotSupport = matchesStableFamilySlotSupport(normalized.attribute);
  const trustedExactReuse =
    exactReuseEntries.length > 0 && (groundedExactReuseEntries.length > 0 || exactReuseEntries.every((candidate) => candidate.id.startsWith("example:")));
  const trustedEntityFamilyReuse = groundedFamilyReuseEntries.length > 0 || familyReuseEntries.some((candidate) => candidate.id.startsWith("example:"));
  const promotionSupport = resolveClaimKeyPromotionSupport({
    exactReuseCount: trustedExactReuse ? Math.max(1, groundedExactReuseEntries.length) : 0,
    familyReuseCount: familyReuseEntries.length,
    groundedFamilyReuseCount:
      groundedFamilyReuseEntries.length > 0
        ? groundedFamilyReuseEntries.length
        : familyReuseEntries.some((candidate) => candidate.id.startsWith("example:"))
          ? familyReuseEntries.length
          : 0,
    localGrounding: localGrounding || familyReuseEntries.some((candidate) => candidate.id.startsWith("example:")),
    templateSupport,
    stableSlotSupport,
    lexicalAlignment,
  });
  const supportedProposal = lexicalAlignment.any && (templateSupport || stableSlotSupport || trustedExactReuse || trustedEntityFamilyReuse || localGrounding);
  const supportEvidence = [
    trustedExactReuse ? "trusted_exact_reuse" : null,
    trustedEntityFamilyReuse ? "trusted_entity_family_reuse" : null,
    tagGrounding ? "tag_grounding" : null,
    sourceContextGrounding ? "source_context_grounding" : null,
    lexicalAlignment.entity ? "entity_lexical_alignment" : null,
    lexicalAlignment.attribute ? "attribute_lexical_alignment" : null,
    lexicalAlignment.strongEntityAttribute ? "strong_entity_attribute_lexical_alignment" : null,
    templateSupport ? "template_support" : null,
    stableSlotSupport ? "stable_slot_support" : null,
    promotionSupport.relaxedStableSlotFamilyGate ? "single_grounded_family_sibling" : null,
  ].filter((value): value is string => value !== null);
  const rationaleFragments = [
    trustedExactReuse
      ? `trusted exact reuse from ${Math.max(1, groundedExactReuseEntries.length)} matching entr${Math.max(1, groundedExactReuseEntries.length) === 1 ? "y" : "ies"}`
      : null,
    trustedEntityFamilyReuse
      ? `trusted ${normalized.entity} family reuse from ${Math.max(1, groundedFamilyReuseEntries.length || familyReuseEntries.length)} supporting entr${Math.max(1, groundedFamilyReuseEntries.length || familyReuseEntries.length) === 1 ? "y" : "ies"}`
      : null,
    tagGrounding ? "overlapping tags with trusted corpus entries" : null,
    sourceContextGrounding ? "overlapping source_context with trusted corpus entries" : null,
    lexicalAlignment.strongEntityAttribute ? "strong entity and slot lexical alignment" : null,
    lexicalAlignment.attribute
      ? lexicalAlignment.strongEntityAttribute
        ? null
        : "clear lexical alignment to the proposed slot"
      : lexicalAlignment.entity
        ? "clear lexical alignment to the proposed entity"
        : null,
    templateSupport ? "a conservative policy/default/source-of-truth template match" : null,
    stableSlotSupport ? "a stable compact slot head in a well-established entity family" : null,
    promotionSupport.relaxedStableSlotFamilyGate ? "one grounded family sibling cleared the stable-slot family gate" : null,
  ].filter((value): value is string => value !== null);

  return {
    autoApplyClass: promotionSupport.autoApplyClass,
    supportedProposal,
    trustedExactReuse,
    trustedEntityFamilyReuse,
    tagGrounding,
    sourceContextGrounding,
    localGrounding,
    entityLexicalAlignment: lexicalAlignment.entity,
    attributeLexicalAlignment: lexicalAlignment.attribute,
    strongEntityAttributeLexicalAlignment: lexicalAlignment.strongEntityAttribute,
    lexicalAlignment: lexicalAlignment.any,
    templateSupport,
    stableSlotSupport,
    familyReuseCount: familyReuseEntries.length,
    groundedFamilyReuseCount: groundedFamilyReuseEntries.length,
    relaxedStableSlotFamilyGate: promotionSupport.relaxedStableSlotFamilyGate,
    supportingEntryIds: normalizeStringArray([
      ...groundedExactReuseEntries.map((candidate) => candidate.id),
      ...groundedFamilyReuseEntries.map((candidate) => candidate.id),
      ...familyReuseEntries.filter((candidate) => candidate.id.startsWith("example:")).map((candidate) => candidate.id),
    ]),
    supportEvidence,
    rationaleFragments,
  };
}

/**
 * Returns an empty support evaluation for malformed or unsupported candidates.
 *
 * @returns Empty support metadata.
 */
export function createEmptyClaimKeySupportEvaluation(): ClaimKeySupportEvaluation {
  return {
    autoApplyClass: null,
    supportedProposal: false,
    trustedExactReuse: false,
    trustedEntityFamilyReuse: false,
    tagGrounding: false,
    sourceContextGrounding: false,
    localGrounding: false,
    entityLexicalAlignment: false,
    attributeLexicalAlignment: false,
    strongEntityAttributeLexicalAlignment: false,
    lexicalAlignment: false,
    templateSupport: false,
    stableSlotSupport: false,
    familyReuseCount: 0,
    groundedFamilyReuseCount: 0,
    relaxedStableSlotFamilyGate: false,
    supportingEntryIds: [],
    supportEvidence: [],
    rationaleFragments: [],
  };
}

/**
 * Evaluates whether one canonical claim key is compact enough for safe auto-apply.
 *
 * @param claimKey - Canonical candidate claim key to inspect.
 * @param prior - Optional previously recorded compaction lineage.
 * @returns Compaction metadata plus the auto-apply blocker when present.
 */
export function evaluateClaimKeyCompactness(
  claimKey: string,
  prior?: {
    priorCompactedFrom: string | null;
    priorCompactionReason: string | null;
  },
): ClaimKeyCompactnessEvaluation {
  const compacted = compactClaimKey(claimKey);
  if (!compacted) {
    return {
      claimKey,
      compactedFrom: null,
      compactionReason: null,
      compactEnoughForAutoApply: false,
      blockerReason: "invalid_claim_key",
    };
  }

  const attributeTokens = compacted.attribute.split("_").filter((token) => token.length > 0);
  const compactEnoughForAutoApply =
    attributeTokens.length > 0 &&
    attributeTokens.length <= MAX_AUTO_APPLY_ATTRIBUTE_TOKENS &&
    !attributeTokens.some((token) => AWKWARD_AUTO_APPLY_ATTRIBUTE_TOKENS.has(token));
  const compactedFrom = compacted.compactedFrom ?? prior?.priorCompactedFrom ?? null;
  const compactionReason =
    compacted.reason && prior?.priorCompactionReason
      ? `${prior.priorCompactionReason} and ${compacted.reason}`
      : (compacted.reason ?? prior?.priorCompactionReason ?? null);

  return {
    claimKey: compacted.claimKey,
    compactedFrom,
    compactionReason,
    compactEnoughForAutoApply,
    blockerReason: compactEnoughForAutoApply ? null : "non_compact_canonical_slot",
  };
}

/**
 * Normalizes local grounding tags into claim-key-safe lexical tokens.
 *
 * @param tags - Raw tag list from an entry.
 * @returns Canonical tag tokens.
 */
export function normalizeGroundingTags(tags: string[] | undefined): string[] {
  return normalizeStringArray((tags ?? []).map((tag) => normalizeClaimKeySegment(tag)).filter((tag) => tag.length > 0));
}

/**
 * Tokenizes free-form text into normalized lexical grounding tokens.
 *
 * @param value - Raw text to tokenize.
 * @returns Ordered unique grounding tokens.
 */
export function tokenizeGroundingText(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return normalizeStringArray(
    value
      .split(/[^a-zA-Z0-9]+/u)
      .map((token) => normalizeClaimKeySegment(token))
      .filter((token) => token.length > 2 && !GROUNDING_STOP_TOKENS.has(token)),
  );
}

/**
 * Builds the combined lexical token set used for claim-key support and resonance checks.
 *
 * @param entry - Entry-like object whose text and tags should be tokenized.
 * @returns Ordered unique local lexical tokens.
 */
export function buildEntryLocalLexicalTokens(entry: ClaimKeySupportEntryLike): string[] {
  return normalizeStringArray([
    ...tokenizeGroundingText(entry.subject),
    ...tokenizeGroundingText(entry.content),
    ...tokenizeGroundingText(entry.source_context),
    ...normalizeGroundingTags(entry.tags),
  ]);
}

/** Resolves whether one candidate has enough structured support for conservative auto-apply. */
function resolveClaimKeyPromotionSupport(input: {
  exactReuseCount: number;
  familyReuseCount: number;
  groundedFamilyReuseCount: number;
  localGrounding: boolean;
  templateSupport: boolean;
  stableSlotSupport: boolean;
  lexicalAlignment: ClaimKeySupportLexicalAlignment;
}): {
  autoApplyClass: ClaimKeySupportAutoApplyClass | null;
  relaxedStableSlotFamilyGate: boolean;
} {
  if (input.exactReuseCount > 0 && (input.lexicalAlignment.attribute || input.templateSupport)) {
    return {
      autoApplyClass: "trusted_exact_reuse_grounded",
      relaxedStableSlotFamilyGate: false,
    };
  }

  if (input.templateSupport && input.localGrounding && input.familyReuseCount > 0 && (input.lexicalAlignment.attribute || input.lexicalAlignment.entity)) {
    return {
      autoApplyClass: "trusted_family_template_grounded",
      relaxedStableSlotFamilyGate: false,
    };
  }

  const relaxedStableSlotFamilyGate =
    input.stableSlotSupport &&
    input.localGrounding &&
    input.groundedFamilyReuseCount > 0 &&
    input.familyReuseCount === 1 &&
    input.lexicalAlignment.strongEntityAttribute;
  if (
    input.stableSlotSupport &&
    input.localGrounding &&
    input.groundedFamilyReuseCount > 0 &&
    (input.familyReuseCount >= 2 || relaxedStableSlotFamilyGate) &&
    input.lexicalAlignment.attribute
  ) {
    return {
      autoApplyClass: "trusted_family_stable_slot",
      relaxedStableSlotFamilyGate,
    };
  }

  if (input.localGrounding && input.groundedFamilyReuseCount > 0 && input.lexicalAlignment.strongEntityAttribute) {
    return {
      autoApplyClass: "trusted_family_grounded_alignment",
      relaxedStableSlotFamilyGate: false,
    };
  }

  return {
    autoApplyClass: null,
    relaxedStableSlotFamilyGate: false,
  };
}

/** Checks whether one trusted hint overlaps the current entry's local grounding clues. */
function inspectGroundingOverlap(
  entryTagSet: Set<string>,
  entrySourceTokens: Set<string>,
  trustedEntry: ClaimKeySupportHintEntry,
): { tagGrounding: boolean; sourceContextGrounding: boolean } {
  return {
    tagGrounding: countSetOverlap(entryTagSet, trustedEntry.tags) > 0,
    sourceContextGrounding: countSetOverlap(entrySourceTokens, trustedEntry.sourceContextTokens) > 0,
  };
}

/** Measures entity and attribute lexical overlap between one entry and one candidate claim key. */
function inspectCandidateLexicalAlignment(entry: ClaimKeySupportEntryLike, entity: string, attribute: string): ClaimKeySupportLexicalAlignment {
  const lexicalTokens = new Set(buildEntryLocalLexicalTokens(entry));
  const entityTokens = entity.split("_").filter((token) => token.length > 0);
  const attributeTokens = attribute.split("_").filter((token) => token.length > 0 && !GROUNDING_STOP_TOKENS.has(token));

  const entityOverlapCount = countSetOverlap(lexicalTokens, entityTokens);
  const attributeOverlapCount = countSetOverlap(lexicalTokens, attributeTokens);
  const entityAlignment = entityOverlapCount > 0;
  const attributeAlignment = attributeOverlapCount > 0;
  const strongAttributeAlignment = attributeTokens.length > 0 && attributeOverlapCount >= Math.min(attributeTokens.length, 2);

  return {
    entity: entityAlignment,
    attribute: attributeAlignment,
    any: entityAlignment || attributeAlignment,
    strongEntityAttribute: entityAlignment && strongAttributeAlignment,
    entityOverlapCount,
    attributeOverlapCount,
  };
}

/** Detects conservative policy/source-of-truth/architecture templates that strengthen a candidate slot. */
function matchesConservativeTemplateSupport(entry: ClaimKeySupportEntryLike, attribute: string): boolean {
  const attributeTokens = new Set(attribute.split("_").filter((token) => token.length > 0));
  const subjectText = entry.subject.toLowerCase();
  const contentText = entry.content.toLowerCase();
  const combinedText = `${subjectText}\n${contentText}`;
  const authoritativePattern = /\b(authoritative|source of truth|source of record|canonical guide|canonical reference|primary guide|runbook)\b/u.test(
    combinedText,
  );
  if (authoritativePattern && intersects(attributeTokens, AUTHORITATIVE_TEMPLATE_ATTRIBUTE_TOKENS)) {
    return true;
  }

  const policyPattern =
    /\b(should|must|should stay|must stay|always|never|default(?:s)? to|default(?:s)?|policy|guardrail|required|preference|prefers?)\b/u.test(combinedText);
  if (policyPattern && intersects(attributeTokens, POLICY_TEMPLATE_ATTRIBUTE_TOKENS)) {
    return true;
  }

  const architecturePattern = /\b(uses|supports|backed by|architecture|boundary|workflow|process|pipeline|adapter|layer|contract|interface|surface)\b/u.test(
    combinedText,
  );
  return architecturePattern && intersects(attributeTokens, ARCHITECTURE_TEMPLATE_ATTRIBUTE_TOKENS);
}

/** Checks whether one attribute ends in a stable family slot head that is safe to reuse conservatively. */
function matchesStableFamilySlotSupport(attribute: string): boolean {
  const tokens = attribute.split("_").filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > MAX_AUTO_APPLY_ATTRIBUTE_TOKENS) {
    return false;
  }

  const head = tokens[tokens.length - 1];
  return typeof head === "string" && STABLE_FAMILY_SLOT_ATTRIBUTE_HEADS.has(head);
}

/** Counts the overlapping values between one set and one iterable. */
function countSetOverlap(left: Set<string>, right: Iterable<string>): number {
  let count = 0;
  for (const value of right) {
    if (left.has(value)) {
      count += 1;
    }
  }

  return count;
}

/** Returns whether two token sets share at least one member. */
function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }

  return false;
}

/** Deduplicates one ordered string list while preserving the first occurrence of each value. */
function normalizeStringArray(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}
