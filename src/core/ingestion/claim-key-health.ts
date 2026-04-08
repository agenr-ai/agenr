import type { ClaimExtractionDiagnostic, ClaimExtractionDiagnosticOutcome } from "../store/claim-extraction.js";
import type { ClaimKeySource, EntryType, StoreEntryInput } from "../types.js";

/**
 * Per-type keyed coverage emitted in the compact ingest claim-key health view.
 */
export interface IngestClaimKeyHealthTypeCoverage {
  type: EntryType;
  total: number;
  eligible: boolean;
  keyed: number;
  missing: number;
}

/**
 * Support fill-rate breakdown for one persisted claim-key source bucket.
 */
export interface IngestClaimKeyHealthSupportCoverage {
  source: ClaimKeySource | "unknown";
  keyed: number;
  withSupport: number;
  missingSupport: number;
  fillRate: number;
}

/**
 * Compact row summary for unresolved or reviewable ingest claim-key outcomes.
 */
export interface IngestClaimKeyHealthRow {
  inputIndex: number;
  type: EntryType;
  subject: string;
  sourceFile?: string;
  outcome: Exclude<ClaimExtractionDiagnosticOutcome, "accepted" | "ineligible_type">;
  confidence: number | null;
  path: ClaimExtractionDiagnostic["path"];
  suggestedClaimKey: string | null;
  reviewable: boolean;
  warning: string | null;
  rationale: string | null;
}

/**
 * Aggregate ingest-time claim-key health summary used by CLI and sandbox comparisons.
 */
export interface IngestClaimKeyHealthSummary {
  totalRows: number;
  eligibleRows: number;
  keyedEligibleRows: number;
  missingEligibleRows: number;
  coveragePct: number;
  byType: IngestClaimKeyHealthTypeCoverage[];
  lifecycle: {
    trusted: number;
    tentative: number;
    unresolved: number;
    legacy: number;
  };
  keyedRows: number;
  keyedWithSupportCount: number;
  keyedMissingSupportCount: number;
  supportFillRate: number;
  supportBySource: IngestClaimKeyHealthSupportCoverage[];
  diagnostics: {
    noClaim: number;
    lowConfidenceCandidate: number;
    rejectedCandidate: number;
    extractionFailure: number;
    ineligibleType: number;
    reviewable: number;
  };
  suspiciousSingletonNamespaceHints: string[];
  reviewCandidates: IngestClaimKeyHealthRow[];
  unresolvedRows: IngestClaimKeyHealthRow[];
}

/**
 * Builds a compact ingest-time claim-key health summary from store candidates and diagnostics.
 *
 * @param entries - Final store candidates after ingest extraction and within-batch dedup.
 * @param diagnosticsByIndex - Structured diagnostics keyed by flattened store-candidate index.
 * @param eligibleTypes - Claim-key-eligible entry types for the current run.
 * @returns Compact claim-key health summary for operator-facing reporting.
 */
export function summarizeIngestClaimKeyHealth(
  entries: StoreEntryInput[],
  diagnosticsByIndex: Map<number, ClaimExtractionDiagnostic>,
  eligibleTypes: EntryType[],
): IngestClaimKeyHealthSummary {
  const eligibleTypeSet = new Set(eligibleTypes);
  const eligibleRows = entries.filter((entry) => eligibleTypeSet.has(entry.type));
  const keyedEligibleRows = eligibleRows.filter((entry) => hasClaimKey(entry)).length;
  const lifecycle = {
    trusted: 0,
    tentative: 0,
    unresolved: 0,
    legacy: 0,
  };
  let keyedRows = 0;
  let keyedWithSupportCount = 0;
  let keyedMissingSupportCount = 0;
  const supportBySource = new Map<ClaimKeySource | "unknown", { keyed: number; withSupport: number }>();

  for (const entry of entries) {
    if (!hasClaimKey(entry)) {
      continue;
    }

    keyedRows += 1;

    switch (entry.claim_key_status) {
      case "trusted":
        lifecycle.trusted += 1;
        break;
      case "tentative":
        lifecycle.tentative += 1;
        break;
      case "unresolved":
        lifecycle.unresolved += 1;
        break;
      default:
        lifecycle.legacy += 1;
        break;
    }

    const source = entry.claim_key_source ?? "unknown";
    const existingSourceBucket = supportBySource.get(source) ?? { keyed: 0, withSupport: 0 };
    existingSourceBucket.keyed += 1;

    if (hasCompleteSupportMetadata(entry)) {
      keyedWithSupportCount += 1;
      existingSourceBucket.withSupport += 1;
    } else {
      keyedMissingSupportCount += 1;
    }

    supportBySource.set(source, existingSourceBucket);
  }

  const byType = (["fact", "decision", "preference", "lesson", "relationship", "milestone"] as const).map((type) => {
    const rows = entries.filter((entry) => entry.type === type);
    const eligible = eligibleTypeSet.has(type);
    const keyed = eligible ? rows.filter((entry) => hasClaimKey(entry)).length : 0;
    const missing = eligible ? rows.length - keyed : rows.length;
    return {
      type,
      total: rows.length,
      eligible,
      keyed,
      missing,
    } satisfies IngestClaimKeyHealthTypeCoverage;
  });

  const unresolvedRows = [...diagnosticsByIndex.entries()]
    .flatMap(([inputIndex, diagnostic]) => {
      if (diagnostic.outcome === "accepted" || diagnostic.outcome === "ineligible_type") {
        return [];
      }

      const entry = entries[inputIndex];
      if (!entry) {
        return [];
      }

      return [
        {
          inputIndex,
          type: entry.type,
          subject: entry.subject,
          sourceFile: entry.source_file,
          outcome: diagnostic.outcome,
          confidence: diagnostic.confidence,
          path: diagnostic.path,
          suggestedClaimKey: diagnostic.suggestedClaimKey,
          reviewable: diagnostic.reviewable,
          warning: diagnostic.warning,
          rationale: diagnostic.rationale,
        } satisfies IngestClaimKeyHealthRow,
      ];
    })
    .sort((left, right) => {
      const reviewableDelta = Number(right.reviewable) - Number(left.reviewable);
      if (reviewableDelta !== 0) {
        return reviewableDelta;
      }

      const confidenceDelta = (right.confidence ?? -1) - (left.confidence ?? -1);
      if (confidenceDelta !== 0) {
        return confidenceDelta;
      }

      return left.subject.localeCompare(right.subject);
    });

  return {
    totalRows: entries.length,
    eligibleRows: eligibleRows.length,
    keyedEligibleRows,
    missingEligibleRows: eligibleRows.length - keyedEligibleRows,
    coveragePct: eligibleRows.length > 0 ? keyedEligibleRows / eligibleRows.length : 0,
    byType,
    lifecycle,
    keyedRows,
    keyedWithSupportCount,
    keyedMissingSupportCount,
    supportFillRate: keyedRows > 0 ? keyedWithSupportCount / keyedRows : 0,
    supportBySource: [...supportBySource.entries()]
      .map(([source, counts]) => ({
        source,
        keyed: counts.keyed,
        withSupport: counts.withSupport,
        missingSupport: counts.keyed - counts.withSupport,
        fillRate: counts.keyed > 0 ? counts.withSupport / counts.keyed : 0,
      }))
      .sort((left, right) => right.keyed - left.keyed || left.source.localeCompare(right.source)),
    diagnostics: {
      noClaim: countDiagnostics(diagnosticsByIndex, "no_claim"),
      lowConfidenceCandidate: countDiagnostics(diagnosticsByIndex, "low_confidence_candidate"),
      rejectedCandidate: countDiagnostics(diagnosticsByIndex, "rejected_candidate"),
      extractionFailure: countDiagnostics(diagnosticsByIndex, "extraction_failure"),
      ineligibleType: countDiagnostics(diagnosticsByIndex, "ineligible_type"),
      reviewable: unresolvedRows.filter((row) => row.reviewable).length,
    },
    suspiciousSingletonNamespaceHints: buildSuspiciousSingletonNamespaceHints(entries),
    reviewCandidates: unresolvedRows.filter((row) => row.reviewable).slice(0, 10),
    unresolvedRows: unresolvedRows.slice(0, 10),
  };
}

/** Returns whether one store candidate already carries a non-empty claim key. */
function hasClaimKey(entry: StoreEntryInput): boolean {
  return typeof entry.claim_key === "string" && entry.claim_key.trim().length > 0;
}

/** Returns whether one keyed row carries the full persisted support bundle. */
function hasCompleteSupportMetadata(entry: StoreEntryInput): boolean {
  return (
    typeof entry.claim_support_source_kind === "string" &&
    entry.claim_support_source_kind.trim().length > 0 &&
    typeof entry.claim_support_locator === "string" &&
    entry.claim_support_locator.trim().length > 0 &&
    typeof entry.claim_support_observed_at === "string" &&
    entry.claim_support_observed_at.trim().length > 0 &&
    entry.claim_support_mode !== undefined
  );
}

/** Counts diagnostics matching one concrete outcome code. */
function countDiagnostics(diagnosticsByIndex: Map<number, ClaimExtractionDiagnostic>, outcome: ClaimExtractionDiagnosticOutcome): number {
  let total = 0;
  for (const diagnostic of diagnosticsByIndex.values()) {
    if (diagnostic.outcome === outcome) {
      total += 1;
    }
  }

  return total;
}

/** Builds lightweight singleton-namespace hints for likely split-family follow-up review. */
function buildSuspiciousSingletonNamespaceHints(entries: StoreEntryInput[]): string[] {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    const entity = entry.claim_key?.split("/", 1)[0]?.trim();
    if (!entity) {
      continue;
    }

    counts.set(entity, (counts.get(entity) ?? 0) + 1);
  }

  const entities = [...counts.keys()];
  const hints: string[] = [];
  for (const entity of entities) {
    if ((counts.get(entity) ?? 0) !== 1) {
      continue;
    }

    const entityTokens = new Set(entity.split("_").filter((token) => token.length > 0));
    const match = entities.find((candidate) => {
      if (candidate === entity || (counts.get(candidate) ?? 0) < 2) {
        return false;
      }

      const candidateTokens = new Set(candidate.split("_").filter((token) => token.length > 0));
      let overlap = 0;
      for (const token of entityTokens) {
        if (candidateTokens.has(token)) {
          overlap += 1;
        }
      }

      return overlap > 0;
    });

    if (match) {
      hints.push(`${entity} -> ${match}`);
    }

    if (hints.length === 5) {
      break;
    }
  }

  return hints;
}
