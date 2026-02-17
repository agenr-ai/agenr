import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openClawAdapter } from "../../src/adapters/openclaw.js";

async function writeTempJsonl(lines: string[]): Promise<{ file: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-test-"));
  const file = path.join(dir, `${randomUUID()}.jsonl`);
  await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return { file, dir };
}

async function cleanupTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe("openclaw adapter", () => {
  it("extracts messages and timestamps from OpenClaw JSONL", async () => {
    const fixture = path.resolve("tests/fixtures/sample-transcript.jsonl");
    const parsed = await openClawAdapter.parse(fixture);

    expect(parsed.messages).toHaveLength(4);
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    expect(parsed.messages[0]?.timestamp).toBe("2026-02-14T00:00:01.000Z");
    expect(parsed.messages[2]?.timestamp).toBe("2026-02-14T00:00:03.000Z");
    expect(parsed.messages[3]?.timestamp).toBe("2026-02-14T00:00:04.000Z");
    expect(parsed.metadata?.platform).toBe("openclaw");
    expect(parsed.metadata?.startedAt).toBe("2026-02-14T00:00:00.000Z");
    expect(parsed.warnings.some((warning) => warning.includes("Skipped malformed JSONL line"))).toBe(true);
  });

  it("filters toolResult messages by tool name and size (per-tool rules win)", async () => {
    const session = `{"type":"session","id":"sess-1","timestamp":"2026-02-14T00:00:00.000Z","cwd":"/tmp"}`;

    // Read is always dropped even if small (<500 chars).
    const readSmall = "x".repeat(300);
    const readLarge = "y".repeat(5000);
    const execOk = "ok\n".repeat(200); // < 1000 chars
    const execBig = "z".repeat(1500);
    const execErrorBig = `Error: something failed\n${"w".repeat(1400)}`;
    const unknownSmall = "u".repeat(400);
    const unknownMid = "v".repeat(600);

    const { file, dir } = await writeTempJsonl([
      session,
      `{"type":"message","timestamp":"2026-02-14T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"Read","arguments":{"file_path":"/tmp/a.txt"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:02.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"${readSmall}"}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:03.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"Read","arguments":{"file_path":"/tmp/b.txt"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:04.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"${readLarge}"}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:05.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"web_search","arguments":{"query":"cats"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:06.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"result 1\\nresult 2"}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:07.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"web_fetch","arguments":{"url":"https://example.com"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:08.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"${"f".repeat(800)}"}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:09.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"exec","arguments":{"command":"ls"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:10.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"${execOk.replace(/\n/g, "\\\\n")}"}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:11.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"exec","arguments":{"command":"echo ${"a".repeat(120)}"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:12.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"${execBig}"}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:13.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"exec","arguments":{"command":"cat /tmp/log"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:14.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"${execErrorBig.replace(/\n/g, "\\\\n")}"}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:15.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"mystery_tool","arguments":{"note":"hello"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:16.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"${unknownSmall}"}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:17.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"mystery_tool","arguments":{"note":"world"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:18.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"${unknownMid}"}]}}`,
    ]);

    try {
      const parsed = await openClawAdapter.parse(file);
      const texts = parsed.messages.map((m) => m.text);

      // Read tool results: always filtered, placeholder includes file_path.
      expect(texts.some((t) => t.includes("[tool result from Read: /tmp/a.txt - filtered]"))).toBe(true);
      expect(texts.some((t) => t.includes("[tool result from Read: /tmp/b.txt - filtered]"))).toBe(true);

      // web_search: kept.
      expect(texts.some((t) => t.includes("result 1"))).toBe(true);

      // web_fetch: always filtered, placeholder includes url.
      expect(texts.some((t) => t.includes("[tool result from web_fetch: https://example.com - filtered]"))).toBe(true);

      // exec: short output kept.
      expect(texts.some((t) => t.includes("ok"))).toBe(true);

      // exec: big output without errors filtered (placeholder includes truncated command).
      const expectedCmdPrefix = `echo ${"a".repeat(120)}`.slice(0, 100);
      expect(texts.some((t) => t.includes(`[tool result from exec: ${expectedCmdPrefix} - filtered]`))).toBe(true);

      // exec: big output with Error kept.
      expect(texts.some((t) => t.includes("Error: something failed"))).toBe(true);

      // Unknown tool: small kept; mid filtered, placeholder includes first string arg value.
      expect(texts.some((t) => t.includes(unknownSmall))).toBe(true);
      expect(texts.some((t) => t.includes("[tool result from mystery_tool: world - filtered]"))).toBe(true);
    } finally {
      await cleanupTempDir(dir);
    }
  });

  it("reconstructs assistant tool_use blocks into compact summaries", async () => {
    const session = `{"type":"session","id":"sess-1","timestamp":"2026-02-14T00:00:00.000Z","cwd":"/tmp"}`;
    const { file, dir } = await writeTempJsonl([
      session,
      `{"type":"message","timestamp":"2026-02-14T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"Write","arguments":{"file_path":"/path/to/file","content":"${"a".repeat(5000)}"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"Edit","arguments":{"file_path":"/path/to/file","oldText":"${"b".repeat(200)}","newText":"x"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:03.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"exec","arguments":{"command":"ls -la /tmp"}}]}}`,
    ]);

    try {
      const parsed = await openClawAdapter.parse(file);
      expect(parsed.messages.map((m) => m.text)).toEqual([
        "[called Write: /path/to/file - 5000 chars]",
        "[called Edit: /path/to/file - replaced 200 chars]",
        "[called exec: ls -la /tmp]",
      ]);
    } finally {
      await cleanupTempDir(dir);
    }
  });

  it("enforces truncation thresholds (assistant=5000, kept toolResult=2000, user=never)", async () => {
    const session = `{"type":"session","id":"sess-1","timestamp":"2026-02-14T00:00:00.000Z","cwd":"/tmp"}`;
    const assistantLong = "a".repeat(6000);
    const toolLong = "b".repeat(3000);
    const userLong = "c".repeat(3000);

    const { file, dir } = await writeTempJsonl([
      session,
      `{"type":"message","timestamp":"2026-02-14T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"${assistantLong}"}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"web_search","arguments":{"query":"dogs"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:03.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"${toolLong}"}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:04.000Z","message":{"role":"user","content":"${userLong}"}}`,
    ]);

    try {
      const parsed = await openClawAdapter.parse(file);
      const assistantMsg = parsed.messages.find((m) => m.role === "assistant" && m.text.startsWith("a".repeat(5000)));
      const toolMsg = parsed.messages.find((m) => m.role === "assistant" && m.text.startsWith("b".repeat(2000)));
      const userMsg = parsed.messages.find((m) => m.role === "user");

      expect(assistantMsg?.text.includes("[...truncated]")).toBe(true);

      expect(toolMsg?.text.includes("[...truncated]")).toBe(true);

      expect(userMsg?.text.length).toBe(3000);
    } finally {
      await cleanupTempDir(dir);
    }
  });

  it("drops messages that are entirely base64 (but keeps mixed text)", async () => {
    const session = `{"type":"session","id":"sess-1","timestamp":"2026-02-14T00:00:00.000Z","cwd":"/tmp"}`;
    const pureBase64 = `${"QUFBQUFBQUFBQUFBQUFB".repeat(40)}==`; // > 500 chars, contains '='

    const { file: file1, dir: dir1 } = await writeTempJsonl([
      session,
      `{"type":"message","timestamp":"2026-02-14T00:00:01.000Z","message":{"role":"assistant","content":"${pureBase64}"}}`,
    ]);

    const { file: file2, dir: dir2 } = await writeTempJsonl([
      session,
      `{"type":"message","timestamp":"2026-02-14T00:00:01.000Z","message":{"role":"assistant","content":"Here is base64: ${pureBase64}"}}`,
    ]);

    try {
      const parsed1 = await openClawAdapter.parse(file1);
      expect(parsed1.messages).toHaveLength(0);

      const parsed2 = await openClawAdapter.parse(file2);
      expect(parsed2.messages).toHaveLength(1);
      expect(parsed2.messages[0]?.text.includes("Here is base64:")).toBe(true);
    } finally {
      await cleanupTempDir(dir1);
      await cleanupTempDir(dir2);
    }
  });

  it("--raw bypasses filtering and preserves full toolResult output", async () => {
    const session = `{"type":"session","id":"sess-1","timestamp":"2026-02-14T00:00:00.000Z","cwd":"/tmp"}`;
    const toolOut = "x".repeat(5000);
    const { file, dir } = await writeTempJsonl([
      session,
      `{"type":"message","timestamp":"2026-02-14T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"Read","arguments":{"file_path":"/tmp/a.txt"}}]}}`,
      `{"type":"message","timestamp":"2026-02-14T00:00:02.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"${toolOut}"}]}}`,
    ]);

    try {
      const parsed = await openClawAdapter.parse(file, { raw: true });
      expect(parsed.messages).toHaveLength(2);
      expect(parsed.messages[1]?.text.length).toBe(5000);
      expect(parsed.messages[1]?.text.includes("[tool result from")).toBe(false);
    } finally {
      await cleanupTempDir(dir);
    }
  });
});
