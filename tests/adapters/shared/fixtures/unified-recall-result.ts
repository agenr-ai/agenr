import { projectClaimCentricRecallEntries } from "../../../../src/app/recall/claim-centric.js";
import type { UnifiedRecallResult } from "../../../../src/app/recall/index.js";
import type { RecallOutput } from "../../../../src/core/recall/types.js";

/** Builds one recall output row for adapter formatting tests. */
export function createRecallOutput(content: string): RecallOutput {
  return {
    entry: {
      id: "entry-1",
      type: "fact",
      subject: "Skeln architecture",
      content,
      importance: 8,
      expiry: "permanent",
      tags: ["skeln"],
      quality_score: 0.5,
      recall_count: 0,
      created_at: "2026-05-31T00:00:00.000Z",
      updated_at: "2026-05-31T00:00:00.000Z",
    },
    score: 0.95,
    scores: {
      relevance: 0.95,
      rrf: 0.95,
      vector: 0.8,
      lexical: 0.7,
      recency: 0.5,
      importance: 0.8,
      historicalLineage: 0,
      neighborhoodBoost: 0,
      claimKeyTrustPenalty: 0,
      claimKeyRedundancyPenalty: 0,
    },
  };
}

/** Builds a minimal unified recall result containing one entry family. */
export function createUnifiedRecallResult(content: string): UnifiedRecallResult {
  const entries = [createRecallOutput(content)];
  const entryFamilies = projectClaimCentricRecallEntries(entries);
  return {
    routing: {
      requested: "durables",
      detectedIntent: "factual",
      queried: ["durables"],
      reason: "Durable recall requested.",
    },
    procedureCandidates: [],
    procedureNotices: [],
    episodes: [],
    entries,
    projectedEntries: entryFamilies.flatMap((family) => family.entries),
    entryFamilies,
    claimTransitions: [],
    notices: [],
    count: 1,
  };
}
