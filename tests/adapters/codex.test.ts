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
  it("filters repeated turn_context records and extracts cwd/model from first only", async () => {
    const filePath = await makeTempFile(
      [
        '{"type":"session_meta","timestamp":"2026-02-16T05:18:47.951Z","payload":{"id":"sess-1","cwd":"/repo","model_provider":"openai"}}',
        '{"type":"turn_context","timestamp":"2026-02-16T05:18:48.000Z","payload":{"turn_id":"t1","cwd":"/from-turn-context","model":"gpt-5.3-codex"}}',
        '{"type":"turn_context","timestamp":"2026-02-16T05:18:49.000Z","payload":{"turn_id":"t2","cwd":"/ignored","model":"ignored"}}',
        '{"type":"turn_context","timestamp":"2026-02-16T05:18:50.000Z","payload":{"turn_id":"t3","cwd":"/ignored2","model":"ignored2"}}',
        '{"type":"event_msg","timestamp":"2026-02-16T05:19:00.000Z","payload":{"type":"user_message","message":"hello"}}',
      ].join("\n"),
    );

    const parsed = await codexAdapter.parse(filePath);

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.role).toBe("user");
    expect(parsed.messages[0]?.text).toBe("hello");
    expect(parsed.metadata?.cwd).toBe("/from-turn-context");
    expect(parsed.metadata?.model).toBe("gpt-5.3-codex");
  });

  it("drops encrypted reasoning records", async () => {
    const filePath = await makeTempFile(
      [
        '{"type":"session_meta","timestamp":"2026-02-16T05:18:47.951Z","payload":{"id":"sess-1","cwd":"/repo","model_provider":"openai"}}',
        '{"type":"response_item","timestamp":"2026-02-16T05:18:48.000Z","payload":{"type":"reasoning","summary":[],"content":null,"encrypted_content":"gAAAA..."}}',
        '{"type":"event_msg","timestamp":"2026-02-16T05:19:00.000Z","payload":{"type":"user_message","message":"hello"}}',
      ].join("\n"),
    );

    const parsed = await codexAdapter.parse(filePath);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.text).toBe("hello");
    expect(parsed.messages.some((m) => m.text.includes("gAAAA"))).toBe(false);
  });

  it("drops token_count telemetry", async () => {
    const filePath = await makeTempFile(
      [
        '{"type":"session_meta","timestamp":"2026-02-16T05:18:47.951Z","payload":{"id":"sess-1","cwd":"/repo","model_provider":"openai"}}',
        '{"type":"event_msg","timestamp":"2026-02-16T05:18:48.000Z","payload":{"type":"token_count","info":null}}',
        '{"type":"event_msg","timestamp":"2026-02-16T05:19:00.000Z","payload":{"type":"user_message","message":"hello"}}',
      ].join("\n"),
    );

    const parsed = await codexAdapter.parse(filePath);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.text).toBe("hello");
    expect(parsed.messages.some((m) => m.text.includes("token_count"))).toBe(false);
  });

  it("filters developer role messages (sandbox/permission instructions)", async () => {
    const filePath = await makeTempFile(
      [
        '{"type":"session_meta","timestamp":"2026-02-16T05:18:47.951Z","payload":{"id":"sess-1","cwd":"/repo","model_provider":"openai"}}',
        '{"type":"response_item","timestamp":"2026-02-16T05:18:48.000Z","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>...</permissions instructions>"}]}}',
        '{"type":"event_msg","timestamp":"2026-02-16T05:19:00.000Z","payload":{"type":"agent_message","message":"ok"}}',
      ].join("\n"),
    );

    const parsed = await codexAdapter.parse(filePath);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.role).toBe("assistant");
    expect(parsed.messages[0]?.text).toBe("ok");
  });

  it("keeps session_meta metadata but does not surface base_instructions", async () => {
    const filePath = await makeTempFile(
      [
        '{"type":"session_meta","timestamp":"2026-02-16T05:18:47.951Z","payload":{"id":"sess-1","cwd":"/repo","model_provider":"openai","cli_version":"0.1.0","base_instructions":{"text":"You are Codex..."}}}',
        '{"type":"event_msg","timestamp":"2026-02-16T05:19:00.000Z","payload":{"type":"user_message","message":"hello"}}',
      ].join("\n"),
    );

    const parsed = await codexAdapter.parse(filePath);
    expect(parsed.metadata?.sessionId).toBe("sess-1");
    expect(parsed.metadata?.cwd).toBe("/repo");
    expect(parsed.metadata?.model).toBe("openai");
    expect(parsed.messages.some((m) => m.text.includes("You are Codex"))).toBe(false);
  });

  it("filters function_call_output by size and error signals", async () => {
    const shortOut = "x".repeat(500);
    const longOut = "y".repeat(3000);
    const errorOut = `Error: something failed\n${"z".repeat(1480)}`;

    const filePath = await makeTempFile(
      [
        '{"type":"session_meta","timestamp":"2026-02-16T05:18:47.951Z","payload":{"id":"sess-1","cwd":"/repo","model_provider":"openai"}}',
        '{"type":"response_item","timestamp":"2026-02-16T05:18:48.000Z","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"ls\\"}","call_id":"call_1"}}',
        `{"type":"response_item","timestamp":"2026-02-16T05:18:49.000Z","payload":{"type":"function_call_output","call_id":"call_1","output":"${shortOut}"}}`,
        '{"type":"response_item","timestamp":"2026-02-16T05:18:50.000Z","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"cat big.txt\\"}","call_id":"call_2"}}',
        `{"type":"response_item","timestamp":"2026-02-16T05:18:51.000Z","payload":{"type":"function_call_output","call_id":"call_2","output":"${longOut}"}}`,
        '{"type":"response_item","timestamp":"2026-02-16T05:18:52.000Z","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"cat err.txt\\"}","call_id":"call_3"}}',
        `{"type":"response_item","timestamp":"2026-02-16T05:18:53.000Z","payload":{"type":"function_call_output","call_id":"call_3","output":"${errorOut.replace(/\n/g, "\\\\n")}"}}`,
      ].join("\n"),
    );

    const parsed = await codexAdapter.parse(filePath);
    const texts = parsed.messages.map((m) => m.text);

    expect(texts.some((t) => t.includes(shortOut))).toBe(true);
    expect(texts.some((t) => t.includes("[function output from exec_command: cat big.txt - filtered (3000 chars)]"))).toBe(true);
    expect(texts.some((t) => t.includes("Error: something failed"))).toBe(true);
  });

  it("keeps apply_patch diffs (custom_tool_call) and custom_tool_call_output", async () => {
    const patch = "*** Begin Patch\n*** Add File: x.txt\n+hello\n*** End Patch\n";
    const filePath = await makeTempFile(
      [
        '{"type":"session_meta","timestamp":"2026-02-16T05:18:47.951Z","payload":{"id":"sess-1","cwd":"/repo","model_provider":"openai"}}',
        `{"type":"response_item","timestamp":"2026-02-16T05:18:48.000Z","payload":{"type":"custom_tool_call","status":"completed","call_id":"call_p","name":"apply_patch","input":"${patch.replace(/\n/g, "\\\\n")}"}}`,
        '{"type":"response_item","timestamp":"2026-02-16T05:18:49.000Z","payload":{"type":"custom_tool_call_output","call_id":"call_p","output":"{\\"output\\":\\"Success\\"}"}}',
      ].join("\n"),
    );

    const parsed = await codexAdapter.parse(filePath);
    const texts = parsed.messages.map((m) => m.text);
    expect(texts.some((t) => t.includes("*** Begin Patch"))).toBe(true);
    expect(texts.some((t) => t.includes("Success"))).toBe(true);
  });

  it("keeps user_message and agent_message (agent truncated to 8000 chars)", async () => {
    const longAgent = "a".repeat(9000);
    const filePath = await makeTempFile(
      [
        '{"type":"session_meta","timestamp":"2026-02-16T05:18:47.951Z","payload":{"id":"sess-1","cwd":"/repo","model_provider":"openai"}}',
        '{"type":"event_msg","timestamp":"2026-02-16T05:19:00.000Z","payload":{"type":"user_message","message":"hello"}}',
        `{"type":"event_msg","timestamp":"2026-02-16T05:19:01.000Z","payload":{"type":"agent_message","message":"${longAgent}"}}`,
      ].join("\n"),
    );

    const parsed = await codexAdapter.parse(filePath);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]?.role).toBe("user");
    expect(parsed.messages[1]?.role).toBe("assistant");
    expect(parsed.messages[0]?.text).toBe("hello");
    expect(parsed.messages[1]?.text.startsWith("a".repeat(8000))).toBe(true);
    expect(parsed.messages[1]?.text.includes("[...truncated]")).toBe(true);
  });

  it("--raw bypasses filtering and preserves token_count/reasoning and full function_call args", async () => {
    const longArgs = `{"cmd":"echo ${"b".repeat(300)}"}`;
    const escapedLongArgs = JSON.stringify(longArgs).slice(1, -1);
    const filePath = await makeTempFile(
      [
        '{"type":"session_meta","timestamp":"2026-02-16T05:18:47.951Z","payload":{"id":"sess-1","cwd":"/repo","model_provider":"openai"}}',
        '{"type":"turn_context","timestamp":"2026-02-16T05:18:48.000Z","payload":{"turn_id":"t1","cwd":"/from-turn-context","model":"gpt-5.3-codex"}}',
        '{"type":"event_msg","timestamp":"2026-02-16T05:18:48.100Z","payload":{"type":"token_count","info":null}}',
        '{"type":"response_item","timestamp":"2026-02-16T05:18:48.200Z","payload":{"type":"reasoning","summary":[],"content":null,"encrypted_content":"gAAAA..."}}',
        `{"type":"response_item","timestamp":"2026-02-16T05:18:48.300Z","payload":{"type":"function_call","name":"exec_command","arguments":"${escapedLongArgs}","call_id":"call_1"}}`,
      ].join("\n"),
    );

    const parsed = await codexAdapter.parse(filePath, { raw: true });
    const texts = parsed.messages.map((m) => m.text);

    expect(texts.some((t) => t.includes("token_count"))).toBe(true);
    expect(texts.some((t) => t.includes("encrypted_content"))).toBe(true);
    expect(texts.some((t) => t.includes(longArgs))).toBe(true);
    expect(texts.some((t) => t.includes("[...truncated]"))).toBe(false);
  });
});
