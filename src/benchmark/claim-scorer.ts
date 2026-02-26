import type { ExtractedClaim } from "../db/claim-extraction.js";

const ENTITY_WEIGHT = 0.25;
const ATTRIBUTE_WEIGHT = 0.25;
const PREDICATE_WEIGHT = 0.15;
const OBJECT_WEIGHT = 0.25;
const CONFIDENCE_WEIGHT = 0.1;
const PASS_THRESHOLD = 0.7;

const STRONG_PREDICATE_GROUPS: string[][] = [
  ["is", "equals"],
  ["uses", "use"],
  ["works_at", "works_for", "employed_at"],
  ["follows", "practices", "adheres_to"],
  ["switched_to", "changed_to", "migrated_to"],
];

const SOFT_PREDICATE_EQUIVALENCE = new Map<string, number>([
  ["prefers|likes", 0.8],
  ["likes|prefers", 0.8],
  ["dislikes|avoids", 0.8],
  ["avoids|dislikes", 0.8],
  ["stores_in|uses", 0.8],
  ["uses|stores_in", 0.8],
]);

export interface ClaimFixtureExpected {
  noClaim: boolean;
  subjectEntity?: string;
  subjectAttribute?: string;
  predicate?: string;
  object?: string;
  minConfidence?: number;
  altEntity?: string;
  altAttribute?: string;
  altPredicate?: string;
  altObject?: string;
}

export interface ClaimFixture {
  id: string;
  content: string;
  type: string;
  subject: string;
  expected: ClaimFixtureExpected;
}

export interface ClaimBenchmarkResult {
  fixtureId: string;
  passed: boolean;
  scores: {
    entityMatch: number;
    attributeMatch: number;
    predicateMatch: number;
    objectMatch: number;
    noClaimCorrect: number;
    confidenceInRange: number;
  };
  overall: number;
  extracted: ExtractedClaim | null;
  expected: ClaimFixtureExpected;
  error?: string;
}

export interface ClaimBenchmarkSummary {
  model: string;
  totalFixtures: number;
  passed: number;
  failed: number;
  averageScore: number;
  entityAccuracy: number;
  attributeAccuracy: number;
  predicateAccuracy: number;
  objectAccuracy: number;
  noClaimAccuracy: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  estimatedCostUsd: number;
}

function normalizeLower(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSnakeCase(value: string): string {
  return normalizeLower(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizePredicate(value: string): string {
  return normalizeSnakeCase(value);
}

function tokenize(value: string): string[] {
  return normalizeLower(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function avg(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return sum / values.length;
}

function scoreEntityMatch(expected: ClaimFixtureExpected, extracted: ExtractedClaim | null): number {
  if (!expected.subjectEntity || !extracted) {
    return 0;
  }
  const extractedNorm = normalizeLower(extracted.subjectEntity);
  if (extractedNorm === normalizeLower(expected.subjectEntity)) {
    return 1;
  }
  if (expected.altEntity && extractedNorm === normalizeLower(expected.altEntity)) {
    return 1;
  }
  return 0;
}

function scoreAttributeMatch(expected: ClaimFixtureExpected, extracted: ExtractedClaim | null): number {
  if (!expected.subjectAttribute || !extracted) {
    return 0;
  }
  const extractedNorm = normalizeSnakeCase(extracted.subjectAttribute);
  if (extractedNorm === normalizeSnakeCase(expected.subjectAttribute)) {
    return 1;
  }
  if (expected.altAttribute && extractedNorm === normalizeSnakeCase(expected.altAttribute)) {
    return 1;
  }
  return 0;
}

function inSameStrongPredicateGroup(left: string, right: string): boolean {
  return STRONG_PREDICATE_GROUPS.some((group) => group.includes(left) && group.includes(right));
}

function scorePredicateMatch(expected: ClaimFixtureExpected, extracted: ExtractedClaim | null): number {
  if (!expected.predicate || !extracted) {
    return 0;
  }

  const right = normalizePredicate(extracted.predicate);
  const expectedPredicates = [expected.predicate, expected.altPredicate]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => normalizePredicate(value));

  if (!right || expectedPredicates.length === 0) {
    return 0;
  }

  let best = 0;
  for (const left of expectedPredicates) {
    if (!left) {
      continue;
    }
    if (left === right) {
      return 1;
    }
    if (inSameStrongPredicateGroup(left, right)) {
      return 1;
    }
    best = Math.max(best, SOFT_PREDICATE_EQUIVALENCE.get(`${left}|${right}`) ?? 0);
  }

  return best;
}

function scoreObjectMatch(expected: ClaimFixtureExpected, extracted: ExtractedClaim | null): number {
  if (!expected.object || !extracted) {
    return 0;
  }

  const target = normalizeLower(extracted.object);

  if (!target) {
    return 0;
  }

  const expectedObjects = [expected.object, expected.altObject]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => normalizeLower(value));

  let best = 0;
  for (const goal of expectedObjects) {
    if (!goal) {
      continue;
    }
    if (target === goal) {
      return 1;
    }
    if (target.includes(goal) || goal.includes(target)) {
      best = Math.max(best, 0.7);
      continue;
    }
    const targetTokens = new Set(tokenize(target));
    const goalTokens = tokenize(goal);
    if (goalTokens.some((token) => targetTokens.has(token))) {
      best = Math.max(best, 0.3);
    }
  }

  return best;
}

function scoreNoClaimCorrect(expectedNoClaim: boolean, extracted: ExtractedClaim | null): number {
  if (expectedNoClaim) {
    return extracted === null ? 1 : 0;
  }
  return extracted !== null ? 1 : 0;
}

function scoreConfidenceInRange(expectedMin: number | undefined, extracted: ExtractedClaim | null): number {
  if (!extracted) {
    return 0;
  }

  if (expectedMin === undefined) {
    return 1;
  }

  return extracted.confidence >= expectedMin ? 1 : 0;
}

export function scoreClaimFixture(
  fixture: ClaimFixture,
  extracted: ExtractedClaim | null,
  error?: string,
): ClaimBenchmarkResult {
  const noClaimCorrect = scoreNoClaimCorrect(fixture.expected.noClaim, extracted);

  if (fixture.expected.noClaim) {
    return {
      fixtureId: fixture.id,
      passed: noClaimCorrect >= PASS_THRESHOLD,
      scores: {
        entityMatch: 0,
        attributeMatch: 0,
        predicateMatch: 0,
        objectMatch: 0,
        noClaimCorrect,
        confidenceInRange: 0,
      },
      overall: noClaimCorrect,
      extracted,
      expected: fixture.expected,
      ...(error ? { error } : {}),
    };
  }

  const entityMatch = scoreEntityMatch(fixture.expected, extracted);
  const attributeMatch = scoreAttributeMatch(fixture.expected, extracted);
  const predicateMatch = scorePredicateMatch(fixture.expected, extracted);
  const objectMatch = scoreObjectMatch(fixture.expected, extracted);
  const confidenceInRange = scoreConfidenceInRange(fixture.expected.minConfidence, extracted);

  const overall =
    entityMatch * ENTITY_WEIGHT +
    attributeMatch * ATTRIBUTE_WEIGHT +
    predicateMatch * PREDICATE_WEIGHT +
    objectMatch * OBJECT_WEIGHT +
    confidenceInRange * CONFIDENCE_WEIGHT;

  return {
    fixtureId: fixture.id,
    passed: overall >= PASS_THRESHOLD,
    scores: {
      entityMatch,
      attributeMatch,
      predicateMatch,
      objectMatch,
      noClaimCorrect,
      confidenceInRange,
    },
    overall,
    extracted,
    expected: fixture.expected,
    ...(error ? { error } : {}),
  };
}

export function summarizeClaimBenchmark(
  model: string,
  results: ClaimBenchmarkResult[],
  totalLatencyMs: number,
  estimatedCostUsd: number,
): ClaimBenchmarkSummary {
  const totalFixtures = results.length;
  const passed = results.filter((result) => result.passed).length;
  const failed = totalFixtures - passed;
  const averageScore = avg(results.map((result) => result.overall));

  const regularResults = results.filter((result) => !result.expected.noClaim);
  const noClaimResults = results.filter((result) => result.expected.noClaim);

  return {
    model,
    totalFixtures,
    passed,
    failed,
    averageScore,
    entityAccuracy: avg(regularResults.map((result) => result.scores.entityMatch)),
    attributeAccuracy: avg(regularResults.map((result) => result.scores.attributeMatch)),
    predicateAccuracy: avg(regularResults.map((result) => result.scores.predicateMatch)),
    objectAccuracy: avg(regularResults.map((result) => result.scores.objectMatch)),
    noClaimAccuracy: avg(noClaimResults.map((result) => result.scores.noClaimCorrect)),
    totalLatencyMs,
    avgLatencyMs: totalFixtures > 0 ? totalLatencyMs / totalFixtures : 0,
    estimatedCostUsd,
  };
}
