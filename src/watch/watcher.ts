import { watch as watchFs, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { readConfig } from "../config.js";
import { deduplicateEntries } from "../dedup.js";
import { closeDb, getDb, initDb, walCheckpoint } from "../db/client.js";
import { storeEntries } from "../db/store.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { extractKnowledgeFromChunks } from "../extractor.js";
import { createLlmClient } from "../llm/client.js";
import { parseTranscriptFile } from "../parser.js";
import { installSignalHandlers, isShutdownRequested } from "../shutdown.js";
import type { KnowledgeEntry, WatchState } from "../types.js";
import type { SessionResolver } from "./session-resolver.js";
import { resolveAutoSession, type AutoSessionResult, type AutoWatchTarget } from "./resolvers/auto.js";
import type { WatchPlatform } from "./resolvers/index.js";
import { openClawSessionResolver } from "./resolvers/openclaw.js";
import { createEmptyWatchState, getFileState, loadWatchState, saveWatchState, updateFileState } from "./state.js";

export interface WatchCycleResult {
  bytesRead: number;
  entriesExtracted: number;
  entriesStored: number;
  skipped: boolean;
  filePath?: string;
  switchedFrom?: string;
  switchedTo?: string;
  error?: string;
}

export interface WatchCycleContext {
  db: Client | null;
  apiKey: string;
}

export interface WatcherOptions {
  filePath?: string;
  directoryMode?: boolean;
  sessionsDir?: string;
  resolver?: SessionResolver;
  autoMode?: boolean;
  platform?: WatchPlatform;
  fsWatchDebounceMs?: number;
  intervalMs: number;
  minChunkChars: number;
  dryRun: boolean;
  verbose: boolean;
  raw: boolean;
  once: boolean;
  onlineDedup?: boolean;
  model?: string;
  provider?: string;
  dbPath?: string;
  onCycle?: (result: WatchCycleResult, ctx: WatchCycleContext) => void;
  onWarn?: (message: string) => void;
  onSwitch?: (from: string | null, to: string, platform?: WatchPlatform | null) => void;
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
  walCheckpointFn: typeof walCheckpoint;
  storeEntriesFn: typeof storeEntries;
  loadWatchStateFn: typeof loadWatchState;
  saveWatchStateFn: typeof saveWatchState;
  statFileFn: typeof fs.stat;
  readFileFn: (filePath: string, offset: number) => Promise<Buffer>;
  mkdtempFn: typeof fs.mkdtemp;
  writeFileFn: typeof fs.writeFile;
  rmFn: typeof fs.rm;
  watchFn: typeof watchFs;
  resolveAutoSessionFn: () => Promise<AutoSessionResult>;
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

function isRecursiveWatchUnsupported(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM";
}

function isTooManyFileHandles(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EMFILE";
}

function normalizeWatchDir(input: string): string {
  return path.resolve(input);
}

function watchTargetKey(target: AutoWatchTarget): string {
  return `${target.platform}:${normalizeWatchDir(target.dir)}`;
}

function shouldWakeForEvent(
  platform: WatchPlatform | null | undefined,
  filename?: string | Buffer | null,
): boolean {
  if (!filename) {
    return true;
  }

  const name = filename.toString();
  if (name.length === 0) {
    return true;
  }

  if (platform === "openclaw") {
    return name === "sessions.json" || name.toLowerCase().endsWith(".jsonl");
  }

  return name.toLowerCase().endsWith(".jsonl");
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
  installSignalHandlers();

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
    walCheckpointFn: deps?.walCheckpointFn ?? walCheckpoint,
    storeEntriesFn: deps?.storeEntriesFn ?? storeEntries,
    loadWatchStateFn: deps?.loadWatchStateFn ?? loadWatchState,
    saveWatchStateFn: deps?.saveWatchStateFn ?? saveWatchState,
    statFileFn: deps?.statFileFn ?? fs.stat,
    readFileFn: deps?.readFileFn ?? readFileFromOffset,
    mkdtempFn: deps?.mkdtempFn ?? fs.mkdtemp,
    writeFileFn: deps?.writeFileFn ?? fs.writeFile,
    rmFn: deps?.rmFn ?? fs.rm,
    watchFn: deps?.watchFn ?? watchFs,
    resolveAutoSessionFn: deps?.resolveAutoSessionFn ?? resolveAutoSession,
    nowFn: deps?.nowFn ?? (() => new Date()),
    sleepFn: deps?.sleepFn ?? sleep,
    shouldShutdownFn: deps?.shouldShutdownFn ?? isShutdownRequested,
  };

  const directoryMode = options.directoryMode === true;
  const autoMode = options.autoMode === true;
  const realtimeEnabled = directoryMode || autoMode;
  const watchDebounceMs = options.fsWatchDebounceMs ?? 2500;

  const findRenamed: ((originalPath: string) => Promise<string | null>) | null =
    options.resolver?.findRenamedFile?.bind(options.resolver) ??
    (directoryMode || autoMode ? openClawSessionResolver.findRenamedFile.bind(openClawSessionResolver) : null);

  if (!directoryMode && !autoMode) {
    if (!options.filePath || options.filePath.trim().length === 0) {
      throw new Error("Watcher filePath is required unless directoryMode or autoMode is enabled.");
    }
  }

  const fixedFilePath = options.filePath ? path.resolve(options.filePath) : null;
  let currentFilePath = fixedFilePath;
  let currentPlatform: WatchPlatform | null = options.platform ?? null;

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

  if (!directoryMode && !autoMode && fixedFilePath) {
    let initialStat: Awaited<ReturnType<typeof resolvedDeps.statFileFn>>;
    try {
      initialStat = await resolvedDeps.statFileFn(fixedFilePath);
    } catch (error) {
      if (isFileNotFound(error)) {
        throw new Error(`Transcript file not found: ${fixedFilePath}`);
      }
      throw error;
    }
    if (!initialStat.isFile()) {
      throw new Error(`Input is not a file: ${fixedFilePath}`);
    }
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

  let dbChain: Promise<void> = Promise.resolve();
  const withDbLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = dbChain;
    let release!: () => void;
    dbChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  let wakeRequested = false;
  let wakePromise: Promise<void> | null = null;
  let wakeResolve: (() => void) | null = null;
  const requestWake = (): void => {
    wakeRequested = true;
    if (wakeResolve) {
      wakeResolve();
      wakeResolve = null;
      wakePromise = null;
    }
  };

  const waitForNextCycle = async (): Promise<void> => {
    if (options.intervalMs <= 0) {
      return;
    }

    if (wakeRequested) {
      wakeRequested = false;
      return;
    }

    if (!wakePromise) {
      wakePromise = new Promise<void>((resolve) => {
        wakeResolve = resolve;
      });
    }

    await Promise.race([resolvedDeps.sleepFn(options.intervalMs), wakePromise]);
    wakeRequested = false;
  };

  const watchers = new Map<string, FSWatcher>();
  let fsWatchDisabled = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  const clearDebounce = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const scheduleWake = (): void => {
    if (watchDebounceMs <= 0) {
      requestWake();
      return;
    }

    clearDebounce();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      requestWake();
    }, watchDebounceMs);
  };

  const closeAllWatchers = (): void => {
    clearDebounce();
    for (const watcher of watchers.values()) {
      watcher.close();
    }
    watchers.clear();
  };

  const registerWatcher = (target: AutoWatchTarget, recursive: boolean): void => {
    const resolvedDir = normalizeWatchDir(target.dir);
    const key = watchTargetKey({ ...target, dir: resolvedDir });
    if (watchers.has(key) || fsWatchDisabled) {
      return;
    }

    try {
      const watcher = resolvedDeps.watchFn(
        resolvedDir,
        {
          persistent: false,
          recursive,
        },
        (_eventType, filename) => {
          if (!shouldWakeForEvent(target.platform, filename)) {
            return;
          }
          scheduleWake();
        },
      );
      watchers.set(key, watcher);
    } catch (error) {
      if (isRecursiveWatchUnsupported(error) && recursive) {
        registerWatcher(target, false);
        return;
      }

      if (isTooManyFileHandles(error)) {
        fsWatchDisabled = true;
        closeAllWatchers();
        options.onWarn?.("fs.watch hit file descriptor limits (EMFILE). Falling back to polling.");
        return;
      }

      options.onWarn?.(`Unable to watch ${resolvedDir}: ${formatError(error)}`);
    }
  };

  const refreshWatchers = (targets: AutoWatchTarget[]): void => {
    if (!realtimeEnabled || fsWatchDisabled) {
      return;
    }

    const desired = new Map<string, AutoWatchTarget>();
    for (const target of targets) {
      const normalized: AutoWatchTarget = {
        ...target,
        dir: normalizeWatchDir(target.dir),
      };
      desired.set(watchTargetKey(normalized), normalized);
    }

    for (const [key, watcher] of watchers.entries()) {
      if (desired.has(key)) {
        continue;
      }
      watcher.close();
      watchers.delete(key);
    }

    for (const target of desired.values()) {
      registerWatcher(target, target.recursive === true);
    }
  };

  const processFileCycle = async (targetFilePath: string, forceProcessSmallChunk: boolean): Promise<WatchCycleResult> => {
    const cycleResult: WatchCycleResult = {
      bytesRead: 0,
      entriesExtracted: 0,
      entriesStored: 0,
      skipped: false,
      filePath: targetFilePath,
    };

    try {
      const stat = await resolvedDeps.statFileFn(targetFilePath);
      if (!stat.isFile()) {
        cycleResult.skipped = true;
        cycleResult.error = `watched path is no longer a file: ${targetFilePath}`;
        return cycleResult;
      }

      const fileState = getFileState(state, targetFilePath);
      let byteOffset = fileState?.byteOffset ?? 0;

      if (stat.size < byteOffset) {
        byteOffset = 0;
        updateFileState(state, targetFilePath, { byteOffset: 0 });
        await resolvedDeps.saveWatchStateFn(state, options.configDir);
      }

      if (stat.size <= byteOffset) {
        cycleResult.skipped = true;
        return cycleResult;
      }

      const newBytes = await resolvedDeps.readFileFn(targetFilePath, byteOffset);
      cycleResult.bytesRead = newBytes.byteLength;
      const newContent = newBytes.toString("utf8");
      const threshold = forceProcessSmallChunk ? 1 : options.minChunkChars;

      if (newContent.length < threshold) {
        cycleResult.skipped = true;
        return cycleResult;
      }

      const tempDir = await resolvedDeps.mkdtempFn(path.join(os.tmpdir(), "agenr-watch-"));
      const tempFile = path.join(tempDir, "delta.txt");
      try {
        await resolvedDeps.writeFileFn(tempFile, newContent, "utf8");
        const parsed = await resolvedDeps.parseTranscriptFileFn(tempFile, { raw: options.raw, verbose: options.verbose });
        if (options.verbose && parsed.warnings.length > 0) {
          for (const warning of parsed.warnings) {
            options.onWarn?.(warning);
          }
        }

        const processChunkEntries = async (chunkEntries: KnowledgeEntry[]): Promise<void> => {
          cycleResult.entriesExtracted += chunkEntries.length;
          const deduped = resolvedDeps.deduplicateEntriesFn(chunkEntries);

          if (options.dryRun || deduped.length === 0) {
            return;
          }

          if (!db) {
            throw new Error("Database client is not initialized.");
          }
          if (!embeddingApiKey) {
            embeddingApiKey = resolvedDeps.resolveEmbeddingApiKeyFn(config, process.env);
          }

          const storeResult = await withDbLock(() =>
            resolvedDeps.storeEntriesFn(db, deduped, embeddingApiKey ?? "", {
              sourceFile: targetFilePath,
              onlineDedup: options.onlineDedup !== false,
              llmClient: options.onlineDedup === false ? undefined : client,
            }),
          );
          cycleResult.entriesStored += storeResult.added + storeResult.updated + storeResult.superseded;
        };

        await resolvedDeps.extractKnowledgeFromChunksFn({
          file: targetFilePath,
          chunks: parsed.chunks,
          client,
          verbose: options.verbose,
          onChunkComplete: async (chunkResult) => {
            await processChunkEntries(chunkResult.entries);
          },
        });

        const latestState = getFileState(state, targetFilePath);
        updateFileState(state, targetFilePath, {
          byteOffset: stat.size,
          lastRunAt: resolvedDeps.nowFn().toISOString(),
          totalEntriesStored: (latestState?.totalEntriesStored ?? 0) + cycleResult.entriesStored,
          totalRunCount: (latestState?.totalRunCount ?? 0) + 1,
        });
        await resolvedDeps.saveWatchStateFn(state, options.configDir);
      } finally {
        await resolvedDeps.rmFn(tempDir, { recursive: true, force: true });
      }

      return cycleResult;
    } catch (error) {
      cycleResult.error = isFileNotFound(error)
        ? `file not found during watch cycle: ${targetFilePath}`
        : formatError(error);
      return cycleResult;
    }
  };

  let cycles = 0;
  let totalEntriesStored = 0;
  let warnedNoAutoRoots = false;

  // Drain orphaned OpenClaw reset files that may have been renamed while the watcher was offline.
  if (findRenamed) {
    for (const trackedPath of Object.keys(state.files)) {
      if (path.basename(trackedPath).includes(".reset.")) {
        continue;
      }

      try {
        await resolvedDeps.statFileFn(trackedPath);
      } catch (error) {
        if (!isFileNotFound(error)) {
          continue;
        }

        const renamedPath = await findRenamed(trackedPath);
        if (!renamedPath) {
          continue;
        }

        const oldState = getFileState(state, trackedPath);
        if (oldState && oldState.byteOffset > 0) {
          updateFileState(state, renamedPath, {
            byteOffset: oldState.byteOffset,
            lastRunAt: oldState.lastRunAt,
            totalEntriesStored: oldState.totalEntriesStored ?? 0,
            totalRunCount: oldState.totalRunCount ?? 0,
          });
        }

        const orphanResult = await processFileCycle(renamedPath, true);
        options.onCycle?.(orphanResult, { db, apiKey: embeddingApiKey ?? "" });

        totalEntriesStored += orphanResult.entriesStored;

        if (orphanResult.entriesStored > 0 && db) {
          try {
            await resolvedDeps.walCheckpointFn(db);
          } catch (error) {
            options.onWarn?.(`WAL checkpoint failed: ${formatError(error)}`);
          }
        }

        delete state.files[path.resolve(trackedPath)];
        delete state.files[path.resolve(renamedPath)];
        await resolvedDeps.saveWatchStateFn(state, options.configDir);
      }
    }
  }

  try {
    while (!resolvedDeps.shouldShutdownFn()) {
      let resolvedTargetPath: string | null = currentFilePath;
      let resolvedPlatform: WatchPlatform | null = currentPlatform;

      try {
        if (autoMode) {
          const autoResult = await resolvedDeps.resolveAutoSessionFn();
          resolvedTargetPath = autoResult.activeFile ? path.resolve(autoResult.activeFile) : null;
          resolvedPlatform = autoResult.platform;
          refreshWatchers(autoResult.watchTargets);

          if (autoResult.discoveredRoots.length === 0 && !warnedNoAutoRoots) {
            warnedNoAutoRoots = true;
            options.onWarn?.(
              "No supported platform directories found for --auto mode. Expected one of: ~/.openclaw/agents/main/sessions, ~/.claude/projects, ~/.codex/sessions",
            );
          } else if (autoResult.discoveredRoots.length > 0) {
            warnedNoAutoRoots = false;
          }
        } else if (directoryMode) {
          if (!options.sessionsDir || !options.resolver) {
            throw new Error("directoryMode requires sessionsDir and resolver.");
          }

          resolvedTargetPath = await options.resolver.resolveActiveSession(options.sessionsDir);
          resolvedTargetPath = resolvedTargetPath ? path.resolve(resolvedTargetPath) : null;
          refreshWatchers([
            {
              dir: path.resolve(options.sessionsDir),
              platform: options.platform ?? "mtime",
              recursive: options.platform === "codex",
            },
          ]);
        }
      } catch (error) {
        options.onWarn?.(`Session resolution failed: ${formatError(error)}. Keeping current file.`);
        resolvedTargetPath = currentFilePath;
      }

      let cycleResult: WatchCycleResult;
      const hasSwitch = Boolean(
        resolvedTargetPath &&
          currentFilePath &&
          path.resolve(resolvedTargetPath) !== path.resolve(currentFilePath),
      );

      if (hasSwitch && currentFilePath && resolvedTargetPath) {
        cycleResult = await processFileCycle(currentFilePath, true);

        // If old file vanished (e.g. OpenClaw .reset rename), find and drain the renamed copy.
        if (cycleResult.error?.includes("file not found") && findRenamed) {
          const renamedPath = await findRenamed(currentFilePath);
          if (renamedPath) {
            // Seed renamed file's state with old file's byte offset (same content, just renamed).
            const oldState = getFileState(state, currentFilePath);
            if (oldState && oldState.byteOffset > 0) {
              updateFileState(state, renamedPath, {
                byteOffset: oldState.byteOffset,
                lastRunAt: oldState.lastRunAt,
                totalEntriesStored: oldState.totalEntriesStored ?? 0,
                totalRunCount: oldState.totalRunCount ?? 0,
              });
            }

            const retryResult = await processFileCycle(renamedPath, true);
            cycleResult = {
              ...retryResult,
              switchedFrom: currentFilePath,
              switchedTo: resolvedTargetPath,
            };

            // Clean up state: remove both old and renamed keys (one-shot drain, not ongoing).
            delete state.files[path.resolve(currentFilePath)];
            delete state.files[path.resolve(renamedPath)];
            await resolvedDeps.saveWatchStateFn(state, options.configDir);
          }
        }

        // IMPORTANT: Keep the existing switchedFrom/switchedTo for the non-error path.
        cycleResult.switchedFrom = cycleResult.switchedFrom ?? currentFilePath;
        cycleResult.switchedTo = cycleResult.switchedTo ?? resolvedTargetPath;

        const previous = currentFilePath;
        currentFilePath = resolvedTargetPath;
        currentPlatform = resolvedPlatform;
        options.onSwitch?.(previous, resolvedTargetPath, resolvedPlatform);

        requestWake();
      } else {
        if (!currentFilePath && resolvedTargetPath) {
          currentFilePath = resolvedTargetPath;
          currentPlatform = resolvedPlatform;
          options.onSwitch?.(null, resolvedTargetPath, resolvedPlatform);
        }

        if (!currentFilePath) {
          cycleResult = {
            bytesRead: 0,
            entriesExtracted: 0,
            entriesStored: 0,
            skipped: true,
            filePath: undefined,
          };
        } else {
          cycleResult = await processFileCycle(currentFilePath, false);

          // If current file vanished (renamed before sessions.json updated), try reset file.
          if (cycleResult.error?.includes("file not found") && findRenamed) {
            const renamedPath = await findRenamed(currentFilePath);
            if (renamedPath) {
              const oldState = getFileState(state, currentFilePath);
              if (oldState && oldState.byteOffset > 0) {
                updateFileState(state, renamedPath, {
                  byteOffset: oldState.byteOffset,
                  lastRunAt: oldState.lastRunAt,
                  totalEntriesStored: oldState.totalEntriesStored ?? 0,
                  totalRunCount: oldState.totalRunCount ?? 0,
                });
              }

              cycleResult = await processFileCycle(renamedPath, true);

              // Clean up state.
              delete state.files[path.resolve(currentFilePath)];
              delete state.files[path.resolve(renamedPath)];
              await resolvedDeps.saveWatchStateFn(state, options.configDir);
            }
          }

          cycleResult.filePath = currentFilePath;
        }
      }

      cycles += 1;
      totalEntriesStored += cycleResult.entriesStored;
      options.onCycle?.(cycleResult, { db, apiKey: embeddingApiKey ?? "" });

      if (cycleResult.entriesStored > 0 && db) {
        try {
          await resolvedDeps.walCheckpointFn(db);
        } catch (error) {
          options.onWarn?.(`WAL checkpoint failed: ${formatError(error)}`);
        }
      }

      if (options.once || resolvedDeps.shouldShutdownFn()) {
        break;
      }

      await waitForNextCycle();
    }
  } finally {
    closeAllWatchers();
    if (db) {
      try {
        await resolvedDeps.walCheckpointFn(db);
      } catch (error) {
        options.onWarn?.(`WAL checkpoint failed: ${formatError(error)}`);
      }
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
