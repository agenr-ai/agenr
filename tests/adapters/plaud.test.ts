import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { plaudAdapter } from "../../src/adapters/plaud.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

async function makeTempFile(fileName: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-plaud-adapter-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, "# Meeting\n", "utf8");
  return filePath;
}

describe("plaud adapter", () => {
  it("extracts timestamp from Plaud filename pattern", async () => {
    const filePath = await makeTempFile("2026-02-06 1108 - Marty Review - Summary.md");
    const parsed = await plaudAdapter.parse(filePath);

    expect(parsed.messages).toEqual([]);
    expect(parsed.metadata?.platform).toBe("plaud");
    expect(parsed.metadata?.startedAt).toBe(new Date("2026-02-06T11:08:00").toISOString());
  });
});
