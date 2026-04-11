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
  it("falls back to lexical-only ranking when query embeddings fail", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "policy-new",
          type: "decision",
          subject: "pager policy",
          content: "Taylor is on call this week.",
        }),
      ],
      vectorCandidates: [],
      ftsCandidates: [{ id: "policy-new", rank: 1, tier: "all_tokens" }],
      embedError: new Error("invalid API key"),
    });

    const results = await recall(
      {
        text: "who is on call this week",
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

    expect(results.map((result) => result.entry.id)).toEqual(["policy-new"]);
    expect(results[0]?.scores.vector).toBe(0);
    expect(results[0]?.scores.lexical).toBeGreaterThan(0);
    expect(traceSummaries).toEqual([
      expect.objectContaining({
        degraded: {
          active: true,
          reasons: ["query_embedding_failed"],
          lexicalOnly: true,
          notices: [expect.stringContaining("fell back to lexical-only entry ranking")],
        },
      }),
    ]);
  });

  it("keeps lexical recall working when vector search fails", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "policy-new",
          type: "decision",
          subject: "pager policy",
          content: "Taylor is on call this week.",
          embedding: createCosineEmbedding(0.81),
        }),
      ],
      vectorCandidates: [],
      ftsCandidates: [{ id: "policy-new", rank: 1, tier: "all_tokens" }],
      vectorSearchError: new Error("vector index unavailable"),
    });

    const results = await recall(
      {
        text: "who is on call this week",
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

    expect(results.map((result) => result.entry.id)).toEqual(["policy-new"]);
    expect(results[0]?.scores.vector).toBeGreaterThan(0);
    expect(results[0]?.scores.lexical).toBeGreaterThan(0);
    expect(traceSummaries).toEqual([
      expect.objectContaining({
        degraded: {
          active: true,
          reasons: ["vector_search_failed"],
          lexicalOnly: false,
          notices: [expect.stringContaining("continued with lexical entry candidates only")],
        },
      }),
    ]);
  });

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

  it("expands historical queries with explicit inactive predecessors only for the historical profile", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "manual-http-shim",
          subject: "local recall eval workflow",
          content: "Run local recall evals with an ad hoc HTTP shim before each debugging session.",
          created_at: "2026-01-12T00:00:00.000Z",
          superseded_by: "dev-recall-command",
        }),
        buildEntry({
          id: "dev-recall-command",
          subject: "local recall eval workflow",
          content: "Use the repo-owned dev recall command for local recall evals.",
          created_at: "2026-03-01T00:00:00.000Z",
        }),
      ],
      vectorCandidates: [{ id: "dev-recall-command", vectorSim: 0.71 }],
      predecessorCandidateIds: ["manual-http-shim"],
    });

    const currentResults = await recall(
      {
        text: "what workflow did we use before the dev recall command existed for local recall evals",
        limit: 5,
      },
      fixture.ports,
    );
    const historicalResults = await recall(
      {
        text: "what workflow did we use before the dev recall command existed for local recall evals",
        limit: 5,
        rankingProfile: "historical_state",
      },
      fixture.ports,
    );

    expect(currentResults.map((result) => result.entry.id)).toEqual(["dev-recall-command"]);
    expect(historicalResults.map((result) => result.entry.id)).toEqual(["manual-http-shim", "dev-recall-command"]);
    expect(fixture.fetchPredecessors).toHaveBeenCalledTimes(1);
    expect(fixture.fetchPredecessors).toHaveBeenCalledWith({
      activeEntryIds: ["dev-recall-command"],
    });
  });

  it("boosts retired same-topic predecessors for historical queries", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "kanban-tracking",
          subject: "memory freshness work tracking",
          content: "Track memory freshness eval work on the kanban board.",
          created_at: "2026-01-05T00:00:00.000Z",
          retired: true,
          retired_at: "2026-02-10T00:00:00.000Z",
          retired_reason: "superseded by GitHub issues",
        }),
        buildEntry({
          id: "github-issues-tracking",
          subject: "memory freshness work tracking",
          content: "Track memory freshness eval work in GitHub issues.",
          created_at: "2026-02-10T00:00:00.000Z",
        }),
      ],
      vectorCandidates: [{ id: "github-issues-tracking", vectorSim: 0.72 }],
      predecessorCandidateIds: ["kanban-tracking"],
    });

    const results = await recall(
      {
        text: "what did we use before GitHub issues to track memory freshness eval work",
        limit: 5,
        rankingProfile: "historical_state",
      },
      fixture.ports,
    );

    expect(results.map((result) => result.entry.id)).toEqual(["kanban-tracking", "github-issues-tracking"]);
  });

  it("adds a same-topic prior-state boost for active historical peers", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "recency-plan",
          subject: "ranking debug plan",
          content: "Plan for today: switch recall ranking to pure recency while debugging freshness problems.",
          created_at: "2026-03-18T09:00:00.000Z",
        }),
        buildEntry({
          id: "freshness-fix",
          type: "milestone",
          subject: "ranking debug outcome",
          content: "Implemented freshness-aware ranking without switching to pure recency; the earlier recency-only plan was dropped.",
          created_at: "2026-03-18T15:00:00.000Z",
        }),
      ],
      vectorCandidates: [
        { id: "recency-plan", vectorSim: 0.63 },
        { id: "freshness-fix", vectorSim: 0.68 },
      ],
    });

    const currentResults = await recall(
      {
        text: "what short-lived plan did we consider earlier that day before the final freshness ranking fix",
        limit: 5,
      },
      fixture.ports,
    );
    const historicalResults = await recall(
      {
        text: "what short-lived plan did we consider earlier that day before the final freshness ranking fix",
        limit: 5,
        rankingProfile: "historical_state",
      },
      fixture.ports,
    );

    expect(currentResults.map((result) => result.entry.id)).toEqual(["freshness-fix", "recency-plan"]);
    expect(historicalResults.map((result) => result.entry.id)).toEqual(["recency-plan", "freshness-fix"]);
  });

  it("prefers older same-claim-key siblings for historical queries even when subjects drift", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "webpack-pipeline",
          subject: "webpack migration note",
          content: "Webpack handled the build setup before the current bundler.",
          claim_key: "deployments/build_toolchain",
          embedding: createCosineEmbedding(0.68),
          created_at: "2026-03-12T09:00:00.000Z",
        }),
        buildEntry({
          id: "vite-pipeline",
          subject: "vite packaging decision",
          content: "Vite handles the build setup for the current bundler.",
          claim_key: "deployments/build_toolchain",
          embedding: createCosineEmbedding(0.72),
          created_at: "2026-03-14T09:00:00.000Z",
        }),
      ],
      vectorCandidates: [{ id: "vite-pipeline", vectorSim: 0.72 }],
      predecessorCandidateIds: ["webpack-pipeline"],
    });

    const currentResults = await recall(
      {
        text: "previous build setup",
        limit: 5,
      },
      fixture.ports,
    );
    const historicalResults = await recall(
      {
        text: "previous build setup",
        limit: 5,
        rankingProfile: "historical_state",
      },
      fixture.ports,
    );

    expect(currentResults.map((result) => result.entry.id)).toEqual(["vite-pipeline"]);
    expect(historicalResults.map((result) => result.entry.id)).toEqual(["webpack-pipeline", "vite-pipeline"]);
  });

  it("prefers trusted same-claim-key predecessors over tentative siblings for historical queries", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "current-toolchain",
          subject: "current build toolchain",
          content: "Vite is the current build toolchain.",
          claim_key: "deployments/build_toolchain",
          claim_key_status: "trusted",
          embedding: createCosineEmbedding(0.72),
          created_at: "2026-03-14T09:00:00.000Z",
        }),
        buildEntry({
          id: "older-toolchain-tentative",
          subject: "build setup fallback note",
          content: "Maybe esbuild handled packaging before the current toolchain settled.",
          claim_key: "deployments/build_toolchain",
          claim_key_status: "tentative",
          embedding: createCosineEmbedding(0.72),
          created_at: "2026-03-10T09:00:00.000Z",
        }),
        buildEntry({
          id: "older-toolchain-trusted",
          subject: "legacy bundler decision",
          content: "Webpack handled packaging before Vite.",
          claim_key: "deployments/build_toolchain",
          claim_key_status: "trusted",
          embedding: createCosineEmbedding(0.72),
          created_at: "2026-03-08T09:00:00.000Z",
        }),
      ],
      vectorCandidates: [{ id: "current-toolchain", vectorSim: 0.72 }],
      predecessorCandidateIds: ["older-toolchain-tentative", "older-toolchain-trusted"],
    });

    const results = await recall(
      {
        text: "previous build toolchain",
        limit: 5,
        rankingProfile: "historical_state",
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

    expect(results.map((result) => result.entry.id)).toEqual(["older-toolchain-trusted", "current-toolchain", "older-toolchain-tentative"]);
    expect(results[0]?.scores.historicalLineage).toBeGreaterThan(results[2]?.scores.historicalLineage ?? 0);
    expect(traceSummaries).toEqual([
      expect.objectContaining({
        claimKey: expect.objectContaining({
          historicalBoosted: 1,
          tentativeLineageSuppressed: 1,
        }),
      }),
    ]);
  });

  it("down-ranks redundant active trusted siblings from the same current slot", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "vite-primary",
          subject: "current build toolchain",
          content: "Use Vite for the current build toolchain.",
          claim_key: "deployments/build_toolchain",
          claim_key_status: "trusted",
          created_at: "2026-03-20T09:00:00.000Z",
        }),
        buildEntry({
          id: "vite-shadow",
          subject: "packaging toolchain note",
          content: "Vite also appears in a second active build toolchain note.",
          claim_key: "deployments/build_toolchain",
          claim_key_status: "trusted",
          created_at: "2026-03-19T09:00:00.000Z",
        }),
        buildEntry({
          id: "release-rollout",
          subject: "release rollout checklist",
          content: "Run the release rollout checklist before packaging.",
          created_at: "2026-03-18T09:00:00.000Z",
        }),
      ],
      vectorCandidates: [
        { id: "vite-primary", vectorSim: 0.74 },
        { id: "vite-shadow", vectorSim: 0.72 },
        { id: "release-rollout", vectorSim: 0.7 },
      ],
    });

    const results = await recall(
      {
        text: "current build toolchain",
        limit: 5,
      },
      fixture.ports,
    );

    expect(results.map((result) => result.entry.id)).toEqual(["vite-primary", "release-rollout", "vite-shadow"]);
    expect(results[2]?.scores.claimKeyRedundancyPenalty).toBeGreaterThan(0);
  });

  it("keeps tentative same-slot siblings from outranking a trusted current answer", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "vite-trusted",
          subject: "current build toolchain",
          content: "Vite is the approved current build toolchain.",
          claim_key: "deployments/build_toolchain",
          claim_key_status: "trusted",
          created_at: "2026-03-18T09:00:00.000Z",
        }),
        buildEntry({
          id: "vite-tentative",
          subject: "current build toolchain experiment",
          content: "Maybe esbuild or Vite is the current build toolchain.",
          claim_key: "deployments/build_toolchain",
          claim_key_status: "tentative",
          created_at: "2026-03-20T09:00:00.000Z",
        }),
      ],
      vectorCandidates: [
        { id: "vite-trusted", vectorSim: 0.68 },
        { id: "vite-tentative", vectorSim: 0.77 },
      ],
    });

    const results = await recall(
      {
        text: "current build toolchain",
        limit: 5,
      },
      fixture.ports,
    );

    expect(results.map((result) => result.entry.id)).toEqual(["vite-trusted", "vite-tentative"]);
    expect(results[1]?.scores.claimKeyTrustPenalty).toBeGreaterThan(0);
  });

  it("limits historical peer boosts to shared subject prefixes", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "phase1-plan",
          subject: "memory freshness eval rollout",
          content: "Plan: build the first memory freshness eval corpus in agenr-evals next week, then add explicit ranking assertions later.",
          created_at: "2026-03-10T00:00:00.000Z",
        }),
        buildEntry({
          id: "phase1-shipped",
          type: "milestone",
          subject: "memory freshness eval rollout status",
          content:
            "Phase 1 is complete: the first memory freshness eval corpus now exists in agenr-evals, and ranking-aware assertions are queued as follow-up work.",
          created_at: "2026-03-14T00:00:00.000Z",
        }),
        buildEntry({
          id: "phase2-ranking-assertions",
          subject: "memory freshness phase 2",
          content: "Phase 2 will add explicit top-result, ordered-prefix, and pairwise-order assertions after the phase 1 corpus lands.",
          created_at: "2026-03-15T00:00:00.000Z",
        }),
      ],
      vectorCandidates: [
        { id: "phase1-plan", vectorSim: 0.70306559207713 },
        { id: "phase1-shipped", vectorSim: 0.7393617024327414 },
        { id: "phase2-ranking-assertions", vectorSim: 0.6777632180111552 },
      ],
      ftsCandidates: [
        { id: "phase1-plan", rank: 1, tier: "all_tokens" },
        { id: "phase1-shipped", rank: 0.5, tier: "all_tokens" },
        { id: "phase2-ranking-assertions", rank: 2, tier: "all_tokens" },
      ],
    });

    const historicalResults = await recall(
      {
        text: "what was the earlier plan for the memory freshness eval corpus before phase 1 shipped",
        limit: 5,
        rankingProfile: "historical_state",
      },
      fixture.ports,
    );

    expect(historicalResults.map((result) => result.entry.id)).toEqual(["phase1-plan", "phase1-shipped", "phase2-ranking-assertions"]);
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

  it("does not apply same-slot redundancy shaping to multivalued claim families", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "dependency-sqlite",
          subject: "runtime dependency",
          content: "SQLite is a supported runtime dependency for local development.",
          claim_key: "runtime/dependency",
          claim_key_status: "trusted",
          created_at: "2026-03-20T09:00:00.000Z",
        }),
        buildEntry({
          id: "dependency-libsql",
          subject: "runtime dependency",
          content: "libSQL is also a supported runtime dependency for local development.",
          claim_key: "runtime/dependency",
          claim_key_status: "trusted",
          created_at: "2026-03-19T09:00:00.000Z",
        }),
        buildEntry({
          id: "dependency-docs",
          subject: "dependency docs",
          content: "Document runtime dependencies in the setup guide.",
          created_at: "2026-03-18T09:00:00.000Z",
        }),
      ],
      vectorCandidates: [
        { id: "dependency-sqlite", vectorSim: 0.74 },
        { id: "dependency-libsql", vectorSim: 0.72 },
        { id: "dependency-docs", vectorSim: 0.7 },
      ],
    });

    const results = await recall(
      {
        text: "runtime dependency",
        limit: 5,
      },
      fixture.ports,
    );

    expect(results.map((result) => result.entry.id)).toEqual(["dependency-sqlite", "dependency-libsql", "dependency-docs"]);
    expect(results[0]?.scores.claimKeyRedundancyPenalty).toBe(0);
    expect(results[1]?.scores.claimKeyRedundancyPenalty).toBe(0);
  });

  it("uses validity windows first when resolving an explicit as-of reference", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "approach-old",
          subject: "deployment approach",
          content: "Webpack was the deployment approach before the migration.",
          claim_key: "deployment/approach",
          claim_key_status: "trusted",
          valid_from: "2026-02-01T00:00:00.000Z",
          valid_to: "2026-03-20T00:00:00.000Z",
          superseded_by: "approach-new",
          created_at: "2026-02-01T00:00:00.000Z",
        }),
        buildEntry({
          id: "approach-new",
          subject: "deployment approach",
          content: "Vite is the deployment approach after the migration.",
          claim_key: "deployment/approach",
          claim_key_status: "trusted",
          valid_from: "2026-03-20T00:00:00.000Z",
          created_at: "2026-03-20T00:00:00.000Z",
        }),
      ],
      vectorCandidates: [
        { id: "approach-old", vectorSim: 0.71 },
        { id: "approach-new", vectorSim: 0.71 },
      ],
    });

    const results = await recall(
      {
        text: "deployment approach",
        asOf: "2026-03-01T00:00:00.000Z",
        limit: 5,
      },
      fixture.ports,
    );

    expect(results.map((result) => result.entry.id)).toEqual(["approach-old", "approach-new"]);
    expect(results[0]?.scores.recency).toBeGreaterThan(results[1]?.scores.recency ?? 0);
  });

  it("falls back to support observation time before created-at for explicit as-of ranking", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "timezone-observed",
          subject: "Jim timezone",
          content: "Jim's timezone is America/Denver.",
          claim_key: "jim/timezone",
          claim_key_status: "trusted",
          claim_support_observed_at: "2026-03-01T00:00:00.000Z",
          created_at: "2026-03-20T00:00:00.000Z",
        }),
        buildEntry({
          id: "timezone-created",
          subject: "Jim timezone",
          content: "Jim's timezone is America/Chicago.",
          claim_key: "jim/timezone",
          claim_key_status: "trusted",
          created_at: "2026-02-01T00:00:00.000Z",
        }),
      ],
      vectorCandidates: [
        { id: "timezone-observed", vectorSim: 0.7 },
        { id: "timezone-created", vectorSim: 0.7 },
      ],
    });

    const results = await recall(
      {
        text: "Jim timezone",
        asOf: "2026-03-02T00:00:00.000Z",
        limit: 5,
      },
      fixture.ports,
    );

    expect(results.map((result) => result.entry.id)).toEqual(["timezone-observed", "timezone-created"]);
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
  predecessorCandidateIds?: string[];
  embedError?: Error;
  vectorSearchError?: Error;
}): {
  ports: RecallPorts;
  recordRecallEvents: ReturnType<typeof vi.fn>;
  fetchPredecessors: ReturnType<typeof vi.fn>;
} {
  const entriesById = new Map(params.entries.map((entry) => [entry.id, entry]));
  const recordRecallEvents = vi.fn(async () => undefined);
  const fetchPredecessors = vi.fn(async () => (params.predecessorCandidateIds ?? []).map((id) => toRecallCandidateEntry(requireEntry(entriesById, id))));
  const ports: RecallPorts = {
    embed: async (): Promise<number[]> => {
      if (params.embedError) {
        throw params.embedError;
      }
      return [1, 0, 0];
    },
    vectorSearch: async (): Promise<VectorCandidate[]> => {
      if (params.vectorSearchError) {
        throw params.vectorSearchError;
      }
      return params.vectorCandidates.map((candidate) => ({
        entry: toRecallCandidateEntry(requireEntry(entriesById, candidate.id)),
        vectorSim: candidate.vectorSim,
      }));
    },
    ftsSearch: async (): Promise<FtsCandidate[]> =>
      (params.ftsCandidates ?? []).map((candidate) => ({
        entry: toRecallCandidateEntry(requireEntry(entriesById, candidate.id)),
        rank: candidate.rank,
        tier: candidate.tier,
      })),
    fetchPredecessors,
    hydrateEntries: async (ids: string[]): Promise<Entry[]> => ids.map((id) => requireEntry(entriesById, id)),
    recordRecallEvents,
  };

  return {
    ports,
    recordRecallEvents,
    fetchPredecessors,
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
    superseded_by: entry.superseded_by,
    claim_key: entry.claim_key,
    claim_key_status: entry.claim_key_status,
    claim_support_observed_at: entry.claim_support_observed_at,
    valid_from: entry.valid_from,
    valid_to: entry.valid_to,
    retired: entry.retired,
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
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    claim_key_status: overrides.claim_key_status,
    claim_support_observed_at: overrides.claim_support_observed_at,
    cluster_id: overrides.cluster_id,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/**
 * Builds a normalized 3D embedding with a known cosine similarity to `[1, 0, 0]`.
 *
 * @param similarity - Desired cosine similarity to the fixture query embedding.
 * @returns Unit-length embedding vector.
 */
function createCosineEmbedding(similarity: number): number[] {
  return [similarity, Math.sqrt(1 - similarity ** 2), 0];
}
