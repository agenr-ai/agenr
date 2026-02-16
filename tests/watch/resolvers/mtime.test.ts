import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMtimeResolver } from "../../../src/watch/resolvers/mtime.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-mtime-resolver-test-"));
  tempDirs.push(dir);
  return dir;
}

async function setMtime(filePath: string, isoDate: string): Promise<void> {
  const date = new Date(isoDate);
  await fs.utimes(filePath, date, date);
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("mtime session resolver", () => {
  it("returns the most recently modified matching file", async () => {
    const dir = await makeTempDir();
    const first = path.join(dir, "a.jsonl");
    const second = path.join(dir, "b.jsonl");

    await fs.writeFile(first, "{}\n", "utf8");
    await fs.writeFile(second, "{}\n", "utf8");
    await setMtime(first, "2026-02-01T00:00:00.000Z");
    await setMtime(second, "2026-02-02T00:00:00.000Z");

    const resolver = createMtimeResolver("*.jsonl");
    const active = await resolver.resolveActiveSession(dir);

    expect(active).toBe(path.resolve(second));
  });

  it("supports recursive patterns", async () => {
    const dir = await makeTempDir();
    const nested = path.join(dir, "2026", "02", "16");
    const session = path.join(nested, "session.jsonl");

    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(session, "{}\n", "utf8");

    const resolver = createMtimeResolver("**/*.jsonl", { recursive: true });
    const active = await resolver.resolveActiveSession(dir);

    expect(active).toBe(path.resolve(session));
  });

  it("returns null when no matching files exist", async () => {
    const dir = await makeTempDir();
    const resolver = createMtimeResolver("*.jsonl");

    const active = await resolver.resolveActiveSession(dir);

    expect(active).toBeNull();
  });
});
