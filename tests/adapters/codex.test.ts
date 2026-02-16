import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../../src/adapters/codex.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

async function makeTempFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-codex-adapter-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "session.jsonl");
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

describe("codex adapter", () => {
  it("maps developer role to assistant and extracts metadata", async () => {
    const filePath = await makeTempFile(
      [
        '{"type":"session_meta","timestamp":"2026-02-16T05:18:47.951Z","payload":{"id":"sess-1","cwd":"/repo","model_provider":"openai"}}',
        '{"type":"response_item","timestamp":"2026-02-16T05:18:47.951Z","payload":{"type":"message","role":"developer","content":"system guidance"}}',
        '{"type":"response_item","timestamp":"2026-02-16T05:20:01.123Z","payload":{"type":"message","role":"user","content":"hello"}}',
      ].join("\n"),
    );

    const parsed = await codexAdapter.parse(filePath);

    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages.map((message) => message.role)).toEqual(["assistant", "user"]);
    expect(parsed.messages[0]?.timestamp).toBe("2026-02-16T05:18:47.951Z");
    expect(parsed.metadata?.sessionId).toBe("sess-1");
    expect(parsed.metadata?.cwd).toBe("/repo");
    expect(parsed.metadata?.model).toBe("openai");
  });
});
