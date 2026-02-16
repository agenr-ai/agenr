import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeSessionResolver } from "../../../src/watch/resolvers/claude-code.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-claude-resolver-test-"));
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

describe("claude-code session resolver", () => {
  it("ignores subagents paths when selecting latest session", async () => {
    const dir = await makeTempDir();
    const mainSession = path.join(dir, "main.jsonl");
    const subagentSession = path.join(dir, "subagents", "worker", "worker.jsonl");

    await fs.mkdir(path.dirname(subagentSession), { recursive: true });
    await fs.writeFile(mainSession, "{}\n", "utf8");
    await fs.writeFile(subagentSession, "{}\n", "utf8");

    await setMtime(mainSession, "2026-02-05T00:00:00.000Z");
    await setMtime(subagentSession, "2026-02-10T00:00:00.000Z");

    const active = await claudeCodeSessionResolver.resolveActiveSession(dir);

    expect(active).toBe(path.resolve(mainSession));
  });

  it("returns null when no root-level main sessions exist", async () => {
    const dir = await makeTempDir();
    const subagentSession = path.join(dir, "subagents", "worker", "worker.jsonl");

    await fs.mkdir(path.dirname(subagentSession), { recursive: true });
    await fs.writeFile(subagentSession, "{}\n", "utf8");

    const active = await claudeCodeSessionResolver.resolveActiveSession(dir);

    expect(active).toBeNull();
  });
});
