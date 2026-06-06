import { describe, expect, it } from "vitest";

import { applyAsOfValidityFilter } from "../../../src/core/recall/as-of-validity.js";
import type { RecallExecutionTraceSummary } from "../../../src/core/recall/trace.js";
import type { RecallCandidateDurable, RecallMergeOutcome } from "../../../src/core/recall/types.js";

const AS_OF_MS = Date.parse("2026-03-15T12:00:00.000Z");

function buildCandidate(overrides: Partial<RecallCandidateDurable> & Pick<RecallCandidateDurable, "id">): RecallCandidateDurable {
  return {
    subject: "subject",
    content: "content",
    importance: 5,
    expiry: "permanent",
    created_at: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildTraceSummary(): RecallExecutionTraceSummary {
  return {
    filtering: { types: [], tags: [] },
    ranking: { limit: 5, threshold: 0, budget: null },
    candidateCounts: { merged: 0, thresholdQualified: 0, budgetAccepted: 0, finalRanked: 0, returned: 0 },
    claimKey: { historicalBoosted: 0, tentativeLineageSuppressed: 0, trustPenalized: 0, redundancyPenalized: 0 },
    rrf: { applied: false, channelCount: 0, rankConstant: 60, fusedCandidateCount: 0, maxFusedScore: 0 },
    neighborhood: {
      expansionRequested: false,
      expansionAvailable: false,
      familiesRequested: [],
      includeHistorical: false,
      seedIds: [],
      expansionCandidates: 0,
      strongSeedIds: [],
      rerankBoostedIds: [],
    },
    mmr: { applied: false, lambda: 0.7, droppedDuplicateCount: 0, reorderedIds: [] },
    crossEncoder: { applied: false, k: 0, alpha: 0.35, latencyMs: 0, rescoredIds: [] },
    timings: { mergeCandidatesMs: 0, scoreCandidatesMs: 0, thresholdMs: 0, budgetMs: 0, shapeResultsMs: 0 },
    degraded: { active: false, reasons: [], lexicalOnly: false, notices: [] },
  };
}

function buildMergeOutcome(entries: RecallCandidateDurable[]): RecallMergeOutcome {
  const merged = new Map(entries.map((entry) => [entry.id, { entry }]));
  return {
    merged,
    vectorRanks: entries.map((entry) => entry.id),
    ftsRanks: entries.map((entry) => entry.id),
  };
}

describe("applyAsOfValidityFilter", () => {
  it("drops expired and not-yet-valid candidates and prunes rank lists", () => {
    const summary = buildTraceSummary();
    const mergeOutcome = buildMergeOutcome([
      buildCandidate({ id: "current", valid_from: "2026-03-01T00:00:00.000Z", valid_to: "2026-03-31T00:00:00.000Z" }),
      buildCandidate({ id: "expired", valid_to: "2026-03-10T00:00:00.000Z" }),
      buildCandidate({ id: "future", valid_from: "2026-03-20T00:00:00.000Z" }),
    ]);

    applyAsOfValidityFilter(mergeOutcome, summary, {
      asOfDate: new Date(AS_OF_MS),
      nowMs: AS_OF_MS,
    });

    expect(Array.from(mergeOutcome.merged.keys())).toEqual(["current"]);
    expect(mergeOutcome.vectorRanks).toEqual(["current"]);
    expect(mergeOutcome.ftsRanks).toEqual(["current"]);
    expect(summary.filtering.asOfValidity).toEqual({
      applied: true,
      anchor: new Date(AS_OF_MS).toISOString(),
      source: "explicit_as_of",
      excludedCount: 2,
    });
  });

  it("bypasses filtering for the historical-state profile", () => {
    const summary = buildTraceSummary();
    const mergeOutcome = buildMergeOutcome([buildCandidate({ id: "expired", valid_to: "2026-03-10T00:00:00.000Z" })]);

    applyAsOfValidityFilter(mergeOutcome, summary, {
      rankingProfile: "historical_state",
      asOfDate: null,
      nowMs: AS_OF_MS,
    });

    expect(Array.from(mergeOutcome.merged.keys())).toEqual(["expired"]);
    expect(summary.filtering.asOfValidity).toBeUndefined();
  });
});
