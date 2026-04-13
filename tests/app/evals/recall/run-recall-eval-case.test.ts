import { createHash } from "node:crypto";
import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase } from "../../../../src/adapters/db/client.js";
import { runRecallEvalCase } from "../../../../src/app/evals/recall/index.js";

const tempPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  delete process.env.OPENAI_API_KEY;
  delete process.env.AGENR_DB_PATH;
  delete process.env.AGENR_CONFIG_DIR;
  delete process.env.AGENR_CONFIG_PATH;

  while (tempPaths.length > 0) {
    await rm(tempPaths.pop() ?? "", { recursive: true, force: true });
  }
});

describe("runRecallEvalCase", () => {
  it("runs one isolated recall eval case end to end with exact seeded fixture metadata", async () => {
    const tempRoot = await createTempDirectory("agenr-eval-app-");
    const sandboxRoot = path.join(tempRoot, "sandbox");

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runRecallEvalCase({
      caseId: "case-app-success",
      sandbox: {
        root: sandboxRoot,
        preserve: true,
      },
      memoryPool: [
        {
          id: "policy-old",
          type: "decision",
          subject: "pager policy",
          content: "Jordan is on call this week.",
          importance: 5,
          expiry: "permanent",
          created_at: "2026-03-10T00:00:00.000Z",
          superseded_by: "policy-new",
        },
        {
          id: "policy-new",
          type: "decision",
          subject: "pager policy",
          content: "Taylor is on call this week.",
          importance: 9,
          expiry: "permanent",
          tags: ["ops"],
          created_at: "2026-03-11T00:00:00.000Z",
          updated_at: "2026-03-12T00:00:00.000Z",
        },
        {
          id: "policy-retired",
          type: "fact",
          subject: "old handoff",
          content: "Pat covered the old pager rotation.",
          importance: 4,
          expiry: "temporary",
          retired: true,
          retired_at: "2026-03-09T00:00:00.000Z",
          retired_reason: "obsolete",
          created_at: "2026-03-08T00:00:00.000Z",
        },
      ],
      recallRequest: {
        text: "who is on call this week",
        limit: 5,
      },
      options: {
        includeDiagnostics: true,
        includeTimings: true,
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      caseId: "case-app-success",
      result: {
        entryIds: ["policy-new"],
      },
      metadata: {
        path: "core",
        claim: {
          projectedEntries: [
            expect.objectContaining({
              entryId: "policy-new",
              familyKey: "entry:policy-new",
              memoryState: "current",
              claimStatus: "no_key",
            }),
          ],
        },
      },
      diagnostics: {
        execution: {
          mode: "isolated-case",
          provisioning: "exact-fixture-seed",
          recallPath: "core",
          memoryPoolCount: 3,
          provisionedCount: 3,
          requestedDiagnostics: true,
          requestedCandidates: false,
        },
        provision: {
          requestedCount: 3,
          provisionedCount: 3,
          providedIdCount: 3,
          generatedIdCount: 0,
          retiredCount: 1,
          supersededCount: 1,
          createdAtDefaultedCount: 0,
          updatedAtDefaultedCount: 2,
          seededEntries: [
            {
              id: "policy-old",
              created_at: "2026-03-10T00:00:00.000Z",
              updated_at: "2026-03-10T00:00:00.000Z",
              retired: false,
              superseded_by: "policy-new",
            },
            {
              id: "policy-new",
              created_at: "2026-03-11T00:00:00.000Z",
              updated_at: "2026-03-12T00:00:00.000Z",
              retired: false,
            },
            {
              id: "policy-retired",
              created_at: "2026-03-08T00:00:00.000Z",
              updated_at: "2026-03-08T00:00:00.000Z",
              retired: true,
            },
          ],
        },
        retrieval: {
          queryEmbeddingDimensions: 1024,
          vectorSearchLimit: 20,
          lexicalSearchLimit: 10,
        },
        ranking: {
          limit: 5,
          threshold: 0,
          budget: null,
        },
        filtering: {
          types: [],
          tags: [],
        },
        candidateCounts: {
          vectorRetrieved: 1,
          lexicalRetrieved: 1,
          merged: 1,
          thresholdQualified: 1,
          budgetAccepted: 1,
          finalRanked: 1,
          hydrated: 1,
          returned: 1,
          telemetryAttempted: 1,
        },
      },
      sandbox: {
        root: sandboxRoot,
        dbPath: path.join(sandboxRoot, "knowledge.db"),
        preserved: true,
      },
    });
    expect(response.result?.entries[0]).toMatchObject({
      id: "policy-new",
      content: "Taylor is on call this week.",
      created_at: "2026-03-11T00:00:00.000Z",
      tags: ["ops"],
    });
    expect(response.timings).toEqual(
      expect.objectContaining({
        totalMs: expect.any(Number),
        sandboxSetupMs: expect.any(Number),
        fixtureProvisionMs: expect.any(Number),
        recallMs: expect.any(Number),
        queryEmbeddingMs: expect.any(Number),
        vectorSearchMs: expect.any(Number),
        lexicalSearchMs: expect.any(Number),
        mergeCandidatesMs: expect.any(Number),
        scoreCandidatesMs: expect.any(Number),
        thresholdMs: expect.any(Number),
        budgetMs: expect.any(Number),
        hydrateEntriesMs: expect.any(Number),
        shapeResultsMs: expect.any(Number),
        recordRecallEventsMs: expect.any(Number),
      }),
    );
    expect(response.timings?.totalMs).toBeGreaterThanOrEqual(response.timings?.recallMs ?? 0);

    await expect(access(response.sandbox?.dbPath ?? "")).resolves.toBeUndefined();
    await expect(access(path.join(response.sandbox?.root ?? "", "trace.json"))).rejects.toBeDefined();

    const sandboxDatabase = await createDatabase(response.sandbox?.dbPath ?? "");
    try {
      const rows = await sandboxDatabase.execute({
        sql: `
          SELECT id, retired, retired_at, retired_reason, superseded_by, created_at, updated_at, last_recalled_at
          FROM entries
          ORDER BY id
        `,
      });

      expect(
        rows.rows.map((row) => ({
          id: String(row.id),
          retired: Number(row.retired),
          retired_at: typeof row.retired_at === "string" ? row.retired_at : undefined,
          retired_reason: typeof row.retired_reason === "string" ? row.retired_reason : undefined,
          superseded_by: typeof row.superseded_by === "string" ? row.superseded_by : undefined,
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
          last_recalled_at: typeof row.last_recalled_at === "string" ? row.last_recalled_at : undefined,
        })),
      ).toEqual([
        {
          id: "policy-new",
          retired: 0,
          retired_at: undefined,
          retired_reason: undefined,
          superseded_by: undefined,
          created_at: "2026-03-11T00:00:00.000Z",
          updated_at: expect.any(String),
          last_recalled_at: expect.any(String),
        },
        {
          id: "policy-old",
          retired: 0,
          retired_at: undefined,
          retired_reason: undefined,
          superseded_by: "policy-new",
          created_at: "2026-03-10T00:00:00.000Z",
          updated_at: "2026-03-10T00:00:00.000Z",
          last_recalled_at: undefined,
        },
        {
          id: "policy-retired",
          retired: 1,
          retired_at: "2026-03-09T00:00:00.000Z",
          retired_reason: "obsolete",
          superseded_by: undefined,
          created_at: "2026-03-08T00:00:00.000Z",
          updated_at: "2026-03-08T00:00:00.000Z",
          last_recalled_at: undefined,
        },
      ]);

      const seededPolicyNew = response.diagnostics?.provision?.seededEntries.find((entry) => entry.id === "policy-new");
      const storedPolicyNew = rows.rows.find((row) => String(row.id) === "policy-new");

      expect(seededPolicyNew).toEqual({
        id: "policy-new",
        created_at: "2026-03-11T00:00:00.000Z",
        updated_at: "2026-03-12T00:00:00.000Z",
        retired: false,
        superseded_by: undefined,
      });
      expect(typeof storedPolicyNew?.updated_at).toBe("string");
      expect(storedPolicyNew?.updated_at).not.toBe(seededPolicyNew?.updated_at);
      expect(typeof storedPolicyNew?.last_recalled_at).toBe("string");
    } finally {
      await sandboxDatabase.close();
    }
  });

  it("maps sandbox setup failures to a structured error response", async () => {
    const tempRoot = await createTempDirectory("agenr-eval-sandbox-fail-");
    const badRoot = path.join(tempRoot, "not-a-directory");
    await writeFile(badRoot, "occupied");

    const response = await runRecallEvalCase({
      caseId: "case-sandbox-fail",
      sandbox: {
        root: badRoot,
      },
      memoryPool: [],
      recallRequest: {
        text: "anything",
      },
      options: {
        includeDiagnostics: true,
        includeTimings: true,
      },
    });

    expect(response).toMatchObject({
      status: "error",
      caseId: "case-sandbox-fail",
      diagnostics: {
        execution: {
          mode: "isolated-case",
          provisioning: "exact-fixture-seed",
          recallPath: "core",
          memoryPoolCount: 0,
          provisionedCount: 0,
          requestedDiagnostics: true,
          requestedCandidates: false,
        },
        candidateCounts: {
          vectorRetrieved: 0,
          lexicalRetrieved: 0,
          merged: 0,
          thresholdQualified: 0,
          budgetAccepted: 0,
          finalRanked: 0,
          hydrated: 0,
          returned: 0,
          telemetryAttempted: 0,
        },
      },
      error: {
        code: "sandbox_setup_failed",
        message: "Failed to create isolated recall eval sandbox.",
      },
    });
    expect(response.error?.details).toEqual(
      expect.objectContaining({
        cause: expect.stringMatching(/file already exists|not a directory/i),
      }),
    );
    expect(response.timings?.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("maps fixture provisioning failures to a structured error response", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runRecallEvalCase({
      caseId: "case-provision-fail",
      memoryPool: [
        {
          id: "duplicate-id",
          type: "fact",
          subject: "subject one",
          content: "content one",
        },
        {
          id: "duplicate-id",
          type: "fact",
          subject: "subject two",
          content: "content two",
        },
      ],
      recallRequest: {
        text: "anything",
      },
      options: {
        includeTimings: true,
      },
    });

    expect(response).toMatchObject({
      status: "error",
      caseId: "case-provision-fail",
      error: {
        code: "fixture_provision_failed",
        message: "Failed to provision recall eval fixtures into isolated storage.",
      },
      sandbox: {
        preserved: false,
      },
    });
    expect(response.error?.details).toEqual({
      cause: "Fixture IDs must be unique. Duplicate IDs: duplicate-id.",
    });
  });

  it("returns degraded lexical results when query embeddings fail during recall execution", async () => {
    const tempRoot = await createTempDirectory("agenr-eval-recall-fail-");

    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub({ failOnCall: 2, failureStatus: 401, failureMessage: "invalid API key" }));

    const response = await runRecallEvalCase({
      caseId: "case-recall-fail",
      sandbox: {
        root: path.join(tempRoot, "sandbox"),
        preserve: true,
      },
      memoryPool: [
        {
          id: "fixture-id",
          type: "fact",
          subject: "ops handoff",
          content: "Taylor is on call this week.",
        },
      ],
      recallRequest: {
        text: "who is on call",
      },
      options: {
        includeDiagnostics: true,
        includeTimings: true,
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      caseId: "case-recall-fail",
      result: {
        entryIds: ["fixture-id"],
      },
      metadata: {
        path: "core",
        claim: {
          projectedEntries: [
            expect.objectContaining({
              entryId: "fixture-id",
              memoryState: "current",
            }),
          ],
        },
      },
      diagnostics: {
        execution: {
          mode: "isolated-case",
          provisioning: "exact-fixture-seed",
          recallPath: "core",
          memoryPoolCount: 1,
          provisionedCount: 1,
          requestedDiagnostics: true,
          requestedCandidates: false,
        },
        provision: {
          requestedCount: 1,
          provisionedCount: 1,
          seededEntries: [
            {
              id: "fixture-id",
            },
          ],
        },
        retrieval: {
          queryEmbeddingDimensions: 0,
          vectorSearchLimit: 0,
          lexicalSearchLimit: 20,
        },
        degraded: {
          active: true,
          reasons: ["query_embedding_failed"],
          lexicalOnly: true,
          notices: [expect.stringContaining("fell back to lexical-only entry ranking")],
        },
        candidateCounts: {
          vectorRetrieved: 0,
          lexicalRetrieved: 1,
          merged: 1,
          thresholdQualified: 1,
          budgetAccepted: 1,
          finalRanked: 1,
          hydrated: 1,
          returned: 1,
          telemetryAttempted: 1,
        },
      },
      sandbox: {
        preserved: true,
      },
    });
    expect(response.result?.entries[0]).toMatchObject({
      id: "fixture-id",
      claim: {
        memoryState: "current",
      },
    });
    await expect(access(response.sandbox?.dbPath ?? "")).resolves.toBeUndefined();
  });

  it("injects a deterministic query-embedding failure after fixture provisioning", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runRecallEvalCase({
      caseId: "case-fault-query-embedding",
      memoryPool: [
        {
          id: "fallback-entry",
          type: "fact",
          subject: "ops handoff",
          content: "Taylor owns the deployment handoff.",
        },
      ],
      recallRequest: {
        text: "who owns the deployment handoff",
        limit: 5,
      },
      options: {
        includeDiagnostics: true,
        faultInjection: {
          queryEmbeddingFailure: true,
        },
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      caseId: "case-fault-query-embedding",
      result: {
        entryIds: ["fallback-entry"],
      },
      diagnostics: {
        retrieval: {
          queryEmbeddingDimensions: 0,
          vectorSearchLimit: 0,
          lexicalSearchLimit: 10,
        },
        degraded: {
          active: true,
          reasons: ["query_embedding_failed"],
          lexicalOnly: true,
          notices: [expect.stringContaining("fell back to lexical-only entry ranking")],
        },
        candidateCounts: {
          vectorRetrieved: 0,
          lexicalRetrieved: 1,
          merged: 1,
          thresholdQualified: 1,
          budgetAccepted: 1,
          finalRanked: 1,
          hydrated: 1,
          returned: 1,
          telemetryAttempted: 1,
        },
      },
    });
  });

  it("injects a deterministic vector-search failure while preserving useful lexical results", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runRecallEvalCase({
      caseId: "case-fault-vector-search",
      memoryPool: [
        {
          id: "vector-fallback-entry",
          type: "fact",
          subject: "ops handoff",
          content: "Taylor owns the deployment handoff.",
        },
      ],
      recallRequest: {
        text: "who owns the deployment handoff",
        limit: 5,
      },
      options: {
        includeDiagnostics: true,
        faultInjection: {
          vectorSearchFailure: true,
        },
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      caseId: "case-fault-vector-search",
      result: {
        entryIds: ["vector-fallback-entry"],
      },
      diagnostics: {
        retrieval: {
          queryEmbeddingDimensions: 1024,
          vectorSearchLimit: 20,
          lexicalSearchLimit: 10,
        },
        degraded: {
          active: true,
          reasons: ["vector_search_failed"],
          lexicalOnly: false,
          notices: [expect.stringContaining("continued with lexical entry candidates only")],
        },
        candidateCounts: {
          vectorRetrieved: 0,
          lexicalRetrieved: 1,
          merged: 1,
          thresholdQualified: 1,
          budgetAccepted: 1,
          finalRanked: 1,
          hydrated: 1,
          returned: 1,
          telemetryAttempted: 1,
        },
      },
    });
  });

  it("routes unified recall eval cases through the unified recall service with real unified caller context", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const tempRoot = await createTempDirectory("agenr-eval-unified-");
    const response = await runRecallEvalCase({
      caseId: "case-unified-recall-path",
      recallPath: "unified",
      sandbox: {
        root: path.join(tempRoot, "sandbox"),
        preserve: true,
      },
      memoryPool: [
        {
          id: "owner-old",
          type: "decision",
          subject: "repository owner",
          content: "Before the reorg, platform owned the repository.",
          created_at: "2026-02-01T00:00:00.000Z",
          claim_key: "repo/owner_primary",
          claim_key_status: "trusted",
          superseded_by: "owner-new",
        },
        {
          id: "owner-new",
          type: "decision",
          subject: "repository owner",
          content: "After the reorg, infra owns the repository.",
          created_at: "2026-03-20T00:00:00.000Z",
          claim_key: "repo/owner_primary",
          claim_key_status: "trusted",
        },
      ],
      recallRequest: {
        text: "what was the previous repository owner",
        limit: 2,
      },
      unified: {
        mode: "entries",
        sessionKey: "agent:test:tui",
        memoryPolicy: {
          slotPolicies: {
            attributeHeads: {
              owner: "multivalued",
            },
          },
        },
      },
      options: {
        includeDiagnostics: true,
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      caseId: "case-unified-recall-path",
      metadata: {
        path: "unified",
        unified: {
          routing: {
            requested: "entries",
            detectedIntent: "historical_state",
            queried: ["entries"],
          },
          notices: [],
          episodeCount: 0,
        },
        claim: {
          projectedEntries: expect.arrayContaining([
            expect.objectContaining({
              entryId: "owner-old",
              familyKey: "repo/owner_primary",
              slotPolicy: "multivalued",
            }),
          ]),
          entryFamilies: expect.arrayContaining([
            expect.objectContaining({
              familyKey: "repo/owner_primary",
              slotPolicy: "multivalued",
            }),
          ]),
        },
      },
      diagnostics: {
        execution: {
          recallPath: "unified",
        },
      },
    });
    expect(response.result?.entryIds).toContain("owner-old");

    const sandboxDatabase = await createDatabase(response.sandbox?.dbPath ?? "");
    try {
      const rows = await sandboxDatabase.execute({
        sql: `
          SELECT session_key
          FROM recall_events
          ORDER BY recalled_at DESC
          LIMIT 1
        `,
      });
      expect(rows.rows[0]?.session_key).toBe("agent:test:tui");
    } finally {
      await sandboxDatabase.close();
    }
  });

  it("returns canonical procedures for unified eval cases seeded through procedurePool", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runRecallEvalCase({
      caseId: "case-unified-procedure-path",
      recallPath: "unified",
      memoryPool: [],
      procedurePool: [
        {
          id: "procedure-rotate-key",
          procedure_key: "security/signing-key-rotation",
          title: "Rotate the production signing key",
          goal: "Rotate the production signing key safely.",
          when_to_use: ["Use this when the production signing key must be rotated."],
          when_not_to_use: ["Do not use this for a read-only audit."],
          prerequisites: ["Access to the production key vault."],
          steps: [
            {
              id: "inspect-state",
              kind: "inspect_state",
              instruction: "Inspect the current signing key state before rotating it.",
              target: "signing key state",
            },
          ],
          verification: ["Downstream verification succeeds after rotation."],
          failure_modes: ["Rotation fails before verification completes."],
          sources: [{ kind: "manual", label: "fixture" }],
        },
      ],
      recallRequest: {
        text: "how do I rotate the production signing key safely",
        limit: 3,
      },
      options: {
        includeDiagnostics: true,
        faultInjection: {
          queryEmbeddingFailure: true,
        },
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      caseId: "case-unified-procedure-path",
      result: {
        entryIds: [],
      },
      metadata: {
        path: "unified",
        unified: {
          routing: {
            requested: "auto",
            detectedIntent: "procedural",
            queried: ["procedures"],
          },
          procedure: {
            id: "procedure-rotate-key",
            procedureKey: "security/signing-key-rotation",
            title: "Rotate the production signing key",
          },
          procedureCandidates: [
            expect.objectContaining({
              id: "procedure-rotate-key",
              procedureKey: "security/signing-key-rotation",
              title: "Rotate the production signing key",
            }),
          ],
          procedureNotices: [expect.stringContaining("lexical-only procedure ranking")],
          notices: [],
          episodeCount: 0,
        },
      },
      diagnostics: {
        execution: {
          recallPath: "unified",
        },
      },
    });
    expect(response.result?.entries).toEqual([]);
  });

  it("forwards the full core recall request shape through the core path", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runRecallEvalCase({
      caseId: "case-ranking-profile",
      memoryPool: [
        {
          id: "approach-old",
          type: "decision",
          subject: "deployment approach",
          content: "The previous deployment approach used webpack before the migration.",
          created_at: "2026-02-01T00:00:00.000Z",
        },
        {
          id: "approach-new",
          type: "decision",
          subject: "deployment approach",
          content: "The current deployment approach uses vite after the migration.",
          created_at: "2026-03-20T00:00:00.000Z",
        },
      ],
      recallRequest: {
        text: "what was the previous deployment approach",
        limit: 2,
        threshold: 0,
        budget: 64,
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-04-01T00:00:00.000Z",
        around: "2026-03-01T00:00:00.000Z",
        aroundRadius: 21,
        asOf: "2026-03-10T00:00:00.000Z",
        rankingProfile: "historical_state",
      },
      options: {
        includeDiagnostics: true,
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      caseId: "case-ranking-profile",
      metadata: {
        path: "core",
      },
      diagnostics: {
        ranking: {
          budget: 64,
          limit: 2,
          threshold: 0,
        },
        filtering: {
          since: "2026-01-01T00:00:00.000Z",
          until: "2026-04-01T00:00:00.000Z",
          around: {
            source: "explicit",
            anchor: "2026-03-01T00:00:00.000Z",
            radiusDays: 21,
          },
        },
      },
    });
    expect(response.result?.entryIds).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(response.result?.entries.length).toBeGreaterThan(0);
  });

  it("returns claim-centric result annotations and claim-key diagnostics for historical-state evals", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runRecallEvalCase({
      caseId: "case-claim-centric",
      memoryPool: [
        {
          id: "approach-old",
          type: "decision",
          subject: "deployment approach",
          content: "Webpack was the previous deployment approach before the migration.",
          created_at: "2026-02-01T00:00:00.000Z",
          claim_key: "deployment/approach",
          claim_key_status: "trusted",
          claim_key_source: "manual",
          claim_support_source_kind: "tool_call",
          claim_support_locator: "fixture://case-claim-centric",
          claim_support_observed_at: "2026-02-01T00:00:00.000Z",
          claim_support_mode: "explicit",
          valid_from: "2026-02-01T00:00:00.000Z",
          valid_to: "2026-03-20T00:00:00.000Z",
          superseded_by: "approach-new",
          supersession_kind: "update",
          supersession_reason: "Migration to vite completed.",
        },
        {
          id: "approach-new",
          type: "decision",
          subject: "deployment approach",
          content: "The current deployment approach uses vite after the migration.",
          created_at: "2026-03-20T00:00:00.000Z",
          claim_key: "deployment/approach",
          claim_key_status: "trusted",
          claim_key_source: "manual",
        },
      ],
      recallRequest: {
        text: "what was the previous deployment approach",
        limit: 2,
        rankingProfile: "historical_state",
      },
      options: {
        includeDiagnostics: true,
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      caseId: "case-claim-centric",
      metadata: {
        path: "core",
        claim: {
          projectedEntries: expect.arrayContaining([
            expect.objectContaining({
              entryId: "approach-old",
              familyKey: "deployment/approach",
              claimKey: "deployment/approach",
              slotPolicy: "exclusive",
              memoryState: "superseded",
              claimStatus: "trusted",
            }),
          ]),
        },
      },
    });
    expect(response.result?.entries[0]).toMatchObject({
      id: "approach-old",
      claim: {
        familyKey: "deployment/approach",
        claimKey: "deployment/approach",
        slotPolicy: "exclusive",
        memoryState: "superseded",
        claimStatus: "trusted",
        provenance: {
          supersededById: "approach-new",
          supersessionKind: "update",
        },
      },
    });
    expect(response.diagnostics?.claimKey?.historicalBoosted ?? 0).toBeGreaterThanOrEqual(1);
    expect(response.diagnostics?.claimKey?.trustPenalized ?? 0).toBeGreaterThanOrEqual(0);
    expect(response.diagnostics?.provision?.seededEntries).toContainEqual(
      expect.objectContaining({
        id: "approach-old",
        claim_key: "deployment/approach",
        claim_key_status: "trusted",
        valid_to: "2026-03-20T00:00:00.000Z",
      }),
    );
  });

  it("preserves explicit as-of resolution metadata in claim-centric eval responses", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runRecallEvalCase({
      caseId: "case-as-of",
      memoryPool: [
        {
          id: "approach-old",
          type: "decision",
          subject: "deployment approach",
          content: "Webpack was the deployment approach before the migration.",
          created_at: "2026-02-01T00:00:00.000Z",
          claim_key: "deployment/approach",
          claim_key_status: "trusted",
          valid_from: "2026-02-01T00:00:00.000Z",
          valid_to: "2026-03-20T00:00:00.000Z",
          superseded_by: "approach-new",
        },
        {
          id: "approach-new",
          type: "decision",
          subject: "deployment approach",
          content: "Vite is the deployment approach after the migration.",
          created_at: "2026-03-20T00:00:00.000Z",
          claim_key: "deployment/approach",
          claim_key_status: "trusted",
          valid_from: "2026-03-20T00:00:00.000Z",
        },
      ],
      recallRequest: {
        text: "what was the previous deployment approach",
        asOf: "2026-03-01T00:00:00.000Z",
        limit: 2,
        rankingProfile: "historical_state",
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      caseId: "case-as-of",
      metadata: {
        path: "core",
      },
    });
    expect(response.result?.entries[0]).toMatchObject({
      id: "approach-old",
      claim: {
        freshness: {
          asOf: {
            clock: "validity",
            relation: "active",
          },
        },
      },
    });
  });
});

/** Creates a temp directory and tracks it for cleanup. */
async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempPaths.push(directory);
  return directory;
}

/** Creates a deterministic embeddings API stub for eval tests. */
function createEmbeddingFetchStub(
  options: {
    failOnCall?: number;
    failureStatus?: number;
    failureMessage?: string;
  } = {},
): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  let callCount = 0;

  return async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    callCount += 1;

    if (options.failOnCall === callCount) {
      return new Response(JSON.stringify({ error: { message: options.failureMessage ?? "failure" } }), {
        status: options.failureStatus ?? 500,
      });
    }

    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(
      JSON.stringify({
        data: body.input.map((text, index) => ({
          index,
          embedding: hashToVector(text, 1024),
        })),
      }),
      { status: 200 },
    );
  };
}

/** Converts input text into a deterministic normalized vector. */
function hashToVector(text: string, dimensions: number): number[] {
  const vector: number[] = [];
  let counter = 0;

  while (vector.length < dimensions) {
    const block = createHash("sha256").update(text).update(String(counter)).digest();

    for (let offset = 0; offset + 4 <= block.length && vector.length < dimensions; offset += 4) {
      vector.push(block.readInt32LE(offset) / 0x7fffffff);
    }

    counter += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (magnitude === 0) {
    return Array.from({ length: dimensions }, (_, index) => (index === 0 ? 1 : 0));
  }

  return vector.map((value) => value / magnitude);
}
