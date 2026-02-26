const RELATION_WEIGHT = 0.8;
const CONFIDENCE_WEIGHT = 0.2;
const PASS_THRESHOLD = 0.7;
const DEFAULT_MIN_CONFIDENCE = 0.7;

export interface JudgeFixture {
  id: string;
  newEntry: {
    content: string;
    type: string;
    subject: string;
  };
  existing: {
    content: string;
    type: string;
    subject: string;
    createdAt: string;
  };
  expected: {
    relation: string;
    altRelation?: string;
    minConfidence?: number;
  };
}

export interface JudgeBenchmarkResult {
  fixtureId: string;
  passed: boolean;
  relationMatch: number;
  confidenceOk: number;
  overall: number;
  extracted: {
    relation: string;
    confidence: number;
    explanation: string;
  } | null;
  expected: JudgeFixture["expected"];
  error?: string;
}

export interface JudgeBenchmarkSummary {
  model: string;
  totalFixtures: number;
  passed: number;
  failed: number;
  averageScore: number;
  relationAccuracy: number;
  confidenceAccuracy: number;
  supersedesAccuracy: number;
  contradictsAccuracy: number;
  coexistsAccuracy: number;
  unrelatedAccuracy: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  estimatedCostUsd: number;
}

function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return sum / values.length;
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function scoreRelationMatch(
  expected: JudgeFixture["expected"],
  extracted: JudgeBenchmarkResult["extracted"],
): number {
  if (!extracted) {
    return 0;
  }
  const relation = normalize(extracted.relation);
  const primary = normalize(expected.relation);
  const alternate = normalize(expected.altRelation);
  if (relation === primary || (alternate.length > 0 && relation === alternate)) {
    return 1;
  }
  return 0;
}

function scoreConfidence(minConfidence: number | undefined, extracted: JudgeBenchmarkResult["extracted"]): number {
  if (!extracted) {
    return 0;
  }
  const min = minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  return extracted.confidence >= min ? 1 : 0;
}

export function scoreJudgeFixture(
  fixture: JudgeFixture,
  extracted: JudgeBenchmarkResult["extracted"],
  error?: string,
): JudgeBenchmarkResult {
  const relationMatch = scoreRelationMatch(fixture.expected, extracted);
  const confidenceOk = scoreConfidence(fixture.expected.minConfidence, extracted);
  const overall = relationMatch * RELATION_WEIGHT + confidenceOk * CONFIDENCE_WEIGHT;

  return {
    fixtureId: fixture.id,
    passed: overall >= PASS_THRESHOLD,
    relationMatch,
    confidenceOk,
    overall,
    extracted,
    expected: fixture.expected,
    ...(error ? { error } : {}),
  };
}

function relationPassRate(results: JudgeBenchmarkResult[], relation: string): number {
  const subset = results.filter((result) => normalize(result.expected.relation) === relation);
  if (subset.length === 0) {
    return 0;
  }
  return subset.filter((result) => result.passed).length / subset.length;
}

export function summarizeJudgeBenchmark(
  model: string,
  results: JudgeBenchmarkResult[],
  totalLatencyMs: number,
  estimatedCostUsd: number,
  totalEvaluations = results.length,
): JudgeBenchmarkSummary {
  const totalFixtures = results.length;
  const passed = results.filter((result) => result.passed).length;
  const failed = totalFixtures - passed;

  return {
    model,
    totalFixtures,
    passed,
    failed,
    averageScore: avg(results.map((result) => result.overall)),
    relationAccuracy: avg(results.map((result) => result.relationMatch)),
    confidenceAccuracy: avg(results.map((result) => result.confidenceOk)),
    supersedesAccuracy: relationPassRate(results, "supersedes"),
    contradictsAccuracy: relationPassRate(results, "contradicts"),
    coexistsAccuracy: relationPassRate(results, "coexists"),
    unrelatedAccuracy: relationPassRate(results, "unrelated"),
    totalLatencyMs,
    avgLatencyMs: totalEvaluations > 0 ? totalLatencyMs / totalEvaluations : 0,
    estimatedCostUsd,
  };
}
