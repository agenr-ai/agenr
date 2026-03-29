import { describe, expect, it } from "vitest";

import { createPaginatedQueryTracker, createSurgeonCompletionGuardState } from "../../../src/app/surgeon/completion-guard.js";

describe("createPaginatedQueryTracker", () => {
  it("tracks pagination progress across multiple pages", () => {
    const tracker = createPaginatedQueryTracker();

    tracker.recordPage({
      offset: 0,
      returnedCount: 20,
      totalCount: 55,
      exhausted: false,
    });
    tracker.recordPage({
      offset: 20,
      returnedCount: 15,
      exhausted: true,
    });

    expect(tracker.snapshot()).toEqual({
      queryCalls: 2,
      maxWindowEnd: 35,
      totalCount: 55,
      sawExhaustedPage: true,
    });
  });

  it("resets pagination progress back to the initial empty state", () => {
    const tracker = createPaginatedQueryTracker();

    tracker.recordPage({
      offset: 10,
      returnedCount: 5,
      totalCount: 10,
      exhausted: true,
    });
    tracker.reset();

    expect(tracker.snapshot()).toEqual({
      queryCalls: 0,
      maxWindowEnd: 0,
      totalCount: null,
      sawExhaustedPage: false,
    });
  });
});

describe("createSurgeonCompletionGuardState", () => {
  it("initializes retirement-only guard state with normalized counts", () => {
    const state = createSurgeonCompletionGuardState({
      totalEntries: 123.8,
      retirementCandidates: -9,
    });

    state.rejectionCounts.set("already-reviewed", 2);

    expect(state.initialHealth).toEqual({
      totalEntries: 123,
      retirementCandidates: 0,
    });
    expect(state.rejectionCounts.get("already-reviewed")).toBe(2);
    expect(state.retirement.snapshot()).toEqual({
      queryCalls: 0,
      maxWindowEnd: 0,
      totalCount: null,
      sawExhaustedPage: false,
    });
  });
});
