import { describe, expect, it } from "vitest";

import { buildEntryRecallPreview, buildRecallToolDetails, ENTRY_PREVIEW_MAX_CHARS } from "../../../src/adapters/shared/memory-tool-format.js";
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

describe("buildRecallToolDetails entry previews", () => {
  it("omits full entry bodies and exposes preview metadata instead", () => {
    const fullContent = `${"Skeln is a local-first terminal agent app. ".repeat(8)}Full body must not appear in recall details.`;
    const preview = buildEntryRecallPreview(fullContent);
    const details = buildRecallToolDetails(createRecallResult(fullContent));

    expect(preview.previewTruncated).toBe(true);
    expect(details.entries).toEqual([
      expect.objectContaining({
        id: "entry-1",
        contentPreview: preview.contentPreview,
        contentChars: fullContent.trim().length,
        previewTruncated: true,
      }),
    ]);
    expect(JSON.stringify(details)).not.toContain(fullContent);
    expect((details.entries as Array<Record<string, unknown>>)[0]).not.toHaveProperty("content");
  });

  it("includes untruncated preview text when content fits the cap", () => {
    const content = "Short durable fact.";
    const details = buildRecallToolDetails(createRecallResult(content));

    expect(details.entries).toEqual([
      expect.objectContaining({
        contentPreview: content,
        contentChars: content.length,
        previewTruncated: false,
      }),
    ]);
    expect(content.length).toBeLessThanOrEqual(ENTRY_PREVIEW_MAX_CHARS);
  });
});
