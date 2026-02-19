import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import * as clack from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConsolidateCommand, shouldAutoTriggerForgetting } from "../../src/commands/consolidate.js";
import type { ConsolidationOrchestratorReport } from "../../src/consolidate/orchestrate.js";
import { initDb } from "../../src/db/client.js";

function reportFixture(): ConsolidationOrchestratorReport {
  return {
    entriesBefore: 100,
    entriesAfter: 70,
    entriesAfterRules: 90,
    expiredCount: 5,
    mergedCount: 5,
    orphanedRelationsCleaned: 1,
    backupPath: "/tmp/knowledge.db.pre-consolidate-2026-02-16",
    estimate: {
      totalClusters: 4,
      estimatedLlmCalls: 4,
      phase1ByType: [],
      phase2Clusters: 1,
    },
    phase1: {
      totals: {
        entries: 20,
        clustersFound: 3,
        skippedByResume: 0,
        clustersProcessed: 3,
        clustersMerged: 2,
        mergesFlagged: 1,
        llmCalls: 3,
        entriesConsolidatedFrom: 6,
        canonicalEntriesCreated: 2,
      },
      types: [],
    },
    phase2: {
      entries: 10,
      clustersFound: 1,
      skippedByResume: 0,
      clustersProcessed: 1,
      clustersMerged: 1,
      mergesFlagged: 0,
      llmCalls: 1,
      entriesConsolidatedFrom: 2,
      canonicalEntriesCreated: 1,
    },
    progress: {
      resumed: false,
      checkpointPath: "/tmp/checkpoint",
      partial: false,
      processedClusters: 4,
      remainingClusters: 0,
    },
    summary: {
      totalLlmCalls: 4,
      totalFlagged: 1,
      totalCanonicalEntriesCreated: 3,
      totalEntriesConsolidatedFrom: 8,
    },
  };
}

describe("consolidate command", () => {
  const clients: Client[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function makeFileBackedDb(): Promise<{ client: Client; dbPath: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-consolidate-cmd-test-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "knowledge.db");
    const client = createClient({ url: `file:${dbPath}` });
    clients.push(client);
    await initDb(client);
    return { client, dbPath };
  }

  async function insertSeedEntry(
    client: Client,
    params: {
      id: string;
      subject: string;
      importance: number;
      type?: string;
      recallCount?: number;
      contradictions?: number;
      daysOld: number;
    },
  ): Promise<void> {
    const now = new Date("2026-02-19T00:00:00.000Z");
    const createdAt = new Date(now.getTime() - params.daysOld * 24 * 60 * 60 * 1000).toISOString();
    await client.execute({
      sql: `
        INSERT INTO entries (
          id,
          type,
          subject,
          content,
          importance,
          expiry,
          scope,
          source_file,
          source_context,
          created_at,
          updated_at,
          recall_count,
          contradictions
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        params.id,
        params.type ?? "fact",
        params.subject,
        `${params.subject} content`,
        params.importance,
        "temporary",
        "private",
        "consolidate.test.jsonl",
        "unit test",
        createdAt,
        createdAt,
        params.recallCount ?? 0,
        params.contradictions ?? 0,
      ],
    });
  }

  async function entryExists(client: Client, id: string): Promise<boolean> {
    const result = await client.execute({
      sql: "SELECT id FROM entries WHERE id = ?",
      args: [id],
    });
    return result.rows.length > 0;
  }

  async function retiredState(client: Client, id: string): Promise<number | null> {
    const result = await client.execute({
      sql: "SELECT retired FROM entries WHERE id = ?",
      args: [id],
    });
    if (result.rows.length === 0) {
      return null;
    }
    return Number((result.rows[0] as { retired?: unknown } | undefined)?.retired ?? 0);
  }

  function makeDeps() {
    const db = {
      execute: vi.fn(async (stmt: unknown) => {
        const sql = typeof stmt === "string" ? stmt : String((stmt as { sql?: unknown }).sql ?? "");
        if (sql.includes("COUNT(*)")) {
          return { rows: [{ count: 0 }] };
        }
        return { rows: [] };
      }),
    };

    return {
      readConfigFn: vi.fn(() => ({ db: { path: "/tmp/knowledge.db" } })),
      getDbFn: vi.fn(() => db as any),
      closeDbFn: vi.fn(() => undefined),
      initSchemaFn: vi.fn(async () => undefined),
      createLlmClientFn: vi.fn(() => ({} as any)),
      resolveEmbeddingApiKeyFn: vi.fn(() => "embed-key"),
      showFlaggedMergesFn: vi.fn(async () => undefined),
      runConsolidationOrchestratorFn: vi.fn(async (_db, _dbPath, _llm, _key, options) => {
        options.onLog?.("progress");
        options.onWarn?.("warning");
        return reportFixture();
      }),
    };
  }

  it("uses plain stderr logging and no clack output when --json is enabled", async () => {
    const deps = makeDeps();
    const infoSpy = vi.spyOn(clack.log, "info");
    const warnSpy = vi.spyOn(clack.log, "warn");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runConsolidateCommand({ json: true }, deps);

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    const stderr = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(stderr).toContain("progress");
    expect(stderr).toContain("warning");

    const stdout = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    const parsed = JSON.parse(stdout) as { entriesBefore: number; entriesAfter: number };
    expect(parsed.entriesBefore).toBe(100);
    expect(parsed.entriesAfter).toBe(70);
  });

  it("bypasses clack in non-tty mode and emits plain text report", async () => {
    const deps = makeDeps();
    const infoSpy = vi.spyOn(clack.log, "info");
    const warnSpy = vi.spyOn(clack.log, "warn");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });

    try {
      await runConsolidateCommand({ json: false }, deps);
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Knowledge Consolidation");
    expect(output.includes("\u001b[")).toBe(false);
  });

  it("supports --report with --dry-run as report-only mode", async () => {
    const deps = makeDeps();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runConsolidateCommand({ report: true, dryRun: true }, deps);

    expect(deps.runConsolidationOrchestratorFn).not.toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Consolidation Report (pre-run)");
  });

  it("reports todo buckets, never-recalled entries, contradictions, and LLM cost details", async () => {
    const { client, dbPath } = await makeFileBackedDb();
    await insertSeedEntry(client, {
      id: "todo-fresh",
      type: "todo",
      subject: "todo-fresh",
      importance: 5,
      daysOld: 3,
      recallCount: 0,
    });
    await insertSeedEntry(client, {
      id: "todo-older",
      type: "todo",
      subject: "todo-older",
      importance: 5,
      daysOld: 45,
      recallCount: 0,
    });
    await insertSeedEntry(client, {
      id: "contradiction-entry",
      type: "fact",
      subject: "test-subject",
      importance: 5,
      daysOld: 15,
      recallCount: 0,
      contradictions: 2,
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });

    try {
      const exit = await runConsolidateCommand(
        { report: true, dryRun: true, db: dbPath },
        {
          readConfigFn: vi.fn(() => ({ db: { path: dbPath } })),
          getDbFn: vi.fn(() => client),
          closeDbFn: vi.fn(() => undefined),
          initSchemaFn: vi.fn(async () => undefined),
          createLlmClientFn: vi.fn(() => ({} as never)),
          resolveEmbeddingApiKeyFn: vi.fn(() => "embed-key"),
          showFlaggedMergesFn: vi.fn(async () => undefined),
          runConsolidationOrchestratorFn: vi.fn(async () => reportFixture()),
        },
      );

      expect(exit.exitCode).toBe(0);
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }

    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Consolidation Report (pre-run)");
    expect(output).toContain("0-7d");
    expect(output.includes("30-90d") || output.includes("30d+")).toBe(true);
    expect(output.toLowerCase()).toContain("never recalled");
    const neverRecalledMatch = output.match(/never recalled:\s*([0-9,]+)/i);
    expect(neverRecalledMatch).toBeTruthy();
    const neverRecalledCount = Number((neverRecalledMatch?.[1] ?? "0").replace(/,/g, ""));
    expect(neverRecalledCount).toBeGreaterThanOrEqual(3);
    expect(output).toContain("test-subject");
    expect(output.toLowerCase().includes("cost") || output.includes("$") || output.toLowerCase().includes("tokens")).toBe(
      true,
    );
  });

  it("evaluates forgetting auto-trigger thresholds", () => {
    expect(
      shouldAutoTriggerForgetting({
        dbFileSizeBytes: 100 * 1024 * 1024,
        activeEntryCount: 1_000,
        lowScoreOldEntryCount: 20,
      }),
    ).toBe(false);

    expect(
      shouldAutoTriggerForgetting({
        dbFileSizeBytes: 201 * 1024 * 1024,
        activeEntryCount: 1_000,
        lowScoreOldEntryCount: 20,
      }),
    ).toBe(true);

    expect(
      shouldAutoTriggerForgetting({
        dbFileSizeBytes: 100 * 1024 * 1024,
        activeEntryCount: 10_001,
        lowScoreOldEntryCount: 20,
      }),
    ).toBe(true);

    expect(
      shouldAutoTriggerForgetting({
        dbFileSizeBytes: 100 * 1024 * 1024,
        activeEntryCount: 1_000,
        lowScoreOldEntryCount: 51,
      }),
    ).toBe(true);

    expect(
      shouldAutoTriggerForgetting({
        dbFileSizeBytes: 200 * 1024 * 1024,
        activeEntryCount: 1_000,
        lowScoreOldEntryCount: 20,
      }),
    ).toBe(false);

    expect(
      shouldAutoTriggerForgetting({
        dbFileSizeBytes: 100 * 1024 * 1024,
        activeEntryCount: 10_000,
        lowScoreOldEntryCount: 20,
      }),
    ).toBe(false);

    expect(
      shouldAutoTriggerForgetting({
        dbFileSizeBytes: 100 * 1024 * 1024,
        activeEntryCount: 1_000,
        lowScoreOldEntryCount: 50,
      }),
    ).toBe(false);
  });

  it("--forget deletes entries with forgettingScore below threshold", async () => {
    const { client, dbPath } = await makeFileBackedDb();
    await insertSeedEntry(client, { id: "entry-a", subject: "Entry A", importance: 3, daysOld: 400, recallCount: 0 });
    await insertSeedEntry(client, { id: "entry-b", subject: "Entry B", importance: 8, daysOld: 400, recallCount: 0 });
    await insertSeedEntry(client, { id: "entry-c", subject: "Entry C", importance: 5, daysOld: 10, recallCount: 0 });

    const exit = await runConsolidateCommand(
      { forget: true, db: dbPath },
      {
        readConfigFn: vi.fn(() => ({
          db: { path: dbPath },
          forgetting: { protect: [], scoreThreshold: 0.05, maxAgeDays: 60, enabled: true },
        })),
        getDbFn: vi.fn(() => client),
        closeDbFn: vi.fn(() => undefined),
        initSchemaFn: vi.fn(async () => undefined),
        createLlmClientFn: vi.fn(() => ({} as never)),
        resolveEmbeddingApiKeyFn: vi.fn(() => "embed-key"),
        showFlaggedMergesFn: vi.fn(async () => undefined),
        runConsolidationOrchestratorFn: vi.fn(async () => reportFixture()),
      },
    );

    expect(exit.exitCode).toBe(0);
    expect(await retiredState(client, "entry-a")).toBe(1);
    expect(await retiredState(client, "entry-b")).toBe(0);
    expect(await retiredState(client, "entry-c")).toBe(0);
  });

  it("--forget respects the protect list", async () => {
    const { client, dbPath } = await makeFileBackedDb();
    await insertSeedEntry(client, { id: "protected-a", subject: "EJA identity", importance: 3, daysOld: 400, recallCount: 0 });

    const exit = await runConsolidateCommand(
      { forget: true, db: dbPath },
      {
        readConfigFn: vi.fn(() => ({
          db: { path: dbPath },
          forgetting: { protect: ["EJA identity"], scoreThreshold: 0.05, maxAgeDays: 60, enabled: true },
        })),
        getDbFn: vi.fn(() => client),
        closeDbFn: vi.fn(() => undefined),
        initSchemaFn: vi.fn(async () => undefined),
        createLlmClientFn: vi.fn(() => ({} as never)),
        resolveEmbeddingApiKeyFn: vi.fn(() => "embed-key"),
        showFlaggedMergesFn: vi.fn(async () => undefined),
        runConsolidationOrchestratorFn: vi.fn(async () => reportFixture()),
      },
    );

    expect(exit.exitCode).toBe(0);
    expect(await entryExists(client, "protected-a")).toBe(true);
  });

  it("--forget dry-run path without --forget does not delete and shows preview", async () => {
    const { client, dbPath } = await makeFileBackedDb();
    await insertSeedEntry(client, { id: "dry-a", subject: "Dry Candidate", importance: 3, daysOld: 400, recallCount: 0 });

    let activeCountCalls = 0;
    const realExecute = client.execute.bind(client);
    const dbProxy = {
      ...client,
      execute: vi.fn(async (stmt: string | { sql?: string; args?: unknown[] }) => {
        const sql = typeof stmt === "string" ? stmt : stmt.sql ?? "";
        if (sql.includes("SELECT COUNT(*) AS count") && sql.includes("FROM entries") && sql.includes("superseded_by IS NULL")) {
          activeCountCalls += 1;
          if (activeCountCalls >= 2) {
            return { rows: [{ count: 10001 }] };
          }
        }
        return realExecute(stmt as never);
      }),
    } as unknown as Client;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const exit = await runConsolidateCommand(
      { dryRun: true, db: dbPath },
      {
        readConfigFn: vi.fn(() => ({
          db: { path: dbPath },
          forgetting: { protect: [], scoreThreshold: 0.05, maxAgeDays: 60, enabled: true },
        })),
        getDbFn: vi.fn(() => dbProxy),
        closeDbFn: vi.fn(() => undefined),
        initSchemaFn: vi.fn(async () => undefined),
        createLlmClientFn: vi.fn(() => ({} as never)),
        resolveEmbeddingApiKeyFn: vi.fn(() => "embed-key"),
        showFlaggedMergesFn: vi.fn(async () => undefined),
        runConsolidationOrchestratorFn: vi.fn(async () => reportFixture()),
      },
    );

    expect(exit.exitCode).toBe(0);
    expect(await entryExists(client, "dry-a")).toBe(true);
    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Forgetting candidates");
    expect(output).toContain("Run with --forget to delete");
  });

  it("--forget outputs a deletion summary line with freed size", async () => {
    const { client, dbPath } = await makeFileBackedDb();
    await insertSeedEntry(client, { id: "delete-1", subject: "Delete One", importance: 3, daysOld: 400, recallCount: 0 });
    await insertSeedEntry(client, { id: "delete-2", subject: "Delete Two", importance: 2, daysOld: 420, recallCount: 0 });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const exit = await runConsolidateCommand(
      { forget: true, db: dbPath },
      {
        readConfigFn: vi.fn(() => ({
          db: { path: dbPath },
          forgetting: { protect: [], scoreThreshold: 0.05, maxAgeDays: 60, enabled: true },
        })),
        getDbFn: vi.fn(() => client),
        closeDbFn: vi.fn(() => undefined),
        initSchemaFn: vi.fn(async () => undefined),
        createLlmClientFn: vi.fn(() => ({} as never)),
        resolveEmbeddingApiKeyFn: vi.fn(() => "embed-key"),
        showFlaggedMergesFn: vi.fn(async () => undefined),
        runConsolidationOrchestratorFn: vi.fn(async () => reportFixture()),
      },
    );

    expect(exit.exitCode).toBe(0);
    const output = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Retired");
    expect(output).toContain("freed");
    const retiredMatch = output.match(/Retired\s+([0-9,]+)\s+entries/);
    expect(retiredMatch).toBeTruthy();
    const deleted = Number((retiredMatch?.[1] ?? "0").replace(/,/g, ""));
    expect(deleted).toBeGreaterThan(0);
  });

  it("--forget with --dry-run previews candidates and advises running without dry-run", async () => {
    const { client, dbPath } = await makeFileBackedDb();
    await insertSeedEntry(client, {
      id: "dry-forget",
      subject: "Dry Forget Candidate",
      importance: 3,
      daysOld: 400,
      recallCount: 0,
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });

    try {
      const exit = await runConsolidateCommand(
        { forget: true, dryRun: true, db: dbPath },
        {
          readConfigFn: vi.fn(() => ({
            db: { path: dbPath },
            forgetting: { protect: [], scoreThreshold: 0.05, maxAgeDays: 60, enabled: true },
          })),
          getDbFn: vi.fn(() => client),
          closeDbFn: vi.fn(() => undefined),
          initSchemaFn: vi.fn(async () => undefined),
          createLlmClientFn: vi.fn(() => ({} as never)),
          resolveEmbeddingApiKeyFn: vi.fn(() => "embed-key"),
          showFlaggedMergesFn: vi.fn(async () => undefined),
          runConsolidationOrchestratorFn: vi.fn(async () => reportFixture()),
        },
      );
      expect(exit.exitCode).toBe(0);
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }

    expect(await entryExists(client, "dry-forget")).toBe(true);
    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Forgetting candidates");
    expect(output).toContain("Run without --dry-run to delete");
  });
});
