import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase } from "../../../../src/adapters/db/client.js";
import { runBeforeTurnEvalCase } from "../../../../src/app/evals/before-turn/index.js";
import type { CrossEncoderPassage, CrossEncoderPort, CrossEncoderScore } from "../../../../src/core/ports.js";

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

describe("runBeforeTurnEvalCase", () => {
  it("returns the selected durable entry id and rendered patch text for an inject case", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runBeforeTurnEvalCase({
      caseId: "before-turn-inject",
      memoryPool: [
        {
          id: "duke-identity",
          type: "fact",
          subject: "duke identity",
          content: "Duke is Jim's dog.",
          tags: ["dogs", "identity"],
        },
      ],
      beforeTurnInput: {
        currentTurnText: "who is Duke?",
        policy: {
          recallThreshold: 0,
          enableProcedureSuggestion: false,
        },
      },
      options: {
        includeDiagnostics: true,
        includeRenderedPatch: true,
        includeTimings: true,
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      caseId: "before-turn-inject",
      output: {
        abstained: false,
        selectedEntryIds: ["duke-identity"],
        selectedProcedureKey: null,
        patch: {
          durableMemory: [
            expect.objectContaining({
              rank: 1,
              entry: expect.objectContaining({
                id: "duke-identity",
              }),
            }),
          ],
        },
        renderedPatchText: expect.stringContaining("Relevant Durable Memory"),
      },
      diagnostics: {
        durableRecallUsed: true,
        procedureRecallUsed: false,
        abstained: false,
      },
      timings: {
        totalMs: expect.any(Number),
        sandboxSetupMs: expect.any(Number),
        fixtureProvisionMs: expect.any(Number),
        beforeTurnMs: expect.any(Number),
        renderPatchMs: expect.any(Number),
      },
      sandbox: {
        root: expect.any(String),
        dbPath: expect.any(String),
        preserved: false,
      },
    });
    expect(response.output?.renderedPatchText).toContain("Duke is Jim's dog.");
  });

  it("returns an abstain response with an empty rendered patch for greeting turns", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runBeforeTurnEvalCase({
      caseId: "before-turn-greeting-abstain",
      memoryPool: [
        {
          id: "noise-entry",
          type: "fact",
          subject: "unrelated note",
          content: "This should not surface for a greeting.",
        },
      ],
      beforeTurnInput: {
        currentTurnText: "hello",
      },
      options: {
        includeDiagnostics: true,
        includeRenderedPatch: true,
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      caseId: "before-turn-greeting-abstain",
      output: {
        abstained: true,
        selectedEntryIds: [],
        selectedProcedureKey: null,
        renderedPatchText: "",
      },
      diagnostics: {
        durableRecallUsed: false,
        procedureRecallUsed: false,
        abstained: true,
        abstentionReasons: ["Current turn was short or social without clear factual, procedural, or task intent."],
      },
    });
  });

  it("returns the selected procedure key for a procedural turn", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runBeforeTurnEvalCase({
      caseId: "before-turn-procedure",
      memoryPool: [],
      procedurePool: [
        {
          id: "procedure-rotate-key",
          procedure_key: "security/signing-key-rotation",
          title: "Rotate the production signing key",
          goal: "Rotate the production signing key safely.",
          when_to_use: ["Use this when the production signing key must be rotated."],
          verification: ["Downstream verification succeeds after rotation."],
          failure_modes: ["Rotation fails before verification completes."],
          steps: [
            {
              id: "inspect-state",
              kind: "inspect_state",
              instruction: "Inspect the current signing key state before rotating it.",
              target: "signing key state",
            },
          ],
          sources: [{ kind: "manual", label: "fixture" }],
        },
      ],
      beforeTurnInput: {
        currentTurnText: "How do I rotate the production signing key safely?",
        policy: {
          enableDurableRecall: false,
        },
      },
      options: {
        includeDiagnostics: true,
      },
    });

    expect(response).toMatchObject({
      status: "ok",
      caseId: "before-turn-procedure",
      output: {
        abstained: false,
        selectedEntryIds: [],
        selectedProcedureKey: "security/signing-key-rotation",
      },
      diagnostics: {
        durableRecallUsed: false,
        procedureRecallUsed: true,
        abstained: false,
      },
    });
  });

  it("returns directness diagnostics for a threshold-zero Duke identity case", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runBeforeTurnEvalCase({
      caseId: "before-turn-directness",
      memoryPool: [
        {
          id: "duke-cousins",
          type: "fact",
          subject: "duke cousins",
          content: "Duke's cousins are Comet and Pepper.",
          tags: ["dogs", "family"],
        },
        {
          id: "duke-identity",
          type: "fact",
          subject: "duke identity",
          content: "Duke is Jim's dog.",
          tags: ["dogs", "identity"],
        },
      ],
      beforeTurnInput: {
        currentTurnText: "Who is Duke?",
        policy: {
          recallThreshold: 0,
          enableProcedureSuggestion: false,
        },
      },
      options: {
        includeDiagnostics: true,
      },
    });

    expect(response.status).toBe("ok");
    expect(response.output?.selectedEntryIds).toEqual(["duke-identity"]);
    expect(response.diagnostics).toMatchObject({
      query: "Who is Duke?",
      queryPolicy: "current_only",
      queryVariants: [
        {
          kind: "current_only",
          query: "Who is Duke?",
          candidateCount: expect.any(Number),
          selected: true,
        },
      ],
      durableRecallUsed: true,
      durableRecallCandidateCount: expect.any(Number),
      procedureRecallUsed: false,
      abstained: false,
      directness: {
        queryKind: "entity_definition",
        entity: "Duke",
        winnerEntryId: "duke-identity",
        candidates: expect.arrayContaining([
          expect.objectContaining({
            entryId: "duke-identity",
          }),
          expect.objectContaining({
            entryId: "duke-cousins",
          }),
        ]),
      },
    });
    expect(["kept", "reranked"]).toContain(response.diagnostics?.directness?.decision ?? "");
  });

  it("returns contextual-required diagnostics for underspecified follow-up turns", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runBeforeTurnEvalCase({
      caseId: "before-turn-context-required",
      memoryPool: [
        {
          id: "duke-identity",
          type: "fact",
          subject: "duke identity",
          content: "Duke is Jim's dog.",
          tags: ["dogs", "identity"],
        },
      ],
      beforeTurnInput: {
        currentTurnText: "What about him?",
        recentTurns: [
          {
            role: "assistant",
            text: "Duke is Jim's dog.",
          },
        ],
        policy: {
          recallThreshold: 0,
          enableProcedureSuggestion: false,
        },
      },
      options: {
        includeDiagnostics: true,
      },
    });

    expect(response.status).toBe("ok");
    expect(response.output?.selectedEntryIds).toEqual(["duke-identity"]);
    expect(response.diagnostics).toMatchObject({
      query: "What about him?\nTopic: Duke is Jim's dog.",
      queryPolicy: "contextual_required",
      queryVariants: [
        {
          kind: "contextual_anchor",
          query: "What about him?\nTopic: Duke is Jim's dog.",
          candidateCount: expect.any(Number),
          selected: true,
        },
      ],
      durableRecallUsed: true,
      procedureRecallUsed: false,
      abstained: false,
    });
    expect(response.diagnostics?.directness).toBeUndefined();
  });

  it("invokes an injected cross-encoder port for phase-4 rerank when dependencies supply one", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const rankSpy = vi.fn<(query: string, passages: readonly CrossEncoderPassage[]) => Promise<CrossEncoderScore[]>>(async (_query, passages) =>
      passages.map((passage, index) => ({ id: passage.id, score: 1 - index * 0.1 })),
    );
    const crossEncoder: CrossEncoderPort = { rank: rankSpy };

    const response = await runBeforeTurnEvalCase(
      {
        caseId: "before-turn-cross-encoder-injection",
        memoryPool: [
          {
            id: "duke-identity",
            type: "fact",
            subject: "duke identity",
            content: "Duke is Jim's dog.",
            tags: ["dogs", "identity"],
          },
          {
            id: "duke-cousins",
            type: "fact",
            subject: "duke cousins",
            content: "Duke's cousins are Comet and Pepper.",
            tags: ["dogs", "family"],
          },
        ],
        beforeTurnInput: {
          currentTurnText: "who is Duke?",
          policy: {
            recallThreshold: 0,
            enableProcedureSuggestion: false,
          },
        },
        options: {
          includeDiagnostics: true,
        },
      },
      { crossEncoder },
    );

    expect(response.status).toBe("ok");
    expect(rankSpy).toHaveBeenCalled();
    expect(response.diagnostics?.durableRecallTrace?.crossEncoder).toMatchObject({
      applied: true,
    });
    expect(response.diagnostics?.durableRecallTrace?.crossEncoder?.degradedReason).toBeUndefined();
  });

  it("records durable-recall cross-encoder degradedReason not_configured when no port is injected", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runBeforeTurnEvalCase({
      caseId: "before-turn-cross-encoder-absent",
      memoryPool: [
        {
          id: "duke-identity",
          type: "fact",
          subject: "duke identity",
          content: "Duke is Jim's dog.",
          tags: ["dogs", "identity"],
        },
      ],
      beforeTurnInput: {
        currentTurnText: "who is Duke?",
        policy: {
          recallThreshold: 0,
          enableProcedureSuggestion: false,
        },
      },
      options: {
        includeDiagnostics: true,
      },
    });

    expect(response.status).toBe("ok");
    expect(response.diagnostics?.durableRecallTrace?.crossEncoder?.applied).toBe(false);
    expect(response.diagnostics?.durableRecallTrace?.crossEncoder?.degradedReason).toBe("not_configured");
  });

  it("seeds durable memory from a copied snapshot and surfaces snapshot metadata", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const sourceRoot = await createTempDirectory("agenr-before-turn-snapshot-source-");
    const snapshotDbPath = path.join(sourceRoot, "knowledge.db");
    await seedSnapshotEntry(snapshotDbPath, {
      id: "snapshot-duke",
      type: "fact",
      subject: "duke identity",
      content: "Duke is Jim's dog.",
      importance: 6,
      expiry: "permanent",
      tags: ["dogs", "identity"],
      quality_score: 0.5,
      recall_count: 0,
      retired: false,
      created_at: "2026-04-18T00:00:00.000Z",
      updated_at: "2026-04-18T00:00:00.000Z",
    });
    const sourceBytesBefore = await readFile(snapshotDbPath);

    const sandboxRoot = await createTempDirectory("agenr-before-turn-snapshot-sandbox-");

    const response = await runBeforeTurnEvalCase({
      caseId: "before-turn-snapshot-seed",
      sandbox: {
        root: sandboxRoot,
        preserve: true,
        corpusSeed: {
          mode: "snapshot_copy",
          snapshotDbPath,
          snapshotId: "nightly-2026-04-18",
          snapshotLabel: "nightly corpus snapshot",
        },
      },
      memoryPool: [],
      beforeTurnInput: {
        currentTurnText: "who is Duke?",
        policy: {
          recallThreshold: 0,
          enableProcedureSuggestion: false,
        },
      },
      options: {
        includeDiagnostics: true,
      },
    });

    expect(response.status).toBe("ok");
    expect(response.output?.selectedEntryIds).toEqual(["snapshot-duke"]);
    expect(response.sandbox).toMatchObject({
      root: sandboxRoot,
      preserved: true,
      snapshot: {
        id: "nightly-2026-04-18",
        label: "nightly corpus snapshot",
        dbPathBasename: "knowledge.db",
        allowedTelemetryWrites: false,
      },
    });

    const sourceBytesAfter = await readFile(snapshotDbPath);
    expect(sourceBytesAfter.equals(sourceBytesBefore)).toBe(true);
  });

  it("applies fixture overlays on top of a copied snapshot and keeps telemetry writes off by default", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const sourceRoot = await createTempDirectory("agenr-before-turn-overlay-source-");
    const snapshotDbPath = path.join(sourceRoot, "knowledge.db");
    await seedSnapshotEntry(snapshotDbPath, {
      id: "snapshot-duke",
      type: "fact",
      subject: "duke identity",
      content: "Duke is Jim's dog in the snapshot.",
      importance: 6,
      expiry: "permanent",
      tags: ["dogs", "identity"],
      quality_score: 0.5,
      recall_count: 0,
      retired: false,
      created_at: "2026-04-18T00:00:00.000Z",
      updated_at: "2026-04-18T00:00:00.000Z",
    });
    const sourceBytesBefore = await readFile(snapshotDbPath);

    const sandboxRoot = await createTempDirectory("agenr-before-turn-overlay-sandbox-");

    const response = await runBeforeTurnEvalCase({
      caseId: "before-turn-snapshot-overlay",
      sandbox: {
        root: sandboxRoot,
        preserve: true,
        corpusSeed: {
          mode: "snapshot_copy",
          snapshotDbPath,
        },
      },
      memoryPool: [
        {
          id: "overlay-pager",
          type: "fact",
          subject: "overlay pager policy",
          content: "Taylor is on call in the overlay fixtures.",
          tags: ["ops"],
        },
      ],
      beforeTurnInput: {
        currentTurnText: "who is on call in the overlay fixtures?",
        policy: {
          recallThreshold: 0,
          enableProcedureSuggestion: false,
        },
      },
    });

    expect(response.status).toBe("ok");
    expect(response.output?.selectedEntryIds).toEqual(["overlay-pager"]);

    const overlaySandboxDb = await createDatabase(path.join(sandboxRoot, "knowledge.db"));
    try {
      const overlayEntry = await overlaySandboxDb.getEntry("overlay-pager");
      expect(overlayEntry?.content).toBe("Taylor is on call in the overlay fixtures.");

      const snapshotEntry = await overlaySandboxDb.getEntry("snapshot-duke");
      expect(snapshotEntry?.content).toBe("Duke is Jim's dog in the snapshot.");
      expect(snapshotEntry?.recall_count).toBe(0);
    } finally {
      await overlaySandboxDb.close();
    }

    const sourceBytesAfter = await readFile(snapshotDbPath);
    expect(sourceBytesAfter.equals(sourceBytesBefore)).toBe(true);
  });

  it("keeps isolated eval state from leaking live database entries into results", async () => {
    const tempRoot = await createTempDirectory("agenr-before-turn-live-");
    const liveDbPath = path.join(tempRoot, "live.sqlite");
    await seedLiveEntry(liveDbPath, {
      id: "live-only",
      type: "fact",
      subject: "live state leak",
      content: "Morgan is on call in the live database only.",
      importance: 8,
      expiry: "permanent",
      tags: [],
      quality_score: 0.8,
      recall_count: 0,
      retired: false,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
    });

    process.env.OPENAI_API_KEY = "test-key";
    process.env.AGENR_DB_PATH = liveDbPath;
    vi.stubGlobal("fetch", createEmbeddingFetchStub());

    const response = await runBeforeTurnEvalCase({
      caseId: "before-turn-isolated",
      memoryPool: [
        {
          id: "fixture-entry",
          type: "fact",
          subject: "sandbox-only",
          content: "Taylor is on call in the eval sandbox.",
        },
      ],
      beforeTurnInput: {
        currentTurnText: "who is on call in the eval sandbox?",
        policy: {
          recallThreshold: 0,
          enableProcedureSuggestion: false,
        },
      },
    });

    expect(response.status).toBe("ok");
    expect(response.output?.selectedEntryIds).toEqual(["fixture-entry"]);
    expect(response.output?.selectedEntryIds).not.toContain("live-only");
    await expect(access(response.sandbox?.dbPath ?? "")).rejects.toBeDefined();
  });
});

/** Creates a temp directory and tracks it for cleanup. */
async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempPaths.push(directory);
  return directory;
}

/** Seeds one entry into a standalone live database used to detect state leaks. */
async function seedLiveEntry(dbPath: string, entry: Parameters<Awaited<ReturnType<typeof createDatabase>>["insertEntry"]>[0]): Promise<void> {
  const database = await createDatabase(dbPath);
  try {
    await database.insertEntry(entry, hashToVector(`${entry.subject} ${entry.content}`, 1024), entry.id);
  } finally {
    await database.close();
  }
}

/**
 * Seeds one entry into a standalone snapshot database and collapses the
 * WAL so the main database file captures every seeded row before the
 * sandbox copyFile step runs.
 */
async function seedSnapshotEntry(dbPath: string, entry: Parameters<Awaited<ReturnType<typeof createDatabase>>["insertEntry"]>[0]): Promise<void> {
  const database = await createDatabase(dbPath);
  try {
    await database.insertEntry(entry, hashToVector(`${entry.subject} ${entry.content}`, 1024), entry.id);
    await database.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    await database.close();
  }
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
