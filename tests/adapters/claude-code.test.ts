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
  it("filters progress/system/file-history-snapshot records and parses user/assistant messages", async () => {
    const filePath = await makeTempFile(
      [
        '{"type":"user","timestamp":"2026-01-25T18:50:15.457Z","message":{"role":"user","content":"hello"},"uuid":"u1","sessionId":"s1","cwd":"/repo"}',
        '{"type":"progress","timestamp":"2026-01-25T18:50:15.458Z","uuid":"u2","message":{"role":"assistant","content":"tool started"}}',
        '{"type":"system","timestamp":"2026-01-25T18:50:15.459Z","uuid":"u3","message":{"role":"assistant","content":"turn_duration=123"}}',
        '{"type":"file-history-snapshot","timestamp":"2026-01-25T18:50:15.460Z","uuid":"u4"}',
        '{"type":"assistant","timestamp":"2026-01-25T18:50:15.519Z","message":{"role":"assistant","content":"world"},"uuid":"u5"}',
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

  it("filters thinking blocks but keeps text blocks", async () => {
    const filePath = await makeTempFile(
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-02-01T00:00:00.000Z",
          uuid: "a1",
          sessionId: "s1",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", text: "draft reasoning" },
              { type: "text", text: "final answer" },
            ],
          },
        }),
      ].join("\n"),
    );

    const parsed = await claudeCodeAdapter.parse(filePath);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.text).toContain("final answer");
    expect(parsed.messages[0]?.text).not.toContain("draft reasoning");
  });

  it("filters base64 images nested inside tool_result content but keeps tool_result text", async () => {
    const base64 = "A".repeat(1500);
    const filePath = await makeTempFile(
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-02-01T00:00:00.000Z",
          uuid: "a1",
          sessionId: "s1",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "exec", input: { cmd: "echo hi" } }],
          },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-02-01T00:00:01.000Z",
          uuid: "u1",
          sessionId: "s1",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [
                  { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
                  { type: "text", text: "stdout: hi" },
                ],
              },
            ],
          },
        }),
      ].join("\n"),
    );

    const parsed = await claudeCodeAdapter.parse(filePath);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[1]?.text).toContain("stdout: hi");
    expect(parsed.messages[1]?.text).not.toContain(base64);
  });

  it("applies 2.9-style tool_result filtering rules (drop Read, keep web_search)", async () => {
    const filePath = await makeTempFile(
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-02-01T00:00:00.000Z",
          uuid: "a1",
          sessionId: "s1",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/tmp/a.txt" } },
              { type: "tool_use", id: "toolu_search", name: "web_search", input: { query: "agenr" } },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-02-01T00:00:01.000Z",
          uuid: "u1",
          sessionId: "s1",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_read", content: [{ type: "text", text: "A".repeat(5000) }] },
              { type: "tool_result", tool_use_id: "toolu_search", content: [{ type: "text", text: "Result 1: ..." }] },
            ],
          },
        }),
      ].join("\n"),
    );

    const parsed = await claudeCodeAdapter.parse(filePath);
    expect(parsed.messages).toHaveLength(2);
    const userText = parsed.messages[1]?.text ?? "";
    expect(userText).toContain("[tool result from Read:");
    expect(userText).toContain("Result 1:");
  });

  it("keeps tool_result text for tools named image (filters only nested image blocks)", async () => {
    const filePath = await makeTempFile(
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-02-01T00:00:00.000Z",
          uuid: "a1",
          sessionId: "s1",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_img", name: "image", input: { url: "https://example.com/x.png" } }],
          },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-02-01T00:00:01.000Z",
          uuid: "u1",
          sessionId: "s1",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_img", content: [{ type: "text", text: "It looks like a cat." }] }],
          },
        }),
      ].join("\n"),
    );

    const parsed = await claudeCodeAdapter.parse(filePath);
    expect(parsed.messages).toHaveLength(2);
    const userText = parsed.messages[1]?.text ?? "";
    expect(userText).toContain("It looks like a cat.");
    expect(userText).not.toContain("[tool result from image:");
  });

  it("deduplicates streaming messages by uuid (keeps last occurrence)", async () => {
    const filePath = await makeTempFile(
      [
        '{"type":"assistant","timestamp":"2026-02-01T00:00:00.000Z","message":{"role":"assistant","content":"first"},"uuid":"dup","sessionId":"s1"}',
        '{"type":"assistant","timestamp":"2026-02-01T00:00:01.000Z","message":{"role":"assistant","content":"second"},"uuid":"dup","sessionId":"s1"}',
      ].join("\n"),
    );

    const parsed = await claudeCodeAdapter.parse(filePath);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.text).toContain("second");
    expect(parsed.messages[0]?.text).not.toContain("first");
  });

  it("does not leak metadata envelope fields into message text", async () => {
    const filePath = await makeTempFile(
      [
        '{"type":"assistant","timestamp":"2026-02-01T00:00:00.000Z","message":{"role":"assistant","content":[{\"type\":\"text\",\"text\":\"hello\"}]},"uuid":"a1","parentUuid":"p1","version":"1","permissionMode":"default","requestId":"r1","toolUseID":"t1"}',
      ].join("\n"),
    );

    const parsed = await claudeCodeAdapter.parse(filePath);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.text).toContain("hello");
    expect(parsed.messages[0]?.text).not.toContain("parentUuid");
    expect(parsed.messages[0]?.text).not.toContain("permissionMode");
    expect(parsed.messages[0]?.text).not.toContain("requestId");
  });

  it("includes sidechain messages and prepends a sidechain hint", async () => {
    const filePath = await makeTempFile(
      [
        '{"type":"assistant","timestamp":"2026-02-01T00:00:00.000Z","message":{"role":"assistant","content":[{\"type\":\"text\",\"text\":\"alternate path\"}]},"uuid":"a1","sessionId":"s1","isSidechain":true,"parentUuid":"p1"}',
      ].join("\n"),
    );

    const parsed = await claudeCodeAdapter.parse(filePath);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.text).toContain("[sidechain]");
    expect(parsed.messages[0]?.text).toContain("alternate path");
  });
});
