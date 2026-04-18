import { describe, expect, it, vi } from "vitest";

import { applyCrossEncoderRerank, DEFAULT_CROSS_ENCODER_ALPHA, DEFAULT_CROSS_ENCODER_TOP_K } from "../../../src/core/recall/cross-encoder.js";
import type { CrossEncoderPort } from "../../../src/core/ports.js";

interface StubCandidate {
  id: string;
}

describe("applyCrossEncoderRerank", () => {
  it("short-circuits into pass-through when the port is not wired", async () => {
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      port: undefined,
      candidates: makeCandidates([
        { id: "alpha", score: 0.9 },
        { id: "beta", score: 0.5 },
      ]),
    });

    expect(result.applied).toBe(false);
    expect(result.degradedReason).toBe("not_configured");
    expect(result.candidates.map((entry) => (entry.candidate as StubCandidate).id)).toEqual(["alpha", "beta"]);
    expect(result.rescoredIds).toEqual([]);
    expect(result.alpha).toBeCloseTo(DEFAULT_CROSS_ENCODER_ALPHA, 6);
  });

  it("short-circuits when the caller explicitly disables the stage", async () => {
    const port: CrossEncoderPort = { rank: vi.fn() };
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      port,
      disabled: true,
      candidates: makeCandidates([{ id: "alpha", score: 0.9 }]),
    });

    expect(result.applied).toBe(false);
    expect(result.degradedReason).toBe("disabled");
    expect(port.rank).not.toHaveBeenCalled();
  });

  it("skips when the candidate list is empty", async () => {
    const port: CrossEncoderPort = { rank: vi.fn() };
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      port,
      candidates: [],
    });

    expect(result.applied).toBe(false);
    expect(result.degradedReason).toBe("no_candidates");
    expect(port.rank).not.toHaveBeenCalled();
  });

  it("skips when the query text trims to empty", async () => {
    const port: CrossEncoderPort = { rank: vi.fn() };
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "    ",
      port,
      candidates: makeCandidates([{ id: "alpha", score: 0.9 }]),
    });

    expect(result.applied).toBe(false);
    expect(result.degradedReason).toBe("no_candidates");
    expect(port.rank).not.toHaveBeenCalled();
  });

  it("reranks only the top-K shortlist and leaves the tail untouched", async () => {
    const rank = vi.fn(async (_query: string, passages: readonly { id: string; text: string }[]) =>
      passages.map((passage) => ({ id: passage.id, score: passage.id === "beta" ? 0.95 : 0.1 })),
    );
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      topK: 2,
      alpha: 0.5,
      port: { rank },
      candidates: makeCandidates([
        { id: "alpha", score: 0.8 },
        { id: "beta", score: 0.6 },
        { id: "gamma", score: 0.4 },
      ]),
    });

    expect(result.applied).toBe(true);
    expect(result.k).toBe(2);
    expect(result.alpha).toBeCloseTo(0.5, 6);
    expect(rank).toHaveBeenCalledTimes(1);
    expect(rank.mock.calls[0]?.[1].map((passage: { id: string }) => passage.id)).toEqual(["alpha", "beta"]);

    const orderedIds = result.candidates.map((entry) => (entry.candidate as StubCandidate).id);
    // "beta" received the higher cross-encoder score and should outrank "alpha"
    // while "gamma" remains in the tail in its original position.
    expect(orderedIds).toEqual(["beta", "alpha", "gamma"]);
    expect(result.candidates[2]?.score).toBe(0.4);
    expect(result.candidates[2]?.crossEncoderScore).toBeUndefined();
    expect(result.rescoredIds.sort()).toEqual(["alpha", "beta"]);
  });

  it("blends cross-encoder scores with the prior composite using alpha", async () => {
    const rank = vi.fn(async (_query: string, passages: readonly { id: string; text: string }[]) => passages.map((passage) => ({ id: passage.id, score: 1 })));
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      alpha: 0.25,
      port: { rank },
      candidates: makeCandidates([
        { id: "alpha", score: 0.2 },
        { id: "beta", score: 0.4 },
      ]),
    });

    expect(result.applied).toBe(true);
    // alpha * 1 + (1 - alpha) * prior
    expect(result.candidates[0]?.score).toBeCloseTo(0.25 * 1 + 0.75 * 0.4, 6);
    expect(result.candidates[1]?.score).toBeCloseTo(0.25 * 1 + 0.75 * 0.2, 6);
  });

  it("fails closed when the port throws and retains input order", async () => {
    const rank = vi.fn(async () => {
      throw new Error("rate limit");
    });
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      port: { rank },
      candidates: makeCandidates([
        { id: "alpha", score: 0.7 },
        { id: "beta", score: 0.6 },
      ]),
    });

    expect(result.applied).toBe(false);
    expect(result.degradedReason).toBe("provider_error");
    expect(result.candidates.map((entry) => (entry.candidate as StubCandidate).id)).toEqual(["alpha", "beta"]);
    expect(result.candidates.every((entry) => entry.crossEncoderScore === undefined)).toBe(true);
  });

  it("fails closed when the port returns a non-array payload", async () => {
    const rank = vi.fn(async () => null as unknown as { id: string; score: number }[]);
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      port: { rank },
      candidates: makeCandidates([{ id: "alpha", score: 0.5 }]),
    });

    expect(result.applied).toBe(false);
    expect(result.degradedReason).toBe("provider_error");
  });

  it("fails closed when every score payload is malformed", async () => {
    const rank = vi.fn(async () => [
      { id: 42 as unknown as string, score: 0.5 },
      { id: "alpha", score: Number.POSITIVE_INFINITY },
    ]);
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      port: { rank },
      candidates: makeCandidates([{ id: "alpha", score: 0.5 }]),
    });

    expect(result.applied).toBe(false);
    expect(result.degradedReason).toBe("provider_error");
  });

  it("skips missing score entries but keeps the rest of the shortlist reranked", async () => {
    const rank = vi.fn(async (_query: string, passages: readonly { id: string; text: string }[]) =>
      passages.filter((passage) => passage.id !== "beta").map((passage) => ({ id: passage.id, score: passage.id === "alpha" ? 0.95 : 0.3 })),
    );
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      alpha: 1,
      port: { rank },
      candidates: makeCandidates([
        { id: "alpha", score: 0.1 },
        { id: "beta", score: 0.8 },
        { id: "gamma", score: 0.2 },
      ]),
    });

    expect(result.applied).toBe(true);
    const orderedIds = result.candidates.map((entry) => (entry.candidate as StubCandidate).id);
    expect(orderedIds[0]).toBe("alpha");
    expect(orderedIds).toContain("beta");
    expect(orderedIds).toContain("gamma");
    const beta = result.candidates.find((entry) => (entry.candidate as StubCandidate).id === "beta");
    expect(beta?.crossEncoderScore).toBeUndefined();
    expect(beta?.score).toBe(0.8);
    expect(result.rescoredIds).toContain("alpha");
    expect(result.rescoredIds).toContain("gamma");
    expect(result.rescoredIds).not.toContain("beta");
  });

  it("clamps provider scores outside the unit interval", async () => {
    const rank = vi.fn(async () => [
      { id: "alpha", score: 5 },
      { id: "beta", score: -3 },
    ]);
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      alpha: 1,
      port: { rank },
      candidates: makeCandidates([
        { id: "alpha", score: 0 },
        { id: "beta", score: 0 },
      ]),
    });

    expect(result.applied).toBe(true);
    const scoreById = new Map(result.candidates.map((entry) => [(entry.candidate as StubCandidate).id, entry.score]));
    expect(scoreById.get("alpha")).toBe(1);
    expect(scoreById.get("beta")).toBe(0);
  });

  it("clamps alpha into the unit interval", async () => {
    const rank = vi.fn(async () => [{ id: "alpha", score: 0.5 }]);
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      alpha: 5,
      port: { rank },
      candidates: makeCandidates([{ id: "alpha", score: 0.2 }]),
    });

    expect(result.alpha).toBe(1);
    expect(result.candidates[0]?.score).toBeCloseTo(0.5, 6);
  });

  it("honors the default top-K when no override is provided", async () => {
    const rank = vi.fn(async (_query: string, passages: readonly { id: string; text: string }[]) =>
      passages.map((passage) => ({ id: passage.id, score: 0.5 })),
    );
    const candidates = makeCandidates(
      Array.from({ length: DEFAULT_CROSS_ENCODER_TOP_K + 5 }, (_value, index) => ({
        id: `id-${index}`,
        score: 0.9 - index * 0.01,
      })),
    );
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      port: { rank },
      candidates,
    });

    expect(result.applied).toBe(true);
    expect(result.k).toBe(DEFAULT_CROSS_ENCODER_TOP_K);
    expect(rank.mock.calls[0]?.[1]).toHaveLength(DEFAULT_CROSS_ENCODER_TOP_K);
  });

  it("breaks score ties using the caller's input order", async () => {
    const rank = vi.fn(async (_query: string, passages: readonly { id: string; text: string }[]) =>
      passages.map((passage) => ({ id: passage.id, score: 0.5 })),
    );
    const result = await applyCrossEncoderRerank<StubCandidate>({
      query: "question",
      alpha: 1,
      port: { rank },
      candidates: makeCandidates([
        { id: "alpha", score: 0.3 },
        { id: "beta", score: 0.4 },
        { id: "gamma", score: 0.7 },
      ]),
    });

    expect(result.applied).toBe(true);
    expect(result.candidates.map((entry) => (entry.candidate as StubCandidate).id)).toEqual(["alpha", "beta", "gamma"]);
  });
});

/** Builds test candidates wired to a minimal stub payload shape. */
function makeCandidates(rows: Array<{ id: string; score: number }>): Array<{
  id: string;
  text: string;
  score: number;
  candidate: StubCandidate;
}> {
  return rows.map((row) => ({
    id: row.id,
    text: `passage for ${row.id}`,
    score: row.score,
    candidate: { id: row.id },
  }));
}
