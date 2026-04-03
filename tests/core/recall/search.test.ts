import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecallPorts } from "../../../src/core/ports.js";
import type { Entry } from "../../../src/core/types.js";
import { recall } from "../../../src/core/recall/search.js";
import type { RecallExecutionTraceSummary } from "../../../src/core/recall/trace.js";
import type { FtsCandidate, RecallCandidateEntry, VectorCandidate } from "../../../src/core/recall/types.js";

const NOW = new Date("2026-03-26T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recall raw evidence gating", () => {
  it("abstains when every candidate is a weak vector-only match", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "branch-prefixes",
          subject: "branch naming convention",
          content: "Use standard Git branch prefixes like feat/, fix/, chore/, and hotfix/ instead of custom names.",
          created_at: "2026-03-06T00:00:00.000Z",
        }),
        buildEntry({
          id: "prompt-drafting-style",
          type: "preference",
          subject: "prompt drafting style",
          content: "Implementation prompts should be numbered and linked back to the plan.",
          created_at: "2026-03-05T00:00:00.000Z",
        }),
        buildEntry({
          id: "db-path-resolution",
          subject: "db path resolution",
          content: "Resolve the database path from AGENR_DB_PATH before config defaults.",
          created_at: "2026-03-04T00:00:00.000Z",
        }),
      ],
      vectorCandidates: [
        { id: "prompt-drafting-style", vectorSim: 0.21 },
        { id: "branch-prefixes", vectorSim: 0.15 },
        { id: "db-path-resolution", vectorSim: 0.13 },
      ],
    });

    const results = await recall(
      {
        text: "what coffee order should I remember",
        limit: 5,
      },
      fixture.ports,
      {
        trace: {
          reportSummary(summary): void {
            traceSummaries.push(summary);
          },
        },
      },
    );

    expect(results).toEqual([]);
    expect(traceSummaries).toEqual([
      expect.objectContaining({
        ranking: expect.objectContaining({
          noResultReason: "below_threshold",
        }),
        candidateCounts: expect.objectContaining({
          merged: 3,
          thresholdQualified: 0,
          returned: 0,
        }),
      }),
    ]);
    expect(fixture.recordRecallEvents).not.toHaveBeenCalled();
  });

  it("keeps a strong vector-only match when the raw similarity is meaningful", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "sandbox-bootstrap",
          subject: "sandbox bootstrap",
          content: "Provision isolated environments for repeatable test runs.",
        }),
      ],
      vectorCandidates: [{ id: "sandbox-bootstrap", vectorSim: 0.34 }],
    });

    const results = await recall(
      {
        text: "can you remind me about the earlier note",
        limit: 5,
      },
      fixture.ports,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.entry.id).toBe("sandbox-bootstrap");
    expect(results[0]?.scores.lexical).toBe(0);
    expect(results[0]?.scores.vector).toBeCloseTo(0.34, 6);
    expect(fixture.recordRecallEvents).toHaveBeenCalledWith({
      entryIds: ["sandbox-bootstrap"],
      query: "can you remind me about the earlier note",
      sessionKey: undefined,
    });
  });

  it("filters weak vector-only distractors while keeping a lexical match", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "policy-new",
          type: "decision",
          subject: "pager policy",
          content: "Taylor is on call this week.",
        }),
        buildEntry({
          id: "branch-cleanup",
          type: "decision",
          subject: "branch cleanup workflow",
          content: "Delete merged branches after review.",
        }),
      ],
      vectorCandidates: [
        { id: "policy-new", vectorSim: 0.41 },
        { id: "branch-cleanup", vectorSim: 0.22 },
      ],
      ftsCandidates: [{ id: "policy-new", rank: 1, tier: "all_tokens" }],
    });

    const results = await recall(
      {
        text: "who is on call this week",
        limit: 5,
      },
      fixture.ports,
    );

    expect(results.map((result) => result.entry.id)).toEqual(["policy-new"]);
    expect(results[0]?.scores.lexical).toBeGreaterThan(0);
    expect(fixture.recordRecallEvents).toHaveBeenCalledWith({
      entryIds: ["policy-new"],
      query: "who is on call this week",
      sessionKey: undefined,
    });
  });

  it("neutralizes default age bias for historical-state ranking", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "approach-old",
          subject: "deployment approach",
          content: "Deployment approach used the same bundler.",
          created_at: "2026-01-01T00:00:00.000Z",
        }),
        buildEntry({
          id: "approach-new",
          subject: "deployment approach",
          content: "Deployment approach used the same bundler.",
          created_at: "2026-03-20T00:00:00.000Z",
        }),
      ],
      vectorCandidates: [
        { id: "approach-old", vectorSim: 0.65 },
        { id: "approach-new", vectorSim: 0.65 },
      ],
    });

    const defaultResults = await recall(
      {
        text: "deployment approach",
        limit: 5,
      },
      fixture.ports,
    );
    const historicalResults = await recall(
      {
        text: "what was the previous deployment approach",
        limit: 5,
        rankingProfile: "historical_state",
      },
      fixture.ports,
    );

    expect(defaultResults.map((result) => result.entry.id)).toEqual(["approach-new", "approach-old"]);
    expect(historicalResults.map((result) => result.entry.id)).toEqual(["approach-old", "approach-new"]);
    expect(historicalResults.map((result) => result.scores.recency)).toEqual([0.5, 0.5]);
  });

  it("keeps around-date recency active for historical-state queries with a temporal anchor", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "approach-feb",
          subject: "deployment approach",
          content: "We used webpack for deployments.",
          created_at: "2026-02-01T00:00:00.000Z",
        }),
        buildEntry({
          id: "approach-mar",
          subject: "deployment approach",
          content: "We used vite for deployments.",
          created_at: "2026-03-20T00:00:00.000Z",
        }),
      ],
      vectorCandidates: [
        { id: "approach-feb", vectorSim: 0.62 },
        { id: "approach-mar", vectorSim: 0.62 },
      ],
    });

    const results = await recall(
      {
        text: "what was the previous deployment approach",
        around: "2026-02-01T00:00:00.000Z",
        aroundRadius: 3,
        limit: 5,
        rankingProfile: "historical_state",
      },
      fixture.ports,
    );

    expect(results.map((result) => result.entry.id)).toEqual(["approach-feb", "approach-mar"]);
    expect(results[0]?.scores.recency).toBeGreaterThan(results[1]?.scores.recency ?? 0);
  });
});

/**
 * Builds a recall fixture with explicit retrieval results and hydrated entries.
 *
 * @param params - Entries plus synthetic vector and lexical retrieval outputs.
 * @returns Recall ports and the telemetry spy used by assertions.
 */
function createRecallPortsFixture(params: {
  entries: Entry[];
  vectorCandidates: Array<{ id: string; vectorSim: number }>;
  ftsCandidates?: Array<{ id: string; rank: number; tier: FtsCandidate["tier"] }>;
}): {
  ports: RecallPorts;
  recordRecallEvents: ReturnType<typeof vi.fn>;
} {
  const entriesById = new Map(params.entries.map((entry) => [entry.id, entry]));
  const recordRecallEvents = vi.fn(async () => undefined);
  const ports: RecallPorts = {
    embed: async (): Promise<number[]> => [1, 0, 0],
    vectorSearch: async (): Promise<VectorCandidate[]> =>
      params.vectorCandidates.map((candidate) => ({
        entry: toRecallCandidateEntry(requireEntry(entriesById, candidate.id)),
        vectorSim: candidate.vectorSim,
      })),
    ftsSearch: async (): Promise<FtsCandidate[]> =>
      (params.ftsCandidates ?? []).map((candidate) => ({
        entry: toRecallCandidateEntry(requireEntry(entriesById, candidate.id)),
        rank: candidate.rank,
        tier: candidate.tier,
      })),
    hydrateEntries: async (ids: string[]): Promise<Entry[]> => ids.map((id) => requireEntry(entriesById, id)),
    recordRecallEvents,
  };

  return {
    ports,
    recordRecallEvents,
  };
}

/**
 * Converts a full entry into the minimal candidate payload used during scoring.
 *
 * @param entry - Hydrated entry fixture.
 * @returns Candidate entry view.
 */
function toRecallCandidateEntry(entry: Entry): RecallCandidateEntry {
  return {
    id: entry.id,
    subject: entry.subject,
    content: entry.content,
    importance: entry.importance,
    expiry: entry.expiry,
    created_at: entry.created_at,
    embedding: entry.embedding,
  };
}

/**
 * Returns a fixture entry and throws if the requested ID is missing.
 *
 * @param entriesById - Fixture entries keyed by ID.
 * @param id - Entry identifier.
 * @returns Matching fixture entry.
 */
function requireEntry(entriesById: Map<string, Entry>, id: string): Entry {
  const entry = entriesById.get(id);
  if (!entry) {
    throw new Error(`Missing recall test entry: ${id}`);
  }

  return entry;
}

/**
 * Builds a canonical entry fixture with stable defaults.
 *
 * @param overrides - Entry field overrides.
 * @returns Fully populated entry.
 */
function buildEntry(overrides: Partial<Entry> & Pick<Entry, "id" | "subject" | "content">): Entry {
  const createdAt = overrides.created_at ?? NOW.toISOString();
  const updatedAt = overrides.updated_at ?? createdAt;

  return {
    id: overrides.id,
    type: overrides.type ?? "fact",
    subject: overrides.subject,
    content: overrides.content,
    importance: overrides.importance ?? 6,
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
    cluster_id: overrides.cluster_id,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}
