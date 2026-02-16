import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "@libsql/client";
import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { deduplicateEntries } from "../dedup.js";
import { closeDb, getDb, initDb, walCheckpoint } from "../db/client.js";
import { hashText, storeEntries } from "../db/store.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { extractKnowledgeFromChunks } from "../extractor.js";
import { createLlmClient } from "../llm/client.js";
import { expandInputFiles, parseTranscriptFile } from "../parser.js";
import type { KnowledgeEntry } from "../types.js";
import { banner, formatError, formatWarn, ui } from "../ui.js";
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
  dryRun?: boolean;
  json?: boolean;
  concurrency?: number | string;
  skipIngested?: boolean;
  force?: boolean;
}

export interface IngestFileResult {
  file: string;
  entriesExtracted: number;
  entriesStored: number;
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

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
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
  };

  const clackOutput = { output: process.stderr };
  const startedAt = resolvedDeps.nowFn();
  const verbose = options.verbose === true;
  const dryRun = options.dryRun === true;
  const json = options.json === true;
  const force = options.force === true;
  const skipIngested = force ? false : options.skipIngested !== false;
  const globPattern = options.glob?.trim() || DEFAULT_GLOB;
  const concurrency = parsePositiveInt(options.concurrency, 1, "--concurrency");

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
    `Ingesting: ${ui.bold(String(sortedTargets.length))} file(s) | Glob: ${globPattern} | Skip ingested: ${skipIngested ? "yes" : "no"}`,
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
  const db = resolvedDeps.getDbFn(dbPath);
  await resolvedDeps.initDbFn(db);

  const results: IngestFileResult[] = new Array(sortedTargets.length);
  let filesProcessed = 0;
  let filesSkipped = 0;
  let filesFailed = 0;
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

  const updateProgress = (): void => {
    if (verbose) {
      return;
    }
    process.stderr.write(`\r${ui.dim(`Processing ${completed}/${sortedTargets.length}...`)}`);
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
      skipped: false,
      durationMs: 0,
    };

    try {
      const rawContent = await fs.readFile(target.file, "utf8");
      const ingestByteOffset = Buffer.byteLength(rawContent, "utf8");
      const fileHash = resolvedDeps.hashTextFn(rawContent);

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
      }

      const parsed = await resolvedDeps.parseTranscriptFileFn(target.file);
      const processChunkEntries = async (chunkEntries: KnowledgeEntry[]): Promise<void> => {
        fileResult.entriesExtracted += chunkEntries.length;
        totalEntriesExtracted += chunkEntries.length;

        const deduped = resolvedDeps.deduplicateEntriesFn(chunkEntries);
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
            onlineDedup: true,
            skipLlmDedup: true,
          }),
        );
        const reinforced = storeResult.updated;
        const stored = storeResult.added + reinforced + storeResult.superseded;
        fileResult.entriesStored += stored;
        totalEntriesStored += stored;
        totalEntriesAdded += storeResult.added;
        totalEntriesUpdated += 0;
        totalEntriesSkipped += storeResult.skipped;
        totalEntriesReinforced += reinforced;
        totalEntriesSuperseded += storeResult.superseded;
        totalDedupLlmCalls += storeResult.llm_dedup_calls;
      };

      await resolvedDeps.extractKnowledgeFromChunksFn({
        file: target.file,
        chunks: parsed.chunks,
        client,
        verbose: false,
        onChunkComplete: async (chunkResult) => {
          await processChunkEntries(chunkResult.entries);
        },
      });

      await withDbLock(() => syncWatchStateOffset(target.file, ingestByteOffset));

      return fileResult;
    } catch (error) {
      fileResult.error = errorMessage(error);
      return fileResult;
    } finally {
      fileResult.durationMs = Math.max(0, resolvedDeps.nowFn().getTime() - fileStartedAt.getTime());
    }
  };

  try {
    const workerCount = Math.max(1, Math.min(concurrency, sortedTargets.length));

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const currentIndex = cursor;
          cursor += 1;
          if (currentIndex >= sortedTargets.length) {
            return;
          }

          const target = sortedTargets[currentIndex];
          if (!target) {
            return;
          }

          const result = await processTarget(target);
          results[currentIndex] = result;

          if (result.error) {
            filesFailed += 1;
          } else if (result.skipped) {
            filesSkipped += 1;
          } else {
            filesProcessed += 1;
          }

          completed += 1;
          updateProgress();

          const label = `[${target.index + 1}/${sortedTargets.length}] ${path.basename(target.file)} (${formatBytes(target.size)})`;
          if (verbose) {
            if (result.error) {
              clack.log.warn(`${label} -- ${formatError(result.error)}`, clackOutput);
            } else if (result.skipped) {
              clack.log.info(`${label} -- skipped (${result.skipReason ?? "n/a"})`, clackOutput);
            } else if (dryRun) {
              clack.log.info(`${label} -- ${result.entriesExtracted} entries extracted (dry-run)`, clackOutput);
            } else {
              clack.log.info(
                `${label} -- ${result.entriesExtracted} extracted, ${result.entriesStored} stored`,
                clackOutput,
              );
            }
            continue;
          }

          if (result.error) {
            clearProgressLine();
            clack.log.warn(
              `${formatWarn(`[${target.index + 1}/${sortedTargets.length}] ${path.basename(target.file)} failed (${formatBytes(target.size)}): ${result.error}`)}`,
              clackOutput,
            );
            updateProgress();
          } else if (result.skipped) {
            clearProgressLine();
            clack.log.info(
              `[${target.index + 1}/${sortedTargets.length}] ${path.basename(target.file)} -- skipped (${result.skipReason ?? "n/a"})`,
              clackOutput,
            );
            updateProgress();
          }
        }
      }),
    );
  } finally {
    clearProgressLine();
    if (!dryRun) {
      try {
        await walCheckpoint(db);
      } catch (error) {
        clack.log.warn(formatWarn(`WAL checkpoint failed: ${errorMessage(error)}`), clackOutput);
      }
    }
    resolvedDeps.closeDbFn(db);
  }

  const durationMs = Math.max(0, resolvedDeps.nowFn().getTime() - startedAt.getTime());
  const finalResult: IngestCommandResult = {
    exitCode: filesFailed > 0 ? 1 : 0,
    filesProcessed,
    filesSkipped,
    filesFailed,
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
  clack.note(
    [
      `Done: ${sortedTargets.length} files | ${filesProcessed} processed, ${filesSkipped} skipped, ${filesFailed} failed`,
      `Entries: ${totalEntriesExtracted} extracted, ${totalEntriesStored} stored, ${totalEntriesSkipped} skipped (duplicate), ${totalEntriesReinforced} reinforced`,
      `Dedup: ${totalEntriesAdded} added, ${totalEntriesUpdated} updated, ${totalEntriesSkipped} skipped, ${totalEntriesReinforced} reinforced, ${totalEntriesSuperseded} superseded, ${totalDedupLlmCalls} LLM calls`,
      forceCleanupLine,
      `Duration: ${formatDuration(durationMs)}`,
      dryRun ? formatWarn("dry-run: no changes persisted") : null,
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
