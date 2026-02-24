import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClient from "../db/client.js";
import { __testing } from "./index.js";
import plugin from "./index.js";
import * as pluginRecall from "./recall.js";
import * as sessionQuery from "./session-query.js";
import * as pluginSignals from "./signals.js";
import * as pluginTools from "./tools.js";
import { runExtractTool, runRecallTool, runRetireTool, runStoreTool } from "./tools.js";
import type { BeforePromptBuildResult, PluginApi } from "./types.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: {
    write: (chunk: string) => void;
    end: () => void;
  };
  kill: (signal?: NodeJS.Signals | number) => void;
};

function createMockChild(params?: {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: Error;
}): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  child.kill = vi.fn();

  process.nextTick(() => {
    if (params?.error) {
      child.emit("error", params.error);
      return;
    }
    if (params?.stdout) {
      child.stdout.emit("data", Buffer.from(params.stdout));
    }
    if (params?.stderr) {
      child.stderr.emit("data", Buffer.from(params.stderr));
    }
    child.emit("close", params?.code ?? 0);
  });

  return child;
}

function createTimeoutChild(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  child.kill = vi.fn(() => {
    // Emit synchronously so fake timers do not need to fake process.nextTick.
    child.emit("close", null);
  });
  return child;
}

function makeApi(overrides?: Partial<PluginApi>): PluginApi {
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

beforeEach(() => {
  __testing.clearState();
  spawnMock.mockImplementation(() => createMockChild({ code: 0 }));
  vi.spyOn(sessionQuery, "findPreviousSessionFile").mockResolvedValue(null);
  vi.spyOn(sessionQuery, "extractRecentTurns").mockResolvedValue("");
});

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

function getBeforeResetHandler(
  api: PluginApi,
): (
  event: { messages?: unknown[]; sessionFile?: string },
  ctx: { sessionKey?: string; sessionId?: string; agentId?: string },
) => Promise<void> {
  const onMock = api.on as unknown as ReturnType<typeof vi.fn>;
  const call = onMock.mock.calls.find((args) => args[0] === "before_reset");
  if (!call) {
    throw new Error("before_reset handler not registered");
  }
  return call[1] as (
    event: { messages?: unknown[]; sessionFile?: string },
    ctx: { sessionKey?: string; sessionId?: string; agentId?: string },
  ) => Promise<void>;
}

function getCommandHandler(
  api: PluginApi,
): (
  event: {
    type: string;
    action: string;
    sessionKey: string;
    timestamp: Date;
    messages: string[];
    context?: {
      sessionEntry?: { sessionFile?: string; sessionId?: string };
      commandSource?: string;
    };
  },
  ctx: { sessionKey?: string; sessionId?: string; agentId?: string },
) => Promise<void> {
  const onMock = api.on as unknown as ReturnType<typeof vi.fn>;
  const call = onMock.mock.calls.find((args) => args[0] === "command");
  if (!call) {
    throw new Error("command handler not registered");
  }
  return call[1] as (
    event: {
      type: string;
      action: string;
      sessionKey: string;
      timestamp: Date;
      messages: string[];
      context?: {
        sessionEntry?: { sessionFile?: string; sessionId?: string };
        commandSource?: string;
      };
    },
    ctx: { sessionKey?: string; sessionId?: string; agentId?: string },
  ) => Promise<void>;
}

describe("openclaw plugin tool registration", () => {
  it("registers all four tools when registerTool is present", () => {
    const registerTool = vi.fn();
    const api = makeApi({ registerTool });

    plugin.register(api);

    expect(registerTool).toHaveBeenCalledTimes(4);
    const names = registerTool.mock.calls.map(
      (call) => (call[0] as { name: string }).name,
    );
    expect(names).toEqual([
      "agenr_recall",
      "agenr_store",
      "agenr_extract",
      "agenr_retire",
    ]);
  });

  it("skips tool registration when registerTool is absent", () => {
    const api = makeApi();
    expect(() => plugin.register(api)).not.toThrow();
  });
});

describe("before_prompt_build recall behavior", () => {
  it("injects recall on first call and skips recall on repeated sessionId while still checking signals", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "session-start",
      results: [
        {
          entry: {
            type: "fact",
            subject: "subject",
            content: "content",
          },
          score: 0.9,
        },
      ],
    });
    vi.spyOn(dbClient, "getDb").mockReturnValue({} as never);
    vi.spyOn(dbClient, "initDb").mockResolvedValue(undefined);
    const checkSignalsMock = vi
      .spyOn(pluginSignals, "checkSignals")
      .mockResolvedValue("AGENR SIGNAL: 1 new high-importance entry");

    const api = makeApi({
      pluginConfig: {
        signalCooldownMs: 0,
        signalMaxPerSession: 10,
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const sessionKey = "agent:main:tui";

    const first = await handler({}, { sessionKey, sessionId: "uuid-a" });
    const second = await handler({}, { sessionKey, sessionId: "uuid-a" });
    const third = await handler({}, { sessionKey, sessionId: "uuid-b" });

    expect(first?.prependContext).toContain("## agenr Memory Context");
    expect(first?.prependContext).toContain("AGENR SIGNAL");
    expect(second?.prependContext).not.toContain("## agenr Memory Context");
    expect(second?.prependContext).toContain("AGENR SIGNAL");
    expect(third?.prependContext).toContain("## agenr Memory Context");
    expect(runRecallMock).toHaveBeenCalledTimes(2);
    expect(checkSignalsMock).toHaveBeenCalledTimes(3);
  });

  it("passes plugin config project to runRecall", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "session-start",
      results: [],
    });
    vi.spyOn(dbClient, "getDb").mockReturnValue({} as never);
    vi.spyOn(dbClient, "initDb").mockResolvedValue(undefined);
    vi.spyOn(pluginSignals, "checkSignals").mockResolvedValue(null);

    const api = makeApi({
      pluginConfig: {
        project: "  plugin-scope  ",
        signalCooldownMs: 0,
        signalMaxPerSession: 10,
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const prompt = "What should we prioritize for the plugin scoped project today";
    await handler(
      { prompt },
      { sessionKey: "agent:main:scoped", sessionId: "uuid-scope-a" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(2);
    expect(runRecallMock).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.any(Number),
      "plugin-scope",
      undefined,
      { context: "browse", since: "1d", limit: 20 },
    );
    expect(runRecallMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.any(Number),
      "plugin-scope",
      prompt,
    );
  });
});

describe("before_prompt_build cross-session context injection", () => {
  it("first message in new session always runs Phase 1B browse recall", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    await handler(
      { prompt: "hey" },
      { sessionKey: "agent:main:first-browse", sessionId: "uuid-first-browse" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(runRecallMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      undefined,
      undefined,
      { context: "browse", since: "1d", limit: 20 },
    );
  });

  it("injects Phase 1A recent turns when a prior session file exists", async () => {
    vi.spyOn(sessionQuery, "findPreviousSessionFile").mockResolvedValue("/tmp/prev.jsonl");
    vi.spyOn(sessionQuery, "extractRecentTurns").mockResolvedValue("U: previous user | A: previous assistant");
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);

    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const result = await handler(
      { prompt: "hello" },
      { sessionKey: "agent:main:phase-1a", sessionId: "uuid-phase-1a" },
    );

    expect(result?.prependContext).toContain("## Recent session\nU: previous user | A: previous assistant");
  });

  it("for short first message with prior session, Phase 2 seed uses previous turns only", async () => {
    vi.spyOn(sessionQuery, "findPreviousSessionFile").mockResolvedValue("/tmp/prev.jsonl");
    vi.spyOn(sessionQuery, "extractRecentTurns").mockResolvedValue("U: previous user | A: previous assistant");
    const browseResult = {
      query: "[browse]",
      results: [
        {
          entry: {
            id: "browse-1",
            type: "fact",
            subject: "recent",
            content: "recent memory",
          },
          score: 0.9,
        },
      ],
    };
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall");
    runRecallMock.mockResolvedValueOnce(browseResult).mockResolvedValueOnce(null);

    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const result = await handler(
      { prompt: "hey" },
      { sessionKey: "agent:main:short-message", sessionId: "uuid-short-message" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(2);
    expect(runRecallMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.any(Number),
      undefined,
      "U: previous user | A: previous assistant",
    );
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("## Recent memory");
  });

  it("for substantive first message with prior session, injects Phase 1A, 1B, and Phase 2", async () => {
    vi.spyOn(sessionQuery, "findPreviousSessionFile").mockResolvedValue("/tmp/prev.jsonl");
    vi.spyOn(sessionQuery, "extractRecentTurns").mockResolvedValue("U: prior work");
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall");
    runRecallMock
      .mockResolvedValueOnce({
        query: "[browse]",
        results: [
          {
            entry: {
              id: "browse-1",
              type: "fact",
              subject: "browse subject",
              content: "browse content",
            },
            score: 0.9,
          },
        ],
      })
      .mockResolvedValueOnce({
        query: "semantic",
        results: [
          {
            entry: {
              id: "sem-1",
              type: "fact",
              subject: "semantic subject",
              content: "semantic content",
            },
            score: 0.8,
          },
        ],
      });

    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const result = await handler(
      { prompt: "fix the recall bug now" },
      { sessionKey: "agent:main:substantive", sessionId: "uuid-substantive" },
    );

    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("## Recent memory");
    expect(result?.prependContext).toContain("## Relevant memory");
  });

  it("when no prior session file exists, skips Phase 1A and still runs Phase 1B", async () => {
    vi.spyOn(sessionQuery, "findPreviousSessionFile").mockResolvedValue(null);
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "[browse]",
      results: [
        {
          entry: {
            id: "browse-1",
            type: "fact",
            subject: "browse only",
            content: "browse content",
          },
          score: 0.9,
        },
      ],
    });

    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const result = await handler(
      { prompt: "hello" },
      { sessionKey: "agent:main:no-prior", sessionId: "uuid-no-prior" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(result?.prependContext).not.toContain("## Recent session");
    expect(result?.prependContext).toContain("## Recent memory");
  });

  it("second message in same session does not inject context again", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "[browse]",
      results: [
        {
          entry: {
            id: "browse-1",
            type: "fact",
            subject: "browse only",
            content: "browse content",
          },
          score: 0.9,
        },
      ],
    });
    const findPreviousSessionFileMock = vi.spyOn(sessionQuery, "findPreviousSessionFile");
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    const first = await handler(
      { prompt: "hello" },
      { sessionKey: "agent:main:same-session", sessionId: "uuid-same-session" },
    );
    const second = await handler(
      { prompt: "fix it" },
      { sessionKey: "agent:main:same-session", sessionId: "uuid-same-session" },
    );

    expect(first?.prependContext).toContain("## Recent memory");
    expect(second).toBeUndefined();
    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(findPreviousSessionFileMock).toHaveBeenCalledTimes(1);
  });

  it("Phase 2 deduplicates entries already present in Phase 1B by id", async () => {
    vi.spyOn(sessionQuery, "findPreviousSessionFile").mockResolvedValue("/tmp/prev.jsonl");
    vi.spyOn(sessionQuery, "extractRecentTurns").mockResolvedValue("U: prior work");
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall");
    runRecallMock
      .mockResolvedValueOnce({
        query: "[browse]",
        results: [
          {
            entry: {
              id: "dup-id",
              type: "fact",
              subject: "duplicate subject",
              content: "browse content",
            },
            score: 0.9,
          },
        ],
      })
      .mockResolvedValueOnce({
        query: "semantic",
        results: [
          {
            entry: {
              id: "dup-id",
              type: "fact",
              subject: "duplicate subject",
              content: "semantic duplicate content",
            },
            score: 0.8,
          },
          {
            entry: {
              id: "new-id",
              type: "fact",
              subject: "new semantic subject",
              content: "semantic new content",
            },
            score: 0.7,
          },
        ],
      });

    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const result = await handler(
      { prompt: "fix the recall bug now" },
      { sessionKey: "agent:main:dedup", sessionId: "uuid-dedup" },
    );

    expect(result?.prependContext).toContain("## Relevant memory");
    expect(result?.prependContext).toContain("new semantic subject");
    expect(result?.prependContext).not.toContain("semantic duplicate content");
  });

  it("does not deduplicate Phase 2 entries that do not have an id", async () => {
    vi.spyOn(sessionQuery, "findPreviousSessionFile").mockResolvedValue("/tmp/prev.jsonl");
    vi.spyOn(sessionQuery, "extractRecentTurns").mockResolvedValue("U: prior work");
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall");
    runRecallMock
      .mockResolvedValueOnce({
        query: "[browse]",
        results: [
          {
            entry: {
              id: "dup-id",
              type: "fact",
              subject: "duplicate subject",
              content: "browse content",
            },
            score: 0.9,
          },
        ],
      })
      .mockResolvedValueOnce({
        query: "semantic",
        results: [
          {
            entry: {
              type: "fact",
              subject: "no-id semantic subject",
              content: "no-id semantic content",
            },
            score: 0.8,
          },
          {
            entry: {
              id: "dup-id",
              type: "fact",
              subject: "duplicate subject",
              content: "semantic duplicate content",
            },
            score: 0.7,
          },
        ],
      });

    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const result = await handler(
      { prompt: "fix the recall bug now" },
      { sessionKey: "agent:main:no-id-dedup", sessionId: "uuid-no-id-dedup" },
    );

    expect(result?.prependContext).toContain("## Relevant memory");
    expect(result?.prependContext).toContain("no-id semantic subject");
    expect(result?.prependContext).not.toContain("semantic duplicate content");
  });
});

describe("openclaw plugin tool runners", () => {
  it("runRecallTool returns text content on success", async () => {
    spawnMock.mockReturnValueOnce(
      createMockChild({
        stdout: JSON.stringify({
          query: "test",
          results: [],
        }),
      }),
    );

    const result = await runRecallTool("/path/to/agenr", { query: "test" });
    expect(result.content[0]?.type).toBe("text");
  });

  it("runRecallTool passes --limit 0 when limit is explicitly 0", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild({ stdout: JSON.stringify({ query: "x", results: [] }) });
    });

    await runRecallTool("/path/to/agenr", { query: "x", limit: 0 });
    expect(capturedArgs).toContain("--limit");
    const limitIdx = capturedArgs.indexOf("--limit");
    expect(capturedArgs[limitIdx + 1]).toBe("0");
  });

  it("runRecallTool passes --browse and omits query text for context=browse", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild({ stdout: JSON.stringify({ query: "[browse]", results: [] }) });
    });

    await runRecallTool("/path/to/agenr", { context: "browse", query: "ignored text" });

    expect(capturedArgs).toContain("--browse");
    expect(capturedArgs).not.toContain("ignored text");
  });

  it("runRecallTool does not pass --context browse to CLI", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild({ stdout: JSON.stringify({ query: "[browse]", results: [] }) });
    });

    await runRecallTool("/path/to/agenr", { context: "browse" });

    expect(capturedArgs).not.toContain("--context");
    expect(capturedArgs).toContain("--browse");
  });

  it("runRecallTool uses default project when params.project is omitted", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild({ stdout: JSON.stringify({ query: "x", results: [] }) });
    });

    await runRecallTool("/path/to/agenr", { query: "x" }, "project-from-config");
    expect(capturedArgs).toContain("--project");
    const projectIdx = capturedArgs.indexOf("--project");
    expect(capturedArgs[projectIdx + 1]).toBe("project-from-config");
  });

  it("runStoreTool returns stored count on success and sends valid JSON to stdin", async () => {
    let writtenStdin = "";
    const mockChild = createMockChild({ code: 0 });
    mockChild.stdin.write = vi.fn((chunk: string) => {
      writtenStdin += chunk;
    });
    spawnMock.mockReturnValueOnce(mockChild);

    const result = await runStoreTool("/path/to/agenr", {
      entries: [
        { content: "test entry 1", type: "fact" },
        { content: "test entry 2", type: "decision" },
      ],
    });

    expect(result.content[0]?.text).toContain("Stored");
    expect(result.content[0]?.text).toContain("2");
    const payload = JSON.parse(writtenStdin) as Array<{ subject?: string }>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
    expect(payload[0]?.subject).toBe("test entry 1");
  });

  it("runStoreTool keeps explicit subject values from params", async () => {
    let writtenStdin = "";
    const mockChild = createMockChild({ code: 0 });
    mockChild.stdin.write = vi.fn((chunk: string) => {
      writtenStdin += chunk;
    });
    spawnMock.mockReturnValueOnce(mockChild);

    await runStoreTool("/path/to/agenr", {
      entries: [{ content: "entry content", subject: "explicit subject", type: "fact" }],
    });

    const payload = JSON.parse(writtenStdin) as Array<{ subject?: string }>;
    expect(payload[0]?.subject).toBe("explicit subject");
  });

  it("runStoreTool subject inference does not truncate at file path periods", async () => {
    let writtenStdin = "";
    const mockChild = createMockChild({ code: 0 });
    mockChild.stdin.write = vi.fn((chunk: string) => {
      writtenStdin += chunk;
    });
    spawnMock.mockReturnValueOnce(mockChild);

    const content = "Use /tmp/notes.txt for reference and keep parsing safely";
    await runStoreTool("/path/to/agenr", {
      entries: [{ content, type: "fact" }],
    });

    const payload = JSON.parse(writtenStdin) as Array<{ subject?: string }>;
    expect(payload[0]?.subject).toBe(content);
  });

  it("runStoreTool passes dedup flags from plugin config", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild({ code: 0 });
    });

    await runStoreTool(
      "/path/to/agenr",
      { entries: [{ content: "test entry", type: "fact" }] },
      { dedup: { aggressive: true, threshold: 0.65 } },
    );

    expect(capturedArgs).toContain("store");
    expect(capturedArgs).toContain("--aggressive");
    expect(capturedArgs).toContain("--dedup-threshold");
    const thresholdIdx = capturedArgs.indexOf("--dedup-threshold");
    expect(capturedArgs[thresholdIdx + 1]).toBe("0.65");
  });

  it("runStoreTool normalizes a valid platform before passing it to CLI", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild({ code: 0 });
    });

    await runStoreTool("/path/to/agenr", {
      platform: " CoDeX ",
      entries: [{ content: "test entry", type: "fact" }],
    });

    expect(capturedArgs).toContain("--platform");
    const platformIdx = capturedArgs.indexOf("--platform");
    expect(capturedArgs[platformIdx + 1]).toBe("codex");
  });

  it("runStoreTool omits invalid platform and warns", async () => {
    let capturedArgs: string[] = [];
    const warn = vi.fn();
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild({ code: 0 });
    });

    await runStoreTool(
      "/path/to/agenr",
      {
        platform: "not-a-platform",
        entries: [{ content: "test entry", type: "fact" }],
      },
      { logger: { warn } },
    );

    expect(capturedArgs).not.toContain("--platform");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("invalid platform");
  });

  it("runStoreTool infers platform from source.file when platform is omitted", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild({ code: 0 });
    });

    await runStoreTool("/path/to/agenr", {
      entries: [
        {
          content: "test entry",
          type: "fact",
          source: { file: "/tmp/claude-sessions/chat.jsonl" },
        },
      ],
    });

    expect(capturedArgs).toContain("--platform");
    const platformIdx = capturedArgs.indexOf("--platform");
    expect(capturedArgs[platformIdx + 1]).toBe("claude-code");
  });

  it("runStoreTool warns once when source string does not use recommended prefixes", async () => {
    const warn = vi.fn();
    spawnMock.mockReturnValueOnce(createMockChild({ code: 0 }));

    await runStoreTool(
      "/path/to/agenr",
      {
        entries: [
          { content: "one", type: "fact", source: "notes.txt" },
          { content: "two", type: "fact", source: "misc source" },
        ],
      },
      { logger: { warn } },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "agenr_store: source_file does not follow recommended format (mcp:, file:, cli:, session:, conversation). Storing as-is.",
    );
  });

  it("runStoreTool uses default project when params.project is omitted", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild({ code: 0 });
    });

    await runStoreTool(
      "/path/to/agenr",
      { entries: [{ content: "test entry", type: "fact" }] },
      undefined,
      "project-from-config",
    );

    expect(capturedArgs).toContain("--project");
    const projectIdx = capturedArgs.indexOf("--project");
    expect(capturedArgs[projectIdx + 1]).toBe("project-from-config");
  });

  it("runExtractTool returns parseable json text on success", async () => {
    spawnMock.mockReturnValueOnce(
      createMockChild({
        stdout: JSON.stringify({
          entries: [{ content: "some text", type: "fact" }],
        }),
      }),
    );

    const result = await runExtractTool("/path/to/agenr", { text: "some text" });
    expect(result.content[0]?.type).toBe("text");
    expect(() => JSON.parse(result.content[0]?.text ?? "")).not.toThrow();
  });

  it("runExtractTool runs store step and injects source when store=true", async () => {
    let extractArgs: string[] = [];
    let storeArgs: string[] = [];
    let storeStdin = "";

    spawnMock
      .mockImplementationOnce((_cmd: string, args: string[]) => {
        extractArgs = args;
        return createMockChild({
          stdout: JSON.stringify([{ content: "some text", type: "fact", subject: "Some subject" }]),
        });
      })
      .mockImplementationOnce((_cmd: string, args: string[]) => {
        storeArgs = args;
        const child = createMockChild({ code: 0 });
        child.stdin.write = vi.fn((chunk: string) => {
          storeStdin += chunk;
        });
        return child;
      });

    const result = await runExtractTool("/path/to/agenr", {
      text: "some text",
      store: true,
      source: "/tmp/source.txt",
    });

    expect(result.content[0]?.text).toContain("Extracted and stored 1 entries.");
    expect(extractArgs).toContain("extract");
    expect(extractArgs).toContain("--json");
    expect(extractArgs).not.toContain("--store");
    expect(extractArgs).not.toContain("--source");
    expect(storeArgs).toContain("store");
    const payload = JSON.parse(storeStdin) as Array<{ source?: { file?: string; context?: string } }>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload[0]?.source).toEqual({ file: "/tmp/source.txt", context: "extracted via agenr_extract" });
  });

  it("runRetireTool includes --force in args", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild({ code: 0 });
    });

    const result = await runRetireTool("/path/to/agenr", { entry_id: "test-id-123" });

    expect(result.content[0]?.text).toContain("Retired entry test-id-123");
    expect(capturedArgs).toContain("--id");
    const idIdx = capturedArgs.indexOf("--id");
    expect(capturedArgs[idIdx + 1]).toBe("test-id-123");
    expect(capturedArgs).toContain("--force");
  });

  it("runRetireTool does not pass stdinPayload to runAgenrCommand", async () => {
    let childRef: MockChildProcess | undefined;
    spawnMock.mockImplementationOnce(() => {
      const child = createMockChild({ code: 0 });
      childRef = child;
      return child;
    });

    await runRetireTool("/path/to/agenr", { entry_id: "test-id-123" });

    expect(childRef?.stdin.write).not.toHaveBeenCalled();
  });

  it("returns timeout message when command exceeds timeout", async () => {
    vi.useFakeTimers();
    try {
      spawnMock.mockReturnValueOnce(createTimeoutChild());

      const resultPromise = runRecallTool("/path/to/agenr", { query: "test" });
      await vi.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;

      expect(result.content[0]?.text).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns stderr message when command exits non-zero", async () => {
    spawnMock.mockReturnValueOnce(
      createMockChild({
        code: 1,
        stderr: "something went wrong",
      }),
    );

    const result = await runRecallTool("/path/to/agenr", { query: "test" });
    expect(result.content[0]?.text).toContain("something went wrong");
  });
});

describe("sessionSignalState gating", () => {
  it("suppresses delivery when within cooldown window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
      vi.spyOn(dbClient, "getDb").mockReturnValue({} as never);
      vi.spyOn(dbClient, "initDb").mockResolvedValue(undefined);
      const checkSignalsMock = vi
        .spyOn(pluginSignals, "checkSignals")
        .mockResolvedValue("AGENR SIGNAL: 1 new high-importance entry");

      const api = makeApi({
        pluginConfig: {
          signalCooldownMs: 60_000,
          signalMaxPerSession: 10,
        },
      });
      plugin.register(api);
      const handler = getBeforePromptBuildHandler(api);
      const sessionKey = "agent:main:cooldown-gating";

      const first = await handler({}, { sessionKey });
      const second = await handler({}, { sessionKey });

      expect(first?.prependContext).toContain("AGENR SIGNAL");
      expect(second).toBeUndefined();
      expect(checkSignalsMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses delivery when session cap is reached", async () => {
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    vi.spyOn(dbClient, "getDb").mockReturnValue({} as never);
    vi.spyOn(dbClient, "initDb").mockResolvedValue(undefined);
    const checkSignalsMock = vi
      .spyOn(pluginSignals, "checkSignals")
      .mockResolvedValue("AGENR SIGNAL: 1 new high-importance entry");

    const api = makeApi({
      pluginConfig: {
        signalCooldownMs: 0,
        signalMaxPerSession: 1,
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const sessionKey = "agent:main:session-cap-gating";

    const first = await handler({}, { sessionKey });
    const second = await handler({}, { sessionKey });

    expect(first?.prependContext).toContain("AGENR SIGNAL");
    expect(second).toBeUndefined();
    expect(checkSignalsMock).toHaveBeenCalledTimes(2);
  });

  it("allows delivery after cooldown has elapsed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
      vi.spyOn(dbClient, "getDb").mockReturnValue({} as never);
      vi.spyOn(dbClient, "initDb").mockResolvedValue(undefined);
      const checkSignalsMock = vi
        .spyOn(pluginSignals, "checkSignals")
        .mockResolvedValue("AGENR SIGNAL: 1 new high-importance entry");

      const api = makeApi({
        pluginConfig: {
          signalCooldownMs: 1000,
          signalMaxPerSession: 10,
        },
      });
      plugin.register(api);
      const handler = getBeforePromptBuildHandler(api);
      const sessionKey = "agent:main:cooldown-elapsed-gating";

      const first = await handler({}, { sessionKey });
      vi.advanceTimersByTime(1001);
      const second = await handler({}, { sessionKey });

      expect(first?.prependContext).toContain("AGENR SIGNAL");
      expect(second?.prependContext).toContain("AGENR SIGNAL");
      expect(checkSignalsMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("before_prompt_build handoff auto-retire", () => {
  it("retires handoff entry surfaced by browse at session start", async () => {
    const browseResult = {
      query: "[browse]",
      results: [
        {
          entry: {
            id: "handoff-entry-abc",
            type: "event",
            subject: "session handoff 2026-02-23 12:00",
            content: "Working on browse mode implementation",
            importance: 10,
          },
          score: 0.95,
        },
      ],
    };
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(browseResult);

    let retireCapturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      retireCapturedArgs = args;
      return createMockChild({ code: 0 });
    });

    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    await handler(
      { prompt: "/new" },
      { sessionKey: "agent:main:retire-handoff", sessionId: "uuid-retire-handoff" },
    );

    expect(retireCapturedArgs).toContain("retire");
    const idIdx = retireCapturedArgs.indexOf("--id");
    expect(retireCapturedArgs[idIdx + 1]).toBe("handoff-entry-abc");
  });

  it("does not retire non-handoff entries surfaced by browse", async () => {
    const browseResult = {
      query: "[browse]",
      results: [
        {
          entry: {
            id: "fact-entry-xyz",
            type: "fact",
            subject: "user prefers tabs over spaces",
            content: "...",
            importance: 8,
          },
          score: 0.8,
        },
      ],
    };
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(browseResult);

    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    await handler(
      { prompt: "/new" },
      { sessionKey: "agent:main:no-retire-fact", sessionId: "uuid-no-retire-fact" },
    );

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("retire failure is swallowed and before_prompt_build still resolves", async () => {
    const browseResult = {
      query: "[browse]",
      results: [
        {
          entry: {
            id: "handoff-fail-id",
            type: "event",
            subject: "session handoff 2026-02-23 11:00",
            content: "Previous session work",
            importance: 10,
          },
          score: 0.95,
        },
      ],
    };
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(browseResult);

    spawnMock.mockImplementationOnce(() => {
      return createMockChild({ code: 1, stderr: "retire failed" });
    });

    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    await expect(
      handler({ prompt: "/new" }, { sessionKey: "agent:main:retire-fail", sessionId: "uuid-retire-fail" }),
    ).resolves.not.toThrow();
  });

  it("skips retire when handoff entry id is missing or empty", async () => {
    const browseResult = {
      query: "[browse]",
      results: [
        {
          entry: {
            type: "event",
            subject: "session handoff 2026-02-23 10:00",
            content: "Previous session work",
            importance: 10,
          },
          score: 0.95,
        },
      ],
    };
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(browseResult);

    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    await expect(
      handler({ prompt: "/new" }, { sessionKey: "agent:main:retire-no-id", sessionId: "uuid-retire-no-id" }),
    ).resolves.not.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("before_reset handoff store", () => {
  it("stores handoff with exchange context", async () => {
    let capturedStdinPayload: unknown;
    const mockChild = createMockChild({ code: 0 });
    mockChild.stdin.write = vi.fn((chunk: string) => {
      capturedStdinPayload = JSON.parse(chunk);
    });
    spawnMock.mockReturnValueOnce(mockChild);

    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);

    await handler(
      {
        messages: [
          { role: "user", content: "Working on session handoff behavior" },
          { role: "assistant", content: "I can update the implementation and tests now" },
          { role: "user", content: "Do it and include swarm findings in the patch" },
        ],
      },
      { sessionKey: "agent:main:handoff-store-test" },
    );

    expect(Array.isArray(capturedStdinPayload)).toBe(true);
    const entries = capturedStdinPayload as Array<{
      type: string;
      importance: number;
      subject: string;
      content: string;
    }>;
    expect(entries[0]?.type).toBe("event");
    expect(entries[0]?.importance).toBe(9);
    expect(entries[0]?.subject).toMatch(/^session handoff/i);
    expect(entries[0]?.content).toContain("U:");
    expect(entries[0]?.content).toContain("A:");
    expect(entries[0]?.content).toContain("U: Do it and include swarm findings in the patch");
  });

  it("passes project to runStoreTool when config has project set", async () => {
    let capturedArgs: string[] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild({ code: 0 });
    });

    const api = makeApi({
      pluginConfig: { project: "  my-project  " },
    });
    plugin.register(api);
    const handler = getBeforeResetHandler(api);

    await handler(
      {
        messages: [{ role: "user", content: "Capture this handoff with project context included for browse recall" }],
      },
      { sessionKey: "agent:main:handoff-project-scope" },
    );

    expect(capturedArgs).toContain("--project");
    const projectIdx = capturedArgs.indexOf("--project");
    expect(capturedArgs[projectIdx + 1]).toBe("my-project");
  });

  it("stores fallback and upgrades with LLM summary before returning", async () => {
    vi.spyOn(__testing, "summarizeSessionForHandoff").mockResolvedValue(
      "WORKING ON: Completed issue #199 handoff summary.",
    );
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockResolvedValue({
      content: [{ type: "text", text: "Stored 1 entries." }],
    });

    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);

    await handler(
      {
        sessionFile: "/tmp/current-session.jsonl",
        messages: [
          { role: "user", content: "Implement issue 199 summary flow." },
          { role: "assistant", content: "Done. Added merged transcript and summary." },
          { role: "user", content: "Store the summary in handoff." },
        ],
      },
      { sessionKey: "agent:main:handoff-summary", agentId: "main" },
    );

    expect(runStoreMock).toHaveBeenCalledTimes(2);
    const firstPayload = runStoreMock.mock.calls[0]?.[1] as { entries: Array<{ importance: number; content: string }> };
    expect(firstPayload.entries[0]?.importance).toBe(9);
    expect(firstPayload.entries[0]?.content).toContain("U:");

    const secondPayload = runStoreMock.mock.calls[1]?.[1] as { entries: Array<{ importance: number; content: string }> };
    expect(secondPayload.entries[0]?.importance).toBe(9);
    expect(secondPayload.entries[0]?.content).toBe("WORKING ON: Completed issue #199 handoff summary.");
  });

  it("keeps fallback entry when summarizer returns null", async () => {
    vi.spyOn(__testing, "summarizeSessionForHandoff").mockResolvedValue(null);
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockResolvedValue({
      content: [{ type: "text", text: "Stored 1 entries." }],
    });

    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);

    await handler(
      {
        sessionFile: "/tmp/current-session.jsonl",
        messages: [
          { role: "user", content: "Fallback should include user context." },
          { role: "assistant", content: "Assistant context should be included too." },
          { role: "user", content: "Please preserve this turn in fallback." },
        ],
      },
      { sessionKey: "agent:main:handoff-fallback", agentId: "main" },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(runStoreMock).toHaveBeenCalledTimes(1);
    const payload = runStoreMock.mock.calls[0]?.[1] as {
      entries: Array<{ importance: number; content: string }>;
    };
    expect(payload.entries[0]?.importance).toBe(9);
    expect(payload.entries[0]?.content).toContain("U:");
    expect(payload.entries[0]?.content).toContain("A:");
    expect(payload.entries[0]?.content).toContain("Please preserve this turn in fallback.");
  });

  it("logs debug and uses fallback when event.sessionFile is missing", async () => {
    const debug = vi.fn();
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockResolvedValue({
      content: [{ type: "text", text: "Stored 1 entries." }],
    });
    const api = makeApi({
      logger: {
        warn: vi.fn(),
        error: vi.fn(),
        debug,
      },
    });
    plugin.register(api);
    const handler = getBeforeResetHandler(api);

    await handler(
      {
        messages: [
          { role: "user", content: "Use fallback because sessionFile is missing." },
          { role: "assistant", content: "Acknowledged." },
        ],
      },
      { sessionKey: "agent:main:no-session-file" },
    );

    expect(runStoreMock).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("[agenr] before_reset: no sessionFile in event, using fallback");
  });
});

describe("summarizeSessionForHandoff logging skip paths", () => {
  it("returns null for short transcripts without throwing", async () => {
    const api = makeApi();
    const summaryPromise = __testing.summarizeSessionForHandoff(
      [
        { role: "user", content: "short one" },
        { role: "assistant", content: "short two" },
      ],
      "/tmp/agenr-missing-sessions-dir",
      "/tmp/current-session-short.jsonl",
      api.logger,
    );

    await expect(summaryPromise).resolves.toBeNull();
  });
});

describe("command hook handoff", () => {
  it("fires handoff for action=new with valid sessionFile", async () => {
    vi.spyOn(__testing, "summarizeSessionForHandoff").mockResolvedValue(null);
    vi.spyOn(__testing, "readAndParseSessionJsonl").mockResolvedValue([
      { role: "user", content: "Please carry this into the next session." },
      { role: "assistant", content: "Acknowledged, capturing handoff now." },
      { role: "user", content: "Focus on issue #210 command reset path." },
    ]);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockResolvedValue({
      content: [{ type: "text", text: "Stored 1 entries." }],
    });

    const api = makeApi();
    plugin.register(api);
    const handler = getCommandHandler(api);

    await handler(
      {
        type: "command",
        action: "new",
        sessionKey: "agent:main:command-new",
        timestamp: new Date(),
        messages: [],
        context: {
          commandSource: "gateway-rpc",
          sessionEntry: {
            sessionId: "session-210-cmd-new",
            sessionFile: "/tmp/session-210-cmd-new.jsonl",
          },
        },
      },
      { sessionKey: "agent:main:command-new", agentId: "main" },
    );

    expect(runStoreMock).toHaveBeenCalledTimes(1);
    const payload = runStoreMock.mock.calls[0]?.[1] as {
      entries: Array<{ type: string; importance: number; tags: string[] }>;
    };
    expect(payload.entries[0]?.type).toBe("event");
    expect(payload.entries[0]?.importance).toBe(9);
    expect(payload.entries[0]?.tags).toContain("handoff");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[agenr] command: triggered action=new sessionKey=agent:main:command-new",
    );
    expect(consoleLogSpy).toHaveBeenCalledWith("[agenr] command: handoff complete");
  });

  it("skips handoff for action=stop", async () => {
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockResolvedValue({
      content: [{ type: "text", text: "Stored 1 entries." }],
    });

    const api = makeApi();
    plugin.register(api);
    const handler = getCommandHandler(api);

    await handler(
      {
        type: "command",
        action: "stop",
        sessionKey: "agent:main:command-stop",
        timestamp: new Date(),
        messages: [],
        context: {
          sessionEntry: {
            sessionId: "session-210-cmd-stop",
            sessionFile: "/tmp/session-210-cmd-stop.jsonl",
          },
        },
      },
      { sessionKey: "agent:main:command-stop", agentId: "main" },
    );

    expect(runStoreMock).not.toHaveBeenCalled();
  });

  it("skips handoff when no messages parsed from JSONL", async () => {
    vi.spyOn(__testing, "readAndParseSessionJsonl").mockResolvedValue([]);
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockResolvedValue({
      content: [{ type: "text", text: "Stored 1 entries." }],
    });

    const api = makeApi();
    plugin.register(api);
    const handler = getCommandHandler(api);

    await handler(
      {
        type: "command",
        action: "reset",
        sessionKey: "agent:main:command-empty",
        timestamp: new Date(),
        messages: [],
        context: {
          sessionEntry: {
            sessionId: "session-210-cmd-empty",
            sessionFile: "/tmp/session-210-cmd-empty.jsonl",
          },
        },
      },
      { sessionKey: "agent:main:command-empty", agentId: "main" },
    );

    expect(runStoreMock).not.toHaveBeenCalled();
  });

  it("dedup: second handler call with same sessionId is skipped", async () => {
    vi.spyOn(__testing, "summarizeSessionForHandoff").mockResolvedValue(null);
    vi.spyOn(__testing, "readAndParseSessionJsonl").mockResolvedValue([
      { role: "user", content: "First handoff call should store." },
      { role: "assistant", content: "Second call should dedup skip." },
    ]);
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockResolvedValue({
      content: [{ type: "text", text: "Stored 1 entries." }],
    });

    const api = makeApi();
    plugin.register(api);
    const handler = getCommandHandler(api);
    const event = {
      type: "command",
      action: "new",
      sessionKey: "agent:main:command-dedup",
      timestamp: new Date(),
      messages: [],
      context: {
        sessionEntry: {
          sessionId: "session-210-cmd-dedup",
          sessionFile: "/tmp/session-210-cmd-dedup.jsonl",
        },
      },
    };

    await handler(event, { sessionKey: "agent:main:command-dedup", agentId: "main" });
    await handler(event, { sessionKey: "agent:main:command-dedup", agentId: "main" });

    expect(runStoreMock).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "[agenr] command: dedup skip sessionId=session-210-cmd-dedup",
    );
  });

  it("dedup: before_reset and command with same sessionId only write one entry", async () => {
    vi.spyOn(__testing, "readAndParseSessionJsonl").mockResolvedValue([
      { role: "user", content: "Command path should be deduped by sessionId." },
      { role: "assistant", content: "before_reset already stored fallback." },
    ]);
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockResolvedValue({
      content: [{ type: "text", text: "Stored 1 entries." }],
    });

    const api = makeApi();
    plugin.register(api);
    const beforeResetHandler = getBeforeResetHandler(api);
    const commandHandler = getCommandHandler(api);

    await beforeResetHandler(
      {
        messages: [
          { role: "user", content: "Persist this fallback before reset." },
          { role: "assistant", content: "Persisted." },
        ],
      },
      { sessionKey: "agent:main:before-reset-dedup", sessionId: "session-210-shared", agentId: "main" },
    );

    await commandHandler(
      {
        type: "command",
        action: "new",
        sessionKey: "agent:main:before-reset-dedup",
        timestamp: new Date(),
        messages: [],
        context: {
          sessionEntry: {
            sessionId: "session-210-shared",
            sessionFile: "/tmp/session-210-shared.jsonl",
          },
        },
      },
      { sessionKey: "agent:main:before-reset-dedup", agentId: "main" },
    );

    expect(runStoreMock).toHaveBeenCalledTimes(1);
  });
});
