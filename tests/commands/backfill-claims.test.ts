import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBackfillClaimsCommand } from "../../src/commands/backfill-claims.js";
import { initDb } from "../../src/db/client.js";
import { SubjectIndex } from "../../src/db/subject-index.js";
import type { LlmClient } from "../../src/types.js";
import * as claimExtractionModule from "../../src/db/claim-extraction.js";
import * as llmClientModule from "../../src/llm/client.js";

interface SeedEntry {
  id: string;
  type?: string;
  subject?: string;
  content?: string;
  importance?: number;
  retired?: number;
  supersededBy?: string | null;
  subjectKey?: string | null;
}

const tempDirs: string[] = [];

function makeFakeClient(modelId = "gpt-4.1-nano"): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId,
      model: {} as never,
    },
    credentials: {
      apiKey: "sk-test",
      source: "test",
    },
  };
}

async function createTempDb(): Promise<{ dbPath: string; client: Client }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-backfill-claims-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "knowledge.db");
  const client = createClient({ url: `file:${dbPath}` });
  await initDb(client);
  return { dbPath, client };
}

async function insertEntry(client: Client, entry: SeedEntry): Promise<void> {
  const now = "2026-02-26T12:00:00.000Z";
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
        retired,
        superseded_by,
        subject_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      entry.id,
      entry.type ?? "fact",
      entry.subject ?? `Subject ${entry.id}`,
      entry.content ?? `Content ${entry.id}`,
      entry.importance ?? 7,
      "temporary",
      "private",
      "backfill-claims.test.ts",
      "test",
      now,
      now,
      entry.retired ?? 0,
      entry.supersededBy ?? null,
      entry.subjectKey ?? null,
    ],
  });
}

async function getEntryRow(client: Client, id: string): Promise<Record<string, unknown>> {
  const result = await client.execute({
    sql: `
      SELECT
        id,
        subject_key,
        subject_entity,
        subject_attribute,
        claim_predicate,
        claim_object,
        claim_confidence,
        retired,
        superseded_by
      FROM entries
      WHERE id = ?
    `,
    args: [id],
  });
  return (result.rows[0] ?? {}) as Record<string, unknown>;
}

async function runWithCapturedOutput(
  options: Parameters<typeof runBackfillClaimsCommand>[0],
): Promise<{ stdout: string; stderr: string; result: Awaited<ReturnType<typeof runBackfillClaimsCommand>> }> {
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const result = await runBackfillClaimsCommand(options);
    const stdout = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    const stderr = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    return { stdout, stderr, result };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

describe("backfill-claims command", () => {
  it("processes entries without subject_key", async () => {
    const { dbPath, client } = await createTempDb();
    await insertEntry(client, { id: "needs-claim" });
    client.close();

    vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue(makeFakeClient());
    const extractClaimSpy = vi.spyOn(claimExtractionModule, "extractClaim").mockResolvedValue({
      subjectEntity: "alex",
      subjectAttribute: "role",
      subjectKey: "alex:role",
      predicate: "is",
      object: "engineer",
      confidence: 0.91,
    });

    const { result } = await runWithCapturedOutput({ db: dbPath });

    expect(result.exitCode).toBe(0);
    expect(result.processed).toBe(1);
    expect(result.claimsExtracted).toBe(1);
    expect(extractClaimSpy).toHaveBeenCalledTimes(1);
  });

  it("skips entries that already have subject_key", async () => {
    const { dbPath, client } = await createTempDb();
    await insertEntry(client, { id: "already-indexed", subjectKey: "alex:role" });
    await insertEntry(client, { id: "needs-claim" });
    client.close();

    vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue(makeFakeClient());
    const extractClaimSpy = vi.spyOn(claimExtractionModule, "extractClaim").mockResolvedValue({
      subjectEntity: "alex",
      subjectAttribute: "role",
      subjectKey: "alex:role",
      predicate: "is",
      object: "engineer",
      confidence: 0.91,
    });

    const { result } = await runWithCapturedOutput({ db: dbPath });
    expect(result.processed).toBe(1);
    expect(extractClaimSpy).toHaveBeenCalledTimes(1);

    const verifyClient = createClient({ url: `file:${dbPath}` });
    await initDb(verifyClient);
    const row = await getEntryRow(verifyClient, "already-indexed");
    verifyClient.close();
    expect(row.subject_key).toBe("alex:role");
  });

  it("skips retired entries", async () => {
    const { dbPath, client } = await createTempDb();
    await insertEntry(client, { id: "retired-entry", retired: 1 });
    await insertEntry(client, { id: "active-entry" });
    client.close();

    vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue(makeFakeClient());
    const extractClaimSpy = vi.spyOn(claimExtractionModule, "extractClaim").mockResolvedValue({
      subjectEntity: "alex",
      subjectAttribute: "status",
      subjectKey: "alex:status",
      predicate: "is",
      object: "active",
      confidence: 0.75,
    });

    const { result } = await runWithCapturedOutput({ db: dbPath });
    expect(result.processed).toBe(1);
    expect(extractClaimSpy).toHaveBeenCalledTimes(1);
  });

  it("skips superseded entries", async () => {
    const { dbPath, client } = await createTempDb();
    await insertEntry(client, { id: "winner" });
    await insertEntry(client, { id: "superseded", supersededBy: "winner" });
    await insertEntry(client, { id: "needs-claim" });
    client.close();

    vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue(makeFakeClient());
    const extractClaimSpy = vi.spyOn(claimExtractionModule, "extractClaim").mockResolvedValue({
      subjectEntity: "alex",
      subjectAttribute: "status",
      subjectKey: "alex:status",
      predicate: "is",
      object: "current",
      confidence: 0.8,
    });

    const { result } = await runWithCapturedOutput({ db: dbPath });
    expect(result.processed).toBe(2);
    expect(extractClaimSpy).toHaveBeenCalledTimes(2);
  });

  it("updates entry with extracted claim fields", async () => {
    const { dbPath, client } = await createTempDb();
    await insertEntry(client, { id: "claim-target" });
    client.close();

    vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue(makeFakeClient());
    vi.spyOn(claimExtractionModule, "extractClaim").mockResolvedValue({
      subjectEntity: "agenr",
      subjectAttribute: "storage_backend",
      subjectKey: "agenr:storage_backend",
      predicate: "uses",
      object: "libsql",
      confidence: 0.88,
    });

    await runWithCapturedOutput({ db: dbPath });

    const verifyClient = createClient({ url: `file:${dbPath}` });
    await initDb(verifyClient);
    const row = await getEntryRow(verifyClient, "claim-target");
    verifyClient.close();

    expect(row.subject_entity).toBe("agenr");
    expect(row.subject_attribute).toBe("storage_backend");
    expect(row.subject_key).toBe("agenr:storage_backend");
    expect(row.claim_predicate).toBe("uses");
    expect(row.claim_object).toBe("libsql");
    expect(Number(row.claim_confidence)).toBeCloseTo(0.88, 6);
  });

  it("continues processing after single-entry extraction error", async () => {
    const { dbPath, client } = await createTempDb();
    await insertEntry(client, { id: "first" });
    await insertEntry(client, { id: "second" });
    client.close();

    vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue(makeFakeClient());
    vi.spyOn(claimExtractionModule, "extractClaim")
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce({
        subjectEntity: "alex",
        subjectAttribute: "city",
        subjectKey: "alex:city",
        predicate: "lives_in",
        object: "seattle",
        confidence: 0.84,
      });

    const { result, stderr } = await runWithCapturedOutput({ db: dbPath, batchSize: 2 });
    expect(result.processed).toBe(2);
    expect(result.claimsExtracted).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("failed");
  });

  it("respects --limit option", async () => {
    const { dbPath, client } = await createTempDb();
    await insertEntry(client, { id: "e1" });
    await insertEntry(client, { id: "e2" });
    await insertEntry(client, { id: "e3" });
    client.close();

    vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue(makeFakeClient());
    const extractClaimSpy = vi.spyOn(claimExtractionModule, "extractClaim").mockResolvedValue({
      subjectEntity: "alex",
      subjectAttribute: "city",
      subjectKey: "alex:city",
      predicate: "lives_in",
      object: "seattle",
      confidence: 0.84,
    });

    const { result } = await runWithCapturedOutput({ db: dbPath, limit: 2 });
    expect(result.processed).toBe(2);
    expect(extractClaimSpy).toHaveBeenCalledTimes(2);
  });

  it("dry-run does not modify entries", async () => {
    const { dbPath, client } = await createTempDb();
    await insertEntry(client, { id: "dry-run-target" });
    client.close();

    const createClientSpy = vi.spyOn(llmClientModule, "createLlmClient");
    const extractClaimSpy = vi.spyOn(claimExtractionModule, "extractClaim");
    const { result, stdout } = await runWithCapturedOutput({ db: dbPath, dryRun: true });

    expect(result.processed).toBe(0);
    expect(result.claimsExtracted).toBe(0);
    expect(createClientSpy).not.toHaveBeenCalled();
    expect(extractClaimSpy).not.toHaveBeenCalled();
    expect(stdout).toContain("dry-run enabled");

    const verifyClient = createClient({ url: `file:${dbPath}` });
    await initDb(verifyClient);
    const row = await getEntryRow(verifyClient, "dry-run-target");
    verifyClient.close();
    expect(row.subject_key).toBeNull();
  });

  it("rebuilds subject index after completion", async () => {
    const { dbPath, client } = await createTempDb();
    await insertEntry(client, { id: "index-target" });
    client.close();

    vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue(makeFakeClient());
    vi.spyOn(claimExtractionModule, "extractClaim").mockResolvedValue({
      subjectEntity: "alex",
      subjectAttribute: "role",
      subjectKey: "alex:role",
      predicate: "is",
      object: "engineer",
      confidence: 0.9,
    });
    const rebuildSpy = vi.spyOn(SubjectIndex.prototype, "rebuild");

    await runWithCapturedOutput({ db: dbPath });
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
  });

  it("reports correct counts for processed, extracted, no-claim, and errors", async () => {
    const { dbPath, client } = await createTempDb();
    await insertEntry(client, { id: "claim-ok", subject: "claim-ok" });
    await insertEntry(client, { id: "claim-none", subject: "claim-none" });
    await insertEntry(client, { id: "claim-error", subject: "claim-error" });
    client.close();

    vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue(makeFakeClient());
    vi.spyOn(claimExtractionModule, "extractClaim").mockImplementation(async (_content, _type, subject) => {
      if (subject === "claim-ok") {
        return {
          subjectEntity: "alex",
          subjectAttribute: "role",
          subjectKey: "alex:role",
          predicate: "is",
          object: "engineer",
          confidence: 0.92,
        };
      }
      if (subject === "claim-none") {
        return null;
      }
      throw new Error("mock extraction failure");
    });

    const { result } = await runWithCapturedOutput({ db: dbPath });
    expect(result.processed).toBe(3);
    expect(result.claimsExtracted).toBe(1);
    expect(result.noClaim).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.skipped).toBe(0);
  });
});
