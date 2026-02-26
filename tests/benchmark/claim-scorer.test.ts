import { describe, expect, it } from "vitest";
import { scoreClaimFixture } from "../../src/benchmark/claim-scorer.js";
import type { ClaimFixture } from "../../src/benchmark/claim-scorer.js";
import type { ExtractedClaim } from "../../src/db/claim-extraction.js";

function makeFixture(overrides: Partial<ClaimFixture> = {}): ClaimFixture {
  return {
    id: "fixture-1",
    content: "Alex uses pnpm",
    type: "fact",
    subject: "Alex package manager",
    expected: {
      noClaim: false,
      subjectEntity: "alex",
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
    subjectEntity: "alex",
    subjectAttribute: "package_manager",
    subjectKey: "alex/package_manager",
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
    const result = scoreClaimFixture(makeFixture(), makeClaim({ subjectEntity: "ALEX" }));
    expect(result.scores.entityMatch).toBe(1);
  });

  it("scores entity mismatch as 0.0", () => {
    const result = scoreClaimFixture(makeFixture(), makeClaim({ subjectEntity: "taylor" }));
    expect(result.scores.entityMatch).toBe(0);
  });

  it("scores entity match as 1.0 when extracted matches altEntity", () => {
    const result = scoreClaimFixture(
      makeFixture({
        expected: {
          ...makeFixture().expected,
          subjectEntity: "buddy",
          altEntity: "alex",
        },
      }),
      makeClaim({ subjectEntity: "alex" }),
    );
    expect(result.scores.entityMatch).toBe(1);
  });

  it("scores entity match as 0.0 when extracted matches neither primary nor altEntity", () => {
    const result = scoreClaimFixture(
      makeFixture({
        expected: {
          ...makeFixture().expected,
          subjectEntity: "buddy",
          altEntity: "alex",
        },
      }),
      makeClaim({ subjectEntity: "sam" }),
    );
    expect(result.scores.entityMatch).toBe(0);
  });

  it("scores attribute match as 1.0 when extracted matches altAttribute", () => {
    const result = scoreClaimFixture(
      makeFixture({
        expected: {
          ...makeFixture().expected,
          subjectAttribute: "breed",
          altAttribute: "pet_breed",
        },
      }),
      makeClaim({ subjectAttribute: "pet_breed" }),
    );
    expect(result.scores.attributeMatch).toBe(1);
  });

  it("scores exact object match as 1.0", () => {
    const result = scoreClaimFixture(makeFixture(), makeClaim({ object: "pnpm" }));
    expect(result.scores.objectMatch).toBe(1);
  });

  it("scores partial object match (contains) as 0.7", () => {
    const result = scoreClaimFixture(
      makeFixture({ expected: { ...makeFixture().expected, object: "180 lbs" } }),
      makeClaim({ object: "Alex weighs 180 lbs" }),
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

  it("passes a fixture using alternate expected values", () => {
    const result = scoreClaimFixture(
      makeFixture({
        expected: {
          noClaim: false,
          subjectEntity: "buddy",
          subjectAttribute: "breed",
          predicate: "is",
          object: "golden retriever",
          minConfidence: 0.7,
          altEntity: "alex",
          altAttribute: "pet_breed",
        },
      }),
      makeClaim({
        subjectEntity: "alex",
        subjectAttribute: "pet_breed",
        subjectKey: "alex/pet_breed",
        predicate: "is",
        object: "golden retriever",
        confidence: 0.9,
      }),
    );
    expect(result.passed).toBe(true);
  });

  it("supports new strong predicate groups", () => {
    const worksAtResult = scoreClaimFixture(
      makeFixture({ expected: { ...makeFixture().expected, predicate: "works_at" } }),
      makeClaim({ predicate: "works_for" }),
    );
    expect(worksAtResult.scores.predicateMatch).toBe(1);

    const followsResult = scoreClaimFixture(
      makeFixture({ expected: { ...makeFixture().expected, predicate: "follows" } }),
      makeClaim({ predicate: "practices" }),
    );
    expect(followsResult.scores.predicateMatch).toBe(1);
  });

  it("supports new soft predicate equivalences", () => {
    const dislikesResult = scoreClaimFixture(
      makeFixture({ expected: { ...makeFixture().expected, predicate: "dislikes" } }),
      makeClaim({ predicate: "avoids" }),
    );
    expect(dislikesResult.scores.predicateMatch).toBe(0.8);
  });

  it("handles null extraction result gracefully", () => {
    const result = scoreClaimFixture(makeFixture(), null);
    expect(result.overall).toBe(0);
    expect(result.passed).toBe(false);
  });
});
