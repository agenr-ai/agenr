import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as clack from "@clack/prompts";
import { readConfig } from "../config.js";
import { warnIfLocked } from "../consolidate/lock.js";
import { deduplicateEntries } from "../dedup.js";
import { closeDb, getDb, initDb } from "../db/client.js";
import { storeEntries } from "../db/store.js";
import { resolveEmbeddingApiKey } from "../embeddings/client.js";
import { extractKnowledgeFromChunks } from "../extractor.js";
import { createLlmClient } from "../llm/client.js";
import { parseTranscriptFile } from "../parser.js";
import type { WatchOptions } from "../types.js";
import { banner, formatLabel, formatWarn } from "../ui.js";
import { generateContextFile } from "./context.js";
import { resolveAutoSession } from "../watch/resolvers/auto.js";
import { detectWatchPlatform, getResolver, type WatchPlatform } from "../watch/resolvers/index.js";
import { getFileState, loadWatchState, saveWatchState } from "../watch/state.js";
import { readFileFromOffset, runWatcher } from "../watch/watcher.js";
import { installSignalHandlers, isShutdownRequested } from "../shutdown.js";

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

function formatSwitchLabel(filePath: string): string {
  return path.resolve(filePath);
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
  generateContextFileFn: typeof generateContextFile;
  nowFn: () => Date;
}

export interface WatchCommandResult {
  exitCode: number;
  cycles: number;
  entriesStored: number;
  durationMs: number;
}

type WatchMode = "file" | "dir" | "auto";

interface WatchModeConfig {
  mode: WatchMode;
  filePath: string | null;
  sessionsDir: string | null;
  platform: WatchPlatform | null;
  resolver: ReturnType<typeof getResolver> | null;
  autoPlatformCount?: number;
}

async function resolveWatchMode(
  file: string | undefined,
  options: WatchCommandOptions,
  statFileFn: typeof fs.stat,
): Promise<WatchModeConfig> {
  const hasFile = typeof file === "string" && file.trim().length > 0;
  const hasDir = typeof options.dir === "string" && options.dir.trim().length > 0;
  const autoMode = options.auto === true;

  const modeCount = Number(hasFile) + Number(hasDir) + Number(autoMode);
  if (modeCount !== 1) {
    throw new Error("Choose exactly one watch mode: <file> OR --dir <path> OR --auto.");
  }

  if (autoMode) {
    if (options.platform && options.platform.trim().length > 0) {
      throw new Error("--platform cannot be used with --auto.");
    }

    const autoProbe = await resolveAutoSession();
    if (autoProbe.discoveredRoots.length === 0) {
      throw new Error(
        [
          "No supported platform directories found for --auto mode.",
          "Expected one of:",
          "  - ~/.openclaw/agents/main/sessions",
          "  - ~/.claude/projects",
          "  - ~/.codex/sessions",
        ].join("\n"),
      );
    }

    return {
      mode: "auto",
      filePath: autoProbe.activeFile ? path.resolve(autoProbe.activeFile) : null,
      sessionsDir: null,
      platform: autoProbe.platform,
      resolver: null,
      autoPlatformCount: autoProbe.discoveredRoots.length,
    };
  }

  if (hasDir) {
    const sessionsDir = path.resolve(options.dir!.trim());
    const stat = await statFileFn(sessionsDir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Sessions directory not found: ${sessionsDir}`);
      }
      throw error;
    });

    if (!stat.isDirectory()) {
      throw new Error(`Input is not a directory: ${sessionsDir}`);
    }

    const platform = detectWatchPlatform(options.platform, sessionsDir);
    const resolver = getResolver(options.platform, sessionsDir);
    const resolvedFile = await resolver.resolveActiveSession(sessionsDir).catch(() => null);

    return {
      mode: "dir",
      filePath: resolvedFile ? path.resolve(resolvedFile) : null,
      sessionsDir,
      platform,
      resolver,
    };
  }

  const filePath = path.resolve((file ?? "").trim());
  const stat = await statFileFn(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Transcript file not found: ${filePath}`);
    }
    throw error;
  });

  if (!stat.isFile()) {
    throw new Error(`Input is not a file: ${filePath}`);
  }

  return {
    mode: "file",
    filePath,
    sessionsDir: null,
    platform: null,
    resolver: null,
  };
}

export async function runWatchCommand(
  file: string | undefined,
  options: WatchCommandOptions,
  deps?: Partial<WatchCommandDeps>,
): Promise<WatchCommandResult> {
  warnIfLocked();
  installSignalHandlers();

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
    generateContextFileFn: deps?.generateContextFileFn ?? generateContextFile,
    nowFn: deps?.nowFn ?? (() => new Date()),
  };

  const intervalMs = parsePositiveInt(options.interval, 300, "--interval") * 1000;
  const minChunkChars = parsePositiveInt(options.minChunk, 2000, "--min-chunk");
  const dryRun = options.dryRun === true;
  const verbose = options.verbose === true;
  const once = options.once === true;
  const json = options.json === true;
  const raw = options.raw === true;

  const modeConfig = await resolveWatchMode(file, options, resolvedDeps.statFileFn);

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

  const fileState = modeConfig.filePath ? getFileState(state, modeConfig.filePath) : undefined;
  const offset = fileState?.byteOffset ?? 0;
  const config = resolvedDeps.readConfigFn(process.env);
  const dbPath = options.db?.trim() || config?.db?.path || "~/.agenr/knowledge.db";

  if (modeConfig.mode === "file") {
    clack.log.info(formatLabel("Watching", modeConfig.filePath ?? "(unknown)"), clackOutput);
  } else if (modeConfig.mode === "dir") {
    clack.log.info(formatLabel("Watching directory", modeConfig.sessionsDir ?? "(unknown)"), clackOutput);
    clack.log.info(formatLabel("Platform", modeConfig.platform ?? "mtime"), clackOutput);
    clack.log.info(
      formatLabel("Active file", modeConfig.filePath ? formatSwitchLabel(modeConfig.filePath) : "(waiting for session file)"),
      clackOutput,
    );
  } else {
    clack.log.info(formatLabel("Watching", "auto mode"), clackOutput);
    clack.log.info(formatLabel("Detected platforms", String(modeConfig.autoPlatformCount ?? 0)), clackOutput);
    clack.log.info(
      formatLabel("Active file", modeConfig.filePath ? formatSwitchLabel(modeConfig.filePath) : "(waiting for session file)"),
      clackOutput,
    );
  }

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
  let contextChain: Promise<void> = Promise.resolve();
  const summary = await runWatcher(
      {
        filePath: modeConfig.filePath ?? undefined,
        directoryMode: modeConfig.mode === "dir",
        sessionsDir: modeConfig.sessionsDir ?? undefined,
        resolver: modeConfig.resolver ?? undefined,
        autoMode: modeConfig.mode === "auto",
        platform: modeConfig.platform ?? undefined,
        intervalMs,
        minChunkChars,
        dryRun,
        verbose,
        raw,
        once,
        onlineDedup: options.onlineDedup !== false,
        model: options.model,
        provider: options.provider,
        dbPath: options.db,
        initialState: state,
        onWarn: (message) => {
          if (message.startsWith("Filtered:")) {
            clack.log.info(message, clackOutput);
            return;
          }
          clack.log.warn(formatWarn(message), clackOutput);
        },
        onSwitch: (from, to, platform) => {
          const fromLabel = from ? formatSwitchLabel(from) : "(none)";
          const platformLabel = platform ? ` [${platform}]` : "";
          clack.log.info(`Switched watch file${platformLabel}: ${fromLabel} -> ${formatSwitchLabel(to)}`, clackOutput);
        },
        onCycle: (result, ctx) => {
          cycleCount += 1;
          const timestamp = formatClock(resolvedDeps.nowFn());
          const fileLabel = result.filePath ? ` | file=${result.filePath}` : "";

          if (json) {
            process.stdout.write(`${JSON.stringify({ cycle: cycleCount, at: resolvedDeps.nowFn().toISOString(), ...result })}\n`);
          }

          if (result.error) {
            clack.log.warn(formatWarn(`[${timestamp}] Cycle ${cycleCount}: ${result.error}${fileLabel}`), clackOutput);
            return;
          }

          if (result.skipped) {
            if (result.bytesRead > 0) {
              clack.log.info(
                `[${timestamp}] Cycle ${cycleCount}: +${formatBytes(result.bytesRead)} bytes (below threshold, skipping)${fileLabel}`,
                clackOutput,
              );
            } else if (once || verbose) {
              clack.log.info(`[${timestamp}] Cycle ${cycleCount}: no new content${fileLabel}`, clackOutput);
            }
            return;
          }

          if (dryRun) {
            clack.log.info(
              `[${timestamp}] Cycle ${cycleCount}: +${formatBytes(result.bytesRead)} bytes | ${result.entriesExtracted} entries extracted (dry-run)${fileLabel}`,
              clackOutput,
            );
            return;
          }

          const deduped = Math.max(0, result.entriesExtracted - result.entriesStored);
          clack.log.info(
            `[${timestamp}] Cycle ${cycleCount}: +${formatBytes(result.bytesRead)} bytes | ${result.entriesExtracted} entries extracted | ${result.entriesStored} stored, ${deduped} deduped${fileLabel}`,
            clackOutput,
          );

          if (!dryRun && options.context && result.entriesStored > 0 && ctx.db) {
            const contextPath = path.resolve(options.context.replace(/^~(?=$|\/)/, os.homedir()));
            contextChain = contextChain
              .then(async () => {
                await resolvedDeps.generateContextFileFn(
                  ctx.db!,
                  ctx.apiKey,
                  contextPath,
                  { budget: 2000, limit: 10, json: false },
                );
              })
              .catch((err: unknown) => {
                if (verbose) {
                  clack.log.warn(
                    `Context refresh failed: ${err instanceof Error ? err.message : String(err)}`,
                    clackOutput,
                  );
                }
              });
          }
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
        shouldShutdownFn: isShutdownRequested,
      },
    );

  // Best-effort: ensure any in-flight context refresh finishes before printing the final summary.
  await contextChain.catch(() => undefined);

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
}
