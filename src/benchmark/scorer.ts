import type { KnowledgeEntry } from "../types.js";
import type {
  BenchmarkRubric,
  ImportanceCeilingRule,
  MustExtractRule,
  MustExtractScore,
  SessionScore,
} from "./types.js";

const TYPE_WEIGHT = 0.2;
const SUBJECT_WEIGHT = 0.3;
const CONTENT_WEIGHT = 0.3;
const IMPORTANCE_WEIGHT = 0.2;

const COUNT_PENALTY = 0.8;
const CEILING_PENALTY = 0.9;
const EPSILON = 1e-9;

interface CandidateScore {
  partialScore: number;
  typeMatch: boolean;
  subjectMatch: boolean;
  contentMatch: number;
  importanceMatch: boolean;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function includesCaseInsensitive(haystack: string, needle: string): boolean {
  const trimmed = needle.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return normalize(haystack).includes(normalize(trimmed));
}

function resolveImportanceCeiling(rubric: BenchmarkRubric): number | undefined {
  const ceiling = rubric.importance_ceiling;
  if (typeof ceiling === "number" && Number.isFinite(ceiling)) {
    return ceiling;
  }
  if (!ceiling || typeof ceiling !== "object") {
    return undefined;
  }
  const structured = ceiling as ImportanceCeilingRule;
  if (typeof structured.max_allowed !== "number" || !Number.isFinite(structured.max_allowed)) {
    return undefined;
  }
  return structured.max_allowed;
}

function scoreRuleAgainstEntry(rule: MustExtractRule, entry: KnowledgeEntry): CandidateScore {
  const typeMatch = normalize(entry.type) === normalize(rule.type);
  const subjectMatch = includesCaseInsensitive(entry.subject, rule.subject_contains);

  const keywords = rule.content_contains ?? [];
  const matchedKeywords = keywords.filter((keyword) => includesCaseInsensitive(entry.content, keyword)).length;
  const keywordRatio = keywords.length === 0 ? 1 : matchedKeywords / keywords.length;
  const contentMatch = keywordRatio * CONTENT_WEIGHT;

  const minImportance = Number.isFinite(rule.min_importance) ? rule.min_importance : 0;
  const maxImportance = Number.isFinite(rule.max_importance) ? (rule.max_importance as number) : undefined;
  const importanceMatch =
    entry.importance >= minImportance &&
    (maxImportance === undefined || entry.importance <= maxImportance);

  const partialScore =
    (typeMatch ? TYPE_WEIGHT : 0) +
    (subjectMatch ? SUBJECT_WEIGHT : 0) +
    contentMatch +
    (importanceMatch ? IMPORTANCE_WEIGHT : 0);

  return {
    partialScore,
    typeMatch,
    subjectMatch,
    contentMatch,
    importanceMatch,
  };
}

function isPerfectMatch(score: number): boolean {
  return Math.abs(1 - score) <= EPSILON;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function harmonicMean(precision: number, recall: number, beta = 1): number {
  if (precision <= 0 && recall <= 0) {
    return 0;
  }
  const betaSq = beta * beta;
  const denominator = betaSq * precision + recall;
  if (denominator <= 0) {
    return 0;
  }
  return ((1 + betaSq) * precision * recall) / denominator;
}

function buildMustExtractScores(entries: KnowledgeEntry[], rubric: BenchmarkRubric): MustExtractScore[] {
  const scoredRules = rubric.must_extract.map((rule, index) => ({ rule, index }));
  scoredRules.sort((a, b) => {
    const keywordDiff = (b.rule.content_contains?.length ?? 0) - (a.rule.content_contains?.length ?? 0);
    if (keywordDiff !== 0) {
      return keywordDiff;
    }
    return b.rule.subject_contains.length - a.rule.subject_contains.length;
  });

  const availableEntries = [...entries];
  const byOriginalIndex: MustExtractScore[] = new Array(rubric.must_extract.length);

  for (const { rule, index } of scoredRules) {
    let bestEntry: KnowledgeEntry | undefined;
    let bestEntryIndex = -1;
    let bestScore: CandidateScore = {
      partialScore: 0,
      typeMatch: false,
      subjectMatch: false,
      contentMatch: 0,
      importanceMatch: false,
    };

    for (const [candidateIndex, candidate] of availableEntries.entries()) {
      const score = scoreRuleAgainstEntry(rule, candidate);
      if (score.partialScore > bestScore.partialScore + EPSILON) {
        bestScore = score;
        bestEntry = candidate;
        bestEntryIndex = candidateIndex;
        continue;
      }

      if (Math.abs(score.partialScore - bestScore.partialScore) <= EPSILON && score.partialScore > 0) {
        const currentKeywordHits = score.contentMatch;
        const bestKeywordHits = bestScore.contentMatch;
        if (currentKeywordHits > bestKeywordHits) {
          bestScore = score;
          bestEntry = candidate;
          bestEntryIndex = candidateIndex;
        }
      }
    }

    if (bestEntryIndex >= 0 && bestScore.partialScore > 0) {
      availableEntries.splice(bestEntryIndex, 1);
    } else {
      bestEntry = undefined;
    }

    byOriginalIndex[index] = {
      rule,
      matched: isPerfectMatch(bestScore.partialScore),
      partial_score: clamp(bestScore.partialScore, 0, 1),
      type_match: bestScore.typeMatch,
      subject_match: bestScore.subjectMatch,
      content_match: bestScore.contentMatch,
      importance_match: bestScore.importanceMatch,
      matched_entry: bestEntry,
    };
  }

  return byOriginalIndex;
}

function evaluateSkipViolations(entries: KnowledgeEntry[], rubric: BenchmarkRubric): SessionScore["must_skip_violations"] {
  const violations: SessionScore["must_skip_violations"] = [];

  for (const rule of rubric.must_skip) {
    const pattern = rule.pattern ?? "";
    let matcher: ((value: string) => boolean) | null = null;

    try {
      const regex = new RegExp(pattern, "i");
      matcher = (value: string) => regex.test(value);
    } catch {
      const fallback = normalize(pattern);
      matcher = (value: string) => normalize(value).includes(fallback);
    }

    for (const entry of entries) {
      if (matcher(entry.subject) || matcher(entry.content)) {
        violations.push({
          rule,
          violating_entry: entry,
        });
      }
    }
  }

  return violations;
}

export function scoreSession(entries: KnowledgeEntry[], rubric: BenchmarkRubric): SessionScore {
  const mustExtractScores = buildMustExtractScores(entries, rubric);
  const mustExtractTotal = rubric.must_extract.length;
  const mustExtractHits = mustExtractScores.filter((score) => score.matched).length;
  const partialScoreSum = mustExtractScores.reduce((sum, score) => sum + score.partial_score, 0);

  const recall = mustExtractTotal === 0 ? 1 : mustExtractHits / mustExtractTotal;
  const partialRecall = mustExtractTotal === 0 ? 1 : partialScoreSum / mustExtractTotal;

  const mustSkipViolations = evaluateSkipViolations(entries, rubric);
  const totalEntries = entries.length;
  const precisionProxy =
    totalEntries === 0 ? 1 : clamp(1 - mustSkipViolations.length / totalEntries, 0, 1);

  const countInRange =
    totalEntries >= rubric.acceptable_range.min &&
    totalEntries <= rubric.acceptable_range.max;

  const ceiling = resolveImportanceCeiling(rubric);
  const importanceViolations =
    ceiling === undefined ? [] : entries.filter((entry) => entry.importance > ceiling);
  const ceilingOk = importanceViolations.length === 0;

  let composite = harmonicMean(precisionProxy, partialRecall, 1);
  if (!countInRange) {
    composite *= COUNT_PENALTY;
  }
  if (!ceilingOk) {
    composite *= CEILING_PENALTY;
  }

  const pass =
    mustExtractScores.every((score) => score.matched) &&
    mustSkipViolations.length === 0 &&
    countInRange &&
    ceilingOk;

  return {
    session: rubric.session,
    description: rubric.description,
    recall: clamp(recall, 0, 1),
    partial_recall: clamp(partialRecall, 0, 1),
    precision_proxy: clamp(precisionProxy, 0, 1),
    count_in_range: countInRange,
    ceiling_ok: ceilingOk,
    composite_score: clamp(composite, 0, 1),
    pass,
    total_entries: totalEntries,
    must_extract_scores: mustExtractScores,
    must_skip_violations: mustSkipViolations,
    importance_violations: importanceViolations,
  };
}
