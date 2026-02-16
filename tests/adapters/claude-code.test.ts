import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../../src/adapters/claude-code.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

async function makeTempFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-claude-adapter-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "session.jsonl");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

describe("claude-code adapter", () => {
  it("skips file-history-snapshot records and parses user/assistant messages", async () => {
    const filePath = await makeTempFile(
      [
        '{"type":"user","timestamp":"2026-01-25T18:50:15.457Z","message":{"role":"user","content":"hello"},"uuid":"u1","sessionId":"s1","cwd":"/repo"}',
        '{"type":"file-history-snapshot","timestamp":"2026-01-25T18:50:15.458Z","uuid":"u2"}',
        '{"type":"assistant","timestamp":"2026-01-25T18:50:15.519Z","message":{"role":"assistant","content":"world"},"uuid":"u3"}',
      ].join("\n"),
    );

    const parsed = await claudeCodeAdapter.parse(filePath);

    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(parsed.messages[0]?.timestamp).toBe("2026-01-25T18:50:15.457Z");
    expect(parsed.messages[1]?.timestamp).toBe("2026-01-25T18:50:15.519Z");
    expect(parsed.metadata?.sessionId).toBe("s1");
    expect(parsed.metadata?.cwd).toBe("/repo");
  });
});
