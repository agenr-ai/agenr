import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase } from "../../../../src/adapters/db/client.js";
import { createInternalRecallEvalRoute, type RecallEvalCaseRunner } from "../../../../src/adapters/api/routes/internal-recall-eval.js";
import { composeEmbeddingText } from "../../../../src/core/store/embedding-text.js";
import type { Durable } from "../../../../src/core/types.js";
import { useIsolatedAgenrConfig } from "../../../helpers/isolated-config.js";
import { removeTestPath, waitForDatabaseRelease } from "../../../helpers/temp-paths.js";

const tempPaths: string[] = [];

beforeEach(async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "agenr-eval-config-"));
  tempPaths.push(configRoot);
  await useIsolatedAgenrConfig(configRoot);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  delete process.env.OPENAI_API_KEY;
  delete process.env.AGENR_DB_PATH;
  delete process.env.AGENR_CONFIG_DIR;
  delete process.env.AGENR_CONFIG_PATH;

  await waitForDatabaseRelease();

  while (tempPaths.length > 0) {
    await removeTestPath(tempPaths.pop() ?? "");
  }
});

describe("createInternalRecallEvalRoute", () => {
  it("keeps the eval HTTP surface to exactly the recall and before-turn route files", async () => {
    const routeFiles = (await readdir(new URL("../../../../src/adapters/api/routes/", import.meta.url))).filter((file) => file.endsWith(".ts")).sort();

    expect(routeFiles).toEqual([
      "internal-before-turn-eval.ts",
      "internal-dreaming-efficiency-eval.ts",
      "internal-recall-eval.ts",
      "internal-session-start-eval.ts",
    ]);
  });

  it("exposes the expected internal POST route and returns JSON from the runner", async () => {
    const runner = vi.fn<RecallEvalCaseRunner>(async (request) => ({
      status: "ok",
      caseId: request.caseId,
      result: {
        entries: [],
        entryIds: [],
      },
      metadata: {
        path: request.recallPath ?? "core",
        claim: {
          projectedEntries: [],
        },
      },
      diagnostics: {
        execution: {
          mode: "isolated-case",
          provisioning: "exact-fixture-seed",
          recallPath: request.recallPath ?? "core",
          memoryPoolCount: request.memoryPool.length,
          provisionedCount: request.memoryPool.length,
          requestedDiagnostics: false,
          requestedCandidates: false,
        },
      },
    }));
    const route = createInternalRecallEvalRoute(runner);

    expect(route.method).toBe("POST");
    expect(route.path).toBe("/internal/evals/recall/run");

    const response = await route.handler(
      new Request("http://localhost/internal/evals/recall/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "  case-route  ",
          memoryPool: [],
          recallRequest: {
            text: "  what do we know?  ",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(runner).toHaveBeenCalledWith({
      caseId: "case-route",
      description: undefined,
      sandbox: undefined,
      memoryPool: [],
      recallRequest: {
        text: "what do we know?",
        limit: undefined,
        threshold: undefined,
        budget: undefined,
        types: undefined,
        tags: undefined,
        since: undefined,
        until: undefined,
        around: undefined,
        aroundRadius: undefined,
        asOf: undefined,
        rankingProfile: undefined,
      },
      unified: undefined,
      options: undefined,
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(["caseId", "diagnostics", "metadata", "result", "status"]);
    expect(body).toEqual({
      status: "ok",
      caseId: "case-route",
      result: {
        entries: [],
        entryIds: [],
      },
      metadata: {
        path: "core",
        claim: {
          projectedEntries: [],
        },
      },
      diagnostics: {
        execution: {
          mode: "isolated-case",
          provisioning: "exact-fixture-seed",
          recallPath: "core",
          memoryPoolCount: 0,
          provisionedCount: 0,
          requestedDiagnostics: false,
          requestedCandidates: false,
        },
      },
    });
  });

  it("runs one real recall eval case end to end through the HTTP route against isolated state", async () => {
    const tempRoot = await createTempDirectory("agenr-eval-route-");
    const liveDbPath = path.join(tempRoot, "live.sqlite");
    await seedLiveEntry(
      liveDbPath,
      createEntry({
        id: "live-only",
        subject: "live state leak",
        content: "Morgan is on call in the live database only.",
      }),
    );

    process.env.OPENAI_API_KEY = "test-key";
    process.env.AGENR_DB_PATH = liveDbPath;
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const route = createInternalRecallEvalRoute();
    const response = await route.handler(
      new Request("http://localhost/internal/evals/recall/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "case-route-e2e",
          sandbox: {
            root: path.join(tempRoot, "sandbox"),
            preserve: true,
          },
          memoryPool: [
            {
              id: "fixture-old",
              type: "decision",
              subject: "pager policy",
              content: "Jordan is on call this week.",
              superseded_by: "fixture-new",
            },
            {
              id: "fixture-new",
              type: "decision",
              subject: "pager policy",
              content: "Taylor is on call this week.",
              tags: ["ops"],
              created_at: "2026-03-11T00:00:00.000Z",
            },
            {
              id: "fixture-retired",
              type: "fact",
              subject: "retired note",
              content: "Casey covered the old rotation.",
              valid_to: "2026-03-09T00:00:00.000Z",
              supersession_kind: "stale",
              supersession_reason: "obsolete",
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
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(["caseId", "diagnostics", "metadata", "result", "sandbox", "status", "timings"]);
    expect(body).toMatchObject({
      status: "ok",
      caseId: "case-route-e2e",
      result: {
        entryIds: ["fixture-new"],
      },
      metadata: {
        path: "core",
        claim: {
          projectedEntries: [
            expect.objectContaining({
              entryId: "fixture-new",
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
          staleCount: 1,
          supersededCount: 1,
          createdAtDefaultedCount: 2,
          updatedAtDefaultedCount: 3,
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
      timings: {
        totalMs: expect.any(Number),
        sandboxSetupMs: expect.any(Number),
        fixtureProvisionMs: expect.any(Number),
        recallMs: expect.any(Number),
      },
      sandbox: {
        root: path.join(tempRoot, "sandbox"),
        dbPath: path.join(tempRoot, "sandbox", "knowledge.db"),
        preserved: true,
      },
    });
  });

  it("surfaces rrf/neighborhood/mmr/crossEncoder diagnostics branches through the HTTP route for attribution sweeps", async () => {
    const tempRoot = await createTempDirectory("agenr-eval-route-attribution-");

    process.env.OPENAI_API_KEY = "test-key";
    process.env.AGENR_DB_PATH = path.join(tempRoot, "live.sqlite");
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const route = createInternalRecallEvalRoute();
    const response = await route.handler(
      new Request("http://localhost/internal/evals/recall/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "case-route-attribution-branches",
          sandbox: {
            root: path.join(tempRoot, "sandbox"),
            preserve: false,
          },
          memoryPool: [
            {
              id: "policy-current",
              type: "decision",
              subject: "pager policy",
              content: "Taylor is on call this week.",
              created_at: "2026-03-11T00:00:00.000Z",
            },
          ],
          recallRequest: {
            text: "who is on call this week",
            limit: 3,
          },
          options: {
            includeDiagnostics: true,
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { diagnostics?: Record<string, unknown> };

    expect(body.diagnostics?.rrf).toMatchObject({
      applied: expect.any(Boolean),
      channelCount: expect.any(Number),
      rankConstant: expect.any(Number),
      fusedCandidateCount: expect.any(Number),
      maxFusedScore: expect.any(Number),
    });
    expect(body.diagnostics?.neighborhood).toMatchObject({
      expansionRequested: expect.any(Boolean),
      expansionAvailable: expect.any(Boolean),
      familiesRequested: expect.any(Array),
      includeHistorical: expect.any(Boolean),
      seedIds: expect.any(Array),
      expansionCandidates: expect.any(Number),
      strongSeedIds: expect.any(Array),
      rerankBoostedIds: expect.any(Array),
    });
    expect(body.diagnostics?.mmr).toMatchObject({
      applied: expect.any(Boolean),
      lambda: expect.any(Number),
      droppedDuplicateCount: expect.any(Number),
      reorderedIds: expect.any(Array),
    });
    expect(body.diagnostics?.crossEncoder).toMatchObject({
      applied: expect.any(Boolean),
      k: expect.any(Number),
      alpha: expect.any(Number),
      latencyMs: expect.any(Number),
      rescoredIds: expect.any(Array),
    });
  });

  it("forwards internal fault-injection options through the HTTP boundary", async () => {
    const runner = vi.fn<RecallEvalCaseRunner>(async (request) => ({
      status: "ok",
      caseId: request.caseId,
      result: {
        entries: [],
        entryIds: [],
      },
      metadata: {
        path: request.recallPath ?? "core",
        claim: {
          projectedEntries: [],
        },
      },
    }));
    const route = createInternalRecallEvalRoute(runner);

    const response = await route.handler(
      new Request("http://localhost/internal/evals/recall/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "case-route-fault-injection",
          memoryPool: [],
          recallRequest: {
            text: "who owns the deployment handoff",
          },
          options: {
            includeDiagnostics: true,
            faultInjection: {
              queryEmbeddingFailure: true,
              vectorSearchFailure: false,
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(runner).toHaveBeenCalledWith({
      caseId: "case-route-fault-injection",
      description: undefined,
      recallPath: undefined,
      sandbox: undefined,
      memoryPool: [],
      recallRequest: {
        text: "who owns the deployment handoff",
        limit: undefined,
        threshold: undefined,
        budget: undefined,
        types: undefined,
        tags: undefined,
        since: undefined,
        until: undefined,
        around: undefined,
        aroundRadius: undefined,
        asOf: undefined,
        rankingProfile: undefined,
      },
      unified: undefined,
      options: {
        includeDiagnostics: true,
        includeCandidates: undefined,
        includeTimings: undefined,
        faultInjection: {
          queryEmbeddingFailure: true,
          vectorSearchFailure: false,
        },
      },
    });
  });

  it("returns a structured invalid_request response and echoes a parseable caseId", async () => {
    const route = createInternalRecallEvalRoute();

    const response = await route.handler(
      new Request("http://localhost/internal/evals/recall/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "case-invalid",
          memoryPool: [
            {
              type: "fact",
              subject: "",
              content: "still wrong",
            },
          ],
          recallRequest: {
            text: "",
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(["caseId", "error", "status"]);
    expect(body).toEqual({
      status: "error",
      caseId: "case-invalid",
      error: {
        code: "invalid_request",
        message: "Invalid recall eval request.",
        details: [
          {
            path: "memoryPool[0].subject",
            message: "Expected a non-empty string.",
          },
          {
            path: "recallRequest.text",
            message: "Expected a non-empty string.",
          },
        ],
      },
    });
  });

  it("omits caseId from invalid_request responses when the envelope does not expose one safely", async () => {
    const route = createInternalRecallEvalRoute();

    const response = await route.handler(
      new Request("http://localhost/internal/evals/recall/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{not-valid-json",
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(["error", "status"]);
    expect(body).toEqual({
      status: "error",
      error: {
        code: "invalid_request",
        message: "Invalid recall eval request.",
        details: [
          {
            path: "$",
            message: "Request body must be valid JSON.",
          },
        ],
      },
    });
  });

  it("echoes the validated caseId on unexpected internal adapter failures", async () => {
    const runner = vi.fn<RecallEvalCaseRunner>(async () => {
      throw new Error("unexpected failure");
    });
    const route = createInternalRecallEvalRoute(runner);

    const response = await route.handler(
      new Request("http://localhost/internal/evals/recall/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "case-internal-error",
          memoryPool: [],
          recallRequest: {
            text: "what do we know?",
          },
        }),
      }),
    );

    expect(response.status).toBe(500);

    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(["caseId", "error", "status"]);
    expect(body).toEqual({
      status: "error",
      caseId: "case-internal-error",
      error: {
        code: "internal_error",
        message: "Internal recall eval adapter error.",
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

/** Seeds a live database entry that should never affect isolated eval execution. */
async function seedLiveEntry(databasePath: string, entry: Durable): Promise<void> {
  const database = await createDatabase(databasePath);
  try {
    await database.insertDurable(entry, hashToVector(composeEmbeddingText(entry), 1024), hashText(entry.content));
  } finally {
    await database.close();
  }
}

/** Creates a canonical entry used for live-state isolation tests. */
function createEntry(overrides: Partial<Durable>): Durable {
  const createdAt = overrides.created_at ?? "2026-03-01T00:00:00.000Z";

  return {
    id: overrides.id ?? randomUUID(),
    type: overrides.type ?? "fact",
    subject: overrides.subject ?? "subject",
    content: overrides.content ?? "content",
    importance: overrides.importance ?? 6,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    cluster_id: overrides.cluster_id,
    created_at: createdAt,
    updated_at: overrides.updated_at ?? createdAt,
  };
}

/** Creates a deterministic embeddings API stub for eval tests. */
function createEmbeddingFetchStub(): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
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

/** Creates a stable SHA-256 hash string for deterministic test writes. */
function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
