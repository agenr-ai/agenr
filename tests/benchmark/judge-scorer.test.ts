import { describe, expect, it } from "vitest";
import { scoreJudgeFixture, summarizeJudgeBenchmark } from "../../src/benchmark/judge-scorer.js";
import type { JudgeBenchmarkResult, JudgeFixture } from "../../src/benchmark/judge-scorer.js";

type JudgeExtracted = {
  relation: string;
  confidence: number;
  explanation: string;
};

function makeFixture(overrides: Partial<JudgeFixture> = {}): JudgeFixture {
  return {
    id: "fixture-1",
    newEntry: {
      content: "Alex now weighs 180 lbs.",
      type: "fact",
      subject: "Alex weight",
    },
    existing: {
      content: "Alex weighs 200 lbs.",
      type: "fact",
      subject: "Alex weight",
      createdAt: "2026-01-15T00:00:00Z",
    },
    expected: {
      relation: "supersedes",
      minConfidence: 0.7,
    },
    ...overrides,
  };
}

function makeExtracted(overrides: Partial<JudgeExtracted> = {}): JudgeExtracted {
  return {
    relation: "supersedes",
    confidence: 0.9,
    explanation: "new entry updates prior value",
    ...overrides,
  };
}

function makeResult(overrides: Partial<JudgeBenchmarkResult> = {}): JudgeBenchmarkResult {
  return {
    fixtureId: "fixture-1",
    passed: true,
    relationMatch: 1,
    confidenceOk: 1,
    overall: 1,
    extracted: makeExtracted(),
    expected: {
      relation: "supersedes",
      minConfidence: 0.7,
    },
    ...overrides,
  };
}

describe("judge benchmark scorer", () => {
  it("returns pass when relation matches exactly", () => {
    const result = scoreJudgeFixture(makeFixture(), makeExtracted({ relation: "supersedes" }));
    expect(result.relationMatch).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("returns pass when relation matches altRelation", () => {
    const result = scoreJudgeFixture(
      makeFixture({
        expected: {
          relation: "contradicts",
          altRelation: "supersedes",
          minConfidence: 0.6,
        },
      }),
      makeExtracted({ relation: "supersedes", confidence: 0.8 }),
    );
    expect(result.relationMatch).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("returns fail when relation does not match", () => {
    const result = scoreJudgeFixture(makeFixture(), makeExtracted({ relation: "coexists" }));
    expect(result.relationMatch).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("returns 1.0 confidenceOk when confidence >= minConfidence", () => {
    const result = scoreJudgeFixture(makeFixture(), makeExtracted({ confidence: 0.8 }));
    expect(result.confidenceOk).toBe(1);
  });

  it("returns 0.0 confidenceOk when confidence < minConfidence", () => {
    const result = scoreJudgeFixture(makeFixture(), makeExtracted({ confidence: 0.5 }));
    expect(result.confidenceOk).toBe(0);
  });

  it("overall score is 0.8 * relationMatch + 0.2 * confidenceOk", () => {
    const result = scoreJudgeFixture(
      makeFixture(),
      makeExtracted({
        relation: "coexists",
        confidence: 0.95,
      }),
    );
    expect(result.overall).toBeCloseTo(0.2, 6);
  });

  it("handles null extracted (LLM error) gracefully", () => {
    const result = scoreJudgeFixture(makeFixture(), null, "LLM error");
    expect(result.relationMatch).toBe(0);
    expect(result.confidenceOk).toBe(0);
    expect(result.overall).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.error).toBe("LLM error");
  });

  it("summary computes per-relation accuracy correctly", () => {
    const summary = summarizeJudgeBenchmark(
      "gpt-4.1-nano",
      [
        makeResult({
          fixtureId: "sup-1",
          passed: true,
          expected: { relation: "supersedes", minConfidence: 0.7 },
        }),
        makeResult({
          fixtureId: "sup-2",
          passed: false,
          expected: { relation: "supersedes", minConfidence: 0.7 },
        }),
        makeResult({
          fixtureId: "coex-1",
          passed: true,
          expected: { relation: "coexists", minConfidence: 0.7 },
        }),
        makeResult({
          fixtureId: "unrel-1",
          passed: false,
          expected: { relation: "unrelated", minConfidence: 0.7 },
        }),
        makeResult({
          fixtureId: "contra-1",
          passed: true,
          expected: { relation: "contradicts", minConfidence: 0.6 },
        }),
      ],
      5000,
      0.01,
    );

    expect(summary.supersedesAccuracy).toBeCloseTo(0.5, 6);
    expect(summary.coexistsAccuracy).toBeCloseTo(1, 6);
    expect(summary.unrelatedAccuracy).toBeCloseTo(0, 6);
    expect(summary.contradictsAccuracy).toBeCloseTo(1, 6);
  });

  it("summary computes overall pass rate correctly", () => {
    const summary = summarizeJudgeBenchmark(
      "gpt-4.1-nano",
      [
        makeResult({ fixtureId: "f1", passed: true, overall: 0.9 }),
        makeResult({ fixtureId: "f2", passed: false, overall: 0.2 }),
        makeResult({ fixtureId: "f3", passed: true, overall: 0.8 }),
      ],
      900,
      0.03,
    );

    expect(summary.totalFixtures).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.averageScore).toBeCloseTo((0.9 + 0.2 + 0.8) / 3, 6);
  });
});
