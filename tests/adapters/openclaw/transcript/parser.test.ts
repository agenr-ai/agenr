import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OpenClawTranscriptParser } from "../../../../src/adapters/openclaw/transcript/parser.js";

const parser = new OpenClawTranscriptParser();
const tempDirectories: string[] = [];

async function writeSessionFile(lines: string[], options?: { mtime?: Date }): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agenr-openclaw-parser-"));
  tempDirectories.push(directory);

  const filePath = path.join(directory, "session.jsonl");
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

  if (options?.mtime) {
    await utimes(filePath, options.mtime, options.mtime);
  }

  return filePath;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("OpenClawTranscriptParser", () => {
  it("parses a minimal valid OpenClaw session", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-1",
        timestamp: "2026-03-01T10:00:00.000Z",
        model: "gpt-4.1",
        conversation_label: "Sprint Review",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-01T10:01:00.000Z",
        message: {
          role: "human",
          content: " Hello   team ",
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-01T10:02:00.000Z",
        message: {
          role: "assistant",
          model: "gpt-4.1",
          content: "Hi there.",
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.metadata).toEqual({
      sessionId: "session-1",
      sessionLabel: "sprint-review",
      startedAt: "2026-03-01T10:00:00.000Z",
      modelsUsed: ["gpt-4.1"],
    });
    expect(transcript.messages).toEqual([
      {
        index: 0,
        role: "user",
        text: "Hello team",
        timestamp: "2026-03-01T10:01:00.000Z",
      },
      {
        index: 1,
        role: "assistant",
        text: "Hi there.",
        timestamp: "2026-03-01T10:02:00.000Z",
      },
    ]);
    expect(transcript.warnings).toEqual([]);
  });

  it("normalizes roles, summarizes tool calls, and drops system messages", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-2",
        timestamp: "2026-03-02T09:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-02T09:00:30.000Z",
        message: {
          role: "system",
          content: "internal",
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-02T09:01:00.000Z",
        message: {
          role: "human",
          content: "Open src/parser.ts",
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-02T09:01:30.000Z",
        message: {
          role: "developer",
          content: [
            { type: "output_text", content: "Looking now." },
            { type: "tool_call", name: "Read", arguments: { path: "src/parser.ts" }, id: "call-read-1" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-02T09:02:00.000Z",
        message: {
          role: "tool_result",
          tool_call_id: "call-read-1",
          content: "export const parser = true;",
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.messages).toEqual([
      {
        index: 0,
        role: "user",
        text: "Open src/parser.ts",
        timestamp: "2026-03-02T09:01:00.000Z",
      },
      {
        index: 1,
        role: "assistant",
        text: "Looking now. [called Read: src/parser.ts]",
        timestamp: "2026-03-02T09:01:30.000Z",
      },
      {
        index: 2,
        role: "assistant",
        text: "[tool result from Read: src/parser.ts - filtered]",
        timestamp: "2026-03-02T09:02:00.000Z",
      },
    ]);
  });

  it("drops agenr_recall tool results while preserving a summary placeholder", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-3",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "output_text", content: "Checking memory." },
            { type: "tool_call", name: "agenr_recall", arguments: { query: "branch strategy" }, id: "call-recall-1" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "tool",
          tool_call_id: "call-recall-1",
          content: "Existing memory entries that must not leak into extraction.",
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.messages).toHaveLength(2);
    expect(transcript.messages[0]?.text).toContain('[recalled from brain: "branch strategy"]');
    expect(transcript.messages[1]?.text).toBe('[tool result from agenr_recall: "branch strategy" - filtered]');
    expect(transcript.messages[1]?.text).not.toContain("Existing memory entries");
  });

  it("filters pure base64 content", async () => {
    const base64Blob = "A/".repeat(300);
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-4",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: base64Blob,
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: "Kept text",
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath, { verbose: true });

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]?.role).toBe("assistant");
    expect(transcript.messages[0]?.text).toBe("Kept text");
    expect(transcript.messages[0]?.timestamp).toMatch(/^202\d-/);
    expect(transcript.warnings.at(-1)).toContain("1 base64 dropped");
  });

  it("omits the misleading kept-message count from verbose filter warnings", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-4b",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "tool_call", name: "Read", arguments: { path: "src/parser.ts" }, id: "call-read-1" }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "tool_result",
          tool_call_id: "call-read-1",
          content: "export const parser = true;",
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath, { verbose: true });
    const filterWarning = transcript.warnings.find((warning) => warning.startsWith("Filtered transcript:"));

    expect(filterWarning).toBeDefined();
    expect(filterWarning).toContain("1 tool results dropped");
    expect(filterWarning).not.toContain("messages kept");
  });

  it("extracts session metadata from session and user message records", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-5",
        timestamp: "2026-03-05T12:00:00.000Z",
        model: "gpt-4.1",
      }),
      JSON.stringify({
        type: "model_change",
        modelId: "gpt-4.1-mini",
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-03-05T12:01:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              content: '```json\n{"conversation_label":"Roadmap Sync"}\n```',
            },
            {
              type: "text",
              content: "What changed?",
            },
          ],
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.metadata).toEqual({
      sessionId: "session-5",
      sessionLabel: "roadmap-sync",
      startedAt: "2026-03-05T12:00:00.000Z",
      modelsUsed: ["gpt-4.1", "gpt-4.1-mini"],
    });
  });

  it("falls back to file mtime when record timestamps are missing", async () => {
    const mtime = new Date("2026-03-06T08:30:00.000Z");
    const filePath = await writeSessionFile(
      [
        JSON.stringify({
          type: "session",
          id: "session-6",
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: "No timestamps here",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: "Still parse it",
          },
        }),
      ],
      { mtime },
    );

    const transcript = await parser.parseFile(filePath);

    expect(transcript.metadata.startedAt).toBe("2026-03-06T08:30:00.000Z");
    expect(transcript.messages.map((message) => message.timestamp)).toEqual(["2026-03-06T08:30:00.000Z", "2026-03-06T08:30:00.000Z"]);
  });

  it("handles malformed JSONL lines without crashing", async () => {
    const filePath = await writeSessionFile([
      JSON.stringify({
        type: "session",
        id: "session-7",
      }),
      "{not valid json",
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: "Still works",
        },
      }),
    ]);

    const transcript = await parser.parseFile(filePath);

    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]?.text).toBe("Still works");
    expect(transcript.warnings).toContain("Skipped malformed JSONL line 2");
  });
});
