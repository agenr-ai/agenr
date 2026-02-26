import { describe, expect, it } from "vitest";
import { scoreClaimFixture } from "../../src/benchmark/claim-scorer.js";
import type { ClaimFixture } from "../../src/benchmark/claim-scorer.js";
import type { ExtractedClaim } from "../../src/db/claim-extraction.js";

function makeFixture(overrides: Partial<ClaimFixture> = {}): ClaimFixture {
  return {
    id: "fixture-1",
    content: "Jim uses pnpm",
    type: "fact",
    subject: "Jim package manager",
    expected: {
      noClaim: false,
      subjectEntity: "jim",
      subjectAttribute: "package_manager",
      predicate: "uses",
      object: "pnpm",
      minConfidence: 0.8,
    },
    ...overrides,
  };
}

function makeClaim(overrides: Partial<ExtractedClaim> = {}): ExtractedClaim {
  return {
    subjectEntity: "jim",
    subjectAttribute: "package_manager",
    subjectKey: "jim/package_manager",
    predicate: "uses",
    object: "pnpm",
    confidence: 0.9,
    ...overrides,
  };
}

describe("claim benchmark scorer", () => {
  it("scores a perfect entity match as 1.0", () => {
    const result = scoreClaimFixture(makeFixture(), makeClaim());
    expect(result.scores.entityMatch).toBe(1);
  });

  it("scores a case-insensitive entity match as 1.0", () => {
    const result = scoreClaimFixture(makeFixture(), makeClaim({ subjectEntity: "JIM" }));
    expect(result.scores.entityMatch).toBe(1);
  });

  it("scores entity mismatch as 0.0", () => {
    const result = scoreClaimFixture(makeFixture(), makeClaim({ subjectEntity: "alex" }));
    expect(result.scores.entityMatch).toBe(0);
  });

  it("scores exact object match as 1.0", () => {
    const result = scoreClaimFixture(makeFixture(), makeClaim({ object: "pnpm" }));
    expect(result.scores.objectMatch).toBe(1);
  });

  it("scores partial object match (contains) as 0.7", () => {
    const result = scoreClaimFixture(
      makeFixture({ expected: { ...makeFixture().expected, object: "185 lbs" } }),
      makeClaim({ object: "Jim weighs 185 lbs" }),
    );
    expect(result.scores.objectMatch).toBe(0.7);
  });

  it("scores no_claim correctly identified as 1.0", () => {
    const result = scoreClaimFixture(
      makeFixture({ expected: { noClaim: true } }),
      null,
    );
    expect(result.scores.noClaimCorrect).toBe(1);
    expect(result.overall).toBe(1);
  });

  it("scores no_claim incorrectly missed as 0.0", () => {
    const result = scoreClaimFixture(
      makeFixture({ expected: { noClaim: true } }),
      makeClaim(),
    );
    expect(result.scores.noClaimCorrect).toBe(0);
    expect(result.overall).toBe(0);
  });

  it("computes overall weighted average correctly", () => {
    const result = scoreClaimFixture(
      makeFixture({ expected: { ...makeFixture().expected, predicate: "prefers", object: "pnpm", minConfidence: 0.8 } }),
      makeClaim({ predicate: "likes", object: "pnpm tooling", confidence: 0.9 }),
    );

    // entity=1 (0.25), attribute=1 (0.25), predicate=0.8 (0.12), object=0.7 (0.175), confidence=1 (0.1)
    expect(result.overall).toBeCloseTo(0.895, 6);
  });

  it("predicate equivalence map works", () => {
    const result = scoreClaimFixture(
      makeFixture({ expected: { ...makeFixture().expected, predicate: "uses" } }),
      makeClaim({ predicate: "uses" }),
    );
    expect(result.scores.predicateMatch).toBe(1);
  });

  it("handles null extraction result gracefully", () => {
    const result = scoreClaimFixture(makeFixture(), null);
    expect(result.overall).toBe(0);
    expect(result.passed).toBe(false);
  });
});
