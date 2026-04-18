import { describe, expect, it } from "vitest";

import { gaussianRecency, importanceScore, recencyScore, scoreCandidate } from "../../../src/core/recall/scoring.js";

const NOW = new Date("2026-03-26T00:00:00.000Z");

describe("recencyScore", () => {
  it("returns 1.0 for core entries regardless of age", () => {
    expect(recencyScore("2010-01-01T00:00:00.000Z", "core", NOW)).toBe(1);
  });

  it("returns about 0.5 for permanent entries that are 365 days old", () => {
    expect(recencyScore("2025-03-26T00:00:00.000Z", "permanent", NOW)).toBeCloseTo(0.5, 6);
  });

  it("returns about 0.5 for temporary entries that are 30 days old", () => {
    expect(recencyScore("2026-02-24T00:00:00.000Z", "temporary", NOW)).toBeCloseTo(0.5, 6);
  });

  it("returns 1.0 for new entries across all tiers", () => {
    expect(recencyScore(NOW, "core", NOW)).toBe(1);
    expect(recencyScore(NOW, "permanent", NOW)).toBe(1);
    expect(recencyScore(NOW, "temporary", NOW)).toBe(1);
  });

  it("returns near zero for very old temporary entries", () => {
    expect(recencyScore("2025-05-30T00:00:00.000Z", "temporary", NOW)).toBeLessThan(0.001);
  });
});

describe("gaussianRecency", () => {
  it("returns 1.0 for entries on the around date", () => {
    expect(gaussianRecency("2026-03-26T00:00:00.000Z", NOW, 14)).toBe(1);
  });

  it("returns about 0.6065 for entries 14 days away with radius 14", () => {
    expect(gaussianRecency("2026-03-12T00:00:00.000Z", NOW, 14)).toBeCloseTo(0.6065, 4);
  });

  it("returns about 0.1353 for entries 28 days away with radius 14", () => {
    expect(gaussianRecency("2026-02-26T00:00:00.000Z", NOW, 14)).toBeCloseTo(0.1353, 4);
  });
});

describe("importanceScore", () => {
  it("maps importance 1 to 0.4", () => {
    expect(importanceScore(1)).toBeCloseTo(0.4, 6);
  });

  it("maps importance 10 to 1.0", () => {
    expect(importanceScore(10)).toBe(1);
  });

  it("maps importance 5 to about 0.667", () => {
    expect(importanceScore(5)).toBeCloseTo(2 / 3, 3);
  });

  it("clamps values outside the supported range", () => {
    expect(importanceScore(-1)).toBeCloseTo(0.4, 6);
    expect(importanceScore(99)).toBe(1);
  });
});

describe("scoreCandidate", () => {
  it("applies the configured weights to the fused relevance signal", () => {
    const result = scoreCandidate({
      relevance: 0.68,
      vectorSim: 0.8,
      lexical: 0.5,
      recency: 0.6,
      importance: 0.7,
    });

    expect(result.score).toBeCloseTo(0.665, 6);
  });

  it("returns zero when all signals are zero", () => {
    expect(
      scoreCandidate({
        relevance: 0,
        vectorSim: 0,
        lexical: 0,
        recency: 0,
        importance: 0,
      }).score,
    ).toBe(0);
  });

  it("returns 1.0 when all signals are 1", () => {
    expect(
      scoreCandidate({
        relevance: 1,
        vectorSim: 1,
        lexical: 1,
        recency: 1,
        importance: 1,
      }).score,
    ).toBe(1);
  });

  it("returns a full signal breakdown", () => {
    const result = scoreCandidate({
      relevance: 0.5,
      vectorSim: 0.6,
      lexical: 0.4,
      recency: 0.8,
      importance: 0.7,
    });

    expect(result).toEqual({
      score: expect.any(Number),
      scores: {
        relevance: expect.any(Number),
        vector: expect.any(Number),
        lexical: expect.any(Number),
        recency: expect.any(Number),
        importance: expect.any(Number),
      },
    });
  });

  it("preserves raw vector and lexical evidence on the breakdown", () => {
    const result = scoreCandidate({
      relevance: 0.5,
      vectorSim: 0.6,
      lexical: 0.4,
      recency: 0.8,
      importance: 0.7,
    });

    expect(result.scores.vector).toBeCloseTo(0.6, 6);
    expect(result.scores.lexical).toBeCloseTo(0.4, 6);
    expect(result.scores.relevance).toBeCloseTo(0.5, 6);
  });

  it("moves the final score by about 0.0167 for a one-step importance demotion", () => {
    const higher = scoreCandidate({
      relevance: 0.68,
      vectorSim: 0.8,
      lexical: 0.5,
      recency: 0.6,
      importance: importanceScore(5),
    }).score;
    const lower = scoreCandidate({
      relevance: 0.68,
      vectorSim: 0.8,
      lexical: 0.5,
      recency: 0.6,
      importance: importanceScore(4),
    }).score;

    expect(higher - lower).toBeCloseTo(1 / 60, 6);
  });

  it("treats NaN inputs as zero and clamps negative scores to zero", () => {
    expect(
      scoreCandidate({
        relevance: Number.NaN,
        vectorSim: Number.NaN,
        lexical: -1,
        recency: Number.NaN,
        importance: -2,
      }),
    ).toEqual({
      score: 0,
      scores: {
        relevance: 0,
        vector: 0,
        lexical: 0,
        recency: 0,
        importance: 0,
      },
    });
  });
});
