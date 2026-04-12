import { describe, expect, it } from "vitest";

import { createPaginatedQueryTracker, createSupersessionReviewTracker, createSurgeonCompletionGuardState } from "../../../src/app/surgeon/completion-guard.js";

describe("createPaginatedQueryTracker", () => {
  it("tracks pagination progress across multiple pages", () => {
    const tracker = createPaginatedQueryTracker();

    tracker.recordPage({
      scope: "actionable",
      offset: 0,
      returnedCount: 20,
      totalCount: 55,
      exhausted: false,
    });
    tracker.recordPage({
      scope: "actionable",
      offset: 20,
      returnedCount: 15,
      exhausted: true,
    });

    expect(tracker.snapshot()).toEqual({
      queryCalls: 2,
      actionable: {
        maxWindowEnd: 35,
        totalCount: 55,
        sawExhaustedPage: true,
      },
      all: {
        maxWindowEnd: 0,
        totalCount: null,
        sawExhaustedPage: false,
      },
    });
  });

  it("resets pagination progress back to the initial empty state", () => {
    const tracker = createPaginatedQueryTracker();

    tracker.recordPage({
      scope: "actionable",
      offset: 10,
      returnedCount: 5,
      totalCount: 10,
      exhausted: true,
    });
    tracker.reset();

    expect(tracker.snapshot()).toEqual({
      queryCalls: 0,
      actionable: {
        maxWindowEnd: 0,
        totalCount: null,
        sawExhaustedPage: false,
      },
      all: {
        maxWindowEnd: 0,
        totalCount: null,
        sawExhaustedPage: false,
      },
    });
  });
});

describe("createSurgeonCompletionGuardState", () => {
  it("initializes pass-aware guard state with normalized counts", () => {
    const state = createSurgeonCompletionGuardState({
      totalEntries: 123.8,
      retirementCandidates: -9,
      retirementAvailableActionableCandidates: -9,
      retirementAvailableAllCandidates: -3,
      supersessionClaimKeyClusters: 4.7,
      supersessionSubjectClusters: -3,
    });

    state.rejectionCounts.set("already-reviewed", 2);

    expect(state.initialHealth).toEqual({
      totalEntries: 123,
      retirementCandidates: 0,
      retirementAvailableActionableCandidates: 0,
      retirementAvailableAllCandidates: 0,
      supersessionClaimKeyClusters: 4,
      supersessionSubjectClusters: 0,
    });
    expect(state.rejectionCounts.get("already-reviewed")).toBe(2);
    expect(state.retirement.snapshot()).toEqual({
      queryCalls: 0,
      actionable: {
        maxWindowEnd: 0,
        totalCount: null,
        sawExhaustedPage: false,
      },
      all: {
        maxWindowEnd: 0,
        totalCount: null,
        sawExhaustedPage: false,
      },
    });
    expect(state.supersession.snapshot()).toEqual({
      claimKeyClustersViewed: 0,
      claimKeyClustersTotal: 4,
      claimKeyClustersAdjudicated: 0,
      claimKeyScopeExhausted: false,
      subjectClustersViewed: 0,
      subjectClustersTotal: 0,
      subjectClustersAdjudicated: 0,
      subjectScopeExhausted: true,
      adjudicatedClusters: 0,
      widenedBeforeClaimKeyExhausted: false,
    });
  });
});

describe("createSupersessionReviewTracker", () => {
  it("tracks viewed and adjudicated claim_key and subject clusters separately", () => {
    const tracker = createSupersessionReviewTracker({
      claimKeyTotal: 2,
      subjectTotal: 1,
    });

    tracker.recordPage({
      scope: "claim_key",
      claimKeyTotal: 2,
      subjectTotal: 1,
      clusters: [
        {
          groupKey: "jim/home_city",
          groupedBy: "claim_key",
          entries: [{ id: "entry-a" }, { id: "entry-b" }] as never,
        },
      ],
    });
    tracker.markAdjudicated(["entry-a"]);
    tracker.recordPage({
      scope: "subject",
      claimKeyTotal: 2,
      subjectTotal: 1,
      clusters: [
        {
          groupKey: "shared subject::fact",
          groupedBy: "subject",
          entries: [{ id: "entry-c" }, { id: "entry-d" }] as never,
        },
      ],
    });

    expect(tracker.snapshot()).toEqual({
      claimKeyClustersViewed: 1,
      claimKeyClustersTotal: 2,
      claimKeyClustersAdjudicated: 1,
      claimKeyScopeExhausted: false,
      subjectClustersViewed: 1,
      subjectClustersTotal: 1,
      subjectClustersAdjudicated: 0,
      subjectScopeExhausted: true,
      adjudicatedClusters: 1,
      widenedBeforeClaimKeyExhausted: true,
    });
  });
});
