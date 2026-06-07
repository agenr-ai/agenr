import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEEDED_RERANK_WEIGHT,
  DEFAULT_STRONG_SEED_SCORE_GAP,
  DEFAULT_STRONG_SEED_TOP_N,
  seededRerank,
  selectStrongSeeds,
  sharesDurableLineage,
  sharesEpisodeLineage,
  sharesProcedureLineage,
} from "../../../src/core/recall/neighborhood.js";
import type { Episode, Procedure } from "../../../src/core/types.js";
import type { RecallCandidateDurable } from "../../../src/core/recall/types.js";

describe("selectStrongSeeds", () => {
  it("returns no seeds when the candidate list is empty", () => {
    expect(selectStrongSeeds([])).toEqual([]);
  });

  it("returns no seeds when the score landscape is flat", () => {
    const candidates = [
      { id: "a", score: 0.5 },
      { id: "b", score: 0.5 },
      { id: "c", score: 0.5 },
      { id: "d", score: 0.5 },
    ];

    expect(selectStrongSeeds(candidates)).toEqual([]);
  });

  it("returns only candidates that sit within the score gap floor of the leader", () => {
    const candidates = [
      { id: "a", score: 0.9 },
      { id: "b", score: 0.88 },
      { id: "c", score: 0.86 },
      { id: "d", score: 0.2 },
      { id: "e", score: 0.1 },
    ];

    const seeds = selectStrongSeeds(candidates, { topN: DEFAULT_STRONG_SEED_TOP_N, scoreGapFloor: DEFAULT_STRONG_SEED_SCORE_GAP });
    expect(seeds.map((seed) => seed.id)).toEqual(["a", "b", "c"]);
  });

  it("drops followers that sit below the leader-floor cutoff", () => {
    const candidates = [
      { id: "a", score: 0.9 },
      { id: "b", score: 0.87 },
      { id: "c", score: 0.2 },
      { id: "d", score: 0.19 },
    ];

    const seeds = selectStrongSeeds(candidates, { topN: 3, scoreGapFloor: 0.05 });
    expect(seeds.map((seed) => seed.id)).toEqual(["a", "b"]);
  });

  it("returns no seeds when the leader does not stand apart from the pack", () => {
    const candidates = [
      { id: "a", score: 0.72 },
      { id: "b", score: 0.71 },
      { id: "c", score: 0.7 },
      { id: "d", score: 0.69 },
    ];

    const seeds = selectStrongSeeds(candidates, { topN: 3, scoreGapFloor: 0.1 });
    expect(seeds).toEqual([]);
  });
});

describe("seededRerank", () => {
  it("is a no-op when there are no seeds", () => {
    const candidates = [
      { id: "a", score: 0.6 },
      { id: "b", score: 0.4 },
    ];

    const result = seededRerank(candidates, [], () => true);
    expect(result.candidates).toEqual(candidates);
    expect(result.boostedIds).toEqual([]);
  });

  it("boosts only lineage-matched candidates and never the seeds themselves", () => {
    const seeds = [{ id: "seed", score: 0.9, group: "x" }];
    const candidates = [
      { id: "seed", score: 0.9, group: "x" },
      { id: "lineage-match", score: 0.5, group: "x" },
      { id: "unrelated", score: 0.4, group: "y" },
    ];

    const result = seededRerank(candidates, seeds, (candidate, seed) => candidate.group === seed.group);

    expect(result.boostedIds).toEqual(["lineage-match"]);
    const matched = result.candidates.find((candidate) => candidate.id === "lineage-match");
    const unrelated = result.candidates.find((candidate) => candidate.id === "unrelated");
    const seed = result.candidates.find((candidate) => candidate.id === "seed");
    expect(matched?.score).toBeCloseTo(0.5 + DEFAULT_SEEDED_RERANK_WEIGHT, 5);
    expect(unrelated?.score).toBe(0.4);
    expect(seed?.score).toBe(0.9);
  });

  it("never lifts the score of a candidate that has no lineage relationship", () => {
    const seeds = [{ id: "seed", score: 0.95, group: "x" }];
    const candidates = [{ id: "orphan", score: 0.6, group: "z" }];

    const result = seededRerank(candidates, seeds, (candidate, seed) => candidate.group === seed.group);
    expect(result.boostedIds).toEqual([]);
    expect(result.candidates[0]?.score).toBe(0.6);
  });

  it("clamps the boosted score into the supported 0-1 range", () => {
    const seeds = [{ id: "seed", score: 0.99, group: "x" }];
    const candidates = [{ id: "lineage-match", score: 0.995, group: "x" }];

    const result = seededRerank(candidates, seeds, (candidate, seed) => candidate.group === seed.group, { weight: 0.5 });
    expect(result.candidates[0]?.score).toBe(1);
  });
});

describe("sharesDurableLineage", () => {
  const baseEntry: RecallCandidateDurable = {
    id: "base",
    subject: "webpack deployment packaging",
    content: "",
    importance: 5,
    expiry: "permanent",
    created_at: "2026-01-01T00:00:00.000Z",
  };

  it("matches when two entries share a claim key", () => {
    const left = { ...baseEntry, id: "a", claim_key: "deployments/packaging" };
    const right = { ...baseEntry, id: "b", subject: "other subject", claim_key: "deployments/packaging" };
    expect(sharesDurableLineage(left, right)).toBe(true);
  });

  it("matches when one entry is superseded by the other", () => {
    const left = { ...baseEntry, id: "old", superseded_by: "new" };
    const right = { ...baseEntry, id: "new" };
    expect(sharesDurableLineage(left, right)).toBe(true);
    expect(sharesDurableLineage(right, left)).toBe(true);
  });

  it("matches when entries share a strong subject prefix", () => {
    const left = { ...baseEntry, id: "a", subject: "deployment packaging pipeline notes" };
    const right = { ...baseEntry, id: "b", subject: "deployment packaging retrospective" };
    expect(sharesDurableLineage(left, right)).toBe(true);
  });

  it("does not match unrelated subjects without claim keys", () => {
    const left = { ...baseEntry, id: "a", subject: "completely different topic" };
    const right = { ...baseEntry, id: "b", subject: "another unrelated subject" };
    expect(sharesDurableLineage(left, right)).toBe(false);
  });

  it("never treats an entry as sharing lineage with itself", () => {
    const entry = { ...baseEntry, id: "self", claim_key: "slot/x" };
    expect(sharesDurableLineage(entry, entry)).toBe(false);
  });
});

describe("sharesEpisodeLineage", () => {
  const baseEpisode: Episode = {
    id: "base",
    source: "cli",
    sourceId: undefined,
    transcriptHash: undefined,
    summary: "",
    tags: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("matches when two episodes share the same source plus sourceId", () => {
    const left: Episode = { ...baseEpisode, id: "a", sourceId: "session-1" };
    const right: Episode = { ...baseEpisode, id: "b", sourceId: "session-1" };
    expect(sharesEpisodeLineage(left, right)).toBe(true);
  });

  it("falls back to transcript hash when sourceId is missing", () => {
    const left: Episode = { ...baseEpisode, id: "a", transcriptHash: "hash-abc" };
    const right: Episode = { ...baseEpisode, id: "b", transcriptHash: "hash-abc" };
    expect(sharesEpisodeLineage(left, right)).toBe(true);
  });

  it("does not match when sources differ even with the same sourceId", () => {
    const left: Episode = { ...baseEpisode, id: "a", source: "cli", sourceId: "shared" };
    const right: Episode = { ...baseEpisode, id: "b", source: "openclaw", sourceId: "shared" };
    expect(sharesEpisodeLineage(left, right)).toBe(false);
  });
});

describe("sharesProcedureLineage", () => {
  const baseProcedure: Procedure = {
    id: "base",
    procedure_key: "release/cut-release",
    title: "",
    goal: "",
    when_to_use: [],
    when_not_to_use: [],
    prerequisites: [],
    steps: [],
    verification: [],
    failure_modes: [],
    sources: [],
    recall_text: "",
    revision_hash: "",
    source_hash: "",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("matches when both procedures share the procedure key", () => {
    const left: Procedure = { ...baseProcedure, id: "a", procedure_key: "release/cut-release" };
    const right: Procedure = { ...baseProcedure, id: "b", procedure_key: "release/cut-release" };
    expect(sharesProcedureLineage(left, right)).toBe(true);
  });

  it("does not match when procedure keys differ", () => {
    const left: Procedure = { ...baseProcedure, id: "a", procedure_key: "release/cut-release" };
    const right: Procedure = { ...baseProcedure, id: "b", procedure_key: "release/hotfix" };
    expect(sharesProcedureLineage(left, right)).toBe(false);
  });
});
