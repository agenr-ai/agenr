import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetShutdownForTests } from "../../src/shutdown.js";
import { isHealthy, readHealthFile, resolveHealthPath, writeHealthFile, type WatcherHealth } from "../../src/watch/health.js";
import { runWatcher, type WatcherDeps } from "../../src/watch/watcher.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempDirs: string[] = [];

function makeHealth(overrides?: Partial<WatcherHealth>): WatcherHealth {
  return {
    pid: 1234,
    startedAt: "2026-02-19T12:00:00.000Z",
    lastHeartbeat: "2026-02-19T12:00:00.000Z",
    sessionsWatched: 2,
    entriesStored: 9,
    ...overrides,
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-watch-health-test-"));
  tempDirs.push(dir);
  return dir;
}

function useTempHome(dir: string): void {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

function makeWatcherDeps(overrides?: Partial<WatcherDeps>): Partial<WatcherDeps> {
  return {
    readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
    resolveEmbeddingApiKeyFn: vi.fn(() => "sk-test"),
    parseTranscriptFileFn: vi.fn(async () => ({
      file: "/tmp/delta.txt",
      messages: [],
      chunks: [],
      warnings: [],
    })),
    createLlmClientFn: vi.fn(() => ({ resolvedModel: { modelId: "test" }, credentials: { apiKey: "x" } })),
    extractKnowledgeFromChunksFn: vi.fn(async () => ({
      entries: [],
      successfulChunks: 0,
      failedChunks: 0,
      warnings: [],
    })),
    deduplicateEntriesFn: vi.fn((entries) => entries),
    getDbFn: vi.fn(() => ({} as unknown as ReturnType<WatcherDeps["getDbFn"]>)),
    initDbFn: vi.fn(async () => undefined),
    closeDbFn: vi.fn(() => undefined),
    walCheckpointFn: vi.fn(async () => undefined),
    storeEntriesFn: vi.fn(async () => ({
      added: 0,
      updated: 0,
      skipped: 0,
      superseded: 0,
      llm_dedup_calls: 0,
      relations_created: 0,
      total_entries: 0,
      duration_ms: 1,
    })),
    loadWatchStateFn: vi.fn(async () => ({ version: 1 as const, files: {} })),
    saveWatchStateFn: vi.fn(async () => undefined),
    writeHealthFileFn: vi.fn(async () => undefined),
    statFileFn: vi.fn(async () => ({ size: 0, isFile: () => true })),
    readFileFn: vi.fn(async () => Buffer.alloc(0)),
    readFileHeadFn: vi.fn(async () => Buffer.alloc(0)),
    detectProjectFn: vi.fn(() => null),
    mkdtempFn: vi.fn(async () => "/tmp/agenr-watch-health"),
    writeFileFn: vi.fn(async () => undefined),
    rmFn: vi.fn(async () => undefined),
    watchFn: vi.fn(
      () =>
        ({
          close: () => undefined,
        }) as unknown as ReturnType<WatcherDeps["watchFn"]>,
    ),
    nowFn: vi.fn(() => new Date("2026-02-19T12:00:00.000Z")),
    sleepFn: vi.fn(async () => undefined),
    shouldShutdownFn: vi.fn(() => true),
    ...overrides,
  };
}

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  resetShutdownForTests();
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  vi.restoreAllMocks();
});

describe("watch health", () => {
  it("writes and reads health data round-trip", async () => {
    useTempHome(await makeTempDir());
    const health = makeHealth();

    await writeHealthFile(health);

    const loaded = await readHealthFile();
    expect(loaded).toEqual(health);
  });

  it("writes health atomically and leaves no tmp files", async () => {
    useTempHome(await makeTempDir());
    const health = makeHealth();

    await writeHealthFile(health);

    const loaded = await readHealthFile();
    expect(loaded).toEqual(health);

    const dirEntries = await fs.readdir(path.dirname(resolveHealthPath()));
    const hasTmp = dirEntries.some((name) => name.endsWith(".tmp"));
    expect(hasTmp).toBe(false);
  });

  it("returns null when health file is missing", async () => {
    useTempHome(await makeTempDir());
    await expect(readHealthFile()).resolves.toBeNull();
  });

  it("returns null when health file contains invalid JSON", async () => {
    useTempHome(await makeTempDir());
    const healthPath = resolveHealthPath();
    await fs.mkdir(path.dirname(healthPath), { recursive: true });
    await fs.writeFile(healthPath, "not-json", "utf8");

    await expect(readHealthFile()).resolves.toBeNull();
  });

  it("returns null when required health field is missing", async () => {
    useTempHome(await makeTempDir());
    const healthPath = resolveHealthPath();
    await fs.mkdir(path.dirname(healthPath), { recursive: true });
    await fs.writeFile(
      healthPath,
      JSON.stringify(
        {
          startedAt: "2026-02-19T12:00:00.000Z",
          lastHeartbeat: "2026-02-19T12:01:00.000Z",
          sessionsWatched: 1,
          entriesStored: 2,
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(readHealthFile()).resolves.toBeNull();
  });

  it("returns null when health field has wrong type", async () => {
    useTempHome(await makeTempDir());
    const healthPath = resolveHealthPath();
    await fs.mkdir(path.dirname(healthPath), { recursive: true });
    await fs.writeFile(
      healthPath,
      JSON.stringify(
        {
          pid: "not-a-number",
          startedAt: "2026-02-19T12:00:00.000Z",
          lastHeartbeat: "2026-02-19T12:01:00.000Z",
          sessionsWatched: 1,
          entriesStored: 2,
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(readHealthFile()).resolves.toBeNull();
  });

  it("isHealthy returns true for recent heartbeat", () => {
    const now = new Date("2026-02-19T12:00:00.000Z");
    const health = makeHealth({
      lastHeartbeat: new Date(now.getTime() - 60 * 1000).toISOString(),
    });

    expect(isHealthy(health, now)).toBe(true);
  });

  it("isHealthy returns false for stale heartbeat", () => {
    const now = new Date("2026-02-19T12:00:00.000Z");
    const health = makeHealth({
      lastHeartbeat: new Date(now.getTime() - 6 * 60 * 1000).toISOString(),
    });

    expect(isHealthy(health, now)).toBe(false);
  });

  it("isHealthy returns false for invalid heartbeat dates", () => {
    const health = makeHealth({ lastHeartbeat: "not-a-date" });

    expect(isHealthy(health, new Date("2026-02-19T12:00:00.000Z"))).toBe(false);
  });

  it("increments sessionsWatched when watcher switches sessions", async () => {
    const fileA = "/tmp/agenr-health-a.jsonl";
    const fileB = "/tmp/agenr-health-b.jsonl";
    const sessionsDir = await makeTempDir();
    const writes: WatcherHealth[] = [];
    let resolveCalls = 0;
    let shutdown = false;
    let cycles = 0;

    const resolver = {
      filePattern: "*.jsonl",
      resolveActiveSession: vi.fn(async () => {
        resolveCalls += 1;
        if (resolveCalls === 1) {
          return fileA;
        }
        return fileB;
      }),
    };

    const writeHealthFileFn = vi.fn(async (health: WatcherHealth) => {
      writes.push(health);
    });

    await runWatcher(
      {
        intervalMs: 1,
        minChunkChars: 5,
        dryRun: true,
        verbose: false,
        raw: false,
        once: false,
        directoryMode: true,
        sessionsDir,
        resolver,
        onCycle: () => {
          cycles += 1;
          if (cycles >= 2) {
            shutdown = true;
          }
        },
      },
      makeWatcherDeps({
        shouldShutdownFn: vi.fn(() => shutdown),
        sleepFn: vi.fn(async () => undefined),
        writeHealthFileFn,
      }),
    );

    const hasSwitchCount = writes.some((health) => health.sessionsWatched >= 1);
    expect(hasSwitchCount).toBe(true);
  });
});
