import { describe, expect, it } from "vitest";

import { projectClaimCentricRecallEntries } from "../../../src/app/recall/claim-centric.js";
import { buildClaimTransitionExplanations } from "../../../src/app/recall/transitions.js";
import type { EpisodeResult } from "../../../src/core/episode/types.js";
import type { RecallOutput } from "../../../src/core/recall/types.js";
import type { Entry, Episode } from "../../../src/core/types.js";

describe("buildClaimTransitionExplanations", () => {
  it("keeps episode context when a matching episode only wins because of token overlap", () => {
    const priorEntry = createEntry({
      id: "approach-old",
      subject: "deployment approach",
      content: "Webpack was the deployment approach before the migration.",
      claim_key: "deployment/approach",
      claim_key_status: "trusted",
      superseded_by: "approach-new",
    });
    const currentEntry = createEntry({
      id: "approach-new",
      subject: "deployment approach",
      content: "Vite is the deployment approach after the migration.",
      claim_key: "deployment/approach",
      claim_key_status: "trusted",
    });
    const families = projectClaimCentricRecallEntries([createRecallOutput(priorEntry, 0.8), createRecallOutput(currentEntry, 0.7)]);

    const transitions = buildClaimTransitionExplanations({
      families,
      episodes: [
        createEpisodeResult({
          episode: createEpisode({
            id: "history-episode",
            summary: "We migrated the deployment approach from webpack to vite.",
            tags: ["deployment", "migration"],
          }),
          score: 0,
        }),
      ],
      detectedIntent: "historical_state",
    });

    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.episodeContext).toMatchObject({
      episodeId: "history-episode",
    });
  });

  it("omits episode context when no episode has positive token overlap", () => {
    const priorEntry = createEntry({
      id: "approach-old",
      subject: "deployment approach",
      content: "Webpack was the deployment approach before the migration.",
      claim_key: "deployment/approach",
      claim_key_status: "trusted",
      superseded_by: "approach-new",
    });
    const currentEntry = createEntry({
      id: "approach-new",
      subject: "deployment approach",
      content: "Vite is the deployment approach after the migration.",
      claim_key: "deployment/approach",
      claim_key_status: "trusted",
    });
    const families = projectClaimCentricRecallEntries([createRecallOutput(priorEntry, 0.8), createRecallOutput(currentEntry, 0.7)]);

    const transitions = buildClaimTransitionExplanations({
      families,
      episodes: [
        createEpisodeResult({
          episode: createEpisode({
            id: "unrelated-episode",
            summary: "We cleaned up the analytics pipeline and rotated credentials.",
            tags: ["analytics", "maintenance"],
          }),
          score: 0.9,
        }),
      ],
      detectedIntent: "historical_state",
    });

    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.episodeContext).toBeUndefined();
  });

  it("emits transitions for factual recall when both prior and current rows are visible", () => {
    const priorEntry = createEntry({
      id: "runtime-old",
      subject: "deployment runtime",
      content: "Deployment runtime used Node 22.",
      claim_key: "deployment/runtime",
      claim_key_status: "trusted",
      superseded_by: "runtime-new",
    });
    const currentEntry = createEntry({
      id: "runtime-new",
      subject: "deployment runtime",
      content: "Deployment runtime uses Node 24.",
      claim_key: "deployment/runtime",
      claim_key_status: "trusted",
    });

    const transitions = buildClaimTransitionExplanations({
      families: projectClaimCentricRecallEntries([createRecallOutput(currentEntry, 0.9), createRecallOutput(priorEntry, 0.7)]),
      episodes: [],
      detectedIntent: "factual",
    });

    expect(transitions).toEqual([
      expect.objectContaining({
        claimKey: "deployment/runtime",
        currentEntryId: "runtime-new",
        priorEntryId: "runtime-old",
        summary: "deployment runtime changed from runtime-old to runtime-new.",
      }),
    ]);
  });

  it("keeps one-sided explanations limited to historical-state intent", () => {
    const currentEntry = createEntry({
      id: "runtime-new",
      subject: "deployment runtime",
      content: "Deployment runtime uses Node 24.",
      claim_key: "deployment/runtime",
      claim_key_status: "trusted",
    });

    const transitions = buildClaimTransitionExplanations({
      families: projectClaimCentricRecallEntries([createRecallOutput(currentEntry, 0.9)]),
      episodes: [],
      detectedIntent: "factual",
    });

    expect(transitions).toEqual([]);
  });
});

function createRecallOutput(entry: Entry, score: number): RecallOutput {
  return {
    entry,
    score,
    scores: {
      relevance: score,
      rrf: score,
      vector: 0,
      lexical: 0,
      recency: 0,
      importance: 0,
      historicalLineage: 0,
      neighborhoodBoost: 0,
      claimKeyTrustPenalty: 0,
      claimKeyRedundancyPenalty: 0,
    },
  };
}

function createEpisodeResult(overrides: Partial<EpisodeResult> & Pick<EpisodeResult, "episode" | "score">): EpisodeResult {
  return {
    episode: overrides.episode,
    score: overrides.score,
    scores: overrides.scores ?? {
      temporal: 0,
      semantic: 0,
      activity: 0,
      recency: 0,
    },
  };
}

function createEpisode(overrides: Partial<Episode> & Pick<Episode, "id" | "summary">): Episode {
  const now = "2026-03-30T00:00:00.000Z";
  return {
    id: overrides.id,
    source: overrides.source ?? "openclaw",
    sourceId: overrides.sourceId,
    sourceRef: overrides.sourceRef,
    transcriptHash: overrides.transcriptHash,
    summaryHash: overrides.summaryHash,
    agentId: overrides.agentId,
    surface: overrides.surface,
    startedAt: overrides.startedAt ?? "2026-03-29T09:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-03-29T10:00:00.000Z",
    summary: overrides.summary,
    tags: overrides.tags ?? [],
    activityLevel: overrides.activityLevel,
    userId: overrides.userId,
    project: overrides.project,
    genModel: overrides.genModel,
    genVersion: overrides.genVersion,
    messageCount: overrides.messageCount,
    embedding: overrides.embedding,
    retired: overrides.retired ?? false,
    retiredAt: overrides.retiredAt,
    retiredReason: overrides.retiredReason,
    supersededBy: overrides.supersededBy,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function createEntry(overrides: Partial<Entry> & Pick<Entry, "id" | "subject" | "content">): Entry {
  const now = "2026-03-30T00:00:00.000Z";
  return {
    id: overrides.id,
    type: overrides.type ?? "decision",
    subject: overrides.subject,
    content: overrides.content,
    importance: overrides.importance ?? 7,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    claim_key_status: overrides.claim_key_status,
    claim_key_source: overrides.claim_key_source,
    claim_key_confidence: overrides.claim_key_confidence,
    claim_key_rationale: overrides.claim_key_rationale,
    claim_support_source_kind: overrides.claim_support_source_kind,
    claim_support_locator: overrides.claim_support_locator,
    claim_support_observed_at: overrides.claim_support_observed_at,
    claim_support_mode: overrides.claim_support_mode,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    cluster_id: overrides.cluster_id,
    user_id: overrides.user_id,
    project: overrides.project,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}
