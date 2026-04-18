import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { runProcedureRecall } from "../../../../src/app/procedures/recall/index.js";
import { computeProcedureRevisionHash, computeProcedureSourceHash } from "../../../../src/core/procedures/hashing.js";
import { composeProcedureRecallText } from "../../../../src/core/procedures/recall-text.js";
import type { Procedure } from "../../../../src/core/types.js";

describe("runProcedureRecall", () => {
  it("returns a canonical lexical match for a natural-language release query", async () => {
    const release = createProcedure({
      procedure_key: "agenr/release",
      title: "Release agenr and publish packages",
      goal: "Cut a release and publish packages safely.",
    });
    const db = createProcedureDatabase({
      procedureFtsSearch: vi.fn(async () => [{ procedure: release, rank: -1.2 }]),
    });

    const result = await runProcedureRecall(
      {
        text: "how do I do an agenr release",
      },
      {
        db,
      },
    );

    expect(result.canonicalProcedure?.id).toBe(release.id);
    expect(result.candidates.map((candidate) => candidate.procedure.id)).toEqual([release.id]);
    expect(result.notices).toEqual(["Semantic procedure search unavailable - using lexical-only procedure ranking."]);
    expect(db.procedureVectorSearch).not.toHaveBeenCalled();
  });

  it("reranks lexical candidates with vector evidence when semantic recall is available", async () => {
    const release = createProcedure({
      procedure_key: "agenr/release",
      title: "Release agenr and publish packages",
      goal: "Publish a new agenr release safely.",
    });
    const sandbox = createProcedure({
      procedure_key: "agenr/sandbox-validation",
      title: "Validate the sandbox plugin locally",
      goal: "Run the local sandbox plugin validation workflow.",
    });
    const db = createProcedureDatabase({
      procedureFtsSearch: vi.fn(async () => [
        { procedure: sandbox, rank: -1.4 },
        { procedure: release, rank: -1.6 },
      ]),
      procedureVectorSearch: vi.fn(async () => [
        { procedure: release, vectorSim: 0.95 },
        { procedure: sandbox, vectorSim: 0.12 },
      ]),
    });

    const result = await runProcedureRecall(
      {
        text: "how should I publish agenr",
        limit: 2,
      },
      {
        db,
        embedQuery: async () => createEmbedding(0, 1),
      },
    );

    expect(result.canonicalProcedure?.id).toBe(release.id);
    expect(result.candidates.map((candidate) => candidate.procedure.id)).toEqual([release.id, sandbox.id]);
    expect(db.procedureVectorSearch).toHaveBeenCalledWith({
      embedding: createEmbedding(0, 1),
      limit: 8,
    });
  });

  it("falls back to lexical-only ranking when query embeddings fail", async () => {
    const review = createProcedure({
      procedure_key: "agenr/surgeon-review",
      title: "Review surgeon proposals",
      goal: "Review one surgeon proposal safely.",
    });
    const db = createProcedureDatabase({
      procedureFtsSearch: vi.fn(async () => [{ procedure: review, rank: -0.9 }]),
    });

    const result = await runProcedureRecall(
      {
        text: "what steps do I take to review surgeon proposals",
      },
      {
        db,
        embedQuery: async () => {
          throw new Error("embedding offline");
        },
      },
    );

    expect(result.canonicalProcedure?.id).toBe(review.id);
    expect(result.notices).toEqual(["Semantic procedure search failed during procedure recall - using lexical-only procedure ranking."]);
    expect(db.procedureVectorSearch).not.toHaveBeenCalled();
  });

  it("returns ranked candidates without a canonical procedure when the lead is too close to the runner-up", async () => {
    const sandbox = createProcedure({
      procedure_key: "agenr/sandbox-validation",
      title: "Validate the sandbox plugin locally",
      goal: "Run the local sandbox plugin validation workflow safely.",
    });
    const pluginCheck = createProcedure({
      procedure_key: "agenr/openclaw-local-plugin-check",
      title: "Validate the local plugin locally",
      goal: "Run the local plugin validation workflow safely.",
    });
    const db = createProcedureDatabase({
      procedureFtsSearch: vi.fn(async () => [
        { procedure: sandbox, rank: -0.7 },
        { procedure: pluginCheck, rank: -0.8 },
      ]),
    });

    const result = await runProcedureRecall(
      {
        text: "local plugin validation",
      },
      {
        db,
      },
    );

    expect(result.canonicalProcedure).toBeUndefined();
    expect(result.candidates.map((candidate) => candidate.procedure.id)).toEqual([pluginCheck.id, sandbox.id]);
  });

  it("reorders near-duplicate procedure candidates when MMR is enabled", async () => {
    const releaseRevisionA = createProcedure({
      procedure_key: "agenr/release",
      title: "Release agenr and publish packages",
      goal: "Cut an agenr release safely.",
      embedding: createEmbedding(0, 1),
    });
    const releaseRevisionB = createProcedure({
      procedure_key: "agenr/release",
      title: "Release agenr and publish packages",
      goal: "Cut an agenr release safely - revision b.",
      embedding: createEmbedding(0, 1),
    });
    const diverseProcedure = createProcedure({
      procedure_key: "agenr/sandbox-validation",
      title: "Validate the sandbox plugin locally",
      goal: "Run the local sandbox plugin validation workflow.",
      embedding: createEmbedding(1, 1),
    });
    const db = createProcedureDatabase({
      procedureFtsSearch: vi.fn(async () => [
        { procedure: releaseRevisionA, rank: -1.3 },
        { procedure: releaseRevisionB, rank: -1.35 },
        { procedure: diverseProcedure, rank: -1.4 },
      ]),
      procedureVectorSearch: vi.fn(async () => [
        { procedure: releaseRevisionA, vectorSim: 0.95 },
        { procedure: releaseRevisionB, vectorSim: 0.94 },
        { procedure: diverseProcedure, vectorSim: 0.6 },
      ]),
    });

    const result = await runProcedureRecall(
      {
        text: "how should I publish agenr",
        limit: 3,
        mmr: { enabled: true, lambda: 0.1 },
      },
      {
        db,
        embedQuery: async () => createEmbedding(0, 1),
      },
    );

    const diverseIndex = result.candidates.findIndex((candidate) => candidate.procedure.id === diverseProcedure.id);
    const revisionBIndex = result.candidates.findIndex((candidate) => candidate.procedure.id === releaseRevisionB.id);
    expect(diverseIndex).toBeGreaterThanOrEqual(0);
    expect(revisionBIndex).toBeGreaterThanOrEqual(0);
    expect(diverseIndex).toBeLessThan(revisionBIndex);
  });

  it("orders equal-score candidates deterministically by procedure key", async () => {
    const alpha = createProcedure({
      procedure_key: "agenr/alpha",
      title: "Sandbox validation",
      goal: "Sandbox validation",
      updated_at: "2026-04-01T00:00:00.000Z",
    });
    const beta = createProcedure({
      procedure_key: "agenr/beta",
      title: "Sandbox validation",
      goal: "Sandbox validation",
      updated_at: "2026-04-01T00:00:00.000Z",
    });
    const db = createProcedureDatabase({
      procedureFtsSearch: vi.fn(async () => [
        { procedure: beta, rank: -0.4 },
        { procedure: alpha, rank: -0.5 },
      ]),
    });

    const result = await runProcedureRecall(
      {
        text: "sandbox validation",
        limit: 2,
      },
      {
        db,
      },
    );

    expect(result.candidates.map((candidate) => candidate.procedure.procedure_key)).toEqual(["agenr/alpha", "agenr/beta"]);
  });
});

/**
 * Builds a minimal procedure-database double for app-layer recall tests.
 *
 * @param overrides - Partial method overrides.
 * @returns Procedure database port with spyable defaults.
 */
function createProcedureDatabase(
  overrides: Partial<{
    procedureFtsSearch: ReturnType<typeof vi.fn>;
    procedureVectorSearch: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    upsertProcedure: vi.fn(),
    getProcedure: vi.fn(),
    hydrateProcedures: vi.fn(),
    findActiveProcedureByKey: vi.fn(),
    procedureFtsSearch: overrides.procedureFtsSearch ?? vi.fn(async () => []),
    procedureVectorSearch: overrides.procedureVectorSearch ?? vi.fn(async () => []),
    listProceduresWithoutEmbeddings: vi.fn(),
    updateProcedureEmbedding: vi.fn(),
    retireProcedure: vi.fn(),
    supersedeProcedure: vi.fn(),
  };
}

/**
 * Creates a stable stored procedure fixture with derived recall metadata.
 *
 * @param overrides - Partial field overrides.
 * @returns Stored procedure fixture.
 */
function createProcedure(overrides: Partial<Procedure> = {}): Procedure {
  const now = overrides.created_at ?? "2026-04-01T00:00:00.000Z";
  const body = {
    procedure_key: overrides.procedure_key ?? "agenr/release",
    title: overrides.title ?? "Release agenr and publish packages",
    goal: overrides.goal ?? "Cut a release and publish packages safely.",
    when_to_use: overrides.when_to_use ?? ["Use this when you need to ship a new agenr release."],
    when_not_to_use: overrides.when_not_to_use ?? ["Do not use this for a local dry run."],
    prerequisites: overrides.prerequisites ?? ["A clean repo state is available."],
    steps: overrides.steps ?? [
      {
        id: "read-doc",
        kind: "read_reference" as const,
        instruction: "Read the release procedure reference.",
        ref: {
          kind: "manual" as const,
          label: "release docs",
        },
      },
    ],
    verification: overrides.verification ?? ["The workflow completed successfully."],
    failure_modes: overrides.failure_modes ?? ["Validation fails before publish."],
    sources: overrides.sources ?? [
      {
        kind: "manual" as const,
        label: "fixture",
      },
    ],
  };

  return {
    id: overrides.id ?? randomUUID(),
    ...body,
    recall_text: overrides.recall_text ?? composeProcedureRecallText(body),
    revision_hash: overrides.revision_hash ?? computeProcedureRevisionHash(body),
    source_hash: overrides.source_hash ?? computeProcedureSourceHash(JSON.stringify(body)),
    source_file: overrides.source_file,
    embedding: overrides.embedding,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    superseded_by: overrides.superseded_by,
    created_at: now,
    updated_at: overrides.updated_at ?? now,
  };
}

/**
 * Creates a sparse 1024-dimensional embedding fixture.
 *
 * @param index - Coordinate index to set.
 * @param value - Coordinate value to write.
 * @returns Embedding vector fixture.
 */
function createEmbedding(index: number, value: number): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[index] = value;
  return vector;
}
