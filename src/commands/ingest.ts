import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { deduplicateEntries } from "../dedup.js";
import { closeDb, getDb, initDb, walCheckpoint } from "../db/client.js";
import { hashText, storeEntries } from "../db/store.js";
import { acquireDbLock, releaseDbLock } from "../db/lockfile.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { extractKnowledgeFromChunks } from "../extractor.js";
import { createLlmClient } from "../llm/client.js";
import { expandInputFiles, parseTranscriptFile } from "../parser.js";
import { normalizeKnowledgePlatform } from "../platform.js";
import { parseProjectList } from "../project.js";
import { KNOWLEDGE_PLATFORMS } from "../types.js";
import type { KnowledgeEntry } from "../types.js";
import { banner, formatError, formatWarn, ui } from "../ui.js";
import { installSignalHandlers, isShutdownRequested, onShutdown } from "../shutdown.js";
import {
  createEmptyWatchState,
  getFileState,
  loadWatchState,
  saveWatchState,
  updateFileState,
} from "../watch/state.js";

const DEFAULT_GLOB = "**/*.{jsonl,md,txt}";

export interface IngestCommandOptions {
  glob?: string;
  db?: string;
  model?: string;
  provider?: string;
  verbose?: boolean;
  raw?: boolean;
  dryRun?: boolean;
  json?: boolean;
  platform?: string;
  project?: string | string[];
  concurrency?: number | string;
  skipIngested?: boolean;
  force?: boolean;
  retry?: boolean;
  maxRetries?: number | string;
}

export interface IngestFileResult {
  file: string;
  entriesExtracted: number;
  entriesStored: number;
  entriesSkippedDuplicate: number;
  entriesReinforced: number;
  skipped: boolean;
  skipReason?: string;
  error?: string;
  durationMs: number;
}

export interface IngestCommandResult {
  exitCode: number;
  filesProcessed: number;
  filesSkipped: number;
  filesFailed: number;
  totalEntriesExtracted: number;
  totalEntriesStored: number;
  dedupStats: {
    entries_added: number;
    entries_updated: number;
    entries_skipped: number;
    entries_reinforced: number;
    entries_superseded: number;
    dedup_llm_calls: number;
  };
  durationMs: number;
  results: IngestFileResult[];
}

export interface IngestCommandDeps {
  readConfigFn: typeof readConfig;
  resolveEmbeddingApiKeyFn: typeof resolveEmbeddingApiKey;
  expandInputFilesFn: typeof expandInputFiles;
  parseTranscriptFileFn: typeof parseTranscriptFile;
  createLlmClientFn: typeof createLlmClient;
  extractKnowledgeFromChunksFn: typeof extractKnowledgeFromChunks;
  deduplicateEntriesFn: typeof deduplicateEntries;
  getDbFn: typeof getDb;
  initDbFn: typeof initDb;
  closeDbFn: typeof closeDb;
  storeEntriesFn: typeof storeEntries;
  hashTextFn: typeof hashText;
  loadWatchStateFn: typeof loadWatchState;
  saveWatchStateFn: typeof saveWatchState;
  nowFn: () => Date;
  sleepFn: (ms: number) => Promise<void>;
  shouldShutdownFn: () => boolean;
}

function hasGlobChars(input: string): boolean {
  return /[*?[\]{}]/.test(input);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let regex = "^";

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];

    if (char === "*" && normalized[i + 1] === "*") {
      if (normalized[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 2;
        continue;
      }
      regex += ".*";
      i += 1;
      continue;
    }

    if (char === "*") {
      regex += "[^/]*";
      continue;
    }

    if (char === "?") {
      regex += "[^/]";
      continue;
    }

    if (char === "{") {
      const close = normalized.indexOf("}", i + 1);
      if (close > i + 1) {
        const body = normalized.slice(i + 1, close);
        const choices = body
          .split(",")
          .map((item) => escapeRegex(item.trim()))
          .filter((item) => item.length > 0);
        if (choices.length > 0) {
          regex += `(?:${choices.join("|")})`;
          i = close;
          continue;
        }
      }
    }

    regex += escapeRegex(char ?? "");
  }

  regex += "$";
  return new RegExp(regex);
}

function matchesGlob(filePath: string, matcher: RegExp): boolean {
  const absolute = path.resolve(filePath).replace(/\\/g, "/");
  const relative = path.relative(process.cwd(), absolute).replace(/\\/g, "/");
  const basename = path.basename(absolute);
  return matcher.test(absolute) || matcher.test(relative) || matcher.test(basename);
}

async function resolveInputFiles(
  inputPaths: string[],
  globPattern: string,
  expandInputFilesFn: typeof expandInputFiles,
): Promise<string[]> {
  const matcher = globToRegExp(globPattern);
  const resolved = new Set<string>();

  for (const input of inputPaths) {
    if (hasGlobChars(input)) {
      const expanded = await expandInputFilesFn([input]);
      for (const filePath of expanded) {
        const absolute = path.resolve(filePath);
        const stat = await fs.stat(absolute).catch(() => null);
        if (stat?.isFile() && matchesGlob(absolute, matcher)) {
          resolved.add(absolute);
        }
      }
      continue;
    }

    const absoluteInput = path.resolve(input);
    const stat = await fs.stat(absoluteInput).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    });

    if (!stat) {
      if (path.extname(input).length === 0 || input.endsWith("/") || input.endsWith(path.sep)) {
        throw new Error(`Directory not found: ${absoluteInput}`);
      }
      resolved.add(absoluteInput);
      continue;
    }

    if (stat.isDirectory()) {
      const dirGlob = path.join(absoluteInput, globPattern);
      const expanded = await expandInputFilesFn([dirGlob]);
      for (const filePath of expanded) {
        const absolute = path.resolve(filePath);
        const fileStat = await fs.stat(absolute).catch(() => null);
        if (fileStat?.isFile()) {
          resolved.add(absolute);
        }
      }
      continue;
    }

    if (stat.isFile() && matchesGlob(absoluteInput, matcher)) {
      resolved.add(absoluteInput);
    }
  }

  return [...resolved];
}

function parsePositiveInt(value: number | string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === null || String(value).trim().length === 0) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return Math.floor(parsed);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function retryBackoffMs(attempt: number): number {
  // attempt is 1-based (retry round, not including initial pass)
  if (attempt <= 1) return 10_000;
  if (attempt === 2) return 30_000;
  return 60_000;
}

function formatBytes(bytes: number): string {
  if (bytes < 0 || !Number.isFinite(bytes)) {
    return "unknown size";
  }
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")}MB`;
}

function isJsonlFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".jsonl";
}

async function isAlreadyIngested(db: Client, filePath: string, contentHash: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT id FROM ingest_log WHERE file_path = ? AND content_hash = ? LIMIT 1",
    args: [filePath, contentHash],
  });
  return result.rows.length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ForceCleanupStats {
  ingestLogRows: number;
  entryRows: number;
  entrySourceRows: number;
}

interface FileStoreStats {
  added: number;
  updated: number;
  skipped: number;
  superseded: number;
  llmDedupCalls: number;
}

function countValue(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : 0;

  return Number.isFinite(parsed) ? parsed : 0;
}

async function getForceCleanupStats(db: Client, filePath: string): Promise<ForceCleanupStats> {
  const ingestLogRowsResult = await db.execute({
    sql: "SELECT COUNT(*) AS count FROM ingest_log WHERE file_path = ?",
    args: [filePath],
  });
  const entryRowsResult = await db.execute({
    sql: "SELECT COUNT(*) AS count FROM entries WHERE source_file = ?",
    args: [filePath],
  });
  const entrySourceRowsResult = await db.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM entry_sources
      WHERE merged_entry_id IN (SELECT id FROM entries WHERE source_file = ?)
         OR source_entry_id IN (SELECT id FROM entries WHERE source_file = ?)
    `,
    args: [filePath, filePath],
  });

  return {
    ingestLogRows: countValue(ingestLogRowsResult.rows[0]?.count),
    entryRows: countValue(entryRowsResult.rows[0]?.count),
    entrySourceRows: countValue(entrySourceRowsResult.rows[0]?.count),
  };
}

async function cleanupForForceReingest(db: Client, filePath: string, dryRun: boolean): Promise<ForceCleanupStats> {
  const stats = await getForceCleanupStats(db, filePath);
  if (dryRun) {
    return stats;
  }

  await db.execute({
    sql: `
      DELETE FROM entry_sources
      WHERE merged_entry_id IN (SELECT id FROM entries WHERE source_file = ?)
         OR source_entry_id IN (SELECT id FROM entries WHERE source_file = ?)
    `,
    args: [filePath, filePath],
  });
  await db.execute({
    sql: "DELETE FROM ingest_log WHERE file_path = ?",
    args: [filePath],
  });
  await db.execute({
    sql: "DELETE FROM entries WHERE source_file = ?",
    args: [filePath],
  });

  return stats;
}

async function getSourceEntryIds(db: Client, filePath: string): Promise<Set<string>> {
  const result = await db.execute({
    sql: "SELECT id FROM entries WHERE source_file = ?",
    args: [filePath],
  });
  return new Set(
    result.rows
      .map((row) => {
        const id = row.id;
        if (typeof id === "string") {
          return id;
        }
        if (typeof id === "number" || typeof id === "bigint") {
          return String(id);
        }
        return "";
      })
      .filter((id) => id.length > 0),
  );
}

async function cleanupFailedFileIngest(
  db: Client,
  filePath: string,
  contentHash: string,
  baselineEntryIds: Set<string>,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    return;
  }

  const currentIds = await getSourceEntryIds(db, filePath);
  const newIds = [...currentIds].filter((id) => !baselineEntryIds.has(id));
  if (newIds.length > 0) {
    const placeholders = newIds.map(() => "?").join(", ");
    await db.execute({
      sql: `
        DELETE FROM entry_sources
        WHERE merged_entry_id IN (${placeholders})
           OR source_entry_id IN (${placeholders})
      `,
      args: [...newIds, ...newIds],
    });
    await db.execute({
      sql: `DELETE FROM entries WHERE id IN (${placeholders})`,
      args: newIds,
    });
  }

  await db.execute({
    sql: "DELETE FROM ingest_log WHERE file_path = ? AND content_hash = ?",
    args: [filePath, contentHash],
  });
}

async function insertIngestLogForFile(
  db: Client,
  params: {
    filePath: string;
    contentHash: string;
    storeStats: FileStoreStats;
    durationMs: number;
  },
): Promise<void> {
  await db.execute({
    sql: `
      INSERT OR REPLACE INTO ingest_log (
        id,
        file_path,
        content_hash,
        ingested_at,
        entries_added,
        entries_updated,
        entries_skipped,
        entries_superseded,
        dedup_llm_calls,
        duration_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      randomUUID(),
      params.filePath,
      params.contentHash,
      new Date().toISOString(),
      params.storeStats.added,
      params.storeStats.updated,
      params.storeStats.skipped,
      params.storeStats.superseded,
      params.storeStats.llmDedupCalls,
      params.durationMs,
    ],
  });
}

interface IngestTarget {
  file: string;
  size: number;
  index: number;
}

export async function runIngestCommand(
  inputPaths: string[],
  options: IngestCommandOptions,
  deps?: Partial<IngestCommandDeps>,
): Promise<IngestCommandResult> {
  installSignalHandlers();

  const resolvedDeps: IngestCommandDeps = {
    readConfigFn: deps?.readConfigFn ?? readConfig,
    resolveEmbeddingApiKeyFn: deps?.resolveEmbeddingApiKeyFn ?? resolveEmbeddingApiKey,
    expandInputFilesFn: deps?.expandInputFilesFn ?? expandInputFiles,
    parseTranscriptFileFn: deps?.parseTranscriptFileFn ?? parseTranscriptFile,
    createLlmClientFn: deps?.createLlmClientFn ?? createLlmClient,
    extractKnowledgeFromChunksFn: deps?.extractKnowledgeFromChunksFn ?? extractKnowledgeFromChunks,
    deduplicateEntriesFn: deps?.deduplicateEntriesFn ?? deduplicateEntries,
    getDbFn: deps?.getDbFn ?? getDb,
    initDbFn: deps?.initDbFn ?? initDb,
    closeDbFn: deps?.closeDbFn ?? closeDb,
    storeEntriesFn: deps?.storeEntriesFn ?? storeEntries,
    hashTextFn: deps?.hashTextFn ?? hashText,
    loadWatchStateFn: deps?.loadWatchStateFn ?? loadWatchState,
    saveWatchStateFn: deps?.saveWatchStateFn ?? saveWatchState,
    nowFn: deps?.nowFn ?? (() => new Date()),
    sleepFn: deps?.sleepFn ?? sleep,
    shouldShutdownFn: deps?.shouldShutdownFn ?? isShutdownRequested,
  };

  const clackOutput = { output: process.stderr };
  const startedAt = resolvedDeps.nowFn();
  const verbose = options.verbose === true;
  const dryRun = options.dryRun === true;
  const json = options.json === true;
  const force = options.force === true;
  const skipIngested = force ? false : options.skipIngested !== false;
  const globPattern = options.glob?.trim() || DEFAULT_GLOB;
  const llmConcurrency = parsePositiveInt(options.concurrency, 5, "--concurrency");
  const retryEnabled = options.retry !== false;
    const maxRetries = retryEnabled ? parsePositiveInt(options.maxRetries, 3, "--max-retries") : 0;
  const platformRaw = options.platform?.trim();
  const platform = platformRaw ? normalizeKnowledgePlatform(platformRaw) : null;
  if (platformRaw && !platform) {
    throw new Error(`--platform must be one of: ${KNOWLEDGE_PLATFORMS.join(", ")}`);
  }

  const projectItems = Array.isArray(options.project) ? options.project : options.project ? [options.project] : [];
  const rawProjectPartCount =
    projectItems.length === 1
      ? String(projectItems[0])
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0).length
      : 0;

  if (projectItems.length > 1 || rawProjectPartCount > 1) {
    throw new Error("--project may only be specified once for the ingest command.");
  }

  const parsedProject = parseProjectList(options.project);
  const project = parsedProject[0] ?? null;
  if (rawProjectPartCount > 0 && parsedProject.length === 0) {
    throw new Error("--project must be a non-empty string.");
  }
  const retrySummaries: string[] = [];
  let stoppedForShutdown = false;

    const files = await resolveInputFiles(inputPaths, globPattern, resolvedDeps.expandInputFilesFn);
    const targetsWithSizes = await Promise.all(
      files.map(async (filePath) => {
        const stat = await fs.stat(filePath).catch(() => null);
        return {
          file: filePath,
          size: stat?.isFile() ? stat.size : -1,
        };
      }),
    );

    const sortedTargets = targetsWithSizes
      .sort((a, b) => a.size - b.size || a.file.localeCompare(b.file))
      .map<IngestTarget>((item, index) => ({ ...item, index }));

    clack.intro(banner(), clackOutput);
    clack.log.info(
      `Ingesting: ${ui.bold(String(sortedTargets.length))} file(s) | Glob: ${globPattern} | Chunk concurrency: ${ui.bold(String(llmConcurrency))} | Skip ingested: ${skipIngested ? "yes" : "no"}`,
      clackOutput,
    );

    if (sortedTargets.length === 0) {
      clack.log.warn(formatWarn("No files matched input paths and glob filter."), clackOutput);
      clack.outro(undefined, clackOutput);
      const emptyResult: IngestCommandResult = {
        exitCode: 0,
        filesProcessed: 0,
        filesSkipped: 0,
        filesFailed: 0,
        totalEntriesExtracted: 0,
        totalEntriesStored: 0,
        dedupStats: {
          entries_added: 0,
          entries_updated: 0,
          entries_skipped: 0,
          entries_reinforced: 0,
          entries_superseded: 0,
          dedup_llm_calls: 0,
        },
        durationMs: Math.max(0, resolvedDeps.nowFn().getTime() - startedAt.getTime()),
        results: [],
      };
      if (json) {
        process.stdout.write(`${JSON.stringify(emptyResult, null, 2)}\n`);
      }
      return emptyResult;
    }

    const config = resolvedDeps.readConfigFn(process.env);
    const client = resolvedDeps.createLlmClientFn({
      provider: options.provider,
      model: options.model,
      env: process.env,
    });

    const dbPath = options.db?.trim() || config?.db?.path;
    const shouldLockDb = dbPath !== ":memory:";
    if (shouldLockDb) {
      acquireDbLock();
      onShutdown(async () => {
        releaseDbLock();
      });
    }
    const db = resolvedDeps.getDbFn(dbPath);
    await resolvedDeps.initDbFn(db);

    const results: IngestFileResult[] = new Array(sortedTargets.length);
    let totalEntriesExtracted = 0;
    let totalEntriesStored = 0;
    let totalEntriesAdded = 0;
    let totalEntriesUpdated = 0;
    let totalEntriesSkipped = 0;
    let totalEntriesReinforced = 0;
    let totalEntriesSuperseded = 0;
    let totalDedupLlmCalls = 0;
    let forceDeletedIngestLogRows = 0;
    let forceDeletedEntryRows = 0;
    let forceDeletedEntrySourceRows = 0;
    let completed = 0;
    let embeddingApiKey: string | null = null;
    let watchStateLoaded = false;
    let watchState = createEmptyWatchState();
    let cursor = 0;
    let totalChunksFailed = 0;
    let filesWithChunkFailures = 0;
    const chunkStatsByFile = new Map<string, { successfulChunks: number; failedChunks: number }>();
    let firstPassFailedIndexSet = new Set<number>();

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

    const updateProgress = (completedCount: number, totalCount: number, verb: string): void => {
      if (verbose) {
        return;
      }
      const suffix = llmConcurrency > 1 ? ` (${llmConcurrency} chunks active)...` : "...";
      process.stderr.write(`\r${ui.dim(`${verb} ${completedCount}/${totalCount}${suffix}`)}`);
    };

    const clearProgressLine = (): void => {
      if (verbose) {
        return;
      }
      process.stderr.write("\r");
      process.stderr.write(`${" ".repeat(80)}\r`);
    };

    const syncWatchStateOffset = async (filePath: string, ingestByteOffset: number): Promise<void> => {
      if (dryRun || !isJsonlFile(filePath)) {
        return;
      }

      try {
        if (!watchStateLoaded) {
          try {
            watchState = await resolvedDeps.loadWatchStateFn();
          } catch (error) {
            watchState = createEmptyWatchState();
            clack.log.warn(
              formatWarn(
                `Watch state is invalid (${errorMessage(error)}). Resetting to fresh state before ingest offset sync.`,
              ),
              clackOutput,
            );
            await resolvedDeps.saveWatchStateFn(watchState);
          }
          watchStateLoaded = true;
        }

        const existingOffset = getFileState(watchState, filePath)?.byteOffset ?? 0;
        if (!force && existingOffset > ingestByteOffset) {
          return;
        }

        updateFileState(watchState, filePath, { byteOffset: ingestByteOffset });
        await resolvedDeps.saveWatchStateFn(watchState);
      } catch (error) {
        clack.log.warn(
          formatWarn(
            `Failed to sync watch offset for ${path.basename(filePath)}: ${errorMessage(error)}`,
          ),
          clackOutput,
        );
      }
    };

    const processTarget = async (target: IngestTarget): Promise<IngestFileResult> => {
    const fileStartedAt = resolvedDeps.nowFn();
    const fileResult: IngestFileResult = {
      file: target.file,
      entriesExtracted: 0,
      entriesStored: 0,
      entriesSkippedDuplicate: 0,
      entriesReinforced: 0,
      skipped: false,
      durationMs: 0,
    };
    let fileHash = "";
    let baselineEntryIds = new Set<string>();
    const fileStoreStats: FileStoreStats = {
      added: 0,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llmDedupCalls: 0,
    };

    try {
      const rawContent = await fs.readFile(target.file, "utf8");
      const ingestByteOffset = Buffer.byteLength(rawContent, "utf8");
      fileHash = resolvedDeps.hashTextFn(rawContent);

      if (skipIngested && !force) {
        const alreadyIngested = await withDbLock(() => isAlreadyIngested(db, target.file, fileHash));
        if (alreadyIngested) {
          fileResult.skipped = true;
          fileResult.skipReason = "already ingested";
          return fileResult;
        }
      }

      if (force) {
        const cleanupStats = await withDbLock(() => cleanupForForceReingest(db, target.file, dryRun));
        forceDeletedIngestLogRows += cleanupStats.ingestLogRows;
        forceDeletedEntryRows += cleanupStats.entryRows;
        forceDeletedEntrySourceRows += cleanupStats.entrySourceRows;
      } else {
        baselineEntryIds = await withDbLock(() => getSourceEntryIds(db, target.file));
      }

      const parsed = await resolvedDeps.parseTranscriptFileFn(target.file, { raw: options.raw === true, verbose });
      if (verbose && parsed.warnings.length > 0) {
        for (const warning of parsed.warnings) {
          if (warning.startsWith("Filtered:")) {
            clack.log.info(warning, clackOutput);
          } else {
            clack.log.warn(formatWarn(warning), clackOutput);
          }
        }
      }
      const processChunkEntries = async (chunkEntries: KnowledgeEntry[]): Promise<void> => {
        const normalizedEntries = chunkEntries.map((entry) => ({
          ...entry,
          ...(platform ? { platform } : {}),
          ...(project ? { project } : {}),
          source: {
            ...entry.source,
            file: target.file,
          },
        }));
        fileResult.entriesExtracted += normalizedEntries.length;
        totalEntriesExtracted += normalizedEntries.length;

        const deduped = resolvedDeps.deduplicateEntriesFn(normalizedEntries);
        if (dryRun || deduped.length === 0) {
          return;
        }

        if (!embeddingApiKey) {
          embeddingApiKey = resolvedDeps.resolveEmbeddingApiKeyFn(config, process.env);
        }

        const storeResult = await withDbLock(() =>
          resolvedDeps.storeEntriesFn(db, deduped, embeddingApiKey ?? "", {
            sourceFile: target.file,
            ingestContentHash: fileHash,
            skipIngestLog: true,
            onlineDedup: true,
            skipLlmDedup: false,
            llmClient: client,
          }),
        );
        const reinforced = storeResult.updated;
        const stored = storeResult.added + storeResult.superseded;
        fileResult.entriesStored += stored;
        fileResult.entriesSkippedDuplicate += storeResult.skipped;
        fileResult.entriesReinforced += reinforced;
        totalEntriesStored += stored;
        totalEntriesAdded += storeResult.added;
        totalEntriesUpdated += 0;
        totalEntriesSkipped += storeResult.skipped;
        totalEntriesReinforced += reinforced;
        totalEntriesSuperseded += storeResult.superseded;
        totalDedupLlmCalls += storeResult.llm_dedup_calls;
        fileStoreStats.added += storeResult.added;
        fileStoreStats.updated += storeResult.updated;
        fileStoreStats.skipped += storeResult.skipped;
        fileStoreStats.superseded += storeResult.superseded;
        fileStoreStats.llmDedupCalls += storeResult.llm_dedup_calls;
      };

      const extracted = await resolvedDeps.extractKnowledgeFromChunksFn({
        file: target.file,
        chunks: parsed.chunks,
        client,
        verbose: false,
        llmConcurrency,
        onVerbose: verbose
          ? (line) => {
              clack.log.info(line, clackOutput);
            }
          : undefined,
        onChunkComplete: async (chunkResult) => {
          await processChunkEntries(chunkResult.entries);
        },
      });

      const successfulChunks = extracted.successfulChunks ?? 0;
      const failedChunks = extracted.failedChunks ?? 0;
      const totalChunks = successfulChunks + failedChunks;
      if (failedChunks > 0) {
        chunkStatsByFile.set(target.file, { successfulChunks, failedChunks });
        totalChunksFailed += failedChunks;
        filesWithChunkFailures += 1;
      }

      if (failedChunks > 0 && successfulChunks === 0) {
        const chunkLabel = totalChunks > 0 ? `${failedChunks}/${totalChunks}` : String(failedChunks);
        throw new Error(
          `All chunks failed during extraction (${chunkLabel}). This is often caused by API rate limits or timeouts; check provider limits/logs and re-run ingest.`,
        );
      }

      await withDbLock(() => syncWatchStateOffset(target.file, ingestByteOffset));
      if (!dryRun) {
        const fileDurationMs = Math.max(0, resolvedDeps.nowFn().getTime() - fileStartedAt.getTime());
        await withDbLock(() =>
          insertIngestLogForFile(db, {
            filePath: target.file,
            contentHash: fileHash,
            storeStats: fileStoreStats,
            durationMs: fileDurationMs,
          }),
        );
      }

      return fileResult;
    } catch (error) {
      if (fileHash.length > 0) {
        try {
          await withDbLock(() => cleanupFailedFileIngest(db, target.file, fileHash, baselineEntryIds, dryRun));
        } catch (cleanupError) {
          fileResult.error = `${errorMessage(error)} | cleanup failed: ${errorMessage(cleanupError)}`;
          return fileResult;
        }
      }
      fileResult.error = errorMessage(error);
      return fileResult;
    } finally {
      fileResult.durationMs = Math.max(0, resolvedDeps.nowFn().getTime() - fileStartedAt.getTime());
    }
  };

    try {
      const processTargets = async (targets: IngestTarget[], passVerb: string): Promise<void> => {
      if (targets.length === 0) {
        return;
      }

      cursor = 0;
      completed = 0;
      const total = targets.length;
      const workerCount = 1;

      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (true) {
            if (resolvedDeps.shouldShutdownFn()) {
              stoppedForShutdown = true;
              return;
            }
            const currentIndex = cursor;
            cursor += 1;
            if (currentIndex >= targets.length) {
              return;
            }

            const target = targets[currentIndex];
            if (!target) {
              return;
            }

            const result = await processTarget(target);
            results[target.index] = result;

            completed += 1;
            updateProgress(completed, total, passVerb);

            const label = `[${target.index + 1}/${sortedTargets.length}] ${path.basename(target.file)} (${formatBytes(target.size)})`;
            if (verbose) {
              if (result.error) {
                clack.log.warn(`${label} -- ${formatError(result.error)}`, clackOutput);
              } else if (result.skipped) {
                clack.log.info(`${label} -- skipped (${result.skipReason ?? "n/a"})`, clackOutput);
              } else if (dryRun) {
                clack.log.info(`${label} -- ${result.entriesExtracted} entries extracted (dry-run)`, clackOutput);
              } else {
                const chunkStats = chunkStatsByFile.get(target.file);
                const chunkFailureSuffix =
                  chunkStats && chunkStats.failedChunks > 0 ? ` (${chunkStats.failedChunks} chunks failed)` : "";
                const totalChunks = chunkStats ? chunkStats.successfulChunks + chunkStats.failedChunks : 0;
                const failureRate = chunkStats && totalChunks > 0 ? chunkStats.failedChunks / totalChunks : 0;
                const summary = `${result.entriesExtracted} extracted${chunkFailureSuffix}, ${result.entriesStored} stored, ${result.entriesSkippedDuplicate} skipped (duplicate), ${result.entriesReinforced} reinforced`;
                if (chunkStats && chunkStats.failedChunks > 0 && failureRate > 0.5) {
                  clack.log.warn(`${label} -- ${formatWarn(summary)}`, clackOutput);
                } else {
                  clack.log.info(`${label} -- ${summary}`, clackOutput);
                }
              }
              continue;
            }

            if (result.error) {
              clearProgressLine();
              clack.log.warn(
                `${formatWarn(`[${target.index + 1}/${sortedTargets.length}] ${path.basename(target.file)} failed (${formatBytes(target.size)}): ${result.error}`)}`,
                clackOutput,
              );
              updateProgress(completed, total, passVerb);
            } else if (result.skipped) {
              clearProgressLine();
              clack.log.info(
                `[${target.index + 1}/${sortedTargets.length}] ${path.basename(target.file)} -- skipped (${result.skipReason ?? "n/a"})`,
                clackOutput,
              );
              updateProgress(completed, total, passVerb);
            } else {
              const chunkStats = chunkStatsByFile.get(target.file);
              if (chunkStats && chunkStats.failedChunks > 0) {
                const totalChunks = chunkStats.successfulChunks + chunkStats.failedChunks;
                const failureRate = totalChunks > 0 ? chunkStats.failedChunks / totalChunks : 1;
                const msg = `[${target.index + 1}/${sortedTargets.length}] ${path.basename(target.file)} -- partial extraction: ${chunkStats.failedChunks}/${totalChunks} chunks failed`;
                clearProgressLine();
                if (failureRate > 0.5) {
                  clack.log.warn(formatWarn(msg), clackOutput);
                } else {
                  clack.log.info(msg, clackOutput);
                }
                updateProgress(completed, total, passVerb);
              }
            }
          }
        }),
      );
    };

      await processTargets(sortedTargets, "Processing");

      firstPassFailedIndexSet = new Set(
        sortedTargets.filter((target) => Boolean(results[target.index]?.error)).map((target) => target.index),
      );

      if (resolvedDeps.shouldShutdownFn()) {
        stoppedForShutdown = true;
      }

      if (retryEnabled && maxRetries > 0 && firstPassFailedIndexSet.size > 0) {
        for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
          const remainingFailed = sortedTargets.filter((target) => Boolean(results[target.index]?.error));
          if (remainingFailed.length === 0) {
            break;
          }

          if (resolvedDeps.shouldShutdownFn()) {
            clack.log.warn(formatWarn("Shutdown requested; skipping remaining retries."), clackOutput);
            break;
          }

          const backoffMs = retryBackoffMs(attempt);
          await resolvedDeps.sleepFn(backoffMs);

          if (resolvedDeps.shouldShutdownFn()) {
            clack.log.warn(formatWarn("Shutdown requested; skipping remaining retries."), clackOutput);
            break;
          }

          clack.log.info(
            `Retrying ${ui.bold(String(remainingFailed.length))} failed file(s) (attempt ${attempt}/${maxRetries})...`,
            clackOutput,
          );

          const failedBefore = new Set(remainingFailed.map((target) => target.index));
          await processTargets(remainingFailed, "Retrying");

          const recovered = remainingFailed.filter((target) => {
            if (!failedBefore.has(target.index)) return false;
            const final = results[target.index];
            return Boolean(final) && !final.error && !final.skipped;
          }).length;
          const stillFailing = remainingFailed.length - recovered;
          retrySummaries.push(
            `Retry round ${attempt}: ${recovered}/${remainingFailed.length} recovered, ${stillFailing} still failing`,
          );
        }
      }
    } finally {
      clearProgressLine();
      if (!dryRun) {
        try {
          await walCheckpoint(db);
        } catch (error) {
          clack.log.warn(formatWarn(`WAL checkpoint failed: ${errorMessage(error)}`), clackOutput);
        }
      }
      if (shouldLockDb) {
        releaseDbLock();
      }
      resolvedDeps.closeDbFn(db);
    }

    const durationMs = Math.max(0, resolvedDeps.nowFn().getTime() - startedAt.getTime());
    const finalFilesFailed = results.filter((result) => Boolean(result?.error)).length;
    const finalFilesSkipped = results.filter((result) => Boolean(result?.skipped)).length;
    const finalFilesProcessed = results.filter((result) => Boolean(result) && !result.error && !result.skipped).length;

    if (stoppedForShutdown) {
      clack.log.warn(
        formatWarn(
          `Shutdown requested; stopping after ${finalFilesProcessed + finalFilesSkipped + finalFilesFailed}/${sortedTargets.length} file(s).`,
        ),
        clackOutput,
      );
    }

    const succeededOnRetry = [...firstPassFailedIndexSet].filter((index) => {
      const result = results[index];
      return Boolean(result) && !result.error && !result.skipped;
    }).length;
    const succeededInitial = Math.max(0, finalFilesProcessed - succeededOnRetry);

    const allTargetsFailed = sortedTargets.length > 0 && finalFilesFailed === sortedTargets.length;
    const finalResult: IngestCommandResult = {
      exitCode: stoppedForShutdown ? 130 : allTargetsFailed ? 2 : finalFilesFailed > 0 ? 1 : 0,
      filesProcessed: finalFilesProcessed,
      filesSkipped: finalFilesSkipped,
      filesFailed: finalFilesFailed,
      totalEntriesExtracted,
      totalEntriesStored,
      dedupStats: {
        entries_added: totalEntriesAdded,
        entries_updated: totalEntriesUpdated,
        entries_skipped: totalEntriesSkipped,
        entries_reinforced: totalEntriesReinforced,
        entries_superseded: totalEntriesSuperseded,
        dedup_llm_calls: totalDedupLlmCalls,
      },
      durationMs,
      results,
    };

    const forceCleanupLine = force
      ? dryRun
        ? `Force cleanup (dry-run): would delete ${forceDeletedIngestLogRows} ingest_log, ${forceDeletedEntryRows} entries, ${forceDeletedEntrySourceRows} entry_sources`
        : `Force cleanup: deleted ${forceDeletedIngestLogRows} ingest_log, ${forceDeletedEntryRows} entries, ${forceDeletedEntrySourceRows} entry_sources`
      : null;
    if (forceCleanupLine) {
      clack.log.info(forceCleanupLine, clackOutput);
    }

    const doneLine =
      retrySummaries.length > 0
        ? `Done: ${succeededInitial} succeeded, ${succeededOnRetry} succeeded on retry, ${finalFilesFailed} failed after retries, ${finalFilesSkipped} skipped (already ingested)`
        : `Done: ${finalFilesProcessed} succeeded, ${finalFilesFailed} failed, ${finalFilesSkipped} skipped (already ingested)`;
    const chunkFailureLine =
      totalChunksFailed > 0
        ? `${totalChunksFailed} chunks failed across ${filesWithChunkFailures} file(s) (partial extraction)`
        : null;
    const retryLines =
      retrySummaries.length > 0 ? ["Retries:", ...retrySummaries.map((line) => `  ${line}`)] : [];
    const failedFileLines =
      finalFilesFailed > 0
        ? [
            retryEnabled && retrySummaries.length > 0
              ? "Failed files (after retries):"
              : retryEnabled
              ? "Failed files (will retry on next run):"
              : "Failed files (re-run ingest to retry):",
            ...results
              .filter((result): result is IngestFileResult => Boolean(result?.error))
              .map((result) => `  ${path.basename(result.file)} - ${result.error ?? "Unknown error"}`),
          ]
        : [];
    clack.note(
      [
        doneLine,
        chunkFailureLine,
        ...retryLines,
        ...failedFileLines,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      "Ingest Complete",
      clackOutput,
    );
    clack.outro(undefined, clackOutput);

    if (json) {
      process.stdout.write(`${JSON.stringify(finalResult, null, 2)}\n`);
    }

  return finalResult;
}
