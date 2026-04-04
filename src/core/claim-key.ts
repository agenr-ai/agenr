const UNKNOWN_SEGMENT = "unknown";
const SELF_REFERENTIAL_ENTITIES = new Set(["i", "me", "myself", "the_user", "user", "we", "our_team", "the_project", "this_project"]);
const GENERIC_ATTRIBUTES = new Set(["info", "details", "config", "stuff", "thing", "data"]);

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
 * Returns whether one normalized attribute looks like a value rather than a slot name.
 *
 * @param attribute - Canonical attribute segment to inspect.
 * @returns `true` when the attribute looks value-shaped.
 */
function isValueShapedAttribute(attribute: string): boolean {
  return /^\d+(?:_\d+)*$/u.test(attribute) || /^v\d+(?:_\d+)*$/u.test(attribute);
}
