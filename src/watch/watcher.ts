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
import { normalizeKnowledgePlatform } from "../platform.js";
import { detectProjectFromCwd } from "../project.js";
import { installSignalHandlers, isShutdownRequested, onWake } from "../shutdown.js";
import type { KnowledgeEntry, KnowledgePlatform, WatchState } from "../types.js";
import type { SessionResolver } from "./session-resolver.js";
import type { WatchPlatform } from "./resolvers/index.js";
import { openClawSessionResolver } from "./resolvers/openclaw.js";
import { createEmptyWatchState, getFileState, loadWatchState, saveWatchState, updateFileState } from "./state.js";
import type { WatcherHealth } from "./health.js";
import { writeHealthFile } from "./health.js";

const DEFAULT_WAL_CHECKPOINT_INTERVAL_MS = 30_000;

interface WatchTarget {
  dir: string;
  platform: WatchPlatform;
  recursive?: boolean;
}

export interface WatchCycleResult {
  bytesRead: number;
  entriesExtracted: number;
  entriesStored: number;
  skipped: boolean;
  notFound?: boolean;
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
  platform?: WatchPlatform;
  fsWatchDebounceMs?: number;
  intervalMs: number;
  minChunkChars: number;
  dryRun: boolean;
  verbose: boolean;
  raw: boolean;
  once: boolean;
  onlineDedup?: boolean;
  noPreFetch?: boolean;
  model?: string;
  provider?: string;
  dbPath?: string;
  onCycle?: (result: WatchCycleResult, ctx: WatchCycleContext) => void;
  onWarn?: (message: string) => void;
  onSwitch?: (from: string | null, to: string, platform?: WatchPlatform | null) => void;
  configDir?: string;
  initialState?: WatchState;
  walCheckpointIntervalMs?: number;
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
  writeHealthFileFn: (health: WatcherHealth, configDir?: string) => Promise<void>;
  statFileFn: typeof fs.stat;
  readFileFn: (filePath: string, offset: number) => Promise<Buffer>;
  readFileHeadFn: (filePath: string, maxBytes: number) => Promise<Buffer>;
  detectProjectFn: (cwd: string) => string | null;
  mkdtempFn: typeof fs.mkdtemp;
  writeFileFn: typeof fs.writeFile;
  rmFn: typeof fs.rm;
  watchFn: typeof watchFs;
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

function watchTargetKey(target: WatchTarget): string {
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

async function readFileHead(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size <= 0 || maxBytes <= 0) {
      return Buffer.alloc(0);
    }

    const toRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(toRead);
    const readResult = await handle.read(buffer, 0, toRead, 0);
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
    writeHealthFileFn: deps?.writeHealthFileFn ?? writeHealthFile,
    statFileFn: deps?.statFileFn ?? fs.stat,
    readFileFn: deps?.readFileFn ?? readFileFromOffset,
    readFileHeadFn: deps?.readFileHeadFn ?? readFileHead,
    detectProjectFn: deps?.detectProjectFn ?? ((cwd) => detectProjectFromCwd(cwd)),
    mkdtempFn: deps?.mkdtempFn ?? fs.mkdtemp,
    writeFileFn: deps?.writeFileFn ?? fs.writeFile,
    rmFn: deps?.rmFn ?? fs.rm,
    watchFn: deps?.watchFn ?? watchFs,
    nowFn: deps?.nowFn ?? (() => new Date()),
    sleepFn: deps?.sleepFn ?? sleep,
    shouldShutdownFn: deps?.shouldShutdownFn ?? isShutdownRequested,
  };

  const directoryMode = options.directoryMode === true;
  const realtimeEnabled = directoryMode;
  const watchDebounceMs = options.fsWatchDebounceMs ?? 2500;

  const findRenamed: ((originalPath: string) => Promise<string | null>) | null =
    options.resolver?.findRenamedFile?.bind(options.resolver) ??
    (directoryMode ? openClawSessionResolver.findRenamedFile.bind(openClawSessionResolver) : null);

  if (!directoryMode) {
    if (!options.filePath || options.filePath.trim().length === 0) {
      throw new Error("Watcher filePath is required unless directoryMode is enabled.");
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

  if (!directoryMode && fixedFilePath) {
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

  if (!options.noPreFetch) {
    try {
      embeddingApiKey = resolvedDeps.resolveEmbeddingApiKeyFn(config, process.env);
    } catch (error) {
      embeddingApiKey = null;
      options.onWarn?.(
        `Pre-fetch disabled - embedding API key not available: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
  onWake(requestWake);

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
  const projectCache = new Map<string, string | null>();

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

  const registerWatcher = (target: WatchTarget, recursive: boolean): void => {
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

  const refreshWatchers = (targets: WatchTarget[]): void => {
    if (!realtimeEnabled || fsWatchDisabled) {
      return;
    }

    const desired = new Map<string, WatchTarget>();
    for (const target of targets) {
      const normalized: WatchTarget = {
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
        let cachedProject: string | null = null;
        const cacheKey = path.resolve(targetFilePath);
        if (projectCache.has(cacheKey)) {
          cachedProject = projectCache.get(cacheKey) ?? null;
        } else {
          // Metadata (cwd) is typically in the original transcript header, which may not be in the delta.
          // Parse a small head slice of the ORIGINAL file through the normal adapter path.
          const headBytes = await resolvedDeps.readFileHeadFn(targetFilePath, 128 * 1024);
          if (headBytes.byteLength > 0) {
            const ext = path.extname(targetFilePath) || ".jsonl";
            const headFile = path.join(tempDir, `head${ext}`);
            await resolvedDeps.writeFileFn(headFile, headBytes.toString("utf8"), "utf8");
            const headParsed = await resolvedDeps.parseTranscriptFileFn(headFile, { raw: options.raw, verbose: false });

            // Priority 1: cwd-based detection.
            const cwd = headParsed.metadata?.cwd;
            if (typeof cwd === "string" && cwd.trim().length > 0) {
              cachedProject = resolvedDeps.detectProjectFn(cwd);
            }

            // Priority 2: session label -> project mapping.
            if (cachedProject === null) {
              const label = headParsed.metadata?.sessionLabel;
              const labelMap = config?.labelProjectMap ?? {};
              if (label && labelMap[label]) {
                cachedProject = labelMap[label];
              }
            }
          }
          projectCache.set(cacheKey, cachedProject);
        }

        await resolvedDeps.writeFileFn(tempFile, newContent, "utf8");
        const parsed = await resolvedDeps.parseTranscriptFileFn(tempFile, { raw: options.raw, verbose: options.verbose });
        if (options.verbose && parsed.warnings.length > 0) {
          for (const warning of parsed.warnings) {
            options.onWarn?.(warning);
          }
        }

        const processChunkEntries = async (chunkEntries: KnowledgeEntry[]): Promise<void> => {
          const platformTag: KnowledgePlatform | undefined =
            currentPlatform && currentPlatform !== "mtime"
              ? normalizeKnowledgePlatform(currentPlatform) ?? undefined
              : undefined;
          const taggedEntries =
            platformTag || cachedProject
              ? chunkEntries.map((entry) => ({
                  ...entry,
                  ...(platformTag ? { platform: platformTag } : {}),
                  ...(cachedProject ? { project: cachedProject } : {}),
                }))
              : chunkEntries;

          cycleResult.entriesExtracted += taggedEntries.length;
          const deduped = resolvedDeps.deduplicateEntriesFn(taggedEntries);

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
              dbPath,
            }),
          );
          cycleResult.entriesStored += storeResult.added + storeResult.updated + storeResult.superseded;
        };

        await resolvedDeps.extractKnowledgeFromChunksFn({
          file: targetFilePath,
          chunks: parsed.chunks,
          watchMode: true,
          client,
          verbose: options.verbose,
          platform:
            currentPlatform && currentPlatform !== "mtime"
              ? normalizeKnowledgePlatform(currentPlatform) ?? undefined
              : undefined,
          db: options.noPreFetch ? undefined : db ?? undefined,
          embeddingApiKey: options.noPreFetch ? undefined : embeddingApiKey ?? undefined,
          noPreFetch: options.noPreFetch === true,
          onChunkComplete: async (chunkResult) => {
            await processChunkEntries(chunkResult.entries);
          },
        });

        const latestState = getFileState(state, targetFilePath);
        updateFileState(state, targetFilePath, {
          byteOffset: byteOffset + newBytes.byteLength,
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
	      if (isFileNotFound(error)) {
	        cycleResult.notFound = true;
	        cycleResult.error = `file not found during watch cycle: ${targetFilePath}`;
	      } else {
	        cycleResult.error = formatError(error);
	      }
	      return cycleResult;
	    }
	  };

	  const drainedPaths = new Set<string>();

	  async function drainRenamedFile(originalPath: string): Promise<WatchCycleResult | null> {
	    if (!findRenamed) {
	      return null;
	    }

	    const renamedPath = await findRenamed(originalPath);
	    if (!renamedPath) {
	      return null;
	    }

	    const oldState = getFileState(state, originalPath);
	    if (oldState && oldState.byteOffset > 0) {
	      updateFileState(state, renamedPath, {
	        byteOffset: oldState.byteOffset,
	        lastRunAt: oldState.lastRunAt,
	        totalEntriesStored: oldState.totalEntriesStored ?? 0,
	        totalRunCount: oldState.totalRunCount ?? 0,
	      });
	    }

	    const result = await processFileCycle(renamedPath, true);

	    delete state.files[path.resolve(originalPath)];
	    delete state.files[path.resolve(renamedPath)];
	    await resolvedDeps.saveWatchStateFn(state, options.configDir);

	    return result;
	  }

  let cycles = 0;
  let totalEntriesStored = 0;
  let sessionsWatched = 0;
  let lastCheckpointAt = new Date(0);

  const writeHeartbeat = (): void => {
    resolvedDeps
      .writeHealthFileFn(
        {
          pid: process.pid,
          startedAt: startedAt.toISOString(),
          lastHeartbeat: resolvedDeps.nowFn().toISOString(),
          sessionsWatched,
          entriesStored: totalEntriesStored,
        },
        options.configDir,
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        options.onWarn?.(`Health file write failed: ${message}`);
      });
  };

  const handleSwitch = (from: string | null, to: string, platform?: WatchPlatform | null): void => {
    sessionsWatched += 1;
    options.onSwitch?.(from, to, platform);
  };

  writeHeartbeat();

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

	        const orphanResult = await drainRenamedFile(trackedPath);
	        if (!orphanResult) {
	          continue;
	        }
	        options.onCycle?.(orphanResult, { db, apiKey: embeddingApiKey ?? "" });

	        totalEntriesStored += orphanResult.entriesStored;
	        drainedPaths.add(path.resolve(trackedPath));

	        if (orphanResult.entriesStored > 0 && db) {
	          try {
	            await resolvedDeps.walCheckpointFn(db);
          } catch (error) {
	            options.onWarn?.(`WAL checkpoint failed: ${formatError(error)}`);
	          }
	        }
	      }
	    }
	  }

  try {
    while (!resolvedDeps.shouldShutdownFn()) {
      let resolvedTargetPath: string | null = currentFilePath;
      let resolvedPlatform: WatchPlatform | null = currentPlatform;

      try {
        if (directoryMode) {
          if (!options.sessionsDir || !options.resolver) {
            throw new Error("directoryMode requires sessionsDir and resolver.");
          }

          resolvedTargetPath = await options.resolver.resolveActiveSession(options.sessionsDir);
          resolvedTargetPath = resolvedTargetPath ? path.resolve(resolvedTargetPath) : null;
          refreshWatchers([
            {
              dir: path.resolve(options.sessionsDir),
              platform: options.platform ?? "mtime",
              recursive: options.platform === "codex" || options.platform === "claude-code",
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
	        if (cycleResult.notFound && !drainedPaths.has(path.resolve(currentFilePath))) {
	          const retryResult = await drainRenamedFile(currentFilePath);
	          if (retryResult) {
	            cycleResult = {
	              ...retryResult,
	              switchedFrom: currentFilePath,
	              switchedTo: resolvedTargetPath,
	            };
	          }
	        }

        // IMPORTANT: Keep the existing switchedFrom/switchedTo for the non-error path.
        cycleResult.switchedFrom = cycleResult.switchedFrom ?? currentFilePath;
        cycleResult.switchedTo = cycleResult.switchedTo ?? resolvedTargetPath;

        const previous = currentFilePath;
        currentFilePath = resolvedTargetPath;
        currentPlatform = resolvedPlatform;
        handleSwitch(previous, resolvedTargetPath, resolvedPlatform);

        requestWake();
      } else {
        if (!currentFilePath && resolvedTargetPath) {
          currentFilePath = resolvedTargetPath;
          currentPlatform = resolvedPlatform;
          handleSwitch(null, resolvedTargetPath, resolvedPlatform);
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
	          if (cycleResult.notFound && !drainedPaths.has(path.resolve(currentFilePath))) {
	            const retryResult = await drainRenamedFile(currentFilePath);
	            if (retryResult) {
	              cycleResult = retryResult;
	            }
	          }

	          cycleResult.filePath = currentFilePath;
	        }
      }

      cycles += 1;
      totalEntriesStored += cycleResult.entriesStored;
      options.onCycle?.(cycleResult, { db, apiKey: embeddingApiKey ?? "" });
      writeHeartbeat();

      const nowAt = resolvedDeps.nowFn();
      const intervalMs = options.walCheckpointIntervalMs ?? DEFAULT_WAL_CHECKPOINT_INTERVAL_MS;
      const shouldCheckpoint =
        intervalMs <= 0 || (nowAt.getTime() - lastCheckpointAt.getTime()) >= intervalMs;

      if (cycleResult.entriesStored > 0 && db && shouldCheckpoint) {
        lastCheckpointAt = nowAt;
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
    onWake(null);
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
