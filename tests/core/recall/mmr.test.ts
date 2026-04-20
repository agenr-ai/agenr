import { describe, expect, it } from "vitest";

import { DEFAULT_MMR_LAMBDA, DEFAULT_MMR_MIN_POOL_SIZE, maximalMarginalRelevance, NEAR_DUPLICATE_SIMILARITY } from "../../../src/core/recall/mmr.js";

const QUERY = unitVector([1, 0, 0]);

// Every algorithm-level MMR test below uses small synthetic pools. The
// phase-4 small-pool gate would otherwise short-circuit them, so we
// disable the gate globally here and exercise it in its own `describe`
// block below.
const NO_POOL_GATE = 0;

describe("maximalMarginalRelevance", () => {
  it("returns input order untouched when no candidates have embeddings", () => {
    const result = maximalMarginalRelevance({
      queryVector: QUERY,
      candidates: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }],
    });

    expect(result.applied).toBe(false);
    expect(result.orderedIds).toEqual(["alpha", "beta", "gamma"]);
    expect(result.reorderedIds).toEqual([]);
    expect(result.droppedDuplicateCount).toBe(0);
    expect(result.lambda).toBeCloseTo(DEFAULT_MMR_LAMBDA, 6);
  });

  it("returns input order untouched when the query vector is empty", () => {
    const result = maximalMarginalRelevance({
      queryVector: [],
      candidates: [
        { id: "alpha", embedding: unitVector([1, 0, 0]) },
        { id: "beta", embedding: unitVector([0, 1, 0]) },
      ],
    });

    expect(result.applied).toBe(false);
    expect(result.orderedIds).toEqual(["alpha", "beta"]);
  });

  it("preserves order when only one candidate has an embedding", () => {
    const result = maximalMarginalRelevance({
      queryVector: QUERY,
      candidates: [{ id: "alpha", embedding: unitVector([1, 0, 0]) }, { id: "beta" }, { id: "gamma" }],
    });

    expect(result.applied).toBe(false);
    expect(result.orderedIds).toEqual(["alpha", "beta", "gamma"]);
  });

  it("demotes near-duplicate candidates under a low lambda", () => {
    const result = maximalMarginalRelevance({
      queryVector: QUERY,
      lambda: 0.1,
      minPoolSize: NO_POOL_GATE,
      candidates: [
        { id: "primary", embedding: unitVector([1, 0, 0]) },
        { id: "duplicate", embedding: unitVector([1, 0, 0]) },
        { id: "diverse", embedding: unitVector([0, 1, 0]) },
      ],
    });

    expect(result.applied).toBe(true);
    expect(result.orderedIds[0]).toBe("diverse");
    expect(result.orderedIds).toContain("primary");
    expect(result.orderedIds).toContain("duplicate");
    // With low lambda and a perfectly orthogonal alternative, the diversity
    // penalty dominates and the orthogonal candidate takes the lead.
    expect(result.reorderedIds.length).toBeGreaterThan(0);
    // Both near-duplicates share pairwise similarity 1.0 and both slid
    // down relative to their input position, so both count as dropped.
    expect(result.droppedDuplicateCount).toBe(2);
  });

  it("preserves relevance-driven order under a very high lambda", () => {
    const result = maximalMarginalRelevance({
      queryVector: QUERY,
      lambda: 1,
      minPoolSize: NO_POOL_GATE,
      candidates: [
        { id: "high", embedding: unitVector([1, 0, 0]) },
        { id: "medium", embedding: unitVector([0.9, 0.436, 0]) },
        { id: "low", embedding: unitVector([0.5, 0.866, 0]) },
      ],
    });

    expect(result.applied).toBe(true);
    expect(result.orderedIds).toEqual(["high", "medium", "low"]);
    expect(result.droppedDuplicateCount).toBe(0);
  });

  it("respects caller-provided relevance overrides when shaping already ran", () => {
    // "boosted" has a lower raw cosine to the query but a higher caller
    // relevance, simulating historical lineage or claim-key shaping
    // deciding the canonical order ahead of MMR.
    const result = maximalMarginalRelevance({
      queryVector: QUERY,
      lambda: 1,
      minPoolSize: NO_POOL_GATE,
      candidates: [
        { id: "raw-leader", embedding: unitVector([1, 0, 0]), relevance: 0.4 },
        { id: "boosted", embedding: unitVector([0.5, 0.866, 0]), relevance: 0.9 },
      ],
    });

    expect(result.applied).toBe(true);
    expect(result.orderedIds[0]).toBe("boosted");
    expect(result.orderedIds[1]).toBe("raw-leader");
  });

  it("appends candidates without embeddings after the embedded candidates", () => {
    const result = maximalMarginalRelevance({
      queryVector: QUERY,
      minPoolSize: NO_POOL_GATE,
      candidates: [
        { id: "no-embed-1" },
        { id: "embedded-1", embedding: unitVector([1, 0, 0]) },
        { id: "no-embed-2" },
        { id: "embedded-2", embedding: unitVector([0, 1, 0]) },
      ],
    });

    expect(result.applied).toBe(true);
    expect(result.orderedIds).toHaveLength(4);
    expect(result.orderedIds.slice(0, 2).sort()).toEqual(["embedded-1", "embedded-2"]);
    expect(result.orderedIds.slice(2)).toEqual(["no-embed-1", "no-embed-2"]);
  });

  it("applies the optional limit after ordering", () => {
    const result = maximalMarginalRelevance({
      queryVector: QUERY,
      limit: 2,
      minPoolSize: NO_POOL_GATE,
      candidates: [
        { id: "alpha", embedding: unitVector([1, 0, 0]) },
        { id: "beta", embedding: unitVector([0, 1, 0]) },
        { id: "gamma", embedding: unitVector([0, 0, 1]) },
      ],
    });

    expect(result.applied).toBe(true);
    expect(result.orderedIds).toHaveLength(2);
  });

  it("clamps out-of-range lambda values back into 0-1", () => {
    const tooLow = maximalMarginalRelevance({
      queryVector: QUERY,
      lambda: -1,
      candidates: [
        { id: "alpha", embedding: unitVector([1, 0, 0]) },
        { id: "beta", embedding: unitVector([0, 1, 0]) },
      ],
    });
    const tooHigh = maximalMarginalRelevance({
      queryVector: QUERY,
      lambda: 5,
      candidates: [
        { id: "alpha", embedding: unitVector([1, 0, 0]) },
        { id: "beta", embedding: unitVector([0, 1, 0]) },
      ],
    });

    expect(tooLow.lambda).toBe(0);
    expect(tooHigh.lambda).toBe(1);
  });

  it("is deterministic for tied MMR scores", () => {
    const candidates = [
      { id: "alpha", embedding: unitVector([1, 0, 0]) },
      { id: "beta", embedding: unitVector([1, 0, 0]) },
    ];

    const first = maximalMarginalRelevance({ queryVector: QUERY, candidates });
    const second = maximalMarginalRelevance({ queryVector: QUERY, candidates });

    expect(first.orderedIds).toEqual(second.orderedIds);
  });

  it("keeps the near-duplicate similarity threshold importable for trace tests", () => {
    expect(NEAR_DUPLICATE_SIMILARITY).toBeGreaterThan(0.9);
    expect(NEAR_DUPLICATE_SIMILARITY).toBeLessThanOrEqual(1);
  });
});

describe("maximalMarginalRelevance small-pool gate", () => {
  it("skips MMR when the candidate pool is at or below the default gate", () => {
    const candidates = [
      { id: "leader", embedding: unitVector([1, 0, 0]) },
      { id: "peer", embedding: unitVector([0, 1, 0]) },
    ];

    const result = maximalMarginalRelevance({
      queryVector: QUERY,
      lambda: 0.1,
      candidates,
    });

    expect(result.applied).toBe(false);
    expect(result.orderedIds).toEqual(["leader", "peer"]);
    expect(result.reorderedIds).toEqual([]);
    expect(DEFAULT_MMR_MIN_POOL_SIZE).toBeGreaterThanOrEqual(candidates.length);
  });

  it("runs MMR once the pool is strictly larger than the default gate", () => {
    const candidates = [
      { id: "leader", embedding: unitVector([1, 0, 0]) },
      { id: "near", embedding: unitVector([1, 0, 0]) },
      { id: "mid", embedding: unitVector([0.9, 0.436, 0]) },
      { id: "edge", embedding: unitVector([0.5, 0.866, 0]) },
      { id: "orth", embedding: unitVector([0, 1, 0]) },
    ];

    const result = maximalMarginalRelevance({
      queryVector: QUERY,
      lambda: 0.1,
      candidates,
    });

    expect(result.applied).toBe(true);
  });

  it("honors an explicit minPoolSize override that re-enables MMR on tiny pools", () => {
    const result = maximalMarginalRelevance({
      queryVector: QUERY,
      lambda: 0.1,
      minPoolSize: 0,
      candidates: [
        { id: "leader", embedding: unitVector([1, 0, 0]) },
        { id: "peer", embedding: unitVector([0, 1, 0]) },
      ],
    });

    expect(result.applied).toBe(true);
  });

  it("treats a negative minPoolSize override as a request for the default gate", () => {
    const result = maximalMarginalRelevance({
      queryVector: QUERY,
      lambda: 0.1,
      minPoolSize: -5,
      candidates: [
        { id: "leader", embedding: unitVector([1, 0, 0]) },
        { id: "peer", embedding: unitVector([0, 1, 0]) },
      ],
    });

    expect(result.applied).toBe(false);
  });
});

/** Normalize a 3-vector to unit length to keep cosine similarity in 0-1. */
function unitVector(values: [number, number, number]): number[] {
  const [x, y, z] = values;
  const norm = Math.sqrt(x * x + y * y + z * z);
  if (norm === 0) {
    return [0, 0, 0];
  }
  return [x / norm, y / norm, z / norm];
}
