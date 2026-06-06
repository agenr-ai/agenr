import type { ClaimExtractionDiagnostic, ClaimExtractionDiagnosticOutcome } from "../store/claim-extraction.js";
import type { ClaimKeySource, DurableKind, StoreDurableInput } from "../types.js";
import { detectClaimKeySingletonAliasCandidates, type ClaimKeyEntityPrefixObservation } from "../claim-key-entity-family.js";
import { hasKeyedDurableLifecycleStatus } from "../keyed-durable-lifecycle.js";
import { isSnapshotStyleSourceFile } from "./source-metadata.js";

/**
 * Per-type keyed coverage emitted in the compact ingest claim-key health view.
 */
export interface IngestClaimKeyHealthTypeCoverage {
  type: DurableKind;
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
  type: DurableKind;
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
  metadataCoverage: {
    rowsWithUserId: number;
    rowsWithoutUserId: number;
    userIdFillRate: number;
    rowsWithProject: number;
    rowsWithoutProject: number;
    projectFillRate: number;
    rowsWithSourceFile: number;
    stableSourceRows: number;
    snapshotStyleSourceRows: number;
    stableSourceFillRate: number;
  };
  byType: IngestClaimKeyHealthTypeCoverage[];
  lifecycle: {
    trusted: number;
    tentative: number;
    unresolved: number;
  };
  keyedRows: number;
  keyedMissingLifecycleStatus: number;
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
  suspiciousSingletonAliasCount: number;
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
  entries: StoreDurableInput[],
  diagnosticsByIndex: Map<number, ClaimExtractionDiagnostic>,
  eligibleTypes: DurableKind[],
): IngestClaimKeyHealthSummary {
  const eligibleTypeSet = new Set(eligibleTypes);
  const eligibleRows = entries.filter((entry) => eligibleTypeSet.has(entry.type));
  const keyedEligibleRows = eligibleRows.filter((entry) => hasClaimKey(entry)).length;
  const rowsWithUserId = entries.filter((entry) => hasNonEmptyValue(entry.user_id)).length;
  const rowsWithProject = entries.filter((entry) => hasNonEmptyValue(entry.project)).length;
  const rowsWithSourceFile = entries.filter((entry) => hasNonEmptyValue(entry.source_file)).length;
  const snapshotStyleSourceRows = entries.filter((entry) => isSnapshotStyleSourceFile(entry.source_file)).length;
  const stableSourceRows = rowsWithSourceFile - snapshotStyleSourceRows;
  const lifecycle = {
    trusted: 0,
    tentative: 0,
    unresolved: 0,
  };
  let keyedRows = 0;
  let keyedMissingLifecycleStatus = 0;
  let keyedWithSupportCount = 0;
  let keyedMissingSupportCount = 0;
  const supportBySource = new Map<ClaimKeySource | "unknown", { keyed: number; withSupport: number }>();

  for (const entry of entries) {
    if (!hasClaimKey(entry)) {
      continue;
    }

    if (!entry.claim_key_status) {
      keyedMissingLifecycleStatus += 1;
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

  const suspiciousSingletonAliases = detectClaimKeySingletonAliasCandidates(toKeyedLifecycleObservations(entries));

  return {
    totalRows: entries.length,
    eligibleRows: eligibleRows.length,
    keyedEligibleRows,
    missingEligibleRows: eligibleRows.length - keyedEligibleRows,
    coveragePct: eligibleRows.length > 0 ? keyedEligibleRows / eligibleRows.length : 0,
    metadataCoverage: {
      rowsWithUserId,
      rowsWithoutUserId: entries.length - rowsWithUserId,
      userIdFillRate: entries.length > 0 ? rowsWithUserId / entries.length : 0,
      rowsWithProject,
      rowsWithoutProject: entries.length - rowsWithProject,
      projectFillRate: entries.length > 0 ? rowsWithProject / entries.length : 0,
      rowsWithSourceFile,
      stableSourceRows,
      snapshotStyleSourceRows,
      stableSourceFillRate: rowsWithSourceFile > 0 ? stableSourceRows / rowsWithSourceFile : 0,
    },
    byType,
    lifecycle,
    keyedRows,
    keyedMissingLifecycleStatus,
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
    suspiciousSingletonAliasCount: suspiciousSingletonAliases.length,
    suspiciousSingletonNamespaceHints: buildSuspiciousSingletonNamespaceHints(suspiciousSingletonAliases),
    reviewCandidates: unresolvedRows.filter((row) => row.reviewable).slice(0, 10),
    unresolvedRows: unresolvedRows.slice(0, 10),
  };
}

/** Narrows ingest store candidates to keyed rows that already carry lifecycle status. */
function toKeyedLifecycleObservations(entries: StoreDurableInput[]): ClaimKeyEntityPrefixObservation[] {
  return entries.filter((entry): entry is StoreDurableInput & ClaimKeyEntityPrefixObservation => hasKeyedDurableLifecycleStatus(entry));
}

/** Returns whether one store candidate already carries a non-empty claim key. */
function hasClaimKey(entry: StoreDurableInput): boolean {
  return typeof entry.claim_key === "string" && entry.claim_key.trim().length > 0;
}

/** Returns whether one optional metadata value is present and non-empty. */
function hasNonEmptyValue(value?: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Returns whether one keyed row carries the full persisted support bundle. */
function hasCompleteSupportMetadata(entry: StoreDurableInput): boolean {
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

/** Builds compact singleton-alias hints for likely split-family follow-up review. */
function buildSuspiciousSingletonNamespaceHints(candidates: ReturnType<typeof detectClaimKeySingletonAliasCandidates>): string[] {
  return candidates
    .slice(0, 5)
    .map(
      (candidate) =>
        `${candidate.aliasEntityPrefix} -> ${candidate.dominantEntityPrefix} ` +
        `(alias ${candidate.aliasFamilySize}, dominant trusted ${candidate.dominantTrustedCount}${candidate.canonicalReuseSafe ? ", auto-reuse safe" : ""})`,
    );
}
