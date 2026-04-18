import { describe, expect, it } from "vitest";

import { DEFAULT_RRF_RANK_CONSTANT, rrfFuse, rrfFuseVectorLexical } from "../../../src/core/recall/fusion.js";

describe("rrfFuse", () => {
  it("returns an empty map when every channel is empty", () => {
    expect(rrfFuse([[], []])).toEqual(new Map());
  });

  it("ignores empty channels when computing the normalization denominator", () => {
    const oneChannel = rrfFuse([["alpha", "beta"]]);
    const paddedChannels = rrfFuse([["alpha", "beta"], [], []]);

    expect(paddedChannels).toEqual(oneChannel);
  });

  it("gives rank-0 entries in a single channel the maximum normalized score", () => {
    const scores = rrfFuse([["alpha", "beta", "gamma"]]);

    expect(scores.get("alpha")).toBe(1);
    expect(scores.get("beta")).toBeCloseTo(DEFAULT_RRF_RANK_CONSTANT / (DEFAULT_RRF_RANK_CONSTANT + 1), 6);
    expect(scores.get("gamma")).toBeCloseTo(DEFAULT_RRF_RANK_CONSTANT / (DEFAULT_RRF_RANK_CONSTANT + 2), 6);
  });

  it("awards 1.0 only to entries that are top-ranked in every channel", () => {
    const scores = rrfFuse([
      ["alpha", "beta"],
      ["alpha", "gamma"],
    ]);

    expect(scores.get("alpha")).toBe(1);
    expect(scores.get("beta")).toBeLessThan(1);
    expect(scores.get("gamma")).toBeLessThan(1);
  });

  it("breaks ties deterministically between symmetric channel positions", () => {
    const scores = rrfFuse([
      ["alpha", "beta"],
      ["beta", "alpha"],
    ]);

    expect(scores.get("alpha")).toBeCloseTo(scores.get("beta") ?? 0, 6);
  });

  it("places the unanimous top candidate first and ties identifiers with symmetric ranks", () => {
    const scores = rrfFuse([
      ["alpha", "gamma", "beta"],
      ["alpha", "beta", "gamma"],
    ]);

    expect(scores.get("alpha")).toBeGreaterThan(scores.get("beta") ?? 0);
    expect(scores.get("alpha")).toBeGreaterThan(scores.get("gamma") ?? 0);
    expect(scores.get("beta")).toBeCloseTo(scores.get("gamma") ?? 0, 6);
  });

  it("deduplicates repeated ids inside a single channel", () => {
    const scoresWithDuplicate = rrfFuse([["alpha", "alpha", "beta"]]);
    const scoresWithoutDuplicate = rrfFuse([["alpha", "beta"]]);

    expect(scoresWithDuplicate.get("alpha")).toBe(scoresWithoutDuplicate.get("alpha"));
    expect(scoresWithDuplicate.get("beta")).toBe(scoresWithoutDuplicate.get("beta"));
  });

  it("treats a non-finite rank constant as the documented default", () => {
    const defaulted = rrfFuse([["alpha", "beta"]], Number.NaN);
    const expected = rrfFuse([["alpha", "beta"]]);

    expect(defaulted).toEqual(expected);
  });

  it("accepts a custom positive rank constant", () => {
    const customK = rrfFuse([["alpha", "beta"]], 10);

    expect(customK.get("alpha")).toBe(1);
    expect(customK.get("beta")).toBeCloseTo(10 / 11, 6);
  });

  it("keeps all scores inside the inclusive 0-1 range", () => {
    const scores = rrfFuse([
      ["alpha", "beta"],
      ["alpha", "gamma"],
      ["alpha", "delta"],
    ]);

    for (const score of scores.values()) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe("rrfFuseVectorLexical", () => {
  it("fuses a vector and lexical rank list into a single score map", () => {
    const scores = rrfFuseVectorLexical(["alpha", "beta"], ["beta", "alpha"]);

    expect(scores.size).toBe(2);
    expect(scores.get("alpha")).toBeGreaterThan(0);
    expect(scores.get("beta")).toBeGreaterThan(0);
  });

  it("returns an empty map when both channels are empty", () => {
    expect(rrfFuseVectorLexical([], [])).toEqual(new Map());
  });
});
