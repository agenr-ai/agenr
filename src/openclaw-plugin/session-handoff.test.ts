import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as llmClientModule from "../llm/client.js";
import type { StreamSimpleFn } from "../llm/stream.js";
import { __testing } from "./index.js";
import type { PluginLogger } from "./types.js";

const tmpDirs: string[] = [];

function makeLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function writeJsonlLines(filePath: string, lines: string[]): Promise<void> {
  const payload = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  await fs.writeFile(filePath, payload, "utf8");
}

function makeEventMessages(count: number, prefix: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index += 1) {
    const minute = String(index % 60).padStart(2, "0");
    messages.push({
      role: "user",
      content: `${prefix}-${index + 1}`,
      timestamp: `2026-02-24T10:${minute}:00`,
    });
  }
  return messages;
}

function makeAssistantMessage(text: string, stopReason = "endTurn"): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stopReason,
  } as unknown as AssistantMessage;
}

function makeAssistantStream(message: AssistantMessage): AsyncIterable<AssistantMessageEvent> & {
  result: () => Promise<AssistantMessage>;
} {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
      return;
    },
    result: async () => message,
  };
}

function makeStreamSimple(params: {
  message?: AssistantMessage;
  onContext?: (context: Context, options?: SimpleStreamOptions) => void;
  shouldThrow?: boolean;
}): StreamSimpleFn {
  return ((_: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    params.onContext?.(context, options);
    if (params.shouldThrow) {
      throw new Error("stream boom");
    }
    return makeAssistantStream(params.message ?? makeAssistantMessage("summary"));
  }) as StreamSimpleFn;
}

function mockLlmClientSuccess(): void {
  vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue({
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId: "gpt-4.1-nano",
      model: {} as Model<Api>,
    },
    credentials: {
      apiKey: "test-api-key",
      source: "env:OPENAI_API_KEY",
    },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("readSessionsJson", () => {
  it("returns {} when file does not exist", async () => {
    const dir = await makeTempDir("agenr-handoff-sessions-json-");
    expect(__testing.readSessionsJson(dir)).toEqual({});
  });

  it("returns parsed object when file is valid JSON", async () => {
    const dir = await makeTempDir("agenr-handoff-sessions-json-");
    await fs.writeFile(
      path.join(dir, "sessions.json"),
      JSON.stringify({ "agent:main:main": { sessionFile: "/tmp/a.jsonl" } }),
      "utf8",
    );

    expect(__testing.readSessionsJson(dir)).toEqual({
      "agent:main:main": { sessionFile: "/tmp/a.jsonl" },
    });
  });

  it("returns {} when file contains invalid JSON", async () => {
    const dir = await makeTempDir("agenr-handoff-sessions-json-");
    await fs.writeFile(path.join(dir, "sessions.json"), "{invalid", "utf8");

    expect(__testing.readSessionsJson(dir)).toEqual({});
  });
});

describe("getSurfaceForSessionFile", () => {
  it("returns origin.surface when matched by sessionFile path in sessions.json", () => {
    const target = path.join(os.tmpdir(), "session-a.jsonl");
    const sessionsJson = {
      "agent:main:main": {
        sessionFile: target,
        origin: { surface: "webchat" },
      },
    } as Record<string, unknown>;

    expect(__testing.getSurfaceForSessionFile(target, sessionsJson)).toBe("webchat");
  });

  it("returns deliveryContext.channel as fallback when origin.surface absent", () => {
    const target = path.join(os.tmpdir(), "session-b.jsonl");
    const sessionsJson = {
      "agent:main:tui": {
        sessionFile: target,
        deliveryContext: { channel: "telegram" },
      },
    } as Record<string, unknown>;

    expect(__testing.getSurfaceForSessionFile(target, sessionsJson)).toBe("telegram");
  });

  it('returns "unknown" when no entry matches the file path', () => {
    const target = path.join(os.tmpdir(), "session-c.jsonl");
    const sessionsJson = {
      "agent:main:main": {
        sessionFile: path.join(os.tmpdir(), "different-session.jsonl"),
        origin: { surface: "webchat" },
      },
    } as Record<string, unknown>;

    expect(__testing.getSurfaceForSessionFile(target, sessionsJson)).toBe("unknown");
  });

  it('returns "unknown" on malformed sessionsJson input', () => {
    expect(
      __testing.getSurfaceForSessionFile(
        path.join(os.tmpdir(), "session-d.jsonl"),
        null as unknown as Record<string, unknown>,
      ),
    ).toBe("unknown");
  });
});

describe("readMessagesFromJsonl", () => {
  it("returns [] when file does not exist", async () => {
    const dir = await makeTempDir("agenr-handoff-jsonl-");
    const file = path.join(dir, "missing.jsonl");
    await expect(__testing.readMessagesFromJsonl(file)).resolves.toEqual([]);
  });

  it("skips non-message type lines", async () => {
    const dir = await makeTempDir("agenr-handoff-jsonl-");
    const file = path.join(dir, "session.jsonl");
    await writeJsonlLines(file, [
      JSON.stringify({ type: "metadata", timestamp: "2026-02-24T10:00:00Z" }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-02-24T10:01:00Z",
        message: { role: "user", content: "kept" },
      }),
    ]);

    await expect(__testing.readMessagesFromJsonl(file)).resolves.toEqual([
      { role: "user", content: "kept", timestamp: "2026-02-24T10:01:00Z" },
    ]);
  });

  it("skips lines that fail JSON.parse", async () => {
    const dir = await makeTempDir("agenr-handoff-jsonl-");
    const file = path.join(dir, "session.jsonl");
    await writeJsonlLines(file, [
      "{not-json",
      JSON.stringify({
        type: "message",
        timestamp: "2026-02-24T10:02:00Z",
        message: { role: "assistant", content: "valid" },
      }),
    ]);

    await expect(__testing.readMessagesFromJsonl(file)).resolves.toEqual([
      { role: "assistant", content: "valid", timestamp: "2026-02-24T10:02:00Z" },
    ]);
  });

  it("skips messages with role other than user/assistant", async () => {
    const dir = await makeTempDir("agenr-handoff-jsonl-");
    const file = path.join(dir, "session.jsonl");
    await writeJsonlLines(file, [
      JSON.stringify({
        type: "message",
        timestamp: "2026-02-24T10:03:00Z",
        message: { role: "system", content: "skip me" },
      }),
    ]);

    await expect(__testing.readMessagesFromJsonl(file)).resolves.toEqual([]);
  });

  it('extracts text from array content (only type==="text" blocks)', async () => {
    const dir = await makeTempDir("agenr-handoff-jsonl-");
    const file = path.join(dir, "session.jsonl");
    await writeJsonlLines(file, [
      JSON.stringify({
        type: "message",
        timestamp: "2026-02-24T10:04:00Z",
        message: {
          role: "user",
          content: [
            { type: "tool_use", input: "ignored" },
            { type: "text", text: "hello" },
            { type: "text", text: "world" },
          ],
        },
      }),
    ]);

    await expect(__testing.readMessagesFromJsonl(file)).resolves.toEqual([
      { role: "user", content: "hello world", timestamp: "2026-02-24T10:04:00Z" },
    ]);
  });

  it("skips array-content messages where all blocks are non-text", async () => {
    const dir = await makeTempDir("agenr-handoff-jsonl-");
    const file = path.join(dir, "session.jsonl");
    await writeJsonlLines(file, [
      JSON.stringify({
        type: "message",
        timestamp: "2026-02-24T10:05:00Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_result", text: "ignored" }],
        },
      }),
    ]);

    await expect(__testing.readMessagesFromJsonl(file)).resolves.toEqual([]);
  });

  it("returns correct role, content, timestamp for valid messages", async () => {
    const dir = await makeTempDir("agenr-handoff-jsonl-");
    const file = path.join(dir, "session.jsonl");
    await writeJsonlLines(file, [
      JSON.stringify({
        type: "message",
        timestamp: "2026-02-24T10:06:00Z",
        message: { role: "user", content: "first" },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-02-24T10:07:00Z",
        message: { role: "assistant", content: "second" },
      }),
    ]);

    await expect(__testing.readMessagesFromJsonl(file)).resolves.toEqual([
      { role: "user", content: "first", timestamp: "2026-02-24T10:06:00Z" },
      { role: "assistant", content: "second", timestamp: "2026-02-24T10:07:00Z" },
    ]);
  });

  it("returns [] for empty file", async () => {
    const dir = await makeTempDir("agenr-handoff-jsonl-");
    const file = path.join(dir, "session.jsonl");
    await fs.writeFile(file, "", "utf8");

    await expect(__testing.readMessagesFromJsonl(file)).resolves.toEqual([]);
  });
});

describe("findPriorResetFile", () => {
  it("returns null when no .reset.* files exist", async () => {
    const dir = await makeTempDir("agenr-handoff-prior-");
    await fs.writeFile(path.join(dir, "session-a.jsonl"), "", "utf8");

    await expect(__testing.findPriorResetFile(dir, path.join(dir, "session-b.jsonl"))).resolves.toBeNull();
  });

  it("returns null when most recent .reset.* file is older than 24h", async () => {
    const dir = await makeTempDir("agenr-handoff-prior-");
    const oldFile = path.join(dir, "old-uuid.jsonl.reset.2026-02-23T01-00-00.000Z");
    await fs.writeFile(oldFile, "", "utf8");

    const olderThanDay = new Date(Date.now() - (24 * 60 * 60 * 1000 + 1));
    await fs.utimes(oldFile, olderThanDay, olderThanDay);

    await expect(__testing.findPriorResetFile(dir, path.join(dir, "current-uuid.jsonl"))).resolves.toBeNull();
  });

  it("returns correct file when multiple .reset.* files exist (returns newest)", async () => {
    const dir = await makeTempDir("agenr-handoff-prior-");
    const older = path.join(dir, "older-uuid.jsonl.reset.2026-02-23T01-00-00.000Z");
    const newer = path.join(dir, "newer-uuid.jsonl.reset.2026-02-24T01-00-00.000Z");
    await fs.writeFile(older, "", "utf8");
    await fs.writeFile(newer, "", "utf8");

    const oldTime = new Date(Date.now() - 5000);
    const newTime = new Date(Date.now() - 1000);
    await fs.utimes(older, oldTime, oldTime);
    await fs.utimes(newer, newTime, newTime);

    await expect(__testing.findPriorResetFile(dir, path.join(dir, "current-uuid.jsonl"))).resolves.toBe(newer);
  });

  it("excludes reset files from the current session UUID", async () => {
    const dir = await makeTempDir("agenr-handoff-prior-");
    const currentReset = path.join(dir, "abc123.jsonl.reset.2026-02-24T01-00-00.000Z");
    const otherReset = path.join(dir, "def456.jsonl.reset.2026-02-24T01-00-00.000Z");
    await fs.writeFile(currentReset, "", "utf8");
    await fs.writeFile(otherReset, "", "utf8");

    const now = new Date();
    await fs.utimes(currentReset, now, now);
    await fs.utimes(otherReset, now, now);

    await expect(__testing.findPriorResetFile(dir, path.join(dir, "abc123.jsonl"))).resolves.toBe(otherReset);
  });

  it("returns null when the only .reset.* file is from current session UUID", async () => {
    const dir = await makeTempDir("agenr-handoff-prior-");
    const currentReset = path.join(dir, "abc123.jsonl.reset.2026-02-24T01-00-00.000Z");
    await fs.writeFile(currentReset, "", "utf8");

    await expect(__testing.findPriorResetFile(dir, path.join(dir, "abc123.jsonl"))).resolves.toBeNull();
  });
});

describe("buildMergedTranscript", () => {
  it("formats two blocks with headers including surface and (ended) label", () => {
    const transcript = __testing.buildMergedTranscript(
      [{ role: "user", content: "prior line", timestamp: "2026-02-23T09:15:00" }],
      "telegram",
      [{ role: "assistant", content: "current line", timestamp: "2026-02-24T10:20:00" }],
      "webchat",
    );

    expect(transcript).toContain("--- Session 2026-02-23 09:15 [telegram] ---");
    expect(transcript).toContain("--- Session 2026-02-24 10:20 [webchat] (ended) ---");
    expect(transcript).toContain("[user]: prior line");
    expect(transcript).toContain("[assistant]: current line");
  });

  it("omits prior block when priorMessages is empty", () => {
    const transcript = __testing.buildMergedTranscript(
      [],
      "telegram",
      [{ role: "user", content: "current only", timestamp: "2026-02-24T11:30:00" }],
      "webchat",
    );

    expect(transcript).toBe("--- Session 2026-02-24 11:30 [webchat] (ended) ---\n[user]: current only");
  });

  it("filters out messages with empty content", () => {
    const transcript = __testing.buildMergedTranscript(
      [{ role: "assistant", content: "   ", timestamp: "2026-02-24T09:00:00" }],
      "telegram",
      [
        { role: "user", content: "", timestamp: "2026-02-24T10:00:00" },
        { role: "assistant", content: "kept", timestamp: "2026-02-24T10:01:00" },
      ],
      "webchat",
    );

    expect(transcript).not.toContain("telegram");
    expect(transcript).toContain("[assistant]: kept");
    expect(transcript).not.toContain("[user]:");
  });

  it("header timestamp formatted as YYYY-MM-DD HH:MM from message timestamp", () => {
    const transcript = __testing.buildMergedTranscript(
      [{ role: "user", content: "prior", timestamp: "2026-01-02T03:04:05" }],
      "telegram",
      [{ role: "assistant", content: "current", timestamp: "2026-01-02T06:07:08" }],
      "webchat",
    );

    expect(transcript).toContain("--- Session 2026-01-02 03:04 [telegram] ---");
    expect(transcript).toContain("--- Session 2026-01-02 06:07 [webchat] (ended) ---");
  });
});

describe("50-message budget slicing", () => {
  it("when currentMessages.length > 50, prior gets 0 messages and current is capped at 50", async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-budget-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    const priorFile = path.join(dir, "prior-uuid.jsonl.reset.2026-02-24T01-00-00.000Z");

    await fs.writeFile(currentSessionFile, "", "utf8");
    await writeJsonlLines(priorFile, [
      JSON.stringify({
        type: "message",
        timestamp: "2026-02-24T09:00:00Z",
        message: { role: "user", content: "prior-budget-should-not-appear" },
      }),
    ]);
    await fs.writeFile(
      path.join(dir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionFile: currentSessionFile, origin: { surface: "webchat" } },
        "agent:main:tui": { sessionFile: priorFile, origin: { surface: "telegram" } },
      }),
      "utf8",
    );

    let transcript = "";
    const streamSimpleImpl = makeStreamSimple({
      message: makeAssistantMessage("summary text"),
      onContext: (context) => {
        const userMessage = context.messages[0];
        if (userMessage?.role === "user" && typeof userMessage.content === "string") {
          transcript = userMessage.content;
        }
      },
    });

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(60, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      streamSimpleImpl,
    );

    expect(summary).toBe("summary text");
    const messageLines = transcript
      .split("\n")
      .filter((line) => line.startsWith("[user]:") || line.startsWith("[assistant]:"));
    expect(messageLines).toHaveLength(50);
    expect(transcript).not.toContain("prior-budget-should-not-appear");
    expect(transcript).not.toContain("[telegram]");
  });

  it("when currentMessages.length = 30 and prior has 40 messages, takes last 20 from prior and all 30 current", async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-budget-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    const priorFile = path.join(dir, "prior-uuid.jsonl.reset.2026-02-24T01-00-00.000Z");

    await fs.writeFile(currentSessionFile, "", "utf8");

    const priorLines: string[] = [];
    for (let index = 1; index <= 40; index += 1) {
      const minute = String(index % 60).padStart(2, "0");
      priorLines.push(
        JSON.stringify({
          type: "message",
          timestamp: `2026-02-24T08:${minute}:00`,
          message: { role: "user", content: `prior-${index}` },
        }),
      );
    }
    await writeJsonlLines(priorFile, priorLines);
    await fs.writeFile(
      path.join(dir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionFile: currentSessionFile, origin: { surface: "webchat" } },
        "agent:main:tui": { sessionFile: priorFile, origin: { surface: "telegram" } },
      }),
      "utf8",
    );

    let transcript = "";
    const streamSimpleImpl = makeStreamSimple({
      message: makeAssistantMessage("summary text"),
      onContext: (context) => {
        const userMessage = context.messages[0];
        if (userMessage?.role === "user" && typeof userMessage.content === "string") {
          transcript = userMessage.content;
        }
      },
    });

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(30, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      streamSimpleImpl,
    );

    expect(summary).toBe("summary text");
    const priorMessageLines = transcript.split("\n").filter((line) => line.includes("prior-"));
    const currentMessageLines = transcript.split("\n").filter((line) => line.includes("current-"));
    expect(priorMessageLines).toHaveLength(20);
    expect(currentMessageLines).toHaveLength(30);
    expect(transcript).toContain("prior-21");
    expect(transcript).toContain("prior-40");
    expect(transcript).not.toContain("prior-1");
    expect(transcript).not.toContain("prior-20");
  });
});

describe("summarizeSessionForHandoff", () => {
  it("returns LLM summary string on success", async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-summary-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(currentSessionFile, "", "utf8");

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      makeStreamSimple({ message: makeAssistantMessage("WORKING ON: Implementing issue #199.") }),
    );

    expect(summary).toBe("WORKING ON: Implementing issue #199.");
  });

  it("returns null when streamSimpleImpl throws", async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-summary-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(currentSessionFile, "", "utf8");

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      makeStreamSimple({ shouldThrow: true }),
    );

    expect(summary).toBeNull();
  });

  it("returns null when fewer than 3 non-header lines in transcript", async () => {
    const createLlmClientSpy = vi.spyOn(llmClientModule, "createLlmClient");
    const dir = await makeTempDir("agenr-handoff-summary-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(currentSessionFile, "", "utf8");

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(2, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      makeStreamSimple({ message: makeAssistantMessage("unused") }),
    );

    expect(summary).toBeNull();
    expect(createLlmClientSpy).not.toHaveBeenCalled();
  });

  it("returns null when minimum session gate fails (fewer than 5 current messages and no prior)", async () => {
    const createLlmClientSpy = vi.spyOn(llmClientModule, "createLlmClient");
    const dir = await makeTempDir("agenr-handoff-summary-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(currentSessionFile, "", "utf8");

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(4, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      makeStreamSimple({ message: makeAssistantMessage("unused") }),
    );

    expect(summary).toBeNull();
    expect(createLlmClientSpy).not.toHaveBeenCalled();
  });

  it('returns null when LLM returns stopReason "error"', async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-summary-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(currentSessionFile, "", "utf8");

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      makeStreamSimple({ message: makeAssistantMessage("provider error", "error") }),
    );

    expect(summary).toBeNull();
  });

  it("returns null when createLlmClient throws", async () => {
    vi.spyOn(llmClientModule, "createLlmClient").mockImplementation(() => {
      throw new Error("Not configured. Run `agenr setup`.");
    });
    const logger = makeLogger();
    const dir = await makeTempDir("agenr-handoff-summary-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(currentSessionFile, "", "utf8");

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      logger,
      makeStreamSimple({ message: makeAssistantMessage("unused") }),
    );

    expect(summary).toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });
});
