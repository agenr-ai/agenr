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
      diagnostics: {
        execution: {
          mode: "isolated-case",
          provisioning: "exact-fixture-seed",
          memoryPoolCount: 3,
          provisionedCount: 3,
          requestedDiagnostics: true,
          requestedCandidates: false,
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
    expect(response.timings?.totalMs).toBeGreaterThanOrEqual(0);

    await expect(access(response.sandbox?.dbPath ?? "")).resolves.toBeUndefined();

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
        includeTimings: true,
      },
    });

    expect(response).toMatchObject({
      status: "error",
      caseId: "case-sandbox-fail",
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

  it("maps recall execution failures to a structured error response", async () => {
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
        includeTimings: true,
      },
    });

    expect(response).toMatchObject({
      status: "error",
      caseId: "case-recall-fail",
      error: {
        code: "recall_execution_failed",
        message: "Failed to execute real recall against isolated eval state.",
      },
      sandbox: {
        preserved: true,
      },
    });
    expect(response.error?.details).toEqual({
      cause: "OpenAI embeddings request failed (401): invalid API key. invalid API key",
    });
    await expect(access(response.sandbox?.dbPath ?? "")).resolves.toBeUndefined();
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
