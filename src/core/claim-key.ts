const UNKNOWN_SEGMENT = "unknown";
const SELF_REFERENTIAL_ENTITIES = new Set(["i", "me", "myself", "the_user", "user", "we", "our_team", "the_project", "this_project"]);
const GENERIC_ENTITIES = new Set([
  "app",
  "company",
  "config",
  "data",
  "device",
  "entity",
  "environment",
  "item",
  "organization",
  "person",
  "place",
  "project",
  "service",
  "setting",
  "system",
  "team",
  "thing",
  "user",
  "workspace",
]);
const GENERIC_ATTRIBUTES = new Set(["info", "details", "config", "stuff", "thing", "data"]);
const COMPACTION_RELATION_TOKENS = new Set([
  "after",
  "before",
  "depend",
  "depends",
  "follows",
  "follow",
  "keep",
  "keeps",
  "maintain",
  "maintains",
  "need",
  "needs",
  "precede",
  "precedes",
  "preserve",
  "preserves",
  "require",
  "required",
  "requires",
  "retain",
  "retains",
]);
const COMPACTION_BREAK_TOKENS = new Set(["about", "across", "and", "between", "during", "for", "from", "into", "onto", "or", "to", "with"]);
const COMPACTION_WEAK_LEADING_TOKENS = new Set(["actual", "authoritative", "canonical", "concrete", "current", "durable", "existing", "real"]);
const ACTION_CONDITION_TOKENS = new Set(["activate", "activation", "apply", "fire", "launch", "run", "start", "trigger"]);
const TRAILING_OBJECT_COMPACTION_PREPOSITIONS = new Set(["about", "for", "from", "into", "onto", "to", "with"]);
const TRAILING_OBJECT_TRANSFER_HEADS = new Set([
  "access",
  "boundary",
  "condition",
  "contract",
  "guide",
  "path",
  "policy",
  "preference",
  "process",
  "rule",
  "schedule",
  "support",
  "surface",
  "window",
  "workflow",
]);
const STABLE_ATTRIBUTE_HEADS = new Set([
  "access",
  "boundary",
  "condition",
  "contract",
  "default",
  "dependency",
  "guide",
  "mode",
  "order",
  "path",
  "policy",
  "preference",
  "preservation",
  "process",
  "requirement",
  "rule",
  "schedule",
  "setting",
  "status",
  "strategy",
  "support",
  "surface",
  "timezone",
  "truth",
  "version",
  "window",
  "workflow",
]);

/**
 * Stable failure reasons emitted by claim-key normalization.
 */
export type ClaimKeyNormalizationFailureReason = "empty" | "missing_separator" | "too_many_segments" | "empty_entity" | "empty_attribute" | "unknown_pair";

/**
 * Successful normalized claim-key payload.
 */
export interface NormalizedClaimKey {
  claimKey: string;
  entity: string;
  attribute: string;
}

/**
 * Structured result returned by compact canonical claim-key rewriting.
 */
export interface ClaimKeyCompactionResult extends NormalizedClaimKey {
  compactedFrom: string | null;
  reason: string | null;
}

/**
 * Structured result returned by canonical claim-key normalization.
 */
export type ClaimKeyNormalizationResult =
  | {
      ok: true;
      value: NormalizedClaimKey;
    }
  | {
      ok: false;
      reason: ClaimKeyNormalizationFailureReason;
    };

/**
 * Stable failure reasons emitted by deterministic extracted-claim validation.
 */
export type ExtractedClaimKeyRejectionReason = "self_referential_entity" | "generic_attribute" | "value_shaped_attribute";

/**
 * Stable suspicion reasons emitted by claim-key-quality inspection.
 */
export type ClaimKeySuspicionReason = ExtractedClaimKeyRejectionReason | "generic_entity";

/**
 * Structured inspection result used by claim-key-quality maintenance.
 */
export interface ClaimKeyInspection {
  rawClaimKey: string;
  canonical: boolean;
  normalized?: NormalizedClaimKey;
  normalizationFailure?: ClaimKeyNormalizationFailureReason;
  suspectReasons: ClaimKeySuspicionReason[];
}

/**
 * Structured result returned by deterministic extracted-claim validation.
 */
export type ExtractedClaimKeyValidationResult =
  | {
      ok: true;
      value: NormalizedClaimKey;
    }
  | {
      ok: false;
      reason: ExtractedClaimKeyRejectionReason;
      value: NormalizedClaimKey;
    };

/**
 * Normalizes one claim-key segment into lowercase snake_case.
 *
 * @param value - Raw claim-key segment.
 * @returns Canonical claim-key segment, or an empty string when nothing remains.
 */
export function normalizeClaimKeySegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Canonically normalizes and validates a claim key.
 *
 * @param value - Raw claim-key input.
 * @returns Structured normalization outcome.
 */
export function normalizeClaimKey(value: string): ClaimKeyNormalizationResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }

  const slashCount = Array.from(trimmed).filter((character) => character === "/").length;
  if (slashCount === 0) {
    return { ok: false, reason: "missing_separator" };
  }

  if (slashCount !== 1) {
    return { ok: false, reason: "too_many_segments" };
  }

  const [rawEntity = "", rawAttribute = ""] = trimmed.split("/");
  const entity = normalizeClaimKeySegment(rawEntity);
  if (entity.length === 0) {
    return { ok: false, reason: "empty_entity" };
  }

  const attribute = normalizeClaimKeySegment(rawAttribute);
  if (attribute.length === 0) {
    return { ok: false, reason: "empty_attribute" };
  }

  if (entity === UNKNOWN_SEGMENT && attribute === UNKNOWN_SEGMENT) {
    return { ok: false, reason: "unknown_pair" };
  }

  return {
    ok: true,
    value: {
      claimKey: `${entity}/${attribute}`,
      entity,
      attribute,
    },
  };
}

/**
 * Rewrites a canonical claim key into a shorter stable slot name when a safe compact form exists.
 *
 * The transformation preserves semantic slot identity and only applies conservative,
 * auditable compactions such as removing duplicated entity phrasing, collapsing
 * sentence-like relation tails into stable slot heads, or collapsing extra
 * source-of-truth wording into `source_of_truth`.
 *
 * @param claimKey - Raw claim key candidate to compact.
 * @returns Canonical compacted key metadata, or `null` when the input is invalid.
 */
export function compactClaimKey(claimKey: string): ClaimKeyCompactionResult | null {
  const normalized = normalizeClaimKey(claimKey);
  if (!normalized.ok) {
    return null;
  }

  let attributeTokens = normalized.value.attribute.split("_").filter((token) => token.length > 0);
  const entityTokens = normalized.value.entity.split("_").filter((token) => token.length > 0);
  const reasons: string[] = [];

  if (entityTokens.length > 0 && startsWithTokens(attributeTokens, entityTokens) && attributeTokens.length > entityTokens.length) {
    attributeTokens = attributeTokens.slice(entityTokens.length);
    reasons.push("removed duplicated entity prefix from attribute");
  }

  if (
    entityTokens.length > 0 &&
    attributeTokens.length > entityTokens.length + 1 &&
    endsWithTokens(attributeTokens, entityTokens) &&
    TRAILING_OBJECT_COMPACTION_PREPOSITIONS.has(attributeTokens[attributeTokens.length - entityTokens.length - 1] ?? "")
  ) {
    attributeTokens = attributeTokens.slice(0, attributeTokens.length - entityTokens.length - 1);
    reasons.push("removed duplicated entity suffix from attribute");
  }

  const sourceOfTruthCompaction = compactSourceOfTruthAttribute(attributeTokens);
  if (sourceOfTruthCompaction) {
    attributeTokens = sourceOfTruthCompaction.attributeTokens;
    reasons.push(sourceOfTruthCompaction.reason);
  } else {
    const relationCompaction = compactRelationAttribute(attributeTokens);
    if (relationCompaction) {
      attributeTokens = relationCompaction.attributeTokens;
      reasons.push(relationCompaction.reason);
    } else {
      const trailingObjectCompaction = compactTrailingObjectAttribute(attributeTokens);
      if (trailingObjectCompaction) {
        attributeTokens = trailingObjectCompaction.attributeTokens;
        reasons.push(trailingObjectCompaction.reason);
      }
    }
  }

  const attribute = attributeTokens.join("_");
  if (attribute.length === 0) {
    return {
      claimKey: normalized.value.claimKey,
      entity: normalized.value.entity,
      attribute: normalized.value.attribute,
      compactedFrom: null,
      reason: null,
    };
  }
  const compactedClaimKey = `${normalized.value.entity}/${attribute}`;
  return {
    claimKey: compactedClaimKey,
    entity: normalized.value.entity,
    attribute,
    compactedFrom: compactedClaimKey !== normalized.value.claimKey ? normalized.value.claimKey : null,
    reason: reasons.length > 0 ? joinCompactionReasons(reasons) : null,
  };
}

/**
 * Applies deterministic quality gates to one already-normalized extracted claim key.
 *
 * @param claimKey - Canonical claim key produced by normalization.
 * @returns Validation outcome that either accepts or rejects the extracted key.
 */
export function validateExtractedClaimKey(claimKey: NormalizedClaimKey): ExtractedClaimKeyValidationResult {
  if (SELF_REFERENTIAL_ENTITIES.has(claimKey.entity)) {
    return {
      ok: false,
      reason: "self_referential_entity",
      value: claimKey,
    };
  }

  if (GENERIC_ATTRIBUTES.has(claimKey.attribute)) {
    return {
      ok: false,
      reason: "generic_attribute",
      value: claimKey,
    };
  }

  if (isValueShapedAttribute(claimKey.attribute)) {
    return {
      ok: false,
      reason: "value_shaped_attribute",
      value: claimKey,
    };
  }

  return {
    ok: true,
    value: claimKey,
  };
}

/**
 * Inspects one raw claim key for canonicality and suspect-but-valid patterns.
 *
 * @param value - Raw stored claim key.
 * @returns Canonicality and suspicion details for the claim key.
 */
export function inspectClaimKey(value: string): ClaimKeyInspection {
  const rawClaimKey = value.trim();
  const normalized = normalizeClaimKey(rawClaimKey);
  if (!normalized.ok) {
    return {
      rawClaimKey,
      canonical: false,
      normalizationFailure: normalized.reason,
      suspectReasons: [],
    };
  }

  const suspectReasons = new Set<ClaimKeySuspicionReason>();
  const validation = validateExtractedClaimKey(normalized.value);
  if (!validation.ok) {
    suspectReasons.add(validation.reason);
  }

  if (GENERIC_ENTITIES.has(normalized.value.entity)) {
    suspectReasons.add("generic_entity");
  }

  return {
    rawClaimKey,
    canonical: normalized.value.claimKey === rawClaimKey,
    normalized: normalized.value,
    suspectReasons: [...suspectReasons],
  };
}

/**
 * Returns whether one claim key is safe to reuse as a trusted cleanup hint.
 *
 * @param value - Raw stored claim key.
 * @returns True when the key is canonical and free of low-trust patterns.
 */
export function isTrustedClaimKeyForCleanup(value: string): boolean {
  const inspection = inspectClaimKey(value);
  return Boolean(inspection.canonical && inspection.normalized && inspection.suspectReasons.length === 0);
}

/**
 * Formats a normalization failure into a human-readable warning suffix.
 *
 * @param reason - Stable normalization failure reason.
 * @returns Human-readable explanation suitable for logs and warnings.
 */
export function describeClaimKeyNormalizationFailure(reason: ClaimKeyNormalizationFailureReason): string {
  switch (reason) {
    case "empty":
      return "claim key was empty";
    case "missing_separator":
      return "claim key must contain exactly one '/'";
    case "too_many_segments":
      return "claim key must contain exactly one '/'";
    case "empty_entity":
      return "claim key entity was empty after normalization";
    case "empty_attribute":
      return "claim key attribute was empty after normalization";
    case "unknown_pair":
      return 'claim key "unknown/unknown" is not allowed';
  }
}

/**
 * Formats an extracted-claim rejection into a human-readable warning suffix.
 *
 * @param reason - Stable extracted-claim rejection reason.
 * @param claimKey - Canonical claim key that was rejected.
 * @returns Human-readable explanation suitable for logs and warnings.
 */
export function describeExtractedClaimKeyRejection(reason: ExtractedClaimKeyRejectionReason, claimKey: NormalizedClaimKey): string {
  switch (reason) {
    case "self_referential_entity":
      return `entity "${claimKey.entity}" is self-referential`;
    case "generic_attribute":
      return `attribute "${claimKey.attribute}" is too generic`;
    case "value_shaped_attribute":
      return `attribute "${claimKey.attribute}" looks value-shaped`;
  }
}

/**
 * Formats a claim-key-quality suspicion into a human-readable warning suffix.
 *
 * @param reason - Stable suspect reason.
 * @param claimKey - Canonical claim key under inspection.
 * @returns Human-readable explanation suitable for logs and proposals.
 */
export function describeClaimKeySuspicion(reason: ClaimKeySuspicionReason, claimKey: NormalizedClaimKey): string {
  switch (reason) {
    case "generic_entity":
      return `entity "${claimKey.entity}" is too generic`;
    case "self_referential_entity":
    case "generic_attribute":
    case "value_shaped_attribute":
      return describeExtractedClaimKeyRejection(reason, claimKey);
  }
}

/**
 * Returns whether one normalized attribute looks like a value rather than a slot name.
 *
 * @param attribute - Canonical attribute segment to inspect.
 * @returns `true` when the attribute looks value-shaped.
 */
function isValueShapedAttribute(attribute: string): boolean {
  return /^\d+(?:_\d+)*$/u.test(attribute) || /^v\d+(?:_\d+)*$/u.test(attribute);
}

/**
 * Collapses extra source-of-truth wording into the canonical `source_of_truth` slot.
 *
 * @param attributeTokens - Canonical attribute tokens to inspect.
 * @returns Compacted tokens plus rationale, or `null` when no safe rewrite exists.
 */
function compactSourceOfTruthAttribute(attributeTokens: string[]): { attributeTokens: string[]; reason: string } | null {
  const sourceOfTruthIndex = findSourceOfTruthPhraseIndex(attributeTokens);
  if (sourceOfTruthIndex === -1) {
    return null;
  }

  const normalizedPhrase = ["source", "of", "truth"];
  if (attributeTokens.length === normalizedPhrase.length && startsWithTokens(attributeTokens, normalizedPhrase)) {
    return null;
  }

  const before = attributeTokens.slice(0, sourceOfTruthIndex);
  const after = attributeTokens.slice(sourceOfTruthIndex + normalizedPhrase.length);
  const leadingAllowed = before.every((token) => COMPACTION_WEAK_LEADING_TOKENS.has(token));
  const hasMixedStableFamily = before.some((token) => STABLE_ATTRIBUTE_HEADS.has(token)) || after.some((token) => STABLE_ATTRIBUTE_HEADS.has(token));
  const hasConjunctionNoise = before.includes("and") || before.includes("or") || after.includes("and") || after.includes("or");
  if (!leadingAllowed || hasMixedStableFamily || hasConjunctionNoise) {
    return null;
  }

  return {
    attributeTokens: normalizedPhrase,
    reason: "collapsed source-of-truth phrasing into the stable canonical slot",
  };
}

/**
 * Collapses sentence-like relation phrases into stable requirement, order, or preservation slots.
 *
 * @param attributeTokens - Canonical attribute tokens to inspect.
 * @returns Compacted tokens plus rationale, or `null` when no safe rewrite exists.
 */
function compactRelationAttribute(attributeTokens: string[]): { attributeTokens: string[]; reason: string } | null {
  const relationIndex = attributeTokens.findIndex((token) => COMPACTION_RELATION_TOKENS.has(token));
  if (relationIndex === -1) {
    return null;
  }

  const relation = attributeTokens[relationIndex] ?? "";
  const left = attributeTokens.slice(0, relationIndex);
  const right = attributeTokens.slice(relationIndex + 1);
  if (left.length === 0 && right.length === 0) {
    return null;
  }

  if (isRequirementRelation(relation)) {
    const conditionAction = extractConditionAction(right);
    if (conditionAction) {
      return {
        attributeTokens: [conditionAction, "condition"],
        reason: `collapsed a sentence-like ${conditionAction} requirement into a stable condition slot`,
      };
    }

    const requirementFocus = extractCompactionFocus(right, 2) ?? extractCompactionFocus(left, 2);
    if (!requirementFocus) {
      return null;
    }

    return {
      attributeTokens: [...requirementFocus, "requirement"],
      reason: "collapsed a sentence-like requirement phrase into a stable requirement slot",
    };
  }

  if (isOrderingRelation(relation)) {
    const orderingFocus = extractCompactionFocus(right, 2) ?? extractCompactionFocus(left, 2);
    if (!orderingFocus) {
      return null;
    }

    return {
      attributeTokens: [...orderingFocus, "order"],
      reason: "collapsed a sentence-like ordering phrase into a stable order slot",
    };
  }

  if (isPreservationRelation(relation)) {
    const preservationFocus = extractCompactionFocus(right, 2) ?? extractCompactionFocus(left, 2);
    if (!preservationFocus) {
      return null;
    }

    return {
      attributeTokens: [...preservationFocus, "preservation"],
      reason: "collapsed a sentence-like preservation phrase into a stable preservation slot",
    };
  }

  return null;
}

/**
 * Rewrites short trailing object phrases into a compact object-first stable slot name.
 *
 * @param attributeTokens - Canonical attribute tokens to inspect.
 * @returns Compacted tokens plus rationale, or `null` when no safe rewrite exists.
 */
function compactTrailingObjectAttribute(attributeTokens: string[]): { attributeTokens: string[]; reason: string } | null {
  const prepositionIndex = attributeTokens.findIndex((token) => TRAILING_OBJECT_COMPACTION_PREPOSITIONS.has(token));
  if (prepositionIndex <= 0 || prepositionIndex >= attributeTokens.length - 1) {
    return null;
  }

  const left = trimWeakLeadingTokens(attributeTokens.slice(0, prepositionIndex));
  const right = attributeTokens.slice(prepositionIndex + 1);
  if (left.length === 0 || left.length > 3 || left.includes("and") || left.includes("or") || left.some((token) => COMPACTION_RELATION_TOKENS.has(token))) {
    return null;
  }

  const head = left[left.length - 1];
  if (!head || !TRAILING_OBJECT_TRANSFER_HEADS.has(head)) {
    return null;
  }

  const objectFocus = extractCompactionFocus(right, 2);
  if (!objectFocus) {
    return null;
  }

  const headCore = extractStableHeadCore(left, 2);
  if (!headCore) {
    return null;
  }

  return {
    attributeTokens: [...objectFocus, ...headCore],
    reason: "collapsed a trailing object phrase into a compact stable slot name",
  };
}

/**
 * Locates the start of a `source_of_truth` phrase inside one token list.
 *
 * @param tokens - Canonical attribute tokens to inspect.
 * @returns Zero-based token index, or `-1` when the phrase is absent.
 */
function findSourceOfTruthPhraseIndex(tokens: string[]): number {
  for (let index = 0; index <= tokens.length - 3; index += 1) {
    if (tokens[index] === "source" && tokens[index + 1] === "of" && tokens[index + 2] === "truth") {
      return index;
    }
  }

  return -1;
}

/**
 * Finds a trailing action token that can be rewritten into a stable condition slot.
 *
 * @param tokens - Canonical attribute tokens to inspect.
 * @returns The compact action token, or `null` when no stable action is present.
 */
function extractConditionAction(tokens: string[]): string | null {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token && ACTION_CONDITION_TOKENS.has(token)) {
      return token;
    }
  }

  return null;
}

/**
 * Extracts the compact noun-like focus tokens from one longer phrase.
 *
 * @param tokens - Canonical attribute tokens to inspect.
 * @param limit - Maximum number of focus tokens to keep.
 * @returns Focus tokens capped to the requested size, or `null` when no focus exists.
 */
function extractCompactionFocus(tokens: string[], limit: number): string[] | null {
  const compactable = trimWeakLeadingTokens(tokens).filter((token) => token.length > 0);
  const segments = splitTokensOnBreaks(compactable).filter((segment) => segment.length > 0);
  const preferredSegment = segments[0];
  if (!preferredSegment || preferredSegment.length === 0) {
    return null;
  }

  return preferredSegment.slice(0, limit);
}

/**
 * Extracts the stable slot-head tail from one left-hand phrase.
 *
 * @param tokens - Canonical attribute tokens to inspect.
 * @param limit - Maximum number of tail tokens to keep.
 * @returns Tail tokens ending in a stable slot head, or `null` when none exist.
 */
function extractStableHeadCore(tokens: string[], limit: number): string[] | null {
  const compactable = trimWeakLeadingTokens(tokens).filter((token) => token.length > 0);
  const head = compactable[compactable.length - 1];
  if (!head || !STABLE_ATTRIBUTE_HEADS.has(head)) {
    return null;
  }

  return compactable.slice(Math.max(0, compactable.length - limit));
}

/**
 * Splits one token list on compaction break words such as conjunctions or prepositions.
 *
 * @param tokens - Canonical tokens to split.
 * @returns Ordered token segments with break words removed.
 */
function splitTokensOnBreaks(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (COMPACTION_BREAK_TOKENS.has(token)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }

    current.push(token);
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments;
}

/**
 * Removes weak leading modifiers that should not anchor a canonical slot name.
 *
 * @param tokens - Canonical tokens to trim.
 * @returns Token list with removable leading modifiers stripped.
 */
function trimWeakLeadingTokens(tokens: string[]): string[] {
  let start = 0;
  while (start < tokens.length && COMPACTION_WEAK_LEADING_TOKENS.has(tokens[start] ?? "")) {
    start += 1;
  }

  return tokens.slice(start);
}

/**
 * Joins one or more compaction reasons into a stable human-readable explanation.
 *
 * @param reasons - Ordered compaction reasons gathered during rewriting.
 * @returns Combined human-readable rationale.
 */
function joinCompactionReasons(reasons: string[]): string {
  if (reasons.length <= 1) {
    return reasons[0] ?? "";
  }

  return `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
}

/**
 * Returns whether one relation token expresses a requirement/dependency pattern.
 *
 * @param token - Canonical relation token to inspect.
 * @returns `true` when the token maps to a requirement slot.
 */
function isRequirementRelation(token: string): boolean {
  return (
    token === "depend" || token === "depends" || token === "need" || token === "needs" || token === "required" || token === "require" || token === "requires"
  );
}

/**
 * Returns whether one relation token expresses an ordering pattern.
 *
 * @param token - Canonical relation token to inspect.
 * @returns `true` when the token maps to an order slot.
 */
function isOrderingRelation(token: string): boolean {
  return token === "after" || token === "before" || token === "follow" || token === "follows" || token === "precede" || token === "precedes";
}

/**
 * Returns whether one relation token expresses a preservation pattern.
 *
 * @param token - Canonical relation token to inspect.
 * @returns `true` when the token maps to a preservation slot.
 */
function isPreservationRelation(token: string): boolean {
  return (
    token === "keep" ||
    token === "keeps" ||
    token === "maintain" ||
    token === "maintains" ||
    token === "preserve" ||
    token === "preserves" ||
    token === "retain" ||
    token === "retains"
  );
}

/**
 * Returns whether one token list starts with another token list.
 *
 * @param tokens - Candidate full token list.
 * @param prefix - Candidate prefix token list.
 * @returns `true` when the prefix matches from the first token onward.
 */
function startsWithTokens(tokens: string[], prefix: string[]): boolean {
  return prefix.every((token, index) => tokens[index] === token);
}

/**
 * Returns whether one token list ends with another token list.
 *
 * @param tokens - Candidate full token list.
 * @param suffix - Candidate suffix token list.
 * @returns `true` when the suffix matches through the final token.
 */
function endsWithTokens(tokens: string[], suffix: string[]): boolean {
  return suffix.every((token, index) => tokens[tokens.length - suffix.length + index] === token);
}
