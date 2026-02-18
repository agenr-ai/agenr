import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmptyWatchState,
  getFileState,
  loadWatchState,
  saveWatchState,
  updateFileState,
} from "../../src/watch/state.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-watch-state-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("watch state", () => {
  it("loads empty state when file does not exist", async () => {
    const dir = await makeTempDir();
    const state = await loadWatchState(dir);
    expect(state).toEqual({ version: 1, files: {} });
  });

  it("saves and reloads state data", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "session.jsonl");
    const state = createEmptyWatchState();
    updateFileState(state, filePath, {
      byteOffset: 120,
      lastRunAt: "2026-02-15T00:00:00.000Z",
      totalEntriesStored: 3,
      totalRunCount: 2,
    });

    await saveWatchState(state, dir);
    const reloaded = await loadWatchState(dir);
    const entry = getFileState(reloaded, filePath);

    expect(entry).toMatchObject({
      filePath: path.resolve(filePath),
      byteOffset: 120,
      totalEntriesStored: 3,
      totalRunCount: 2,
    });
  });

  it("merges file state updates", () => {
    const state = createEmptyWatchState();
    const filePath = "/tmp/a.jsonl";
    updateFileState(state, filePath, {
      byteOffset: 10,
      lastRunAt: "2026-02-15T00:00:00.000Z",
      totalEntriesStored: 1,
      totalRunCount: 1,
    });
    updateFileState(state, filePath, {
      byteOffset: 42,
      totalEntriesStored: 5,
    });

    const entry = getFileState(state, filePath);
    expect(entry).toMatchObject({
      byteOffset: 42,
      lastRunAt: "2026-02-15T00:00:00.000Z",
      totalEntriesStored: 5,
      totalRunCount: 1,
    });
  });

  it("tracks multiple files independently", () => {
    const state = createEmptyWatchState();
    const first = "/tmp/first.jsonl";
    const second = "/tmp/second.jsonl";

    updateFileState(state, first, { byteOffset: 10, totalRunCount: 1, totalEntriesStored: 2 });
    updateFileState(state, second, { byteOffset: 100, totalRunCount: 3, totalEntriesStored: 9 });

    expect(getFileState(state, first)?.byteOffset).toBe(10);
    expect(getFileState(state, second)?.byteOffset).toBe(100);
  });

  it("supports truncation detection through stored offset values", () => {
    const state = createEmptyWatchState();
    const filePath = "/tmp/truncated.jsonl";
    updateFileState(state, filePath, { byteOffset: 100 });

    const currentSize = 20;
    expect(currentSize < (getFileState(state, filePath)?.byteOffset ?? 0)).toBe(true);
  });

  it("writes watch state atomically via temp file rename", async () => {
    const dir = await makeTempDir();
    const filePath = path.join(dir, "session.jsonl");
    const state = createEmptyWatchState();
    updateFileState(state, filePath, {
      byteOffset: 42,
      lastRunAt: "2026-02-15T00:00:00.000Z",
      totalEntriesStored: 1,
      totalRunCount: 1,
    });

    const writeFileSpy = vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);
    const renameSpy = vi.spyOn(fs, "rename").mockResolvedValue(undefined);

    await saveWatchState(state, dir);

    const expectedStatePath = path.join(dir, "watch-state.json");
    const expectedTmpPath = `${expectedStatePath}.tmp`;
    expect(writeFileSpy).toHaveBeenCalledWith(
      expectedTmpPath,
      expect.any(String),
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(renameSpy).toHaveBeenCalledWith(expectedTmpPath, expectedStatePath);
    const writeCallOrder = writeFileSpy.mock.invocationCallOrder.at(-1) ?? 0;
    const renameCallOrder = renameSpy.mock.invocationCallOrder.at(-1) ?? 0;
    expect(writeCallOrder).toBeLessThan(renameCallOrder);
  });
});
