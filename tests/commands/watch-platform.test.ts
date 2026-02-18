import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-watch-platform-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
  vi.restoreAllMocks();
  vi.resetModules();
});

async function setupWatcherMock(): Promise<{
  runWatcherSpy: ReturnType<typeof vi.fn>;
  getLastOptions: () => Record<string, unknown> | null;
}> {
  let lastOptions: Record<string, unknown> | null = null;
  const runWatcherSpy = vi.fn(async (opts: Record<string, unknown>) => {
    lastOptions = opts;
    const now = new Date("2026-02-15T00:00:00.000Z");
    return { cycles: 0, entriesStored: 0, startedAt: now, endedAt: now, durationMs: 0 };
  });

  vi.doMock("../../src/watch/watcher.js", () => {
    return {
      readFileFromOffset: vi.fn(async () => Buffer.alloc(0)),
      runWatcher: runWatcherSpy,
    };
  });

  return {
    runWatcherSpy,
    getLastOptions: () => lastOptions,
  };
}

describe("watch command platform defaults and --auto deprecation", () => {
  it("--auto without --platform warns, defaults to openclaw, and runs in dir mode", async () => {
    const home = await makeTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    await fs.mkdir(path.join(home, ".openclaw", "agents", "main", "sessions"), { recursive: true });

    const { runWatcherSpy, getLastOptions } = await setupWatcherMock();
    const { runWatchCommand } = await import("../../src/commands/watch.js");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runWatchCommand(undefined, { auto: true, once: true }, {
      statFileFn: fs.stat as any,
      loadWatchStateFn: vi.fn(async () => ({ version: 1 as const, files: {} })),
      saveWatchStateFn: vi.fn(async () => undefined),
      readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
    } as any);

    const stderr = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(stderr).toContain("Warning: --auto is deprecated. Use --platform <name> instead.");
    expect(stderr).toContain("Defaulting to --platform openclaw.");

    expect(runWatcherSpy).toHaveBeenCalledTimes(1);
    const opts = getLastOptions();
    expect(opts?.directoryMode).toBe(true);
    expect(opts?.sessionsDir).toBe(path.join(home, ".openclaw", "agents", "main", "sessions"));
    expect(opts?.platform).toBe("openclaw");
  });

  it("--auto with --platform uses the specified platform (no defaulting warning)", async () => {
    const home = await makeTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    await fs.mkdir(path.join(home, ".codex", "sessions"), { recursive: true });

    const { runWatcherSpy, getLastOptions } = await setupWatcherMock();
    const { runWatchCommand } = await import("../../src/commands/watch.js");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runWatchCommand(undefined, { auto: true, platform: "codex", once: true }, {
      statFileFn: fs.stat as any,
      loadWatchStateFn: vi.fn(async () => ({ version: 1 as const, files: {} })),
      saveWatchStateFn: vi.fn(async () => undefined),
      readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
    } as any);

    const stderr = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(stderr).toContain("Warning: --auto is deprecated. Use --platform <name> instead.");
    expect(stderr).not.toContain("Defaulting to --platform openclaw.");

    expect(runWatcherSpy).toHaveBeenCalledTimes(1);
    const opts = getLastOptions();
    expect(opts?.directoryMode).toBe(true);
    expect(opts?.sessionsDir).toBe(path.join(home, ".codex", "sessions"));
    expect(opts?.platform).toBe("codex");
  });

  it("--platform <name> without --dir resolves the default directory and runs in dir mode", async () => {
    const home = await makeTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    await fs.mkdir(path.join(home, ".openclaw", "agents", "main", "sessions"), { recursive: true });

    const { runWatcherSpy, getLastOptions } = await setupWatcherMock();
    const { runWatchCommand } = await import("../../src/commands/watch.js");

    await runWatchCommand(undefined, { platform: "openclaw", once: true }, {
      statFileFn: fs.stat as any,
      loadWatchStateFn: vi.fn(async () => ({ version: 1 as const, files: {} })),
      saveWatchStateFn: vi.fn(async () => undefined),
      readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
    } as any);

    expect(runWatcherSpy).toHaveBeenCalledTimes(1);
    const opts = getLastOptions();
    expect(opts?.directoryMode).toBe(true);
    expect(opts?.sessionsDir).toBe(path.join(home, ".openclaw", "agents", "main", "sessions"));
    expect(opts?.platform).toBe("openclaw");
  });

  it("errors when --platform directory is missing", async () => {
    const home = await makeTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(home);

    await setupWatcherMock();
    const { runWatchCommand } = await import("../../src/commands/watch.js");

    await expect(
      runWatchCommand(undefined, { platform: "codex", once: true }, {
        statFileFn: fs.stat as any,
        loadWatchStateFn: vi.fn(async () => ({ version: 1 as const, files: {} })),
        saveWatchStateFn: vi.fn(async () => undefined),
        readConfigFn: vi.fn(() => ({ db: { path: ":memory:" } })),
      } as any),
    ).rejects.toThrow("Platform directory not found:");
  });
});

