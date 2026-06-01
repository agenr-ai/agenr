import { describe, expect, it } from "vitest";

import { formatUnifiedRecallResults } from "../../../src/adapters/shared/recall-format.js";
import { projectClaimCentricRecallEntries } from "../../../src/app/recall/claim-centric.js";
import type { UnifiedRecallResult } from "../../../src/app/recall/index.js";
import type { RecallOutput } from "../../../src/core/recall/types.js";

function createRecallOutput(content: string): RecallOutput {
  return {
    entry: {
      id: "entry-1",
      type: "fact",
      subject: "Skeln architecture",
      content,
      importance: 8,
      expiry: "permanent",
      tags: ["skeln"],
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

function createRecallResult(content: string): UnifiedRecallResult {
  const entries = [createRecallOutput(content)];
  const entryFamilies = projectClaimCentricRecallEntries(entries);
  return {
    routing: {
      requested: "entries",
      detectedIntent: "factual",
      queried: ["entries"],
      reason: "Entry recall requested.",
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

describe("formatUnifiedRecallResults fetch guidance", () => {
  it("marks truncated previews and points the agent to agenr_fetch", () => {
    const fullContent = `${"Skeln is a local-first terminal agent app. ".repeat(8)}The full body must remain available in the structured details JSON block after the summary preview truncates it.`;
    const text = formatUnifiedRecallResults(createRecallResult(fullContent));

    expect(text).toContain("Recall Route");
    expect(text).toContain("content_chars=");
    expect(text).toContain("preview_truncated=true");
    expect(text).not.toContain("Fetch Guidance");
    expect(text).not.toContain(fullContent);
    expect(text).toContain("...");
  });
});
