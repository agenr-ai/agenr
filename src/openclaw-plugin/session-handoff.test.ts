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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as llmClientModule from "../llm/client.js";
import type { StreamSimpleFn } from "../llm/stream.js";
import plugin, { __testing } from "./index.js";
import * as pluginRecall from "./recall.js";
import * as sessionQuery from "./session-query.js";
import * as pluginTools from "./tools.js";
import type { BeforePromptBuildResult, PluginApi, PluginLogger } from "./types.js";

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
    [Symbol.asyncIterator](): AsyncIterableIterator<AssistantMessageEvent> {
      return {
        next: async () => ({
          done: true as const,
          value: undefined as never,
        }),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
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

function makePluginApi(overrides?: Partial<PluginApi>): PluginApi {
  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    ...(overrides?.logger ?? {}),
  };
  const { logger: _ignoredLogger, ...restOverrides } = overrides ?? {};
  return {
    id: "agenr",
    name: "agenr memory context",
    logger,
    on: vi.fn() as unknown as PluginApi["on"],
    ...restOverrides,
  };
}

function getBeforePromptBuildHandler(
  api: PluginApi,
): (
  event: Record<string, unknown>,
  ctx: { sessionKey?: string; sessionId?: string; agentId?: string },
) => Promise<BeforePromptBuildResult | undefined> {
  const onMock = api.on as unknown as ReturnType<typeof vi.fn>;
  const call = onMock.mock.calls.find((args) => args[0] === "before_prompt_build");
  if (!call) {
    throw new Error("before_prompt_build handler not registered");
  }
  return call[1] as (
    event: Record<string, unknown>,
    ctx: { sessionKey?: string; sessionId?: string; agentId?: string },
  ) => Promise<BeforePromptBuildResult | undefined>;
}

beforeEach(() => {
  __testing.clearState();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("readSessionsJson", () => {
  it("returns {} when file does not exist", async () => {
    const dir = await makeTempDir("agenr-handoff-sessions-json-");
    expect(await __testing.readSessionsJson(dir)).toEqual({});
  });

  it("returns parsed object when file is valid JSON", async () => {
    const dir = await makeTempDir("agenr-handoff-sessions-json-");
    await fs.writeFile(
      path.join(dir, "sessions.json"),
      JSON.stringify({ "agent:main:main": { sessionFile: "/tmp/a.jsonl" } }),
      "utf8",
    );

    expect(await __testing.readSessionsJson(dir)).toEqual({
      "agent:main:main": { sessionFile: "/tmp/a.jsonl" },
    });
  });

  it("returns {} when file contains invalid JSON", async () => {
    const dir = await makeTempDir("agenr-handoff-sessions-json-");
    await fs.writeFile(path.join(dir, "sessions.json"), "{invalid", "utf8");

    expect(await __testing.readSessionsJson(dir)).toEqual({});
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

  it('returns "prior session" when no entry matches the file path', () => {
    const target = path.join(os.tmpdir(), "session-c.jsonl");
    const sessionsJson = {
      "agent:main:main": {
        sessionFile: path.join(os.tmpdir(), "different-session.jsonl"),
        origin: { surface: "webchat" },
      },
    } as Record<string, unknown>;

    expect(__testing.getSurfaceForSessionFile(target, sessionsJson)).toBe("prior session");
  });

  it('returns "prior session" on malformed sessionsJson input', () => {
    expect(
      __testing.getSurfaceForSessionFile(
        path.join(os.tmpdir(), "session-d.jsonl"),
        null as unknown as Record<string, unknown>,
      ),
    ).toBe("prior session");
  });

  it("resolves surface for reset file path when getBaseSessionPath is applied", () => {
    const activePath = path.join(os.tmpdir(), "abc123.jsonl");
    const resetPath = `${activePath}.reset.2026-02-24T01-00-00.000Z`;
    const sessionsJson = {
      "agent:main:main": {
        sessionFile: activePath,
        origin: { surface: "webchat" },
      },
    } as Record<string, unknown>;

    expect(
      __testing.getSurfaceForSessionFile(__testing.getBaseSessionPath(resetPath), sessionsJson),
    ).toBe("webchat");
  });
});

describe("getBaseSessionPath", () => {
  it("extracts base path from a .reset.* filename", () => {
    const resetPath = "/tmp/abc123.jsonl.reset.2026-02-24T01-00-00.000Z";
    expect(__testing.getBaseSessionPath(resetPath)).toBe("/tmp/abc123.jsonl");
  });

  it("returns input unchanged for non-reset files", () => {
    const activePath = "/tmp/abc123.jsonl";
    expect(__testing.getBaseSessionPath(activePath)).toBe(activePath);
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

  it("orders prior block before current block", () => {
    const transcript = __testing.buildMergedTranscript(
      [{ role: "user", content: "prior line", timestamp: "2026-02-23T09:15:00" }],
      "telegram",
      [{ role: "assistant", content: "current line", timestamp: "2026-02-24T10:20:00" }],
      "webchat",
    );

    const priorIndex = transcript.indexOf("--- Session 2026-02-23 09:15 [telegram] ---");
    const currentIndex = transcript.indexOf("--- Session 2026-02-24 10:20 [webchat] (ended) ---");
    expect(priorIndex).toBeGreaterThanOrEqual(0);
    expect(currentIndex).toBeGreaterThanOrEqual(0);
    expect(priorIndex).toBeLessThan(currentIndex);
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

describe("capTranscriptLength", () => {
  it("drops prior messages until transcript is under maxChars when prior causes overflow", () => {
    const priorMessages = Array.from({ length: 20 }, (_, index) => ({
      role: "user" as const,
      content: `prior-${index + 1} ${"x".repeat(120)}`,
      timestamp: "2026-02-23T09:15:00",
    }));
    const currentMessages = [
      { role: "assistant" as const, content: "current-kept", timestamp: "2026-02-24T10:20:00" },
    ];

    const capped = __testing.capTranscriptLength({
      priorMessages,
      priorSurface: "telegram",
      currentMessages,
      currentSurface: "webchat",
      maxChars: 600,
    });

    expect(capped.length).toBeLessThanOrEqual(600);
    expect(capped).toContain("current-kept");
    const priorLines = capped.split("\n").filter((line) => line.startsWith("[user]: prior-"));
    expect(priorLines.some((line) => line.startsWith("[user]: prior-1 "))).toBe(false);
  });

  it("returns truncated transcript under maxChars when current-only content exceeds cap", () => {
    const currentMessages = [
      { role: "user" as const, content: `current-${"y".repeat(9000)}`, timestamp: "2026-02-24T10:20:00" },
    ];

    const capped = __testing.capTranscriptLength({
      priorMessages: [],
      priorSurface: "telegram",
      currentMessages,
      currentSurface: "webchat",
      maxChars: 8000,
    });

    expect(capped.length).toBeLessThanOrEqual(8000);
    expect(capped.length).toBeGreaterThan(0);
  });

  it("returns the original transcript when already under cap", () => {
    const priorMessages = [
      { role: "user" as const, content: "prior", timestamp: "2026-02-23T09:15:00" },
    ];
    const currentMessages = [
      { role: "assistant" as const, content: "current", timestamp: "2026-02-24T10:20:00" },
    ];
    const original = __testing.buildMergedTranscript(priorMessages, "telegram", currentMessages, "webchat");

    const capped = __testing.capTranscriptLength({
      priorMessages,
      priorSurface: "telegram",
      currentMessages,
      currentSurface: "webchat",
      maxChars: 8000,
    });

    expect(capped).toBe(original);
  });

  it("does not truncate current message text when removing prior is sufficient", () => {
    const priorMessages = Array.from({ length: 8 }, (_, index) => ({
      role: "user" as const,
      content: `prior-${index + 1}-${"z".repeat(200)}`,
      timestamp: "2026-02-23T09:15:00",
    }));
    const currentContent = "CURRENT_FULL_PAYLOAD_1234567890";
    const currentMessages = [
      { role: "assistant" as const, content: currentContent, timestamp: "2026-02-24T10:20:00" },
    ];

    const capped = __testing.capTranscriptLength({
      priorMessages,
      priorSurface: "telegram",
      currentMessages,
      currentSurface: "webchat",
      maxChars: 500,
    });

    expect(capped.length).toBeLessThanOrEqual(500);
    expect(capped).toContain(`[assistant]: ${currentContent}`);
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
    expect(transcript).toContain("current-60");
    expect(messageLines).not.toContain("[user]: current-1");
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
  it("logs model and transcript stats before calling LLM", async () => {
    vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue({
      auth: "openai-api-key",
      resolvedModel: {
        provider: "openai",
        modelId: "gpt-4.1-nano",
        model: "gpt-4.1-nano" as unknown as Model<Api>,
      },
      credentials: {
        apiKey: "test-api-key",
        source: "env:OPENAI_API_KEY",
      },
    });
    const logger = makeLogger();
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = await makeTempDir("agenr-handoff-summary-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(currentSessionFile, "", "utf8");

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      logger,
      makeStreamSimple({ message: makeAssistantMessage("summary text") }),
    );

    expect(summary).toBe("summary text");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[agenr\] before_reset: sending to LLM model=gpt-4\.1-nano chars=\d+ currentMsgs=5 priorMsgs=0$/,
      ),
    );
  });

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
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  it("returns null and logs when credentials.apiKey is missing", async () => {
    vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue({
      auth: "openai-api-key",
      resolvedModel: {
        provider: "openai",
        modelId: "gpt-4.1-nano",
        model: {} as Model<Api>,
      },
      credentials: {} as { apiKey?: string },
    });
    const logger = makeLogger();
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[agenr] before_reset: no apiKey available, skipping LLM summary",
    );
  });
});

describe("runHandoffForSession", () => {
  it("LLM handoff store is awaited before before_reset resolves", async () => {
    const summaryText = "WORKING ON: awaited LLM handoff";
    let runResolved = false;
    let llmStoreHappenedBeforeResolve = false;

    vi.spyOn(__testing, "summarizeSessionForHandoff").mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return summaryText;
    });
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockImplementation(async (_agenrPath, payload) => {
      const content = (payload as { entries?: Array<{ content?: string }> }).entries?.[0]?.content;
      if (content === summaryText) {
        llmStoreHappenedBeforeResolve = !runResolved;
      }
      return {
        content: [{ type: "text", text: "Stored 1 entries." }],
      };
    });

    const runPromise = __testing.runHandoffForSession({
      messages: [
        { role: "user", content: "please summarize this handoff" },
        { role: "assistant", content: "summary incoming" },
      ],
      sessionFile: "/tmp/current-session-await.jsonl",
      sessionId: "session-await",
      sessionKey: "agent:main:session-await",
      agentId: "main",
      agenrPath: "/tmp/agenr",
      budget: 20,
      defaultProject: undefined,
      storeConfig: {},
      sessionsDir: "/tmp",
      logger: makeLogger(),
      source: "before_reset",
    });

    runPromise.then(() => {
      runResolved = true;
    });
    await runPromise;

    expect(runStoreMock).toHaveBeenCalledWith(
      "/tmp/agenr",
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            content: summaryText,
          }),
        ],
      }),
      {},
      undefined,
    );
    expect(llmStoreHappenedBeforeResolve).toBe(true);
  });

  it("falls back to fallback-only if LLM returns null", async () => {
    vi.spyOn(__testing, "summarizeSessionForHandoff").mockResolvedValue(null);
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockResolvedValue({
      content: [{ type: "text", text: "Stored 1 entries." }],
    });

    await __testing.runHandoffForSession({
      messages: [
        { role: "user", content: "fallback only path" },
        { role: "assistant", content: "no llm summary for this one" },
      ],
      sessionFile: "/tmp/current-session-null.jsonl",
      sessionId: "session-null",
      sessionKey: "agent:main:session-null",
      agentId: "main",
      agenrPath: "/tmp/agenr",
      budget: 20,
      defaultProject: undefined,
      storeConfig: {},
      sessionsDir: "/tmp",
      logger: makeLogger(),
      source: "before_reset",
    });

    expect(runStoreMock).toHaveBeenCalledTimes(1);
    expect(runStoreMock).toHaveBeenCalledWith(
      "/tmp/agenr",
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            importance: 9,
            content: expect.stringContaining("fallback only path"),
          }),
        ],
      }),
      {},
      undefined,
    );
  });

  it("retires fallback by subject+importance+tag even when browse content differs", async () => {
    vi.spyOn(__testing, "summarizeSessionForHandoff").mockResolvedValue("WORKING ON: issue #221 complete.");

    let fallbackSubject = "";
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockImplementation(async (_agenrPath, payload) => {
      const subject = (payload as { entries?: Array<{ subject?: string }> }).entries?.[0]?.subject;
      if (!fallbackSubject && typeof subject === "string") {
        fallbackSubject = subject;
      }
      return {
        content: [{ type: "text", text: "Stored 1 entries." }],
      };
    });
    vi.spyOn(pluginRecall, "runRecall").mockImplementation(async () => ({
      query: "[browse]",
      results: [
        {
          entry: {
            id: "fallback-entry-221",
            subject: fallbackSubject,
            importance: 9,
            tags: ["handoff", "session"],
            content: "content intentionally mismatched from stored fallback",
          },
          score: 0.95,
        },
      ],
    }));
    const runRetireMock = vi.spyOn(pluginTools, "runRetireTool").mockResolvedValue({
      content: [{ type: "text", text: "Retired 1 entries." }],
    });

    await __testing.runHandoffForSession({
      messages: [
        { role: "user", content: "Please carry this handoff forward." },
        { role: "assistant", content: "I will summarize and persist it." },
      ],
      sessionFile: "/tmp/current-session-221.jsonl",
      sessionId: "session-221",
      sessionKey: "agent:main:session-221",
      agentId: "main",
      agenrPath: "/tmp/agenr",
      budget: 20,
      defaultProject: undefined,
      storeConfig: {},
      sessionsDir: "/tmp",
      logger: makeLogger(),
      source: "before_reset",
    });

    expect(runStoreMock).toHaveBeenCalledTimes(2);
    expect(fallbackSubject).toMatch(/^session handoff /);

    expect(runRetireMock).toHaveBeenCalledWith("/tmp/agenr", {
      entry_id: "fallback-entry-221",
      reason: "superseded by LLM handoff",
    });
  });
});

describe("session_start path in before_prompt_build", () => {
  it("session_start path: runHandoffForSession called when previous session file found", async () => {
    const previousSessionFile = "/tmp/prev-session-123.jsonl.reset.2026-02-24T01-00-00.000Z";
    const parsedMessages = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index + 1}`,
      timestamp: `2026-02-24T10:${String(index).padStart(2, "0")}:00`,
    }));

    vi.spyOn(sessionQuery, "findPreviousSessionFile").mockResolvedValue(previousSessionFile);
    vi.spyOn(sessionQuery, "extractRecentTurns").mockResolvedValue("U: previous user | A: previous assistant");
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    vi.spyOn(__testing, "readAndParseSessionJsonl").mockResolvedValue(parsedMessages);
    const runHandoffSpy = vi.spyOn(__testing, "runHandoffForSession").mockResolvedValue(undefined);

    const api = makePluginApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    await handler(
      { prompt: "hello" },
      { sessionKey: "agent:main:session-start-trigger", sessionId: "uuid-session-start-trigger", agentId: "main" },
    );

    expect(runHandoffSpy).toHaveBeenCalledTimes(1);
    expect(runHandoffSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: parsedMessages,
        sessionFile: previousSessionFile,
        sessionId: "prev-session-123",
        sessionKey: "agent:main:session-start-trigger",
        agentId: "main",
        source: "session_start",
      }),
    );
  });

  it("session_start path: runHandoffForSession NOT called when no previous session file found", async () => {
    vi.spyOn(sessionQuery, "findPreviousSessionFile").mockResolvedValue(null);
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const readSpy = vi.spyOn(__testing, "readAndParseSessionJsonl");
    const runHandoffSpy = vi.spyOn(__testing, "runHandoffForSession").mockResolvedValue(undefined);

    const api = makePluginApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    await handler(
      { prompt: "hello" },
      { sessionKey: "agent:main:session-start-no-prev", sessionId: "uuid-session-start-no-prev", agentId: "main" },
    );

    expect(readSpy).not.toHaveBeenCalled();
    expect(runHandoffSpy).not.toHaveBeenCalled();
  });

  it("session_start path: runHandoffForSession NOT called on second prompt in same session (isFirstInSession = false)", async () => {
    const previousSessionFile = "/tmp/prev-session-same.jsonl";
    const parsedMessages = [{ role: "user", content: "first", timestamp: "2026-02-24T10:00:00" }];

    vi.spyOn(sessionQuery, "findPreviousSessionFile").mockResolvedValue(previousSessionFile);
    vi.spyOn(sessionQuery, "extractRecentTurns").mockResolvedValue("U: prior");
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    vi.spyOn(__testing, "readAndParseSessionJsonl").mockResolvedValue(parsedMessages);
    const runHandoffSpy = vi.spyOn(__testing, "runHandoffForSession").mockResolvedValue(undefined);

    const api = makePluginApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    await handler(
      { prompt: "first prompt" },
      { sessionKey: "agent:main:session-start-same", sessionId: "uuid-session-start-same", agentId: "main" },
    );
    await handler(
      { prompt: "second prompt" },
      { sessionKey: "agent:main:session-start-same", sessionId: "uuid-session-start-same", agentId: "main" },
    );

    expect(runHandoffSpy).toHaveBeenCalledTimes(1);
  });

  it("session_start path: skips if readAndParseSessionJsonl returns empty array", async () => {
    const previousSessionFile = "/tmp/prev-session-empty.jsonl";

    vi.spyOn(sessionQuery, "findPreviousSessionFile").mockResolvedValue(previousSessionFile);
    vi.spyOn(sessionQuery, "extractRecentTurns").mockResolvedValue("U: prior");
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    vi.spyOn(__testing, "readAndParseSessionJsonl").mockResolvedValue([]);
    const runHandoffSpy = vi.spyOn(__testing, "runHandoffForSession").mockResolvedValue(undefined);

    const api = makePluginApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    await handler(
      { prompt: "hello" },
      { sessionKey: "agent:main:session-start-empty", sessionId: "uuid-session-start-empty", agentId: "main" },
    );

    expect(runHandoffSpy).not.toHaveBeenCalled();
  });

  it("source type allows session_start", () => {
    type HandoffSource = Parameters<(typeof __testing)["runHandoffForSession"]>[0]["source"];
    const source: HandoffSource = "session_start";
    expect(source).toBe("session_start");
  });
});
