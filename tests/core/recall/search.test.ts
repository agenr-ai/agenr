import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CrossEncoderPort, RecallPorts } from "../../../src/core/ports.js";
import type { Durable } from "../../../src/core/types.js";
import { recall } from "../../../src/core/recall/search.js";
import type { RecallExecutionTraceSummary } from "../../../src/core/recall/trace.js";
import type { EntityAttributeKind, FtsCandidate, RecallCandidateDurable, VectorCandidate } from "../../../src/core/recall/types.js";

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

  it("keeps degraded lexical ranking useful for non-ASCII queries", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "cafe-policy",
          type: "decision",
          subject: "café policy",
          content: "The café policy requires badge access after hours.",
        }),
      ],
      vectorCandidates: [],
      ftsCandidates: [{ id: "cafe-policy", rank: 1, tier: "all_tokens" }],
      embedError: new Error("embedding unavailable"),
    });

    const results = await recall(
      {
        text: "café policy",
        limit: 5,
      },
      fixture.ports,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.entry.id).toBe("cafe-policy");
    expect(results[0]?.scores.lexical).toBeGreaterThan(0.9);
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

  it("keeps a strong vector-only match for a non-reminder query when the raw similarity is meaningful", async () => {
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
        text: "artifact preservation",
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
      query: "artifact preservation",
      sessionKey: undefined,
    });
  });

  it("rejects lexical overlap that comes only from weak conversational grounding tokens", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "memory-trigger",
          subject: "memory trigger phrase",
          content: "Saying remember this saves the current context.",
          embedding: createCosineEmbedding(0.36),
        }),
        buildEntry({
          id: "workflow-order",
          subject: "workflow cleanup order",
          content: "Cleanup order matters when shared handles stay open.",
          embedding: createCosineEmbedding(0.34),
        }),
      ],
      vectorCandidates: [
        { id: "memory-trigger", vectorSim: 0.36 },
        { id: "workflow-order", vectorSim: 0.34 },
      ],
      ftsCandidates: [
        { id: "memory-trigger", rank: 1, tier: "any_tokens" },
        { id: "workflow-order", rank: 2, tier: "any_tokens" },
      ],
    });

    const results = await recall(
      {
        text: "what coffee order should I remember",
        limit: 5,
      },
      fixture.ports,
    );

    expect(results).toEqual([]);
  });

  it("abstains on reminder-style queries that have no grounded lexical anchor", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "path-precedence",
          subject: "global binary path precedence",
          content: "The earlier CLI on PATH wins.",
          embedding: createCosineEmbedding(0.22),
        }),
        buildEntry({
          id: "branch-testing",
          subject: "guard branch testing",
          content: "Earlier guards can mask later test branches.",
          embedding: createCosineEmbedding(0.25),
        }),
      ],
      vectorCandidates: [
        { id: "branch-testing", vectorSim: 0.25 },
        { id: "path-precedence", vectorSim: 0.22 },
      ],
      ftsCandidates: [
        { id: "path-precedence", rank: 1, tier: "any_tokens" },
        { id: "branch-testing", rank: 2, tier: "any_tokens" },
      ],
    });

    const results = await recall(
      {
        text: "can you remind me about the thing from earlier",
        limit: 5,
      },
      fixture.ports,
    );

    expect(results).toEqual([]);
  });

  it("does not treat generic numbering terms as grounding for reminder-style no-result queries", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "prompt-style",
          subject: "codex prompt style",
          content: "Number the prompts and point them back to the plan doc.",
          embedding: createCosineEmbedding(0.22),
        }),
        buildEntry({
          id: "numbered-lists",
          subject: "numbered list usage",
          content: "Use numbered lists when the user needs to refer back by number.",
          embedding: createCosineEmbedding(0.25),
        }),
      ],
      vectorCandidates: [
        { id: "numbered-lists", vectorSim: 0.25 },
        { id: "prompt-style", vectorSim: 0.22 },
      ],
      ftsCandidates: [
        { id: "prompt-style", rank: 1, tier: "any_tokens" },
        { id: "numbered-lists", rank: 2, tier: "any_tokens" },
      ],
    });

    const results = await recall(
      {
        text: "what hotel room number did I mention last time",
        limit: 5,
      },
      fixture.ports,
    );

    expect(results).toEqual([]);
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

  it("rejects weak entity-attribute distractors that only match identity or the base entity name", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "git-identity",
          subject: "agenr git identity",
          content: "Use the repo git identity for signed commits.",
        }),
        buildEntry({
          id: "jim-email",
          subject: "jim martin work email",
          content: "Jim Martin uses jim@example.com for work mail.",
        }),
      ],
      vectorCandidates: [
        { id: "git-identity", vectorSim: 0.79 },
        { id: "jim-email", vectorSim: 0.77 },
      ],
      ftsCandidates: [
        { id: "git-identity", rank: 1, tier: "any_tokens" },
        { id: "jim-email", rank: 2, tier: "any_tokens" },
      ],
    });

    const results = await recall(
      {
        text: "Where does Jim Martin's dad live? identity and location",
        limit: 6,
        threshold: 0.2,
        rankingProfile: "entity_attribute",
        queryShape: buildEntityAttributeQueryShape("Jim Martin's dad", "location"),
      },
      fixture.ports,
    );

    expect(results).toEqual([]);
  });

  it("keeps the location-bearing family entry for a narrow entity-attribute query", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "jim-dad-location",
          subject: "Jim Martin dad location",
          content: "Jim Martin's dad lives in Austin, Texas.",
        }),
        buildEntry({
          id: "jim-identity",
          subject: "Jim Martin skunk identity",
          content: "Jim Martin's skunk is named Pepper.",
        }),
      ],
      vectorCandidates: [
        { id: "jim-dad-location", vectorSim: 0.83 },
        { id: "jim-identity", vectorSim: 0.81 },
      ],
      ftsCandidates: [
        { id: "jim-identity", rank: 1, tier: "any_tokens" },
        { id: "jim-dad-location", rank: 2, tier: "all_tokens" },
      ],
    });

    const results = await recall(
      {
        text: "Where does Jim Martin's dad live?",
        limit: 6,
        threshold: 0.2,
        rankingProfile: "entity_attribute",
        queryShape: buildEntityAttributeQueryShape("Jim Martin's dad", "location"),
      },
      fixture.ports,
    );

    expect(results.map((result) => result.entry.id)).toEqual(["jim-dad-location"]);
  });

  it("keeps identity wrapper subjects working for entity-definition queries", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "duke-identity",
          subject: "Duke identity",
          content: "Duke is Jim Martin's dog.",
        }),
        buildEntry({
          id: "duke-family",
          subject: "Duke family notes",
          content: "Duke likes visiting Jim Martin's parents.",
        }),
      ],
      vectorCandidates: [
        { id: "duke-family", vectorSim: 0.76 },
        { id: "duke-identity", vectorSim: 0.72 },
      ],
      ftsCandidates: [
        { id: "duke-family", rank: 1, tier: "any_tokens" },
        { id: "duke-identity", rank: 2, tier: "all_tokens" },
      ],
    });

    const results = await recall(
      {
        text: "who is Duke?",
        limit: 3,
        threshold: 0.2,
        rankingProfile: "entity_attribute",
        queryShape: buildEntityAttributeQueryShape("Duke", "identity"),
      },
      fixture.ports,
    );

    expect(results.map((result) => result.entry.id)).toEqual(["duke-identity"]);
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
    // Only the historical profile requests neighborhood expansion. The default
    // profile already filters superseded rows out during retrieval, so there
    // is nothing useful to expand toward.
    expect(fixture.expandNeighborhood).toHaveBeenCalledTimes(1);
    expect(fixture.expandNeighborhood).toHaveBeenCalledWith({
      seedIds: ["dev-recall-command"],
      budget: expect.any(Number),
      families: ["supersession_chain", "claim_key_sibling", "topic_family"],
      includeRetired: true,
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
      {
        // Opt this three-candidate pool out of the phase-4 small-pool
        // RRF sharpening so the fixed trusted-sibling redundancy penalty
        // still dominates the rank-1 vs. rank-2 relevance gap. Sharpened
        // relevance scores on pools this narrow would widen the gap past
        // the phase-3 calibrated penalty magnitude, flipping the order
        // this test is specifically designed to verify.
        rankingPolicy: { rrfSmallPoolRankConstant: 60 },
      },
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

  it("flips the superseded trusted predecessor above an RRF-dominant successor in historical_state", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "approach-old",
          type: "decision",
          subject: "deployment approach",
          content: "Webpack was the previous deployment approach before the migration.",
          claim_key: "deployment/approach",
          claim_key_status: "trusted",
          created_at: "2026-02-01T00:00:00.000Z",
          superseded_by: "approach-new",
        }),
        buildEntry({
          id: "approach-new",
          type: "decision",
          subject: "deployment approach",
          content: "The current deployment approach uses vite after the migration.",
          claim_key: "deployment/approach",
          claim_key_status: "trusted",
          created_at: "2026-03-20T00:00:00.000Z",
        }),
      ],
      vectorCandidates: [{ id: "approach-new", vectorSim: 0.69 }],
      ftsCandidates: [{ id: "approach-new", rank: 1, tier: "all_tokens" }],
      predecessorCandidateIds: ["approach-old"],
    });

    const historicalResults = await recall(
      {
        text: "what was the previous deployment approach",
        limit: 2,
        rankingProfile: "historical_state",
      },
      fixture.ports,
    );

    expect(historicalResults.map((result) => result.entry.id)).toEqual(["approach-old", "approach-new"]);
    const predecessor = historicalResults[0];
    const successor = historicalResults[1];
    expect(predecessor?.scores.rrf).toBeLessThan(successor?.scores.rrf ?? Infinity);
    expect(predecessor?.scores.historicalLineage).toBeGreaterThan(0.08);
    expect((predecessor?.score ?? 0) - (successor?.score ?? 0)).toBeGreaterThanOrEqual(0.02);
  });

  it("keeps the current entry first under the default profile even when the pool has a direct predecessor", async () => {
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "approach-old",
          type: "decision",
          subject: "deployment approach",
          content: "Webpack was the previous deployment approach before the migration.",
          claim_key: "deployment/approach",
          claim_key_status: "trusted",
          created_at: "2026-02-01T00:00:00.000Z",
          superseded_by: "approach-new",
        }),
        buildEntry({
          id: "approach-new",
          type: "decision",
          subject: "deployment approach",
          content: "The current deployment approach uses vite after the migration.",
          claim_key: "deployment/approach",
          claim_key_status: "trusted",
          created_at: "2026-03-20T00:00:00.000Z",
        }),
      ],
      vectorCandidates: [
        { id: "approach-new", vectorSim: 0.7 },
        { id: "approach-old", vectorSim: 0.66 },
      ],
      ftsCandidates: [{ id: "approach-new", rank: 1, tier: "all_tokens" }],
    });

    const defaultResults = await recall(
      {
        text: "what is the deployment approach",
        limit: 2,
      },
      fixture.ports,
    );

    expect(defaultResults.map((result) => result.entry.id)).toEqual(["approach-new", "approach-old"]);
    expect(defaultResults.map((result) => result.scores.historicalLineage)).toEqual([0, 0]);
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

  it("records a default mmr trace branch when no embeddings are available on candidates", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "plain-entry",
          subject: "team rotation",
          content: "Taylor is on call this week.",
        }),
      ],
      vectorCandidates: [{ id: "plain-entry", vectorSim: 0.7 }],
      ftsCandidates: [{ id: "plain-entry", rank: 1, tier: "all_tokens" }],
    });

    await recall(
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

    expect(traceSummaries).toHaveLength(1);
    expect(traceSummaries[0]?.mmr).toEqual({
      applied: false,
      lambda: expect.closeTo(0.7, 6),
      droppedDuplicateCount: 0,
      reorderedIds: [],
    });
  });

  it("diversifies near-duplicate embeddings with MMR when lambda is low", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "primary",
          subject: "repeat finding",
          content: "First write-up of the finding.",
          embedding: createCosineEmbedding(0.9),
        }),
        buildEntry({
          id: "duplicate",
          subject: "repeat finding",
          content: "Slightly reworded write-up of the same finding.",
          embedding: createCosineEmbedding(0.9),
        }),
        buildEntry({
          id: "diverse",
          subject: "diverse finding",
          content: "A note on a different but related topic.",
          embedding: [0, 1, 0],
        }),
      ],
      vectorCandidates: [
        { id: "primary", vectorSim: 0.9 },
        { id: "duplicate", vectorSim: 0.9 },
        { id: "diverse", vectorSim: 0.4 },
      ],
    });

    await recall(
      {
        text: "repeat finding",
        limit: 5,
      },
      fixture.ports,
      {
        trace: {
          reportSummary(summary): void {
            traceSummaries.push(summary);
          },
        },
        rankingPolicy: {
          mmrLambda: 0.1,
          // The three-candidate synthetic pool falls under the phase-4
          // small-pool gate, so the test disables it to exercise MMR
          // itself; dedicated gate coverage lives in its own `it` block
          // below.
          mmrMinPoolSize: 0,
        },
      },
    );

    expect(traceSummaries).toHaveLength(1);
    expect(traceSummaries[0]?.mmr.applied).toBe(true);
    expect(traceSummaries[0]?.mmr.lambda).toBeCloseTo(0.1, 6);
    expect(traceSummaries[0]?.mmr.droppedDuplicateCount).toBeGreaterThan(0);
    expect(traceSummaries[0]?.mmr.reorderedIds.length).toBeGreaterThan(0);
  });

  it("treats rankingPolicy.mmr = disabled as a kill switch", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "primary",
          subject: "repeat finding",
          content: "First write-up of the finding.",
          embedding: createCosineEmbedding(0.9),
        }),
        buildEntry({
          id: "duplicate",
          subject: "repeat finding",
          content: "Slightly reworded write-up of the same finding.",
          embedding: createCosineEmbedding(0.9),
        }),
      ],
      vectorCandidates: [
        { id: "primary", vectorSim: 0.9 },
        { id: "duplicate", vectorSim: 0.9 },
      ],
    });

    await recall(
      {
        text: "repeat finding",
        limit: 5,
      },
      fixture.ports,
      {
        trace: {
          reportSummary(summary): void {
            traceSummaries.push(summary);
          },
        },
        rankingPolicy: {
          mmr: "disabled",
          mmrLambda: 0.1,
        },
      },
    );

    expect(traceSummaries).toHaveLength(1);
    expect(traceSummaries[0]?.mmr.applied).toBe(false);
    expect(traceSummaries[0]?.mmr.droppedDuplicateCount).toBe(0);
    expect(traceSummaries[0]?.mmr.reorderedIds).toEqual([]);
  });

  it("reorders the shortlist and records a trace when the cross-encoder is wired", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const rank = vi.fn<CrossEncoderPort["rank"]>(async (_query, passages) =>
      passages.map((passage) => ({
        // Favor the candidate the RRF ordering would otherwise place second.
        id: passage.id,
        score: passage.id === "runner-up" ? 0.95 : 0.1,
      })),
    );
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "leader",
          subject: "on call rotation",
          content: "Taylor is on call this week.",
        }),
        buildEntry({
          id: "runner-up",
          subject: "on call rotation swap",
          content: "The on call rotation swapped to Taylor last Monday.",
        }),
      ],
      vectorCandidates: [
        { id: "leader", vectorSim: 0.71 },
        { id: "runner-up", vectorSim: 0.69 },
      ],
      ftsCandidates: [
        { id: "leader", rank: 1, tier: "all_tokens" },
        { id: "runner-up", rank: 2, tier: "all_tokens" },
      ],
      crossEncoder: { rank },
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
        rankingPolicy: { crossEncoderAlpha: 1 },
      },
    );

    expect(results.map((result) => result.entry.id)).toEqual(["runner-up", "leader"]);
    expect(results[0]?.scores.crossEncoder).toBeCloseTo(0.95, 6);
    expect(results[1]?.scores.crossEncoder).toBeCloseTo(0.1, 6);
    expect(rank).toHaveBeenCalledTimes(1);
    expect(traceSummaries).toHaveLength(1);
    expect(traceSummaries[0]?.crossEncoder).toEqual(
      expect.objectContaining({
        applied: true,
        k: 2,
        alpha: expect.closeTo(1, 6),
        rescoredIds: expect.arrayContaining(["leader", "runner-up"]),
      }),
    );
    expect(traceSummaries[0]?.crossEncoder.degradedReason).toBeUndefined();
  });

  it("lets grounding break near-ties after cross-encoder reranking", async () => {
    const rank = vi.fn<CrossEncoderPort["rank"]>(async (_query, passages) =>
      passages.map((passage) => ({
        id: passage.id,
        score: passage.id === "codex-prefix" ? 0.90001 : 0.9,
      })),
    );
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "codex-prefix",
          subject: "codex branch naming",
          content: "Use the `codex/` prefix for Codex iteration branches in this repo.",
        }),
        buildEntry({
          id: "standard-prefixes",
          subject: "branch prefixes guide",
          content: "The branch prefixes to use are `feat/`, `fix/`, `chore/`, and `hotfix/`.",
        }),
      ],
      vectorCandidates: [
        { id: "codex-prefix", vectorSim: 0.7 },
        { id: "standard-prefixes", vectorSim: 0.69 },
      ],
      ftsCandidates: [
        { id: "standard-prefixes", rank: 1, tier: "all_tokens" },
        { id: "codex-prefix", rank: 2, tier: "all_tokens" },
      ],
      crossEncoder: { rank },
    });

    const results = await recall(
      {
        text: "what branch prefixes should I use",
        limit: 5,
      },
      fixture.ports,
      {
        rankingPolicy: { crossEncoderAlpha: 1 },
      },
    );

    expect(rank).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.entry.id)).toEqual(["standard-prefixes", "codex-prefix"]);
    expect(results[0]?.scores.crossEncoder).toBeCloseTo(0.9, 6);
    expect(results[1]?.scores.crossEncoder).toBeCloseTo(0.90001, 6);
  });

  it("uses lexical support to break canonicalized prefix near-ties after cross-encoder reranking", async () => {
    const rank = vi.fn<CrossEncoderPort["rank"]>(async (_query, passages) =>
      passages.map((passage) => ({
        id: passage.id,
        score: passage.id === "singular-prefix" ? 0.90001 : 0.9,
      })),
    );
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "singular-prefix",
          subject: "codex branch naming",
          content: "Use the `codex/` branch prefix for Codex iteration work.",
        }),
        buildEntry({
          id: "plural-prefixes",
          subject: "branch naming convention",
          content: "Use `feat/`, `fix/`, `chore/`, and `hotfix/` as the standard branch prefixes going forward.",
        }),
      ],
      vectorCandidates: [
        { id: "singular-prefix", vectorSim: 0.7 },
        { id: "plural-prefixes", vectorSim: 0.69 },
      ],
      ftsCandidates: [
        { id: "plural-prefixes", rank: 1, tier: "all_tokens" },
        { id: "singular-prefix", rank: 2, tier: "all_tokens" },
      ],
      crossEncoder: { rank },
    });

    const results = await recall(
      {
        text: "what branch prefixes should I use",
        limit: 5,
      },
      fixture.ports,
      {
        rankingPolicy: { crossEncoderAlpha: 1 },
      },
    );

    expect(rank).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.entry.id)).toEqual(["plural-prefixes", "singular-prefix"]);
    expect(results[0]?.scores.lexical).toBeGreaterThan(results[1]?.scores.lexical ?? 0);
  });

  it("records `not_configured` in the cross-encoder trace when no port is wired", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "lone-entry",
          subject: "on call rotation",
          content: "Taylor is on call this week.",
        }),
      ],
      vectorCandidates: [{ id: "lone-entry", vectorSim: 0.7 }],
      ftsCandidates: [{ id: "lone-entry", rank: 1, tier: "all_tokens" }],
    });

    await recall(
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

    expect(traceSummaries).toHaveLength(1);
    expect(traceSummaries[0]?.crossEncoder).toEqual(
      expect.objectContaining({
        applied: false,
        degradedReason: "not_configured",
        rescoredIds: [],
      }),
    );
  });

  it("short-circuits the cross-encoder when rankingPolicy.crossEncoder is disabled", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const rank = vi.fn<CrossEncoderPort["rank"]>(async () => []);
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "leader",
          subject: "on call rotation",
          content: "Taylor is on call this week.",
        }),
        buildEntry({
          id: "runner-up",
          subject: "on call rotation swap",
          content: "The on call rotation swapped to Taylor last Monday.",
        }),
      ],
      vectorCandidates: [
        { id: "leader", vectorSim: 0.71 },
        { id: "runner-up", vectorSim: 0.69 },
      ],
      crossEncoder: { rank },
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
        rankingPolicy: { crossEncoder: "disabled" },
      },
    );

    expect(rank).not.toHaveBeenCalled();
    expect(results.map((result) => result.entry.id)).toEqual(["leader", "runner-up"]);
    expect(traceSummaries[0]?.crossEncoder).toEqual(
      expect.objectContaining({
        applied: false,
        degradedReason: "disabled",
      }),
    );
    expect(results[0]?.scores.crossEncoder).toBeUndefined();
  });

  it("falls back to the pre-rerank ordering when the cross-encoder port throws", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const rank = vi.fn<CrossEncoderPort["rank"]>(async () => {
      throw new Error("rate limit");
    });
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "leader",
          subject: "on call rotation",
          content: "Taylor is on call this week.",
        }),
        buildEntry({
          id: "runner-up",
          subject: "on call rotation swap",
          content: "The on call rotation swapped to Taylor last Monday.",
        }),
      ],
      vectorCandidates: [
        { id: "leader", vectorSim: 0.71 },
        { id: "runner-up", vectorSim: 0.69 },
      ],
      ftsCandidates: [
        { id: "leader", rank: 1, tier: "all_tokens" },
        { id: "runner-up", rank: 2, tier: "all_tokens" },
      ],
      crossEncoder: { rank },
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

    expect(rank).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.entry.id)).toEqual(["leader", "runner-up"]);
    expect(results.every((result) => result.scores.crossEncoder === undefined)).toBe(true);
    expect(traceSummaries[0]?.crossEncoder).toEqual(
      expect.objectContaining({
        applied: false,
        degradedReason: "provider_error",
      }),
    );
  });

  it("only reranks the configured top-K shortlist", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const rankedIds: string[][] = [];
    const rank = vi.fn<CrossEncoderPort["rank"]>(async (_query, passages) => {
      rankedIds.push(passages.map((passage) => passage.id));
      return passages.map((passage) => ({ id: passage.id, score: 0.5 }));
    });
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({ id: "a", subject: "topic a", content: "Taylor is on call this week a." }),
        buildEntry({ id: "b", subject: "topic b", content: "Taylor is on call this week b." }),
        buildEntry({ id: "c", subject: "topic c", content: "Taylor is on call this week c." }),
      ],
      vectorCandidates: [
        { id: "a", vectorSim: 0.72 },
        { id: "b", vectorSim: 0.7 },
        { id: "c", vectorSim: 0.68 },
      ],
      crossEncoder: { rank },
    });

    await recall(
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
        rankingPolicy: { crossEncoderTopK: 2 },
      },
    );

    expect(rankedIds).toEqual([["a", "b"]]);
    expect(traceSummaries[0]?.crossEncoder.k).toBe(2);
  });

  it("sharpens the RRF rank constant on small fused pools by default", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "alpha",
          subject: "alpha note",
          content: "Alpha content.",
          embedding: createCosineEmbedding(0.9),
        }),
        buildEntry({
          id: "beta",
          subject: "beta note",
          content: "Beta content.",
          embedding: createCosineEmbedding(0.6),
        }),
      ],
      vectorCandidates: [
        { id: "alpha", vectorSim: 0.9 },
        { id: "beta", vectorSim: 0.6 },
      ],
    });

    await recall(
      {
        text: "alpha beta",
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

    expect(traceSummaries).toHaveLength(1);
    // With the phase-4 small-pool sharpening in place, the trace reports
    // the small-pool constant (8 by default) instead of the paper's k=60
    // when the fused pool is narrow enough to compress rank differences.
    expect(traceSummaries[0]?.rrf.rankConstant).toBeLessThan(60);
    expect(traceSummaries[0]?.rrf.rankConstant).toBeGreaterThan(0);
  });

  it("honors rrfSmallPoolRankConstant override on small pools", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "alpha",
          subject: "alpha note",
          content: "Alpha content.",
          embedding: createCosineEmbedding(0.9),
        }),
        buildEntry({
          id: "beta",
          subject: "beta note",
          content: "Beta content.",
          embedding: createCosineEmbedding(0.6),
        }),
      ],
      vectorCandidates: [
        { id: "alpha", vectorSim: 0.9 },
        { id: "beta", vectorSim: 0.6 },
      ],
    });

    await recall(
      {
        text: "alpha beta",
        limit: 5,
      },
      fixture.ports,
      {
        trace: {
          reportSummary(summary): void {
            traceSummaries.push(summary);
          },
        },
        rankingPolicy: {
          rrfSmallPoolRankConstant: 12,
        },
      },
    );

    expect(traceSummaries[0]?.rrf.rankConstant).toBe(12);
  });

  it("keeps k=60 on small pools when the caller sets rrfRankConstant without a small-pool override", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "alpha",
          subject: "alpha note",
          content: "Alpha content.",
          embedding: createCosineEmbedding(0.9),
        }),
      ],
      vectorCandidates: [{ id: "alpha", vectorSim: 0.9 }],
    });

    await recall(
      {
        text: "alpha",
        limit: 5,
      },
      fixture.ports,
      {
        trace: {
          reportSummary(summary): void {
            traceSummaries.push(summary);
          },
        },
        rankingPolicy: {
          rrfRankConstant: 45,
        },
      },
    );

    expect(traceSummaries[0]?.rrf.rankConstant).toBe(45);
  });

  it("keeps the vector-preferred top-1 on a small pool where a recency-favored peer used to flip it (phase-4 RRF regression)", async () => {
    // Regression mirror of row 1 in
    // docs/internal/recall/regression-attribution.md: a small two-candidate
    // pool where the pre-phase-4 k=60 rank compression allowed a more
    // recent but semantically weaker neighbor to beat the vector-preferred
    // leader. Sharpening the RRF rank constant on small pools keeps the
    // leader on top.
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "leader",
          subject: "deployment owner",
          content: "Taylor owns the deployment handoff.",
          embedding: createCosineEmbedding(0.95),
          created_at: "2026-02-15T00:00:00.000Z",
        }),
        buildEntry({
          id: "recent-neighbor",
          subject: "deployment note",
          content: "Jamie sent a short note about deployment logistics.",
          embedding: createCosineEmbedding(0.75),
          created_at: "2026-03-25T12:00:00.000Z",
        }),
      ],
      vectorCandidates: [
        { id: "leader", vectorSim: 0.95 },
        { id: "recent-neighbor", vectorSim: 0.75 },
      ],
    });

    const results = await recall(
      {
        text: "who owns the deployment handoff",
        limit: 5,
      },
      fixture.ports,
    );

    expect(results[0]?.entry.id).toBe("leader");
  });

  it("keeps the ranked leader intact on a three-candidate pool with a semantically distant but embeddings-diverse peer (phase-4 MMR regression)", async () => {
    // Regression mirror of the `mmr_induced` rows (e.g., row 7) in
    // docs/internal/recall/regression-attribution.md: MMR's diversity
    // penalty used to promote an orthogonal but topically unrelated
    // neighbor above the intended top-1 when the shortlist was tiny.
    // The phase-4 small-pool gate skips MMR on pools of this size.
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "leader",
          subject: "pager policy",
          content: "Jordan is on call this week.",
          embedding: createCosineEmbedding(0.95),
        }),
        buildEntry({
          id: "near-neighbor",
          subject: "pager policy note",
          content: "Jordan holds the pager through Friday.",
          embedding: createCosineEmbedding(0.9),
        }),
        buildEntry({
          id: "diverse-distractor",
          subject: "office snacks",
          content: "The office is out of almonds.",
          embedding: [0, 1, 0],
        }),
      ],
      vectorCandidates: [
        { id: "leader", vectorSim: 0.95 },
        { id: "near-neighbor", vectorSim: 0.9 },
        { id: "diverse-distractor", vectorSim: 0.2 },
      ],
    });

    const results = await recall(
      {
        text: "who is on call",
        limit: 5,
      },
      fixture.ports,
      {
        trace: {
          reportSummary(summary): void {
            traceSummaries.push(summary);
          },
        },
        rankingPolicy: {
          // Keep MMR enabled with a diversity-leaning lambda to prove the
          // phase-4 gate prevents the diversity penalty from flipping the
          // leader; the assertion flips if the gate is removed.
          mmrLambda: 0.1,
        },
      },
    );

    expect(results[0]?.entry.id).toBe("leader");
    expect(traceSummaries[0]?.mmr.applied).toBe(false);
  });

  it("sorts the accepted MMR shortlist back into descending score order", async () => {
    const traceSummaries: RecallExecutionTraceSummary[] = [];
    const fixture = createRecallPortsFixture({
      entries: [
        buildEntry({
          id: "leader",
          subject: "branch naming convention",
          content: "Use feat/, fix/, chore/, and hotfix/ branch prefixes.",
          embedding: createCosineEmbedding(0.95),
        }),
        buildEntry({
          id: "near-1",
          subject: "branch workflow note",
          content: "Branch workflow note for nearby Git tasks.",
          embedding: createCosineEmbedding(0.94),
        }),
        buildEntry({
          id: "near-2",
          subject: "branch cleanup workflow",
          content: "Delete merged branches after review.",
          embedding: createCosineEmbedding(0.93),
        }),
        buildEntry({
          id: "diverse-mid",
          subject: "branch strategy discussion",
          content: "Branch strategy remains reviewable with standard prefixes.",
          embedding: [0, 1, 0],
        }),
        buildEntry({
          id: "tail",
          subject: "branch history note",
          content: "Historical note about earlier branch names.",
          embedding: [0, 0, 1],
        }),
      ],
      vectorCandidates: [
        { id: "leader", vectorSim: 0.95 },
        { id: "near-1", vectorSim: 0.94 },
        { id: "near-2", vectorSim: 0.93 },
        { id: "diverse-mid", vectorSim: 0.6 },
        { id: "tail", vectorSim: 0.2 },
      ],
      ftsCandidates: [
        { id: "leader", rank: 1, tier: "all_tokens" },
        { id: "near-1", rank: 2, tier: "all_tokens" },
        { id: "near-2", rank: 3, tier: "all_tokens" },
      ],
    });

    const results = await recall(
      {
        text: "what branch prefixes should I use",
        limit: 3,
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

    expect(traceSummaries[0]?.mmr.applied).toBe(true);
    expect(traceSummaries[0]?.mmr.reorderedIds.length ?? 0).toBeGreaterThan(0);
    expect(results.map((result) => result.score)).toEqual([...results.map((result) => result.score)].sort((left, right) => right - left));
    expect(results[0]?.entry.id).toBe("leader");
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
  entries: Durable[];
  vectorCandidates: Array<{ id: string; vectorSim: number }>;
  ftsCandidates?: Array<{ id: string; rank: number; tier: FtsCandidate["tier"] }>;
  predecessorCandidateIds?: string[];
  embedError?: Error;
  vectorSearchError?: Error;
  crossEncoder?: CrossEncoderPort;
}): {
  ports: RecallPorts;
  recordRecallEvents: ReturnType<typeof vi.fn>;
  expandNeighborhood: ReturnType<typeof vi.fn>;
} {
  const entriesById = new Map(params.entries.map((entry) => [entry.id, entry]));
  const recordRecallEvents = vi.fn(async () => undefined);
  const expandNeighborhood = vi.fn(async () => (params.predecessorCandidateIds ?? []).map((id) => toRecallCandidateDurable(requireEntry(entriesById, id))));
  // Mirror the production adapter's ordering contract so RRF fusion sees the
  // strongest vector candidate at rank 0 regardless of fixture declaration order.
  const sortedVectorCandidates = params.vectorCandidates.slice().sort((left, right) => right.vectorSim - left.vectorSim || left.id.localeCompare(right.id));
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
      return sortedVectorCandidates.map((candidate) => ({
        entry: toRecallCandidateDurable(requireEntry(entriesById, candidate.id)),
        vectorSim: candidate.vectorSim,
      }));
    },
    ftsSearch: async (): Promise<FtsCandidate[]> =>
      (params.ftsCandidates ?? []).map((candidate) => ({
        entry: toRecallCandidateDurable(requireEntry(entriesById, candidate.id)),
        rank: candidate.rank,
        tier: candidate.tier,
      })),
    expandNeighborhood,
    hydrateEntries: async (ids: string[]): Promise<Durable[]> => ids.map((id) => requireEntry(entriesById, id)),
    recordRecallEvents,
    ...(params.crossEncoder ? { crossEncoder: params.crossEncoder } : {}),
  };

  return {
    ports,
    recordRecallEvents,
    expandNeighborhood,
  };
}

/**
 * Converts a full entry into the minimal candidate payload used during scoring.
 *
 * @param entry - Hydrated entry fixture.
 * @returns Candidate entry view.
 */
function toRecallCandidateDurable(entry: Durable): RecallCandidateDurable {
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
function requireEntry(entriesById: Map<string, Durable>, id: string): Durable {
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
function buildEntry(overrides: Partial<Durable> & Pick<Durable, "id" | "subject" | "content">): Durable {
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
 * Builds a stable entity-attribute query shape for recall tests.
 *
 * @param entityText - Extracted entity text.
 * @param attributeKind - Supported attribute bucket.
 * @returns Structured query-shape fixture.
 */
function buildEntityAttributeQueryShape(entityText: string, attributeKind: EntityAttributeKind) {
  const attributeTokensByKind: Record<EntityAttributeKind, string[]> = {
    identity: ["identity", "profile", "bio", "biography", "summary"],
    location: ["location", "live", "lives", "reside", "resides", "located", "home", "city"],
    email: ["email", "e-mail", "mail"],
    phone: ["phone", "number", "mobile", "cell", "telephone"],
    address: ["address", "street", "mailing"],
  };

  return {
    kind: "entity_attribute" as const,
    entityText,
    normalizedEntity: entityText.normalize("NFKC").toLocaleLowerCase(),
    entityTokens:
      entityText
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu)
        ?.filter((token) => token.length >= 2 && !["is", "who", "where", "the", "a", "an", "does"].includes(token)) ?? [],
    attributeKind,
    attributeTokens: attributeTokensByKind[attributeKind],
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
