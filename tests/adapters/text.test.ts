import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { textAdapter } from "../../src/adapters/text.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

async function makeTempFile(name: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-text-adapter-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

describe("text adapter", () => {
  it("falls back to file mtime timestamp for plain text", async () => {
    const filePath = await makeTempFile("note.txt", "plain text\n");
    const mtime = new Date("2026-02-01T10:15:30.000Z");
    await fs.utimes(filePath, mtime, mtime);

    const parsed = await textAdapter.parse(filePath);

    expect(parsed.messages).toEqual([]);
    expect(parsed.metadata?.platform).toBe("text");
    expect(parsed.metadata?.startedAt).toBe("2026-02-01T10:15:30.000Z");
  });

  it("detects JSONL content in .txt and delegates to JSONL adapter", async () => {
    const filePath = await makeTempFile(
      "session.txt",
      '{"role":"user","content":"hello from jsonl-in-txt","timestamp":"2026-02-16T05:20:01.123Z"}\n',
    );

    const parsed = await textAdapter.parse(filePath);

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.role).toBe("user");
    expect(parsed.messages[0]?.text).toContain("jsonl-in-txt");
    expect(parsed.messages[0]?.timestamp).toBe("2026-02-16T05:20:01.123Z");
    expect(parsed.metadata?.platform).toBe("jsonl-generic");
  });
});
