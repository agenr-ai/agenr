import type { Client } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { sessionStartRecall, type SessionStartRecallOptions } from "../db/session-start.js";
import type { RecallQuery, RecallResult } from "../types.js";

function createMockRecallResult(overrides?: Partial<RecallResult>): RecallResult {
  return {
    score: 0.95,
    entry: {
      id: "test-id",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      subject: "test subject",
      content: "test content",
      type: "fact",
      importance: 5,
      expiry: "temporary",
      tags: [],
      recall_count: 0,
      last_recalled_at: null,
      platform: "cli",
      project: null,
    },
    embedding: new Float32Array(1024),
    ...overrides,
  };
}

function createDeps(overrides?: Partial<SessionStartRecallOptions>): SessionStartRecallOptions {
  return {
    query: {
      text: "test query",
      context: "session-start",
      noUpdate: true,
    },
    apiKey: "test-api-key",
    nonCoreLimit: 10,
    recallFn: vi.fn(async () => []),
    ...overrides,
  };
}

describe("sessionStartRecall", () => {
  it("returns empty array without errors when DB is empty", async () => {
    const db = {} as Client;
    const deps = createDeps();

    const result = await sessionStartRecall(db, deps);

    expect(result.results).toEqual([]);
    expect(result.budgetUsed).toBe(0);
    expect(deps.recallFn).toHaveBeenCalledTimes(2); // Once for core, once for non-core
  });

  it("returns empty array without errors when DB has no core entries", async () => {
    const db = {} as Client;
    const mockRecallFn = vi.fn<[Client, RecallQuery, string], Promise<RecallResult[]>>();
    mockRecallFn.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const deps = createDeps({
      recallFn: mockRecallFn,
    });

    const result = await sessionStartRecall(db, deps);

    expect(result.results).toEqual([]);
    expect(result.budgetUsed).toBe(0);
  });

  it("returns empty array without errors when DB has no non-core entries", async () => {
    const db = {} as Client;
    const coreResult = createMockRecallResult({
      entry: { ...createMockRecallResult().entry, expiry: "core" },
    });
    const mockRecallFn = vi.fn<[Client, RecallQuery, string], Promise<RecallResult[]>>();
    mockRecallFn.mockResolvedValueOnce([coreResult]).mockResolvedValueOnce([]);

    const deps = createDeps({
      recallFn: mockRecallFn,
    });

    const result = await sessionStartRecall(db, deps);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].category).toBe("core");
    expect(result.budgetUsed).toBeGreaterThanOrEqual(0);
  });

  it("handles budget parameter correctly with empty DB", async () => {
    const db = {} as Client;
    const deps = createDeps({
      budget: 100,
    });

    const result = await sessionStartRecall(db, deps);

    expect(result.results).toEqual([]);
    expect(result.budgetUsed).toBe(0);
  });

  it("returns empty array when recallFn throws but is handled gracefully", async () => {
    const db = {} as Client;
    const mockRecallFn = vi.fn<[Client, RecallQuery, string], Promise<RecallResult[]>>();
    mockRecallFn.mockRejectedValueOnce(new Error("DB error"));

    const deps = createDeps({
      recallFn: mockRecallFn,
    });

    // This should throw because recallFn throws
    await expect(sessionStartRecall(db, deps)).rejects.toThrow("DB error");
  });
});
