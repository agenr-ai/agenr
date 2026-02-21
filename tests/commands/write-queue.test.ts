import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeEntry, LlmClient } from "../../src/types.js";
import {
  CancelledError,
  ShutdownError,
  WriteQueue,
  type StoreEntriesFn,
} from "../../src/ingest/write-queue.js";

function makeEntry(content: string): KnowledgeEntry {
  return {
    type: "fact",
    subject: "WriteQueue Test",
    content,
    importance: 7,
    expiry: "temporary",
    tags: ["test"],
    source: {
      file: "source.txt",
      context: "test",
    },
  };
}

function makeStoreResult(overrides?: Partial<Awaited<ReturnType<StoreEntriesFn>>>) {
  return {
    added: 1,
    updated: 0,
    skipped: 0,
    superseded: 0,
    llm_dedup_calls: 0,
    relations_created: 0,
    total_entries: 1,
    duration_ms: 1,
    ...overrides,
  };
}

function makeLlmClient(): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId: "gpt-4o",
      model: {} as never,
    },
    credentials: {
      apiKey: "sk-test",
      source: "test",
    },
  };
}

function createQueue(storeEntriesFn: StoreEntriesFn, options?: { batchSize?: number; highWatermark?: number; isShutdownRequested?: () => boolean }) {
  return new WriteQueue({
    db: {} as Client,
    storeEntriesFn,
    apiKey: "sk-test",
    llmClient: makeLlmClient(),
    dbPath: ":memory:",
    batchSize: options?.batchSize,
    highWatermark: options?.highWatermark,
    isShutdownRequested: options?.isShutdownRequested,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await sleep(10);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WriteQueue", () => {
  it("pushes entries and drains with expected storeEntries args", async () => {
    const storeEntriesFn = vi.fn(async (_db, entries) => makeStoreResult({ added: entries.length })) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn, { batchSize: 40 });

    const entries = [makeEntry("a"), makeEntry("b")];
    const result = await queue.push(entries, "file-a", "hash-a");
    await queue.drain();
    queue.destroy();

    expect(result.added).toBe(2);
    expect(storeEntriesFn).toHaveBeenCalledTimes(1);
    const [dbArg, entriesArg, apiKeyArg, optionsArg] = (storeEntriesFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      KnowledgeEntry[],
      string,
      Record<string, unknown>,
    ];
    expect(dbArg).toBeDefined();
    expect(entriesArg).toEqual(entries);
    expect(apiKeyArg).toBe("sk-test");
    expect(optionsArg).toMatchObject({
      sourceFile: "file-a",
      ingestContentHash: "hash-a",
      onlineDedup: true,
      skipLlmDedup: false,
      skipIngestLog: true,
      dbPath: ":memory:",
    });
  });

  it("drain on an empty queue resolves immediately", async () => {
    const storeEntriesFn = vi.fn(async () => makeStoreResult()) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn);

    await expect(queue.drain()).resolves.toBeUndefined();
    queue.destroy();
  });

  it("push after destroy rejects with a descriptive error", async () => {
    const storeEntriesFn = vi.fn(async () => makeStoreResult()) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn);
    queue.destroy();

    await expect(queue.push([makeEntry("x")], "file-a", "hash-a")).rejects.toThrow(/destroyed/i);
  });

  it("destroy before drain rejects pending push promises", async () => {
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const storeEntriesFn = vi.fn(async (_db, entries) => {
      if (entries[0]?.content === "first") {
        await firstGate;
      }
      return makeStoreResult({ added: entries.length });
    }) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn);

    const firstPromise = queue.push([makeEntry("first")], "file-a", "hash-a");
    await waitFor(() => (storeEntriesFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    const secondPromise = queue.push([makeEntry("second")], "file-b", "hash-b");

    queue.destroy();
    await expect(secondPromise).rejects.toBeInstanceOf(ShutdownError);
    releaseFirst?.();
    await firstPromise;
    await queue.drain();
  });

  it("handles concurrent push from 10 workers with no dropped entries", async () => {
    const storeEntriesFn = vi.fn(async (_db, entries) => makeStoreResult({ added: entries.length })) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn);

    const pushes = await Promise.all(
      Array.from({ length: 10 }, (_, index) => queue.push([makeEntry(`e-${index}-1`), makeEntry(`e-${index}-2`)], `file-${index}`, `hash-${index}`)),
    );

    await queue.drain();
    queue.destroy();

    const totalAdded = pushes.reduce((sum, result) => sum + result.added, 0);
    expect(totalAdded).toBe(20);
    expect(storeEntriesFn).toHaveBeenCalledTimes(10);
  });

  it("applies backpressure when pending entries exceed highWatermark", async () => {
    const storeEntriesFn = vi.fn(async (_db, entries) => makeStoreResult({ added: entries.length })) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn, { highWatermark: 2 });

    const first = queue.push([makeEntry("a"), makeEntry("b")], "file-a", "hash-a");
    const startedAt = Date.now();
    const second = queue.push([makeEntry("c")], "file-b", "hash-b");
    const secondResult = await second;
    const elapsed = Date.now() - startedAt;
    await first;
    await queue.drain();
    queue.destroy();

    expect(secondResult.added).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("applies backpressure based on pending plus incoming batch size", async () => {
    const storeEntriesFn = vi.fn(async (_db, entries) => makeStoreResult({ added: entries.length })) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn, { highWatermark: 2 });

    const first = queue.push([makeEntry("a")], "file-a", "hash-a");
    const startedAt = Date.now();
    const second = queue.push([makeEntry("b"), makeEntry("c")], "file-b", "hash-b");
    const secondResult = await second;
    const elapsed = Date.now() - startedAt;
    await first;
    await queue.drain();
    queue.destroy();

    expect(secondResult.added).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("retries once after a write error and then succeeds", async () => {
    vi.useFakeTimers();
    const storeEntriesFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockResolvedValueOnce(makeStoreResult({ added: 1 })) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn);

    const pushPromise = queue.push([makeEntry("x")], "file-a", "hash-a");
    await vi.runAllTimersAsync();
    const result = await pushPromise;
    await queue.drain();
    queue.destroy();

    expect(result.added).toBe(1);
    expect(storeEntriesFn).toHaveBeenCalledTimes(2);
  });

  it("rejects when both retry attempts fail", async () => {
    vi.useFakeTimers();
    const storeEntriesFn = vi.fn().mockRejectedValue(new Error("always fails")) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn);

    const pushExpectation = expect(queue.push([makeEntry("x")], "file-a", "hash-a")).rejects.toThrow("always fails");
    await vi.runAllTimersAsync();
    await pushExpectation;
    await queue.drain();
    queue.destroy();
    expect(storeEntriesFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry when retryOnFailure is false", async () => {
    const storeEntriesFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail once"))
      .mockResolvedValueOnce(makeStoreResult({ added: 1 })) as unknown as StoreEntriesFn;

    const queue = new WriteQueue({
      db: {} as Client,
      storeEntriesFn,
      apiKey: "sk-test",
      llmClient: makeLlmClient(),
      dbPath: ":memory:",
      retryOnFailure: false,
    });

    await expect(queue.push([makeEntry("x")], "file-a", "hash-a")).rejects.toThrow("fail once");
    await queue.drain();
    queue.destroy();

    expect(storeEntriesFn).toHaveBeenCalledTimes(1);
  });

  it("drain resolves only after all pushed items are written", async () => {
    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const storeEntriesFn = vi.fn(async (_db, entries) => {
      if (entries[0]?.content === "wait") {
        await gate;
      }
      return makeStoreResult({ added: entries.length });
    }) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn);

    const first = queue.push([makeEntry("wait")], "file-a", "hash-a");
    const second = queue.push([makeEntry("done")], "file-b", "hash-b");
    const drainPromise = queue.drain();

    let drained = false;
    void drainPromise.then(() => {
      drained = true;
    });
    await sleep(50);
    expect(drained).toBe(false);

    releaseGate?.();
    await Promise.all([first, second, drainPromise]);
    queue.destroy();
    expect(drained).toBe(true);
  });

  it("returns per-push stats for different file keys", async () => {
    const storeEntriesFn = vi.fn(async (_db, entries) => makeStoreResult({ added: entries.length })) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn);

    const fileA = queue.push([makeEntry("a")], "file-a", "hash-a");
    const fileB = queue.push([makeEntry("b"), makeEntry("c")], "file-b", "hash-b");
    const [resultA, resultB] = await Promise.all([fileA, fileB]);
    await queue.drain();
    queue.destroy();

    expect(resultA).toMatchObject({ added: 1 });
    expect(resultB).toMatchObject({ added: 2 });
  });

  it("cancel removes pending items for a file and rejects them with CancelledError", async () => {
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const storeEntriesFn = vi.fn(async (_db, entries) => {
      if (entries[0]?.content === "first") {
        await firstGate;
      }
      return makeStoreResult({ added: entries.length });
    }) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn);

    const first = queue.push([makeEntry("first")], "file-a", "hash-a");
    await waitFor(() => (storeEntriesFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    const pendingCancelled = queue.push([makeEntry("cancel-me")], "file-a", "hash-a");

    const cancelPromise = queue.cancel("file-a");
    releaseFirst?.();
    await Promise.all([first, cancelPromise]);
    await expect(pendingCancelled).rejects.toBeInstanceOf(CancelledError);

    await queue.drain();
    queue.destroy();
  });

  it("cancel() is a no-op when no items are pending for that fileKey", async () => {
    const storeEntriesFn = vi.fn(async (_db, entries) => makeStoreResult({ added: entries.length })) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn);

    await queue.push([makeEntry("a")], "file-a", "hash-a");
    await queue.drain();

    await expect(queue.cancel("file-a")).resolves.toBeUndefined();
    queue.destroy();
  });

  it("runExclusive executes inside writer serialization order", async () => {
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    const storeEntriesFn = vi.fn(async (_db, entries) => {
      if (entries[0]?.content === "first") {
        order.push("write-1-start");
        await firstGate;
        order.push("write-1-end");
      } else {
        order.push("write-2");
      }
      return makeStoreResult({ added: entries.length });
    }) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn);

    const first = queue.push([makeEntry("first")], "file-a", "hash-a");
    await waitFor(() => order.includes("write-1-start"));
    const exclusive = queue.runExclusive(async () => {
      order.push("exclusive");
      return 42;
    });
    const second = queue.push([makeEntry("second")], "file-b", "hash-b");

    releaseFirst?.();
    const [exclusiveResult] = await Promise.all([exclusive, first, second]);
    await queue.drain();
    queue.destroy();

    expect(exclusiveResult).toBe(42);
    expect(order).toEqual(["write-1-start", "write-1-end", "exclusive", "write-2"]);
  });

  it("honors isShutdownRequested by rejecting pending items with ShutdownError", async () => {
    let shutdown = false;
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const storeEntriesFn = vi.fn(async (_db, entries) => {
      if (entries[0]?.content === "first") {
        await firstGate;
      }
      return makeStoreResult({ added: entries.length });
    }) as unknown as StoreEntriesFn;

    const queue = createQueue(storeEntriesFn, { isShutdownRequested: () => shutdown });
    const first = queue.push([makeEntry("first")], "file-a", "hash-a");
    await waitFor(() => (storeEntriesFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    const pending = queue.push([makeEntry("pending")], "file-b", "hash-b");

    shutdown = true;
    releaseFirst?.();
    await first;
    await expect(pending).rejects.toBeInstanceOf(ShutdownError);
    await queue.drain();
    queue.destroy();
  });

  it("tracks pendingCount for queued (not yet written) entries", async () => {
    const storeEntriesFn = vi.fn(async (_db, entries) => makeStoreResult({ added: entries.length })) as unknown as StoreEntriesFn;
    const queue = createQueue(storeEntriesFn);

    const first = queue.push([makeEntry("a"), makeEntry("b")], "file-a", "hash-a");
    expect(queue.pendingCount).toBe(2);
    const second = queue.push([makeEntry("c")], "file-b", "hash-b");
    expect(queue.pendingCount).toBe(3);

    await Promise.all([first, second]);
    await queue.drain();
    expect(queue.pendingCount).toBe(0);
    queue.destroy();
  });
});
