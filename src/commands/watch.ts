import fs from "node:fs/promises";
import path from "node:path";
import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { deduplicateEntries } from "../dedup.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { storeEntries } from "../db/store.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { extractKnowledgeFromChunks } from "../extractor.js";
import { createLlmClient } from "../llm/client.js";
import { parseTranscriptFile } from "../parser.js";
import type { WatchOptions } from "../types.js";
import { banner, formatLabel, formatWarn } from "../ui.js";
import { getFileState, loadWatchState, saveWatchState } from "../watch/state.js";
import { readFileFromOffset, runWatcher } from "../watch/watcher.js";

function formatBytes(value: number): string {
  return value.toLocaleString("en-US");
}

function formatClock(value: Date): string {
  return value.toTimeString().slice(0, 8);
}

function formatInterval(intervalMs: number): string {
  const seconds = Math.floor(intervalMs / 1000);
  if (seconds % 60 === 0) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${seconds}s`;
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

export interface WatchCommandOptions extends WatchOptions {
  interval?: number | string;
  minChunk?: number | string;
}

export interface WatchCommandDeps {
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
  readFileFn: (path: string, offset: number) => Promise<Buffer>;
  nowFn: () => Date;
}

export interface WatchCommandResult {
  exitCode: number;
  cycles: number;
  entriesStored: number;
  durationMs: number;
}

export async function runWatchCommand(
  file: string,
  options: WatchCommandOptions,
  deps?: Partial<WatchCommandDeps>,
): Promise<WatchCommandResult> {
  const resolvedDeps: WatchCommandDeps = {
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
    nowFn: deps?.nowFn ?? (() => new Date()),
  };

  const intervalMs = parsePositiveInt(options.interval, 300, "--interval") * 1000;
  const minChunkChars = parsePositiveInt(options.minChunk, 2000, "--min-chunk");
  const dryRun = options.dryRun === true;
  const verbose = options.verbose === true;
  const once = options.once === true;
  const json = options.json === true;
  const filePath = path.resolve(file);

  const stat = await resolvedDeps.statFileFn(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Transcript file not found: ${filePath}`);
    }
    throw error;
  });
  if (!stat.isFile()) {
    throw new Error(`Input is not a file: ${filePath}`);
  }

  const clackOutput = { output: process.stderr };
  clack.intro(banner(), clackOutput);

  let stateWarning: string | null = null;
  let state = await resolvedDeps.loadWatchStateFn().catch((error: unknown) => {
    stateWarning = `State file is invalid (${error instanceof Error ? error.message : String(error)}). Resetting.`;
    return { version: 1 as const, files: {} };
  });
  if (stateWarning) {
    clack.log.warn(formatWarn(stateWarning), clackOutput);
    await resolvedDeps.saveWatchStateFn(state);
  }

  const fileState = getFileState(state, filePath);
  const offset = fileState?.byteOffset ?? 0;
  const config = resolvedDeps.readConfigFn(process.env);
  const dbPath = options.db?.trim() || config?.db?.path || "~/.agenr/knowledge.db";

  clack.log.info(formatLabel("Watching", filePath), clackOutput);
  clack.log.info(
    `${formatLabel("Interval", formatInterval(intervalMs))} | ${formatLabel("Min chunk", `${minChunkChars} chars`)}`,
    clackOutput,
  );
  clack.log.info(
    `${formatLabel("Offset", `${formatBytes(offset)} bytes (${fileState ? "resume" : "fresh"})`)} | ${formatLabel("DB", dbPath)}`,
    clackOutput,
  );
  clack.log.info("", clackOutput);
  clack.log.info("Waiting for changes...", clackOutput);

  let cycleCount = 0;
  let shuttingDown = false;
  const onSigint = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clack.log.info("Stopping watch...", clackOutput);
  };
  process.on("SIGINT", onSigint);

  try {
    const summary = await runWatcher(
      {
        filePath,
        intervalMs,
        minChunkChars,
        dryRun,
        verbose,
        once,
        model: options.model,
        provider: options.provider,
        dbPath: options.db,
        initialState: state,
        onWarn: (message) => {
          clack.log.warn(formatWarn(message), clackOutput);
        },
        onCycle: (result) => {
          cycleCount += 1;
          const timestamp = formatClock(resolvedDeps.nowFn());

          if (json) {
            process.stdout.write(`${JSON.stringify({ cycle: cycleCount, at: resolvedDeps.nowFn().toISOString(), ...result })}\n`);
          }

          if (result.error) {
            clack.log.warn(formatWarn(`[${timestamp}] Cycle ${cycleCount}: ${result.error}`), clackOutput);
            return;
          }

          if (result.skipped) {
            if (result.bytesRead > 0) {
              clack.log.info(
                `[${timestamp}] Cycle ${cycleCount}: +${formatBytes(result.bytesRead)} bytes (below threshold, skipping)`,
                clackOutput,
              );
            } else if (once || verbose) {
              clack.log.info(`[${timestamp}] Cycle ${cycleCount}: no new content`, clackOutput);
            }
            return;
          }

          if (dryRun) {
            clack.log.info(
              `[${timestamp}] Cycle ${cycleCount}: +${formatBytes(result.bytesRead)} bytes | ${result.entriesExtracted} entries extracted (dry-run)`,
              clackOutput,
            );
            return;
          }

          const deduped = Math.max(0, result.entriesExtracted - result.entriesStored);
          clack.log.info(
            `[${timestamp}] Cycle ${cycleCount}: +${formatBytes(result.bytesRead)} bytes | ${result.entriesExtracted} entries extracted | ${result.entriesStored} stored, ${deduped} deduped`,
            clackOutput,
          );
        },
      },
      {
        readConfigFn: resolvedDeps.readConfigFn,
        resolveEmbeddingApiKeyFn: resolvedDeps.resolveEmbeddingApiKeyFn,
        parseTranscriptFileFn: resolvedDeps.parseTranscriptFileFn,
        createLlmClientFn: resolvedDeps.createLlmClientFn,
        extractKnowledgeFromChunksFn: resolvedDeps.extractKnowledgeFromChunksFn,
        deduplicateEntriesFn: resolvedDeps.deduplicateEntriesFn,
        getDbFn: resolvedDeps.getDbFn,
        initDbFn: resolvedDeps.initDbFn,
        closeDbFn: resolvedDeps.closeDbFn,
        storeEntriesFn: resolvedDeps.storeEntriesFn,
        loadWatchStateFn: resolvedDeps.loadWatchStateFn,
        saveWatchStateFn: resolvedDeps.saveWatchStateFn,
        statFileFn: resolvedDeps.statFileFn,
        readFileFn: resolvedDeps.readFileFn,
        nowFn: resolvedDeps.nowFn,
        shouldShutdownFn: () => shuttingDown,
      },
    );

    clack.log.info(
      `Summary: ${summary.cycles} cycles | ${summary.entriesStored} entries stored | watched for ${formatDuration(summary.durationMs)}`,
      clackOutput,
    );
    clack.outro(undefined, clackOutput);

    return {
      exitCode: 0,
      cycles: summary.cycles,
      entriesStored: summary.entriesStored,
      durationMs: summary.durationMs,
    };
  } finally {
    process.off("SIGINT", onSigint);
  }
}
