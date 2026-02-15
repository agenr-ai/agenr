import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readConfig } from "../config.js";
import { deduplicateEntries } from "../dedup.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { storeEntries } from "../db/store.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { extractKnowledgeFromChunks } from "../extractor.js";
import { createLlmClient } from "../llm/client.js";
import { parseTranscriptFile } from "../parser.js";
import type { WatchState } from "../types.js";
import { createEmptyWatchState, getFileState, loadWatchState, saveWatchState, updateFileState } from "./state.js";

export interface WatchCycleResult {
  bytesRead: number;
  entriesExtracted: number;
  entriesStored: number;
  skipped: boolean;
  error?: string;
}

export interface WatcherOptions {
  filePath: string;
  intervalMs: number;
  minChunkChars: number;
  dryRun: boolean;
  verbose: boolean;
  once: boolean;
  model?: string;
  provider?: string;
  dbPath?: string;
  onCycle?: (result: WatchCycleResult) => void;
  onWarn?: (message: string) => void;
  configDir?: string;
  initialState?: WatchState;
}

export interface WatchRunSummary {
  cycles: number;
  entriesStored: number;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
}

export interface WatcherDeps {
  readConfigFn: typeof readConfig;
  resolveEmbeddingApiKeyFn: typeof resolveEmbeddingApiKey;
  parseTranscriptFileFn: typeof parseTranscriptFile;
  createLlmClientFn: typeof createLlmClient;
  extractKnowledgeFromChunksFn: typeof extractKnowledgeFromChunks;
  deduplicateEntriesFn: typeof deduplicateEntries;
  getDbFn: typeof getDb;
  initDbFn: typeof initDb;
  closeDbFn: typeof closeDb;
  storeEntriesFn: typeof storeEntries;
  loadWatchStateFn: typeof loadWatchState;
  saveWatchStateFn: typeof saveWatchState;
  statFileFn: typeof fs.stat;
  readFileFn: (filePath: string, offset: number) => Promise<Buffer>;
  mkdtempFn: typeof fs.mkdtemp;
  writeFileFn: typeof fs.writeFile;
  rmFn: typeof fs.rm;
  nowFn: () => Date;
  sleepFn: (ms: number) => Promise<void>;
  shouldShutdownFn: () => boolean;
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readFileFromOffset(filePath: string, offset: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (offset >= stat.size) {
      return Buffer.alloc(0);
    }

    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    const readResult = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, readResult.bytesRead);
  } finally {
    await handle.close();
  }
}

export async function runWatcher(options: WatcherOptions, deps?: Partial<WatcherDeps>): Promise<WatchRunSummary> {
  const resolvedDeps: WatcherDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    resolveEmbeddingApiKeyFn: deps?.resolveEmbeddingApiKeyFn ?? resolveEmbeddingApiKey,
    parseTranscriptFileFn: deps?.parseTranscriptFileFn ?? parseTranscriptFile,
    createLlmClientFn: deps?.createLlmClientFn ?? createLlmClient,
    extractKnowledgeFromChunksFn: deps?.extractKnowledgeFromChunksFn ?? extractKnowledgeFromChunks,
    deduplicateEntriesFn: deps?.deduplicateEntriesFn ?? deduplicateEntries,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    closeDbFn: deps?.closeDbFn ?? closeDb,
    storeEntriesFn: deps?.storeEntriesFn ?? storeEntries,
    loadWatchStateFn: deps?.loadWatchStateFn ?? loadWatchState,
    saveWatchStateFn: deps?.saveWatchStateFn ?? saveWatchState,
    statFileFn: deps?.statFileFn ?? fs.stat,
    readFileFn: deps?.readFileFn ?? readFileFromOffset,
    mkdtempFn: deps?.mkdtempFn ?? fs.mkdtemp,
    writeFileFn: deps?.writeFileFn ?? fs.writeFile,
    rmFn: deps?.rmFn ?? fs.rm,
    nowFn: deps?.nowFn ?? (() => new Date()),
    sleepFn: deps?.sleepFn ?? sleep,
    shouldShutdownFn: deps?.shouldShutdownFn ?? (() => false),
  };

  const filePath = path.resolve(options.filePath);
  const startedAt = resolvedDeps.nowFn();

  let state = options.initialState;
  if (!state) {
    try {
      state = await resolvedDeps.loadWatchStateFn(options.configDir);
    } catch (error) {
      options.onWarn?.(
        `State file is invalid (${formatError(error)}). Resetting to fresh state.`,
      );
      state = createEmptyWatchState();
      await resolvedDeps.saveWatchStateFn(state, options.configDir);
    }
  }

  let initialStat: Awaited<ReturnType<typeof resolvedDeps.statFileFn>>;
  try {
    initialStat = await resolvedDeps.statFileFn(filePath);
  } catch (error) {
    if (isFileNotFound(error)) {
      throw new Error(`Transcript file not found: ${filePath}`);
    }
    throw error;
  }
  if (!initialStat.isFile()) {
    throw new Error(`Input is not a file: ${filePath}`);
  }

  const client = resolvedDeps.createLlmClientFn({
    provider: options.provider,
    model: options.model,
    env: process.env,
  });

  const config = resolvedDeps.readConfigFn(process.env);
  const dbPath = options.dbPath?.trim() || config?.db?.path;
  const db = options.dryRun ? null : resolvedDeps.getDbFn(dbPath);
  let embeddingApiKey: string | null = null;

  if (db) {
    await resolvedDeps.initDbFn(db);
  }

  let cycles = 0;
  let totalEntriesStored = 0;

  try {
    while (!resolvedDeps.shouldShutdownFn()) {
      const fileState = getFileState(state, filePath);
      let byteOffset = fileState?.byteOffset ?? 0;

      const cycleResult: WatchCycleResult = {
        bytesRead: 0,
        entriesExtracted: 0,
        entriesStored: 0,
        skipped: false,
      };

      try {
        const stat = await resolvedDeps.statFileFn(filePath);
        if (!stat.isFile()) {
          cycleResult.skipped = true;
          cycleResult.error = `watched path is no longer a file: ${filePath}`;
        } else {
          if (stat.size < byteOffset) {
            byteOffset = 0;
            updateFileState(state, filePath, { byteOffset: 0 });
            await resolvedDeps.saveWatchStateFn(state, options.configDir);
          }

          if (stat.size <= byteOffset) {
            cycleResult.skipped = true;
          } else {
            const newBytes = await resolvedDeps.readFileFn(filePath, byteOffset);
            cycleResult.bytesRead = newBytes.byteLength;
            const newContent = newBytes.toString("utf8");

            if (newContent.length < options.minChunkChars) {
              cycleResult.skipped = true;
            } else {
              const tempDir = await resolvedDeps.mkdtempFn(path.join(os.tmpdir(), "agenr-watch-"));
              const tempFile = path.join(tempDir, "delta.txt");
              try {
                await resolvedDeps.writeFileFn(tempFile, newContent, "utf8");
                const parsed = await resolvedDeps.parseTranscriptFileFn(tempFile);
                const extracted = await resolvedDeps.extractKnowledgeFromChunksFn({
                  file: filePath,
                  chunks: parsed.chunks,
                  client,
                  verbose: options.verbose,
                });
                const deduped = resolvedDeps.deduplicateEntriesFn(extracted.entries);
                cycleResult.entriesExtracted = extracted.entries.length;

                if (!options.dryRun && deduped.length > 0) {
                  if (!db) {
                    throw new Error("Database client is not initialized.");
                  }
                  if (!embeddingApiKey) {
                    embeddingApiKey = resolvedDeps.resolveEmbeddingApiKeyFn(config, process.env);
                  }

                  const storeResult = await resolvedDeps.storeEntriesFn(db, deduped, embeddingApiKey, {
                    sourceFile: filePath,
                  });
                  cycleResult.entriesStored = storeResult.added + storeResult.updated;
                }

                const latestState = getFileState(state, filePath);
                updateFileState(state, filePath, {
                  byteOffset: stat.size,
                  lastRunAt: resolvedDeps.nowFn().toISOString(),
                  totalEntriesStored: (latestState?.totalEntriesStored ?? 0) + cycleResult.entriesStored,
                  totalRunCount: (latestState?.totalRunCount ?? 0) + 1,
                });
                await resolvedDeps.saveWatchStateFn(state, options.configDir);
              } finally {
                await resolvedDeps.rmFn(tempDir, { recursive: true, force: true });
              }
            }
          }
        }
      } catch (error) {
        cycleResult.error = isFileNotFound(error)
          ? `file not found during watch cycle: ${filePath}`
          : formatError(error);
      }

      cycles += 1;
      totalEntriesStored += cycleResult.entriesStored;
      options.onCycle?.(cycleResult);

      if (options.once || resolvedDeps.shouldShutdownFn()) {
        break;
      }

      await resolvedDeps.sleepFn(options.intervalMs);
    }
  } finally {
    if (db) {
      resolvedDeps.closeDbFn(db);
    }
  }

  const endedAt = resolvedDeps.nowFn();
  return {
    cycles,
    entriesStored: totalEntriesStored,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
  };
}
