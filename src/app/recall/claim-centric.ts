import { resolveClaimSlotPolicy, type ClaimSlotPolicy, type ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import type { ClaimKeyStatus, ClaimSupportMode } from "../../core/types.js";
import type { RecallOutput } from "../../core/recall/types.js";

/**
 * High-level memory-state label for one recalled entry.
 */
export type ClaimCentricMemoryState = "current" | "historical" | "superseded";

/**
 * Normalized claim-family lifecycle label for one recalled entry.
 */
export type ClaimCentricClaimStatus = ClaimKeyStatus | "legacy" | "no_key";

/**
 * Freshness metadata surfaced alongside one recalled entry.
 */
export interface ClaimCentricFreshness {
  /** Original created-at timestamp from the durable entry row. */
  createdAt: string;
  /** Optional validity-window lower bound when the entry models a time range. */
  validFrom?: string;
  /** Optional validity-window upper bound when the entry models a time range. */
  validTo?: string;
  /** Whether this recalled row still represents the current active state. */
  isCurrent: boolean;
  /** Optional explicit as-of resolution details for historical targeting. */
  asOf?: ClaimCentricAsOfResolution;
  /** Concise human-readable freshness summary for UI surfaces. */
  label: string;
}

/**
 * Structured explanation of how an explicit as-of reference point was resolved.
 */
export interface ClaimCentricAsOfResolution {
  /** Normalized as-of timestamp requested by the caller. */
  asOf: string;
  /** Which temporal clock determined the as-of interpretation. */
  clock: "validity" | "support_observed_at" | "created_at";
  /** Relationship between the row and the as-of reference point. */
  relation: "active" | "before_start" | "after_end" | "observed_before" | "observed_after" | "created_before" | "created_after";
  /** Human-readable explanation of the chosen clock and relation. */
  label: string;
}

/**
 * Provenance metadata surfaced alongside one recalled entry.
 */
export interface ClaimCentricProvenance {
  /** Successor row ID when this entry has been superseded. */
  supersededById?: string;
  /** Optional supersession relationship kind persisted on the entry. */
  supersessionKind?: string;
  /** Optional human rationale explaining the supersession relationship. */
  supersessionReason?: string;
  /** Optional explicit support source kind persisted for the claim. */
  supportSourceKind?: string;
  /** Optional support locator persisted for the claim. */
  supportLocator?: string;
  /** Optional observed-at timestamp for the supporting source. */
  supportObservedAt?: string;
  /** Optional support normalization mode persisted for the claim. */
  supportMode?: ClaimSupportMode;
}

/**
 * One concise explanation of why a row surfaced in recall.
 */
export interface ClaimCentricRecallExplanation {
  /** Concise one-line summary suitable for human-facing surfaces. */
  summary: string;
  /** Ordered machine-readable explanation fragments for tests or richer UIs. */
  reasons: string[];
}

/**
 * Claim-aware annotation attached to one recalled entry row.
 */
export interface ClaimCentricRecallEntry {
  /** Stable entry identifier mirrored for convenience. */
  entryId: string;
  /** Claim-family grouping key. Claim-key rows group by claim key, others by entry ID. */
  familyKey: string;
  /** Claim key when the row participates in a claim family. */
  claimKey?: string;
  /** Runtime slot-policy class used for read-time shaping. */
  slotPolicy: ClaimSlotPolicy;
  /** High-level memory-state label used in trust surfaces. */
  memoryState: ClaimCentricMemoryState;
  /** Normalized lifecycle label for trust annotations. */
  claimStatus: ClaimCentricClaimStatus;
  /** Freshness and validity summary for the recalled row. */
  freshness: ClaimCentricFreshness;
  /** Persisted provenance cues that justify or contextualize the row. */
  provenance: ClaimCentricProvenance;
  /** Concise reason the row surfaced in recall. */
  whySurfaced: ClaimCentricRecallExplanation;
  /** Underlying raw recall output from core recall. */
  recall: RecallOutput;
}

/**
 * Group of related recall rows that belong to the same claim family.
 */
export interface ClaimCentricRecallFamily {
  /** Stable grouping key used by app and formatter layers. */
  familyKey: string;
  /** Shared claim key for the family, when present. */
  claimKey?: string;
  /** Runtime slot-policy class shared across the family. */
  slotPolicy: ClaimSlotPolicy;
  /** Subject from the first ranked row in the family. */
  subject: string;
  /** Highest-ranked row in the family. */
  primary: ClaimCentricRecallEntry;
  /** Family rows preserved in ranked order. */
  entries: ClaimCentricRecallEntry[];
}

/**
 * Projects raw recall rows into claim-aware families and annotations.
 *
 * @param entries - Ranked raw recall rows returned by the unified layer.
 * @returns Claim-aware grouped projection preserving ranked order.
 */
export function projectClaimCentricRecallEntries(
  entries: RecallOutput[],
  options: { asOf?: string; slotPolicyConfig?: ClaimSlotPolicyConfig } = {},
): ClaimCentricRecallFamily[] {
  const families = new Map<string, ClaimCentricRecallFamily>();

  for (const recall of entries) {
    const projected = projectClaimCentricRecallEntry(recall, options);
    const family = families.get(projected.familyKey);
    if (family) {
      family.entries.push(projected);
      continue;
    }

    families.set(projected.familyKey, {
      familyKey: projected.familyKey,
      claimKey: projected.claimKey,
      slotPolicy: projected.slotPolicy,
      subject: recall.entry.subject,
      primary: projected,
      entries: [projected],
    });
  }

  return [...families.values()];
}

/**
 * Flattens the claim-centric family view back into ranked row order.
 *
 * @param families - Claim-aware grouped projection.
 * @returns Flat projected rows in the same ranked order as recall output.
 */
export function flattenClaimCentricRecallFamilies(families: ClaimCentricRecallFamily[]): ClaimCentricRecallEntry[] {
  return families.flatMap((family) => family.entries);
}

/**
 * Projects one raw recall row into the claim-centric annotation shape.
 *
 * @param recall - Raw scored recall row from the core recall pipeline.
 * @returns Claim-aware projected row used by app and adapter surfaces.
 */
export function projectClaimCentricRecallEntry(
  recall: RecallOutput,
  options: { asOf?: string; slotPolicyConfig?: ClaimSlotPolicyConfig } = {},
): ClaimCentricRecallEntry {
  const entry = recall.entry;
  const claimKey = normalizeOptionalString(entry.claim_key);
  const familyKey = claimKey ?? `entry:${entry.id}`;
  const slotPolicy = resolveClaimSlotPolicy(claimKey, options.slotPolicyConfig).policy;
  const asOfResolution = buildAsOfResolution(recall, options.asOf);
  const memoryState = resolveMemoryState(recall, asOfResolution);
  const claimStatus = resolveClaimStatus(recall);

  return {
    entryId: entry.id,
    familyKey,
    ...(claimKey ? { claimKey } : {}),
    slotPolicy,
    memoryState,
    claimStatus,
    freshness: buildFreshness(recall, memoryState, asOfResolution),
    provenance: buildProvenance(recall),
    whySurfaced: buildWhySurfaced(recall, asOfResolution),
    recall,
  };
}

/**
 * Resolves the user-facing memory-state label for one recalled row.
 *
 * @param recall - Raw scored recall row.
 * @returns Memory-state label for trust surfaces.
 */
function resolveMemoryState(recall: RecallOutput, asOfResolution?: ClaimCentricAsOfResolution): ClaimCentricMemoryState {
  const entry = recall.entry;
  if (asOfResolution) {
    if (asOfResolution.clock === "validity") {
      if (asOfResolution.relation === "active") {
        return "current";
      }

      return normalizeOptionalString(entry.superseded_by) ? "superseded" : "historical";
    }

    if (asOfResolution.relation === "observed_after" || asOfResolution.relation === "created_after") {
      return "historical";
    }

    if (normalizeOptionalString(entry.superseded_by)) {
      return "superseded";
    }

    if (entry.retired || normalizeOptionalString(entry.valid_to)) {
      return "historical";
    }

    return "current";
  }

  if (normalizeOptionalString(entry.superseded_by)) {
    return "superseded";
  }

  if (entry.retired || normalizeOptionalString(entry.valid_to)) {
    return "historical";
  }

  return "current";
}

/**
 * Resolves the normalized claim-status label for one recalled row.
 *
 * @param recall - Raw scored recall row.
 * @returns Claim-family lifecycle label for trust surfaces.
 */
function resolveClaimStatus(recall: RecallOutput): ClaimCentricClaimStatus {
  const entry = recall.entry;
  if (!normalizeOptionalString(entry.claim_key)) {
    return "no_key";
  }

  return entry.claim_key_status ?? "legacy";
}

/**
 * Builds the freshness summary surfaced with one recalled row.
 *
 * @param recall - Raw scored recall row.
 * @param memoryState - Resolved memory-state label for the row.
 * @returns Freshness metadata for tool and CLI rendering.
 */
function buildFreshness(recall: RecallOutput, memoryState: ClaimCentricMemoryState, asOfResolution?: ClaimCentricAsOfResolution): ClaimCentricFreshness {
  const entry = recall.entry;
  const validFrom = normalizeOptionalString(entry.valid_from);
  const validTo = normalizeOptionalString(entry.valid_to);
  const createdAt = entry.created_at;
  const labelParts = [`created ${createdAt}`];

  if (validFrom || validTo) {
    labelParts.push(`valid ${validFrom ?? "?"} -> ${validTo ?? "ongoing"}`);
  }

  if (memoryState === "superseded") {
    labelParts.push("superseded state");
  } else if (memoryState === "historical") {
    labelParts.push("historical state");
  } else {
    labelParts.push("current state");
  }

  if (asOfResolution) {
    labelParts.push(asOfResolution.label);
  }

  return {
    createdAt,
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
    isCurrent: memoryState === "current",
    ...(asOfResolution ? { asOf: asOfResolution } : {}),
    label: labelParts.join(" | "),
  };
}

/**
 * Builds the provenance summary surfaced with one recalled row.
 *
 * @param recall - Raw scored recall row.
 * @returns Persisted provenance cues relevant to trust surfaces.
 */
function buildProvenance(recall: RecallOutput): ClaimCentricProvenance {
  const entry = recall.entry;
  return {
    ...(normalizeOptionalString(entry.superseded_by) ? { supersededById: entry.superseded_by } : {}),
    ...(normalizeOptionalString(entry.supersession_kind) ? { supersessionKind: entry.supersession_kind } : {}),
    ...(normalizeOptionalString(entry.supersession_reason) ? { supersessionReason: entry.supersession_reason } : {}),
    ...(normalizeOptionalString(entry.claim_support_source_kind) ? { supportSourceKind: entry.claim_support_source_kind } : {}),
    ...(normalizeOptionalString(entry.claim_support_locator) ? { supportLocator: entry.claim_support_locator } : {}),
    ...(normalizeOptionalString(entry.claim_support_observed_at) ? { supportObservedAt: entry.claim_support_observed_at } : {}),
    ...(entry.claim_support_mode ? { supportMode: entry.claim_support_mode } : {}),
  };
}

/**
 * Builds a concise explanation of why a row surfaced in recall.
 *
 * @param recall - Raw scored recall row.
 * @returns Ordered reasons plus a one-line summary.
 */
function buildWhySurfaced(recall: RecallOutput, asOfResolution?: ClaimCentricAsOfResolution): ClaimCentricRecallExplanation {
  const reasons: string[] = [];

  if (recall.scores.vector > 0) {
    reasons.push(`semantic similarity ${formatScore(recall.scores.vector)}`);
  }
  if (recall.scores.lexical > 0) {
    reasons.push(`lexical overlap ${formatScore(recall.scores.lexical)}`);
  }
  if (recall.scores.historicalLineage > 0) {
    reasons.push(`historical lineage boost ${formatScore(recall.scores.historicalLineage)}`);
  }
  if (recall.scores.claimKeyTrustPenalty > 0) {
    reasons.push(`same-slot trust penalty ${formatScore(recall.scores.claimKeyTrustPenalty)}`);
  }
  if (recall.scores.claimKeyRedundancyPenalty > 0) {
    reasons.push(`same-slot redundancy penalty ${formatScore(recall.scores.claimKeyRedundancyPenalty)}`);
  }
  if (recall.scores.recency > 0) {
    reasons.push(`freshness ${formatScore(recall.scores.recency)}`);
  }
  if (asOfResolution) {
    reasons.push(`as_of ${asOfResolution.asOf} via ${asOfResolution.clock} (${formatAsOfRelation(asOfResolution.relation)})`);
  }

  const summary = reasons.slice(0, 3).join("; ") || `ranked score ${formatScore(recall.score)}`;
  return {
    summary,
    reasons,
  };
}

/**
 * Formats one score component in a stable compact style.
 *
 * @param value - Numeric score to format.
 * @returns Two-decimal score string.
 */
function formatScore(value: number): string {
  return value.toFixed(2);
}

/**
 * Normalizes optional strings by trimming empties to undefined.
 *
 * @param value - Candidate optional text field.
 * @returns Trimmed string, or undefined when absent.
 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Resolves how an explicit as-of reference point applies to one recalled row.
 *
 * @param recall - Raw scored recall row.
 * @param asOf - Optional caller-supplied as-of timestamp text.
 * @returns Structured as-of facts, or undefined when the caller did not request one.
 */
function buildAsOfResolution(recall: RecallOutput, asOf: string | undefined): ClaimCentricAsOfResolution | undefined {
  const normalizedAsOf = normalizeOptionalString(asOf);
  if (!normalizedAsOf) {
    return undefined;
  }

  const asOfDate = parseTimestamp(normalizedAsOf);
  if (!asOfDate) {
    return undefined;
  }

  const entry = recall.entry;
  const validFrom = parseTimestamp(entry.valid_from);
  const validTo = parseTimestamp(entry.valid_to);
  if (validFrom || validTo) {
    const asOfMs = asOfDate.getTime();
    const startMs = validFrom?.getTime() ?? Number.NEGATIVE_INFINITY;
    const endMs = validTo?.getTime() ?? Number.POSITIVE_INFINITY;
    const relation: ClaimCentricAsOfResolution["relation"] = asOfMs < startMs ? "before_start" : asOfMs > endMs ? "after_end" : "active";
    return {
      asOf: asOfDate.toISOString(),
      clock: "validity",
      relation,
      label: `as_of ${asOfDate.toISOString()} via validity (${formatAsOfRelation(relation)})`,
    };
  }

  const supportObservedAt = parseTimestamp(entry.claim_support_observed_at);
  if (supportObservedAt) {
    const relation: ClaimCentricAsOfResolution["relation"] = supportObservedAt.getTime() <= asOfDate.getTime() ? "observed_before" : "observed_after";
    return {
      asOf: asOfDate.toISOString(),
      clock: "support_observed_at",
      relation,
      label: `as_of ${asOfDate.toISOString()} via support_observed_at (${formatAsOfRelation(relation)})`,
    };
  }

  const createdAt = parseTimestamp(entry.created_at);
  if (!createdAt) {
    return undefined;
  }

  const relation: ClaimCentricAsOfResolution["relation"] = createdAt.getTime() <= asOfDate.getTime() ? "created_before" : "created_after";
  return {
    asOf: asOfDate.toISOString(),
    clock: "created_at",
    relation,
    label: `as_of ${asOfDate.toISOString()} via created_at (${formatAsOfRelation(relation)})`,
  };
}

/** Formats one as-of relation into a concise user-facing label. */
function formatAsOfRelation(relation: ClaimCentricAsOfResolution["relation"]): string {
  switch (relation) {
    case "active":
      return "active at reference time";
    case "before_start":
      return "starts after the reference time";
    case "after_end":
      return "ended before the reference time";
    case "observed_before":
      return "support observed before the reference time";
    case "observed_after":
      return "support observed after the reference time";
    case "created_before":
      return "created before the reference time";
    case "created_after":
      return "created after the reference time";
  }
}

/** Parses one optional timestamp into a Date when valid. */
function parseTimestamp(value: string | undefined): Date | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }

  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}
