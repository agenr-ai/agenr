import type { Client } from "@libsql/client";
import type { KnowledgeEntry, LlmClient } from "../types.js";

export interface BatchWriteResult {
  added: number;
  updated: number;
  skipped: number;
  superseded: number;
  llm_dedup_calls: number;
}

export type StoreEntriesFn = typeof import("../db/store.js").storeEntries;

export interface WriteQueueOptions {
  db: Client;
  storeEntriesFn: StoreEntriesFn;
  apiKey: string;
  llmClient: LlmClient;
  dbPath: string | undefined;
  batchSize?: number;
  highWatermark?: number;
  retryOnFailure?: boolean;
  isShutdownRequested?: () => boolean;
}

export class CancelledError extends Error {
  constructor(message = "Write queue item was cancelled.") {
    super(message);
    this.name = "CancelledError";
  }
}

export class ShutdownError extends Error {
  constructor(message = "Write queue is shutting down.") {
    super(message);
    this.name = "ShutdownError";
  }
}

interface WriteQueueItem {
  kind: "write";
  entries: KnowledgeEntry[];
  fileKey: string;
  fileHash: string;
  resolve: (result: BatchWriteResult) => void;
  reject: (err: Error) => void;
}

interface ExclusiveQueueItem<T = unknown> {
  kind: "exclusive";
  fn: () => Promise<T>;
  resolve: (result: T) => void;
  reject: (err: Error) => void;
}

type QueueItem = WriteQueueItem | ExclusiveQueueItem;

const ZERO_RESULT: BatchWriteResult = {
  added: 0,
  updated: 0,
  skipped: 0,
  superseded: 0,
  llm_dedup_calls: 0,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeBatchResult(a: BatchWriteResult, b: BatchWriteResult): BatchWriteResult {
  return {
    added: a.added + b.added,
    updated: a.updated + b.updated,
    skipped: a.skipped + b.skipped,
    superseded: a.superseded + b.superseded,
    llm_dedup_calls: a.llm_dedup_calls + b.llm_dedup_calls,
  };
}

function chunkEntries(entries: KnowledgeEntry[], size: number): KnowledgeEntry[][] {
  if (entries.length <= size) {
    return [entries];
  }

  const chunks: KnowledgeEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) {
    chunks.push(entries.slice(i, i + size));
  }
  return chunks;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export class WriteQueue {
  private readonly db: Client;
  private readonly storeEntriesFn: StoreEntriesFn;
  private readonly apiKey: string;
  private readonly llmClient: LlmClient;
  private readonly dbPath: string | undefined;
  private readonly batchSize: number;
  private readonly highWatermark: number;
  private readonly retryOnFailure: boolean;
  private readonly isShutdownRequested: (() => boolean) | undefined;

  private readonly queue: QueueItem[] = [];
  private pendingEntries = 0;
  private destroyed = false;
  private writerStopping = false;
  private inflightWrites = 0;
  private activeWorkItems = 0;
  private readonly activeByFileKey = new Map<string, number>();
  private readonly fileWaiters = new Map<string, Array<() => void>>();
  private readonly drainWaiters: Array<() => void> = [];
  private readonly writerWaiters: Array<() => void> = [];

  constructor(options: WriteQueueOptions) {
    this.db = options.db;
    this.storeEntriesFn = options.storeEntriesFn;
    this.apiKey = options.apiKey;
    this.llmClient = options.llmClient;
    this.dbPath = options.dbPath;
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 40));
    this.highWatermark = Math.max(1, Math.floor(options.highWatermark ?? 500));
    this.retryOnFailure = options.retryOnFailure !== false;
    this.isShutdownRequested = options.isShutdownRequested;

    void this.runWriterLoop();
  }

  get pendingCount(): number {
    return this.pendingEntries + this.activeWorkItems;
  }

  async push(entries: KnowledgeEntry[], fileKey: string, fileHash: string): Promise<BatchWriteResult> {
    if (this.destroyed) {
      throw new ShutdownError("WriteQueue has been destroyed and cannot accept new items.");
    }

    while (this.pendingEntries > 0 && this.pendingEntries + entries.length > this.highWatermark) {
      if (this.destroyed) {
        throw new ShutdownError("WriteQueue has been destroyed and cannot accept new items.");
      }
      await sleep(50);
    }

    if (entries.length === 0) {
      return { ...ZERO_RESULT };
    }

    return await new Promise<BatchWriteResult>((resolve, reject) => {
      if (this.destroyed) {
        reject(new ShutdownError("WriteQueue has been destroyed and cannot accept new items."));
        return;
      }

      this.pendingEntries += entries.length;
      this.queue.push({
        kind: "write",
        entries,
        fileKey,
        fileHash,
        resolve,
        reject,
      });
      this.wakeWriter();
    });
  }

  async cancel(fileKey: string): Promise<void> {
    const kept: QueueItem[] = [];
    const cancelled: WriteQueueItem[] = [];

    for (const item of this.queue) {
      if (item.kind === "write" && item.fileKey === fileKey) {
        cancelled.push(item);
        this.pendingEntries = Math.max(0, this.pendingEntries - item.entries.length);
      } else {
        kept.push(item);
      }
    }

    if (cancelled.length > 0) {
      this.queue.splice(0, this.queue.length, ...kept);
      for (const item of cancelled) {
        item.reject(new CancelledError(`Cancelled queued write for ${fileKey}.`));
      }
      this.resolveDrainIfIdle();
    }

    await this.waitForFileIdle(fileKey);
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.destroyed) {
      throw new ShutdownError("WriteQueue has been destroyed and cannot accept new items.");
    }

    return await new Promise<T>((resolve, reject) => {
      if (this.destroyed) {
        reject(new ShutdownError("WriteQueue has been destroyed and cannot accept new items."));
        return;
      }

      this.queue.push({
        kind: "exclusive",
        fn,
        resolve: resolve as (result: unknown) => void,
        reject,
      });
      this.wakeWriter();
    });
  }

  async drain(): Promise<void> {
    if (this.isIdle()) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.writerStopping = true;

    const pending = this.queue.splice(0, this.queue.length);
    this.pendingEntries = 0;
    for (const item of pending) {
      item.reject(new ShutdownError("WriteQueue destroyed before item was processed."));
    }

    this.wakeWriter();
    this.resolveDrainIfIdle();
  }

  private async runWriterLoop(): Promise<void> {
    while (true) {
      if (this.isShutdownRequested?.() && this.hasPendingWriteItems()) {
        this.shutdownFromSignal();
      }

      if ((this.writerStopping || this.destroyed) && this.queue.length === 0) {
        break;
      }

      if (this.queue.length === 0) {
        await this.waitForWork();
        continue;
      }

      const batch = this.queue.splice(0, this.queue.length);
      this.markBatchAsDispatched(batch);
      await this.processBatch(batch);
    }

    this.resolveDrainIfIdle();
  }

  private hasPendingWriteItems(): boolean {
    return this.queue.some((item) => item.kind === "write");
  }

  private async processBatch(batch: QueueItem[]): Promise<void> {
    let index = 0;

    while (index < batch.length) {
      const item = batch[index];
      if (!item) {
        index += 1;
        continue;
      }

      if (item.kind === "exclusive") {
        await this.processExclusive(item);
        index += 1;
        continue;
      }

      const segment: WriteQueueItem[] = [];
      while (index < batch.length) {
        const segmentItem = batch[index];
        if (!segmentItem || segmentItem.kind !== "write") {
          break;
        }
        segment.push(segmentItem);
        index += 1;
      }

      await this.processWriteSegment(segment);
    }
  }

  private async processExclusive(item: ExclusiveQueueItem): Promise<void> {
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (error) {
      item.reject(toError(error));
    } finally {
      this.activeWorkItems = Math.max(0, this.activeWorkItems - 1);
      this.resolveDrainIfIdle();
    }
  }

  private async processWriteSegment(segment: WriteQueueItem[]): Promise<void> {
    const grouped = new Map<string, WriteQueueItem[]>();
    for (const item of segment) {
      const group = grouped.get(item.fileKey);
      if (group) {
        group.push(item);
      } else {
        grouped.set(item.fileKey, [item]);
      }
    }

    for (const items of grouped.values()) {
      for (const item of items) {
        await this.processWriteItem(item);
      }
    }
  }

  private async processWriteItem(item: WriteQueueItem): Promise<void> {
    let result = { ...ZERO_RESULT };
    const subBatches = chunkEntries(item.entries, this.batchSize);

    try {
      for (const subBatch of subBatches) {
        const writeResult = await this.writeSubBatchWithRetry(subBatch, item.fileKey, item.fileHash);
        result = mergeBatchResult(result, writeResult);
      }
      item.resolve(result);
    } catch (error) {
      item.reject(toError(error));
    } finally {
      this.activeWorkItems = Math.max(0, this.activeWorkItems - 1);
      this.decrementActiveFile(item.fileKey);
      this.resolveDrainIfIdle();
    }
  }

  private async writeSubBatchWithRetry(
    entries: KnowledgeEntry[],
    fileKey: string,
    fileHash: string,
  ): Promise<BatchWriteResult> {
    let lastError: Error | null = null;
    const maxAttempts = this.retryOnFailure ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.inflightWrites += 1;
      try {
        const result = await this.storeEntriesFn(this.db, entries, this.apiKey, {
          sourceFile: fileKey,
          ingestContentHash: fileHash,
          skipIngestLog: true,
          onlineDedup: true,
          skipLlmDedup: false,
          llmClient: this.llmClient,
          dbPath: this.dbPath,
        });
        return {
          added: result.added,
          updated: result.updated,
          skipped: result.skipped,
          superseded: result.superseded,
          llm_dedup_calls: result.llm_dedup_calls,
        };
      } catch (error) {
        lastError = toError(error);
        if (attempt < maxAttempts) {
          await sleep(2_000);
        }
      } finally {
        this.inflightWrites = Math.max(0, this.inflightWrites - 1);
        this.resolveDrainIfIdle();
      }
    }

    throw lastError ?? new Error("Write queue failed to store sub-batch.");
  }

  private markBatchAsDispatched(batch: QueueItem[]): void {
    for (const item of batch) {
      this.activeWorkItems += 1;
      if (item.kind === "write") {
        this.pendingEntries = Math.max(0, this.pendingEntries - item.entries.length);
        this.activeByFileKey.set(item.fileKey, (this.activeByFileKey.get(item.fileKey) ?? 0) + 1);
      }
    }
    this.resolveDrainIfIdle();
  }

  private decrementActiveFile(fileKey: string): void {
    const current = this.activeByFileKey.get(fileKey) ?? 0;
    if (current <= 1) {
      this.activeByFileKey.delete(fileKey);
      const waiters = this.fileWaiters.get(fileKey) ?? [];
      this.fileWaiters.delete(fileKey);
      for (const waiter of waiters) {
        waiter();
      }
      return;
    }

    this.activeByFileKey.set(fileKey, current - 1);
  }

  private async waitForFileIdle(fileKey: string): Promise<void> {
    if ((this.activeByFileKey.get(fileKey) ?? 0) === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      const existing = this.fileWaiters.get(fileKey);
      if (existing) {
        existing.push(resolve);
      } else {
        this.fileWaiters.set(fileKey, [resolve]);
      }
    });
  }

  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      this.writerWaiters.push(resolve);
    });
  }

  private wakeWriter(): void {
    while (this.writerWaiters.length > 0) {
      const waiter = this.writerWaiters.shift();
      waiter?.();
    }
  }

  private shutdownFromSignal(): void {
    this.destroyed = true;
    this.writerStopping = true;

    const pending = this.queue.splice(0, this.queue.length);
    this.pendingEntries = 0;
    for (const item of pending) {
      item.reject(new ShutdownError("Shutdown requested. Dropping queued writes."));
    }
    this.wakeWriter();
    this.resolveDrainIfIdle();
  }

  private isIdle(): boolean {
    return this.pendingEntries === 0 && this.activeWorkItems === 0 && this.inflightWrites === 0;
  }

  private resolveDrainIfIdle(): void {
    if (!this.isIdle()) {
      return;
    }

    while (this.drainWaiters.length > 0) {
      const waiter = this.drainWaiters.shift();
      waiter?.();
    }
  }
}
