import { createHash } from "node:crypto";
import { access, constants, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../../../src/adapters/db/client.js";
import { setupRecallEvalSandbox } from "../../../../src/app/evals/recall/sandbox.js";
import type { Durable } from "../../../../src/core/types.js";
import { removeTestPath, waitForDatabaseRelease } from "../../../helpers/temp-paths.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await waitForDatabaseRelease();

  while (tempPaths.length > 0) {
    await removeTestPath(tempPaths.pop() ?? "");
  }
});

describe("setupRecallEvalSandbox", () => {
  it("returns a sandbox without snapshot metadata when corpusSeed is omitted", async () => {
    const root = await createTempDirectory("agenr-sandbox-fixture-");

    const sandbox = await setupRecallEvalSandbox({ root, preserve: false });

    try {
      expect(sandbox.snapshot).toBeUndefined();
      expect(sandbox.dbPath).toBe(path.join(root, "knowledge.db"));
      await access(sandbox.dbPath, constants.F_OK);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("returns a sandbox without snapshot metadata when corpusSeed is explicit fixture mode", async () => {
    const root = await createTempDirectory("agenr-sandbox-fixture-explicit-");

    const sandbox = await setupRecallEvalSandbox({
      root,
      preserve: false,
      corpusSeed: { mode: "fixture" },
    });

    try {
      expect(sandbox.snapshot).toBeUndefined();
    } finally {
      await sandbox.cleanup();
    }
  });

  it("copies the source snapshot DB into the sandbox and preserves the source bytes", async () => {
    const sourceRoot = await createTempDirectory("agenr-sandbox-source-");
    const snapshotDbPath = path.join(sourceRoot, "knowledge.db");

    await seedSnapshotDatabase(snapshotDbPath, seedEntryFixture("snapshot-fact-1", "Taylor is on call this week."));
    const sourceBytesBefore = await readFile(snapshotDbPath);

    const sandboxRoot = await createTempDirectory("agenr-sandbox-copy-");
    const sandbox = await setupRecallEvalSandbox({
      root: sandboxRoot,
      preserve: false,
      corpusSeed: {
        mode: "snapshot_copy",
        snapshotDbPath,
        snapshotId: "snapshot-01",
        snapshotLabel: "test snapshot",
      },
    });

    try {
      expect(sandbox.snapshot).toEqual({
        id: "snapshot-01",
        label: "test snapshot",
        dbPathBasename: "knowledge.db",
        allowedTelemetryWrites: false,
      });

      const hydrated = await sandbox.episodeDatabase.getDurable("snapshot-fact-1");
      expect(hydrated?.subject).toBe("pager policy");
      expect(hydrated?.content).toBe("Taylor is on call this week.");
    } finally {
      await sandbox.cleanup();
    }

    const sourceBytesAfter = await readFile(snapshotDbPath);
    expect(sourceBytesAfter.equals(sourceBytesBefore)).toBe(true);
  });

  it("allows fixture overlays on top of the copied snapshot without touching the source", async () => {
    const sourceRoot = await createTempDirectory("agenr-sandbox-overlay-source-");
    const snapshotDbPath = path.join(sourceRoot, "knowledge.db");
    await seedSnapshotDatabase(snapshotDbPath, seedEntryFixture("snapshot-fact-1", "Jordan is on call this week."));
    const sourceBytesBefore = await readFile(snapshotDbPath);

    const sandboxRoot = await createTempDirectory("agenr-sandbox-overlay-");
    const sandbox = await setupRecallEvalSandbox({
      root: sandboxRoot,
      preserve: false,
      corpusSeed: {
        mode: "snapshot_copy",
        snapshotDbPath,
      },
    });

    try {
      await sandbox.fixtureStore.insertDurable(
        buildEntryFixture("overlay-fact-1", "Overlay fixture content."),
        deterministicVector("overlay-fact-1", 1024),
        contentHashOf("overlay-fact-1"),
      );

      const overlay = await sandbox.episodeDatabase.getDurable("overlay-fact-1");
      expect(overlay?.content).toBe("Overlay fixture content.");

      const snapshotRow = await sandbox.episodeDatabase.getDurable("snapshot-fact-1");
      expect(snapshotRow?.content).toBe("Jordan is on call this week.");
    } finally {
      await sandbox.cleanup();
    }

    const sourceBytesAfter = await readFile(snapshotDbPath);
    expect(sourceBytesAfter.equals(sourceBytesBefore)).toBe(true);
  });

  it("preserves the copied snapshot on disk when preserve is true", async () => {
    const sourceRoot = await createTempDirectory("agenr-sandbox-preserve-source-");
    const snapshotDbPath = path.join(sourceRoot, "knowledge.db");
    await seedSnapshotDatabase(snapshotDbPath, seedEntryFixture("snapshot-fact-1", "Preserved snapshot content."));

    const sandboxRoot = await createTempDirectory("agenr-sandbox-preserve-");
    const sandbox = await setupRecallEvalSandbox({
      root: sandboxRoot,
      preserve: true,
      corpusSeed: {
        mode: "snapshot_copy",
        snapshotDbPath,
      },
    });

    try {
      expect(sandbox.preserved).toBe(true);
    } finally {
      await sandbox.cleanup();
    }

    await expect(access(path.join(sandboxRoot, "knowledge.db"), constants.F_OK)).resolves.toBeUndefined();
  });

  it("rejects snapshot_copy with a missing source file", async () => {
    const sandboxRoot = await createTempDirectory("agenr-sandbox-missing-source-");

    await expect(
      setupRecallEvalSandbox({
        root: sandboxRoot,
        preserve: false,
        corpusSeed: {
          mode: "snapshot_copy",
          snapshotDbPath: path.join(sandboxRoot, "does-not-exist.db"),
        },
      }),
    ).rejects.toThrow(/Snapshot database file is not accessible/);
  });

  it("rejects snapshot_copy when the snapshot path equals the sandbox db path", async () => {
    const sandboxRoot = await createTempDirectory("agenr-sandbox-self-copy-");
    const collidingPath = path.join(sandboxRoot, "knowledge.db");
    await writeFile(collidingPath, Buffer.alloc(0));

    await expect(
      setupRecallEvalSandbox({
        root: sandboxRoot,
        preserve: false,
        corpusSeed: {
          mode: "snapshot_copy",
          snapshotDbPath: collidingPath,
        },
      }),
    ).rejects.toThrow(/must not point at the sandbox database path/);
  });
});

/** Seeds a single-entry source database that can be copied into a sandbox. */
async function seedSnapshotDatabase(dbPath: string, entry: Durable): Promise<void> {
  const database = await createDatabase(dbPath);
  try {
    await database.insertDurable(entry, deterministicVector(entry.id, 1024), contentHashOf(entry.id));
    // Collapse the WAL into the main database file so the snapshot copy
    // sees every seeded row. Without this, libSQL would leave recently
    // written rows in the `-wal` companion file and copyFile would
    // silently miss them.
    await database.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    await database.close();
  }
}

/** Builds an entry payload and returns it as one parameter for inline seeding. */
function seedEntryFixture(id: string, content: string): Durable {
  return buildEntryFixture(id, content);
}

/** Builds a canonical Entry payload for deterministic test fixtures. */
function buildEntryFixture(id: string, content: string): Durable {
  return {
    id,
    type: "fact",
    subject: "pager policy",
    content,
    importance: 6,
    expiry: "permanent",
    tags: [],
    retired: false,
    quality_score: 0.5,
    recall_count: 0,
    created_at: "2026-04-18T00:00:00.000Z",
    updated_at: "2026-04-18T00:00:00.000Z",
  };
}

/** Returns a deterministic normalized vector derived from stable input. */
function deterministicVector(seed: string, dimensions: number): number[] {
  const vector: number[] = [];
  let counter = 0;

  while (vector.length < dimensions) {
    const block = createHash("sha256").update(seed).update(String(counter)).digest();
    for (let offset = 0; offset + 4 <= block.length && vector.length < dimensions; offset += 4) {
      vector.push(block.readInt32LE(offset) / 0x7fffffff);
    }
    counter += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  return magnitude === 0 ? Array.from({ length: dimensions }, (_, index) => (index === 0 ? 1 : 0)) : vector.map((value) => value / magnitude);
}

/** Returns a stable content hash derived from the fixture ID. */
function contentHashOf(id: string): string {
  return createHash("sha256").update(`fixture:${id}`).digest("hex");
}

/** Creates a temp directory and tracks it for afterEach cleanup. */
async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempPaths.push(directory);
  return directory;
}
