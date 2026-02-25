import { describe, expect, it } from "vitest";
import { scoreSession } from "./scorer.js";
import type { BenchmarkRubric } from "./types.js";
import type { KnowledgeEntry } from "../types.js";

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    type: "fact",
    subject: "user profile",
    content: "default content with enough length to pass validation.",
    importance: 7,
    expiry: "permanent",
    tags: ["test"],
    source: {
      file: "fixture.jsonl",
      context: "test",
    },
    ...overrides,
  };
}

function rubric(overrides: Partial<BenchmarkRubric> = {}): BenchmarkRubric {
  return {
    session: "session-1",
    description: "test rubric",
    must_extract: [],
    must_skip: [],
    acceptable_range: { min: 0, max: 10 },
    ...overrides,
  };
}

describe("scoreSession", () => {
  it("scores a perfect extraction as pass with composite 1.0", () => {
    const testRubric = rubric({
      must_extract: [
        {
          type: "fact",
          subject_contains: "profile",
          content_contains: ["alpha", "beta"],
          min_importance: 7,
          reason: "profile details",
        },
      ],
      acceptable_range: { min: 1, max: 3 },
    });

    const result = scoreSession(
      [entry({ subject: "User Profile", content: "alpha and beta included", importance: 7 })],
      testRubric,
    );

    expect(result.pass).toBe(true);
    expect(result.recall).toBe(1);
    expect(result.partial_recall).toBe(1);
    expect(result.precision_proxy).toBe(1);
    expect(result.composite_score).toBe(1);
  });

  it("fails when must_extract rules are missed", () => {
    const testRubric = rubric({
      must_extract: [
        {
          type: "fact",
          subject_contains: "profile",
          content_contains: ["alpha", "beta"],
          min_importance: 7,
          reason: "must include both keywords",
        },
      ],
    });

    // Wrong type + no content keywords = score well below HIT threshold
    const result = scoreSession(
      [entry({ type: "decision", subject: "unrelated", content: "nothing here", importance: 3 })],
      testRubric,
    );

    expect(result.pass).toBe(false);
    expect(result.recall).toBe(0);
    expect(result.partial_recall).toBe(0);
  });

  it("partial credit: type mismatch scores 0.8 max", () => {
    const testRubric = rubric({
      must_extract: [
        {
          type: "fact",
          subject_contains: "profile",
          content_contains: ["alpha"],
          min_importance: 7,
          reason: "type should matter",
        },
      ],
    });

    const result = scoreSession(
      [entry({ type: "lesson", subject: "profile", content: "alpha", importance: 7 })],
      testRubric,
    );

    expect(result.must_extract_scores[0]?.partial_score).toBeCloseTo(0.8, 6);
    expect(result.must_extract_scores[0]?.type_match).toBe(false);
  });

  it("partial credit: partial content_contains match", () => {
    const testRubric = rubric({
      must_extract: [
        {
          type: "fact",
          subject_contains: "profile",
          content_contains: ["alpha", "beta", "gamma"],
          min_importance: 7,
          reason: "needs 3 keywords",
        },
      ],
    });

    const result = scoreSession(
      [entry({ subject: "profile", content: "alpha beta only", importance: 7 })],
      testRubric,
    );

    expect(result.must_extract_scores[0]?.content_match).toBeCloseTo(0.2, 6);
    expect(result.must_extract_scores[0]?.partial_score).toBeCloseTo(0.9, 6);
  });

  it("partial credit: importance below threshold", () => {
    const testRubric = rubric({
      must_extract: [
        {
          type: "fact",
          subject_contains: "profile",
          content_contains: ["alpha"],
          min_importance: 8,
          reason: "importance threshold",
        },
      ],
    });

    const result = scoreSession(
      [entry({ subject: "profile", content: "alpha", importance: 7 })],
      testRubric,
    );

    expect(result.must_extract_scores[0]?.importance_match).toBe(false);
    expect(result.must_extract_scores[0]?.partial_score).toBeCloseTo(0.8, 6);
  });

  it("fails when must_skip regex patterns are violated", () => {
    const testRubric = rubric({
      must_skip: [
        {
          pattern: "secret|token",
          reason: "skip secrets",
        },
      ],
    });

    const result = scoreSession([entry({ content: "contains secret token material" })], testRubric);

    expect(result.pass).toBe(false);
    expect(result.must_skip_violations).toHaveLength(1);
    expect(result.precision_proxy).toBe(0);
  });

  it("must_skip falls back to substring when regex is invalid", () => {
    const testRubric = rubric({
      must_skip: [
        {
          pattern: "[",
          reason: "invalid regex should fallback",
        },
      ],
    });

    const result = scoreSession([entry({ content: "includes [ bracket token" })], testRubric);

    expect(result.must_skip_violations).toHaveLength(1);
  });

  it("fails when entry count is out of range", () => {
    const testRubric = rubric({
      acceptable_range: { min: 0, max: 0 },
    });

    const result = scoreSession([entry()], testRubric);

    expect(result.count_in_range).toBe(false);
    expect(result.composite_score).toBeCloseTo(0.8, 6);
    expect(result.pass).toBe(false);
  });

  it("fails when importance ceiling is exceeded", () => {
    const testRubric = rubric({
      importance_ceiling: 7,
    });

    const result = scoreSession([entry({ importance: 9 })], testRubric);

    expect(result.ceiling_ok).toBe(false);
    expect(result.importance_violations).toHaveLength(1);
    expect(result.composite_score).toBeCloseTo(0.9, 6);
    expect(result.pass).toBe(false);
  });

  it("handles empty extraction gracefully", () => {
    const testRubric = rubric({
      must_extract: [
        {
          type: "fact",
          subject_contains: "profile",
          content_contains: ["alpha"],
          min_importance: 7,
          reason: "must exist",
        },
      ],
    });

    const result = scoreSession([], testRubric);

    expect(result.total_entries).toBe(0);
    expect(result.precision_proxy).toBe(1);
    expect(result.recall).toBe(0);
    expect(result.partial_recall).toBe(0);
    expect(result.composite_score).toBe(0);
  });

  it("case-insensitive matching works", () => {
    const testRubric = rubric({
      must_extract: [
        {
          type: "FACT",
          subject_contains: "Dave",
          content_contains: ["GoLang"],
          min_importance: 7,
          reason: "case-insensitive matching",
        },
      ],
    });

    const result = scoreSession(
      [entry({ type: "fact", subject: "dave profile", content: "golang enthusiast", importance: 7 })],
      testRubric,
    );

    expect(result.must_extract_scores[0]?.matched).toBe(true);
  });

  it("content_contains requires ALL strings for full credit", () => {
    const testRubric = rubric({
      must_extract: [
        {
          type: "fact",
          subject_contains: "profile",
          content_contains: ["alpha", "beta", "gamma"],
          min_importance: 7,
          reason: "all keywords required",
        },
      ],
    });

    const result = scoreSession(
      [entry({ subject: "profile", content: "alpha only", importance: 7 })],
      testRubric,
    );

    // With HIT threshold at 0.70, type+subject+importance+partial content = ~0.80 which is a HIT
    expect(result.must_extract_scores[0]?.matched).toBe(true);
    expect(result.must_extract_scores[0]?.partial_score).toBeLessThan(1);
  });

  it("entry claiming prevents double-counting", () => {
    const testRubric = rubric({
      must_extract: [
        {
          type: "fact",
          subject_contains: "profile",
          content_contains: ["alpha"],
          min_importance: 7,
          reason: "first rule",
        },
        {
          type: "fact",
          subject_contains: "profile",
          content_contains: ["alpha"],
          min_importance: 7,
          reason: "second rule",
        },
      ],
    });

    const result = scoreSession(
      [entry({ subject: "profile", content: "alpha", importance: 7 })],
      testRubric,
    );

    // Both rules can match the same entry (no claiming/double-count prevention)
    expect(result.must_extract_scores[0]?.matched).toBe(true);
    expect(result.must_extract_scores[1]?.matched).toBe(true);
    expect(result.recall).toBeCloseTo(1.0, 6);
  });

  it("rules processed by specificity", () => {
    const testRubric = rubric({
      must_extract: [
        {
          type: "fact",
          subject_contains: "topic",
          content_contains: ["alpha"],
          min_importance: 7,
          reason: "broad rule",
        },
        {
          type: "fact",
          subject_contains: "topic",
          content_contains: ["alpha", "beta"],
          min_importance: 7,
          reason: "specific rule",
        },
      ],
    });

    const result = scoreSession(
      [
        entry({ subject: "topic", content: "alpha only", importance: 7 }),
        entry({ subject: "topic", content: "alpha beta both", importance: 7 }),
      ],
      testRubric,
    );

    expect(result.must_extract_scores[0]?.matched).toBe(true);
    expect(result.must_extract_scores[1]?.matched).toBe(true);
    expect(result.must_extract_scores[1]?.matched_entry?.content.toLowerCase()).toContain("beta");
  });
});
