import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { backupDatabaseFile } from "../../../src/app/dreaming/service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("backupDatabaseFile", () => {
  it("backs up file URL database paths and sidecar files", async () => {
    const directory = await createTempDir();
    const dbPath = path.join(directory, "knowledge.db");
    await writeFile(dbPath, "main database", "utf8");
    await writeFile(`${dbPath}-wal`, "wal data", "utf8");

    const backupPath = await backupDatabaseFile(pathToFileURL(dbPath).href);

    expect(path.dirname(backupPath)).toBe(path.join(directory, "backups"));
    await expect(readFile(backupPath, "utf8")).resolves.toBe("main database");
    await expect(readFile(`${backupPath}-wal`, "utf8")).resolves.toBe("wal data");
  });
});

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-dream-service-"));
  tempDirs.push(directory);
  return directory;
}
