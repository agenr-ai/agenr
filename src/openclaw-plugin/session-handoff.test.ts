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

describe("testingApi exports", () => {
  it("exports findPriorResetFile", () => {
    const exported = __testing as unknown as Record<string, unknown>;
    expect("findPriorResetFile" in exported).toBe(true);
  });
});

describe("buildTranscript", () => {
  it("formats one block with header including surface and (ended) label", () => {
    const transcript = __testing.buildTranscript(
      [{ role: "assistant", content: "current line", timestamp: "2026-02-24T10:20:00" }],
      "webchat",
    );

    expect(transcript).toContain("--- Session 2026-02-24 10:20 [webchat] (ended) ---");
    expect(transcript).toContain("[assistant]: current line");
  });

  it("filters out messages with empty content", () => {
    const transcript = __testing.buildTranscript(
      [
        { role: "user", content: "", timestamp: "2026-02-24T10:00:00" },
        { role: "assistant", content: "kept", timestamp: "2026-02-24T10:01:00" },
      ],
      "webchat",
    );

    expect(transcript).toContain("[assistant]: kept");
    expect(transcript).not.toContain("[user]:");
  });

  it("header timestamp formatted as YYYY-MM-DD HH:MM from message timestamp", () => {
    const transcript = __testing.buildTranscript(
      [{ role: "assistant", content: "current", timestamp: "2026-01-02T06:07:08" }],
      "webchat",
    );

    expect(transcript).toContain("--- Session 2026-01-02 06:07 [webchat] (ended) ---");
  });
});

describe("buildMergedTranscript", () => {
  it("with empty prior section includes summarize header only", () => {
    const transcript = __testing.buildMergedTranscript(
      [],
      "telegram",
      [{ role: "assistant", content: "current line", timestamp: "2026-02-24T10:20:00" }],
      "webchat",
    );

    expect(transcript).toContain("=== SUMMARIZE THIS SESSION ONLY ===");
    expect(transcript).not.toContain("=== BACKGROUND CONTEXT (DO NOT SUMMARIZE) ===");
  });

  it("with prior and current includes both section headers", () => {
    const transcript = __testing.buildMergedTranscript(
      [{ role: "user", content: "prior line", timestamp: "2026-02-24T09:10:00" }],
      "telegram",
      [{ role: "assistant", content: "current line", timestamp: "2026-02-24T10:20:00" }],
      "webchat",
    );

    expect(transcript).toContain("=== BACKGROUND CONTEXT (DO NOT SUMMARIZE) ===");
    expect(transcript).toContain("=== SUMMARIZE THIS SESSION ONLY ===");
  });

  it("orders prior messages before current messages", () => {
    const transcript = __testing.buildMergedTranscript(
      [{ role: "user", content: "prior line", timestamp: "2026-02-24T09:10:00" }],
      "telegram",
      [{ role: "assistant", content: "current line", timestamp: "2026-02-24T10:20:00" }],
      "webchat",
    );

    const priorIndex = transcript.indexOf("[user]: prior line");
    const currentIndex = transcript.indexOf("[assistant]: current line");
    expect(priorIndex).toBeGreaterThanOrEqual(0);
    expect(currentIndex).toBeGreaterThanOrEqual(0);
    expect(priorIndex).toBeLessThan(currentIndex);
  });

  it("filters empty content from both prior and current sections", () => {
    const transcript = __testing.buildMergedTranscript(
      [{ role: "user", content: "   ", timestamp: "2026-02-24T09:10:00" }],
      "telegram",
      [
        { role: "assistant", content: "", timestamp: "2026-02-24T10:20:00" },
        { role: "assistant", content: "kept", timestamp: "2026-02-24T10:21:00" },
      ],
      "webchat",
    );

    expect(transcript).not.toContain("[user]:");
    expect(transcript).not.toContain("Current session unknown time");
    expect(transcript).toContain("[assistant]: kept");
  });
});

describe("handoff prompt constants", () => {
  it('HANDOFF_SUMMARY_SYSTEM_PROMPT does not mention "BACKGROUND CONTEXT"', () => {
    expect(__testing.HANDOFF_SUMMARY_SYSTEM_PROMPT).not.toContain("BACKGROUND CONTEXT");
  });

  it("HANDOFF_SUMMARY_SYSTEM_PROMPT_WITH_BACKGROUND includes required background headers and guardrail text", () => {
    expect(__testing.HANDOFF_SUMMARY_SYSTEM_PROMPT_WITH_BACKGROUND).toContain(
      "BACKGROUND CONTEXT (DO NOT SUMMARIZE)",
    );
    expect(__testing.HANDOFF_SUMMARY_SYSTEM_PROMPT_WITH_BACKGROUND).toContain(
      "SUMMARIZE THIS SESSION ONLY",
    );
    expect(__testing.HANDOFF_SUMMARY_SYSTEM_PROMPT_WITH_BACKGROUND).toMatch(
      /Do NOT fall back to summarizing the\s+background context/,
    );
  });
});

describe("50-message budget slicing", () => {
  it("sends only current-session messages to LLM transcript", async () => {
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
      false,
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

  it("when currentMessages.length = 30, sends all 30 current messages", async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-budget-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");

    await fs.writeFile(currentSessionFile, "", "utf8");
    await fs.writeFile(
      path.join(dir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionFile: currentSessionFile, origin: { surface: "webchat" } },
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
      false,
      streamSimpleImpl,
    );

    expect(summary).toBe("summary text");
    const currentMessageLines = transcript.split("\n").filter((line) => line.includes("current-"));
    expect(currentMessageLines).toHaveLength(30);
    expect(transcript).toContain("current-1");
    expect(transcript).toContain("current-30");
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
      false,
      makeStreamSimple({ message: makeAssistantMessage("summary text") }),
    );

    expect(summary).toBe("summary text");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[agenr\] before_reset: sending to LLM model=gpt-4\.1-nano chars=\d+ msgs=5$/,
      ),
    );
  });

  it("uses resolvedModel.modelId in log output instead of model object", async () => {
    vi.spyOn(llmClientModule, "createLlmClient").mockReturnValue({
      auth: "openai-api-key",
      resolvedModel: {
        provider: "openai",
        modelId: "gpt-4.1-nano-test",
        model: {} as Model<Api>,
      },
      credentials: {
        apiKey: "test-api-key",
        source: "env:OPENAI_API_KEY",
      },
    });
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = await makeTempDir("agenr-handoff-summary-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(currentSessionFile, "", "utf8");

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      false,
      makeStreamSimple({ message: makeAssistantMessage("summary text") }),
    );

    expect(summary).toBe("summary text");
    const sendingLog = consoleLogSpy.mock.calls
      .map((call) => (typeof call[0] === "string" ? call[0] : ""))
      .find((line) => line.includes("[agenr] before_reset: sending to LLM"));
    expect(sendingLog).toContain("model=gpt-4.1-nano-test");
    expect(sendingLog).not.toContain("[object Object]");
  });

  it("writes request/response files when logEnabled=true and logDir is set", async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-summary-logdir-");
    const logDir = path.join(dir, "handoff-logs");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(currentSessionFile, "", "utf8");

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      false,
      makeStreamSimple({ message: makeAssistantMessage("summary text") }),
      true,
      logDir,
    );

    expect(summary).toBe("summary text");
    const files = await fs.readdir(logDir);
    const requestFile = files.find((file) => /^handoff-.*-request\.txt$/.test(file));
    const responseFile = files.find((file) => /^handoff-.*-response\.txt$/.test(file));
    expect(requestFile).toBeDefined();
    expect(responseFile).toBeDefined();

    const requestBody = await fs.readFile(path.join(logDir, requestFile as string), "utf8");
    const responseBody = await fs.readFile(path.join(logDir, responseFile as string), "utf8");
    expect(requestBody).toContain("=== SYSTEM PROMPT ===");
    expect(requestBody).toContain("=== TRANSCRIPT ===");
    expect(requestBody).toContain("=== METADATA ===");
    expect(responseBody).toContain("=== LLM RESPONSE ===");
    expect(responseBody).toContain("=== METADATA ===");
  });

  it("does not write files when logDir is not set", async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-summary-logdir-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    const mkdirSpy = vi.spyOn(fs, "mkdir");
    await fs.writeFile(currentSessionFile, "", "utf8");

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      false,
      makeStreamSimple({ message: makeAssistantMessage("summary text") }),
      true,
      undefined,
    );

    expect(summary).toBe("summary text");
    expect(mkdirSpy).not.toHaveBeenCalled();
  });

  it("continues successfully when logDir is not writable", async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-summary-logdir-");
    const blockedPath = path.join(dir, "blocked-path");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(blockedPath, "not-a-directory", "utf8");
    await fs.writeFile(currentSessionFile, "", "utf8");

    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      false,
      makeStreamSimple({ message: makeAssistantMessage("summary text") }),
      true,
      blockedPath,
    );

    expect(summary).toBe("summary text");
  });

  it("when includeBackground=true and prior reset exists, transcript contains both section headers", async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-summary-bg-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    const priorBaseFile = path.join(dir, "prior-uuid.jsonl");
    const priorResetFile = `${priorBaseFile}.reset.2026-02-24T01-00-00.000Z`;
    await fs.writeFile(currentSessionFile, "", "utf8");
    await writeJsonlLines(priorResetFile, [
      JSON.stringify({
        type: "message",
        timestamp: "2026-02-24T09:00:00Z",
        message: { role: "user", content: "prior context here" },
      }),
    ]);
    const now = new Date();
    await fs.utimes(priorResetFile, now, now);
    await fs.writeFile(
      path.join(dir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionFile: currentSessionFile, origin: { surface: "webchat" } },
        "agent:main:tui": { sessionFile: priorBaseFile, origin: { surface: "telegram" } },
      }),
      "utf8",
    );

    let transcript = "";
    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      true,
      makeStreamSimple({
        message: makeAssistantMessage("summary text"),
        onContext: (context) => {
          const userMessage = context.messages[0];
          if (userMessage?.role === "user" && typeof userMessage.content === "string") {
            transcript = userMessage.content;
          }
        },
      }),
    );

    expect(summary).toBe("summary text");
    expect(transcript).toContain("=== BACKGROUND CONTEXT (DO NOT SUMMARIZE) ===");
    expect(transcript).toContain("=== SUMMARIZE THIS SESSION ONLY ===");
  });

  it("when includeBackground=true and no prior file within 24h, transcript includes summarize header only", async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-summary-bg-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    const oldResetFile = path.join(dir, "older-uuid.jsonl.reset.2026-02-23T01-00-00.000Z");
    await fs.writeFile(currentSessionFile, "", "utf8");
    await writeJsonlLines(oldResetFile, [
      JSON.stringify({
        type: "message",
        timestamp: "2026-02-23T09:00:00Z",
        message: { role: "user", content: "stale prior context" },
      }),
    ]);
    const olderThanDay = new Date(Date.now() - (24 * 60 * 60 * 1000 + 1));
    await fs.utimes(oldResetFile, olderThanDay, olderThanDay);
    await fs.writeFile(
      path.join(dir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionFile: currentSessionFile, origin: { surface: "webchat" } },
      }),
      "utf8",
    );

    let transcript = "";
    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      true,
      makeStreamSimple({
        message: makeAssistantMessage("summary text"),
        onContext: (context) => {
          const userMessage = context.messages[0];
          if (userMessage?.role === "user" && typeof userMessage.content === "string") {
            transcript = userMessage.content;
          }
        },
      }),
    );

    expect(summary).toBe("summary text");
    expect(transcript).not.toContain("=== BACKGROUND CONTEXT (DO NOT SUMMARIZE) ===");
    expect(transcript).toContain("=== SUMMARIZE THIS SESSION ONLY ===");
  });

  it("when includeBackground=false, transcript uses simple single-session format", async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-summary-bg-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(currentSessionFile, "", "utf8");

    let transcript = "";
    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      false,
      makeStreamSimple({
        message: makeAssistantMessage("summary text"),
        onContext: (context) => {
          const userMessage = context.messages[0];
          if (userMessage?.role === "user" && typeof userMessage.content === "string") {
            transcript = userMessage.content;
          }
        },
      }),
    );

    expect(summary).toBe("summary text");
    expect(transcript).toContain("--- Session");
    expect(transcript).not.toContain("=== BACKGROUND CONTEXT (DO NOT SUMMARIZE) ===");
    expect(transcript).not.toContain("=== SUMMARIZE THIS SESSION ONLY ===");
  });

  it('uses a single-session prompt without "prior session" or "two sessions"', async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-summary-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(currentSessionFile, "", "utf8");

    let systemPrompt = "";
    const summary = await __testing.summarizeSessionForHandoff(
      makeEventMessages(5, "current"),
      dir,
      currentSessionFile,
      makeLogger(),
      false,
      makeStreamSimple({
        message: makeAssistantMessage("summary text"),
        onContext: (context) => {
          systemPrompt = context.systemPrompt;
        },
      }),
    );

    expect(summary).toBe("summary text");
    expect(systemPrompt.toLowerCase()).not.toContain("prior session");
    expect(systemPrompt.toLowerCase()).not.toContain("two sessions");
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
      false,
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
      false,
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
      false,
      makeStreamSimple({ message: makeAssistantMessage("unused") }),
    );

    expect(summary).toBeNull();
    expect(createLlmClientSpy).not.toHaveBeenCalled();
  });

  it('returns "No significant activity" summary for a trivial greeting session', async () => {
    mockLlmClientSuccess();
    const dir = await makeTempDir("agenr-handoff-summary-");
    const currentSessionFile = path.join(dir, "current-uuid.jsonl");
    await fs.writeFile(currentSessionFile, "", "utf8");

    const summary = await __testing.summarizeSessionForHandoff(
      [
        { role: "user", content: "hi", timestamp: "2026-02-24T10:00:00" },
        { role: "assistant", content: "hello", timestamp: "2026-02-24T10:01:00" },
        { role: "user", content: "thanks", timestamp: "2026-02-24T10:02:00" },
      ],
      dir,
      currentSessionFile,
      makeLogger(),
      false,
      makeStreamSimple({
        message: makeAssistantMessage(
          "WORKING ON: No significant activity\nKEY FINDINGS: None\nOPEN THREADS: None\nIMPORTANT FACTS: None",
        ),
      }),
    );

    expect(summary).toContain("No significant activity");
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
      false,
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
      false,
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
      false,
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
    }, undefined);
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

  it("session_start path: awaits runHandoffForSession before handler resolves", async () => {
    let resolved = false;
    const runHandoffSpy = vi.spyOn(__testing, "runHandoffForSession").mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      resolved = true;
    });

    const sessionsDir = await makeTempDir("agenr-handoff-session-start-await-");
    const previousSessionFile = path.join(
      sessionsDir,
      "abc123.jsonl.reset.2026-02-24T01-00-00.000Z",
    );
    await writeJsonlLines(previousSessionFile, [
      JSON.stringify({
        role: "user",
        content: "hello",
        timestamp: Date.now() - 5000,
      }),
    ]);

    vi.spyOn(sessionQuery, "findPreviousSessionFile").mockResolvedValue(previousSessionFile);
    vi.spyOn(sessionQuery, "extractRecentTurns").mockResolvedValue("U: previous user");
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);

    const api = makePluginApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    await handler(
      { prompt: "hello" },
      { sessionKey: "agent:main:session-start-await", sessionId: "uuid-session-start-await", agentId: "main" },
    );

    expect(resolved).toBe(true);
    expect(runHandoffSpy).toHaveBeenCalledOnce();
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
