import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClient from "../db/client.js";
import { __testing } from "./index.js";
import plugin from "./index.js";
import * as pluginRecall from "./recall.js";
import {
  clearStash,
  extractLastUserText,
  isThinPrompt,
  resolveSessionQuery,
  SESSION_TOPIC_TTL_MS,
  shouldStashTopic,
  sweepInterval,
} from "./session-query.js";
import * as pluginSignals from "./signals.js";
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
  return {
    id: "agenr",
    name: "agenr memory context",
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn() as unknown as PluginApi["on"],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

beforeEach(() => {
  __testing.clearState();
  spawnMock.mockImplementation(() => createMockChild({ code: 0 }));
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
  event: { messages?: unknown[] },
  ctx: { sessionKey?: string; sessionId?: string },
) => void {
  const onMock = api.on as unknown as ReturnType<typeof vi.fn>;
  const call = onMock.mock.calls.find((args) => args[0] === "before_reset");
  if (!call) {
    throw new Error("before_reset handler not registered");
  }
  return call[1] as (
    event: { messages?: unknown[] },
    ctx: { sessionKey?: string; sessionId?: string },
  ) => void;
}

function seedStashWithMessage(
  handler: ReturnType<typeof getBeforeResetHandler>,
  sessionKey: string,
  text: string,
): void {
  handler(
    {
      messages: [{ role: "user", content: text }],
    },
    { sessionKey },
  );
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

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(runRecallMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      "plugin-scope",
      prompt,
    );
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

  it("runRetireTool returns success message on exit code 0", async () => {
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

describe("before_prompt_build query seeding", () => {
  it("uses high-signal prompt when no stash is present", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const sessionKey = "agent:main:seed-high-no-stash";

    await handler(
      { prompt: "What is the current status?" },
      { sessionKey, sessionId: "uuid-seed-high-no-stash" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(runRecallMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      undefined,
      "What is the current status?",
    );
    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
  });

  it("uses stash as query when live prompt is low-signal and stash is present", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const promptHandler = getBeforePromptBuildHandler(api);
    const resetHandler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:seed-low-with-stash";
    const stashedText = "Please continue discussing release risks across deployment and rollback checks";
    seedStashWithMessage(resetHandler, sessionKey, stashedText);

    await promptHandler(
      { prompt: "Check release blockers" },
      { sessionKey, sessionId: "uuid-seed-low-with-stash" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(runRecallMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      undefined,
      stashedText,
    );
    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
  });

  it("substantive prompt uses embed path", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const longPrompt = "this prompt is clearly long enough to use the embed path";

    await handler(
      { prompt: longPrompt },
      { sessionKey: "agent:main:embed-substantive", sessionId: "uuid-embed-substantive" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(runRecallMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      undefined,
      longPrompt,
    );
  });

  it("thin prompt with stash uses embed path with stash", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const promptHandler = getBeforePromptBuildHandler(api);
    const resetHandler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:thin-with-stash-embed";
    const stashedText = "this stashed topic should be used for recall query seeding";
    seedStashWithMessage(resetHandler, sessionKey, stashedText);

    await promptHandler(
      { prompt: "/new" },
      { sessionKey, sessionId: "uuid-thin-with-stash-embed", agentId: "main" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(runRecallMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      undefined,
      stashedText,
    );
  });

  it("runs recall once per session even when first prompt is thin", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const sessionId = "uuid-same-session-no-second-recall";

    await handler(
      { prompt: "/new" },
      { sessionKey: "agent:main:same-session", sessionId, agentId: "main" },
    );
    await handler(
      { prompt: "yes" },
      { sessionKey: "agent:main:same-session", sessionId, agentId: "main" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(1);
  });

  it("uses agentId main as fallback when ctx.agentId is absent", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const debugLogger = vi.fn();
    const api = makeApi({
      pluginConfig: { signalsEnabled: false },
      logger: {
        debug: debugLogger,
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    await handler(
      { prompt: "/new" },
      { sessionKey: "agent:main:agentid-fallback", sessionId: "uuid-agentid-fallback" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(runRecallMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      undefined,
      undefined,
      { context: "browse", since: "1d" },
    );
    expect(debugLogger).toHaveBeenCalledWith(
      "[agenr] cold-start: agentId not in ctx, defaulting to 'main'",
    );
  });

  it("strips OpenClaw prompt metadata envelope before resolving query", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const promptHandler = getBeforePromptBuildHandler(api);
    const resetHandler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:seed-metadata-envelope";
    const stashedText = "Please continue discussing release risks across deployment and rollback checks";
    seedStashWithMessage(resetHandler, sessionKey, stashedText);
    const rawPrompt = `Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "08f2ed82-1111-2222-3333-444455556666",
  "sender_id": "gateway-client",
  "sender": "gateway-client"
}
\`\`\`

[Sun 2026-02-22 21:08 CST] hey`;

    await promptHandler(
      { prompt: rawPrompt },
      { sessionKey, sessionId: "uuid-seed-metadata-envelope" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(runRecallMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      undefined,
      stashedText,
    );
    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
  });

  it("blends stash and high-signal live prompt when both present at integration level", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const promptHandler = getBeforePromptBuildHandler(api);
    const resetHandler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:blend-high-with-stash";
    const stashedText = "Please continue discussing release risks across deployment and rollback checks";
    const livePrompt = "Let us pick up the recall blend work and fix the stash query seeding logic";
    seedStashWithMessage(resetHandler, sessionKey, stashedText);

    await promptHandler(
      { prompt: livePrompt },
      { sessionKey, sessionId: "uuid-blend-high-with-stash" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(runRecallMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      undefined,
      `${stashedText} ${livePrompt}`,
    );
    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
  });

  it("thin prompt with no stash uses browse mode recall", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);

    await handler(
      { prompt: "/new" },
      { sessionKey: "agent:main:thin-no-stash", sessionId: "uuid-thin-no-stash" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(runRecallMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      undefined,
      undefined,
      { context: "browse", since: "1d" },
    );
  });

  it("falls back to valid stash text for thin prompt and consumes stash", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const promptHandler = getBeforePromptBuildHandler(api);
    const resetHandler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:thin-with-stash";
    const stashedText = "Please continue from the previous deployment migration issue and retry checks";
    seedStashWithMessage(resetHandler, sessionKey, stashedText);

    await promptHandler({ prompt: "/new" }, { sessionKey, sessionId: "uuid-thin-with-stash" });

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(runRecallMock).toHaveBeenCalledWith(expect.any(String), expect.any(Number), undefined, stashedText);
    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
  });

  it("drops expired stash for thin prompt and still consumes stash entry", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
      const api = makeApi({ pluginConfig: { signalsEnabled: false } });
      plugin.register(api);
      const promptHandler = getBeforePromptBuildHandler(api);
      const resetHandler = getBeforeResetHandler(api);
      const sessionKey = "agent:main:thin-expired-stash";
      seedStashWithMessage(
        resetHandler,
        sessionKey,
        "Keep investigating the retry queue behavior before release goes live",
      );
      vi.advanceTimersByTime(SESSION_TOPIC_TTL_MS + 1);

      await promptHandler({ prompt: "/new" }, { sessionKey, sessionId: "uuid-thin-expired-stash" });

      expect(runRecallMock).toHaveBeenCalledTimes(1);
      expect(runRecallMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Number),
        undefined,
        undefined,
        { context: "browse", since: "1d" },
      );
      expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats missing prompt key as thin and falls back to stash", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const promptHandler = getBeforePromptBuildHandler(api);
    const resetHandler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:thin-undefined-prompt";
    const stashedText = "Continue evaluating migration planning and rollback readiness this afternoon";
    seedStashWithMessage(resetHandler, sessionKey, stashedText);

    await promptHandler({}, { sessionKey, sessionId: "uuid-thin-undefined-prompt" });

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(runRecallMock).toHaveBeenCalledWith(expect.any(String), expect.any(Number), undefined, stashedText);
  });

  it("runs recall once per session and stash stays consumed after first call", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue(null);
    const api = makeApi({ pluginConfig: { signalsEnabled: false } });
    plugin.register(api);
    const promptHandler = getBeforePromptBuildHandler(api);
    const resetHandler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:thin-run-once";
    seedStashWithMessage(
      resetHandler,
      sessionKey,
      "Resume discussion about release timing and rollout plan with rollback coverage",
    );

    await promptHandler({ prompt: "/new" }, { sessionKey, sessionId: "uuid-thin-run-once" });
    await promptHandler({ prompt: "/new" }, { sessionKey, sessionId: "uuid-thin-run-once" });

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
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

describe("before_reset topic stashing", () => {
  it("stashes the last long user message for sessionKey", () => {
    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:reset-long-user";

    handler(
      {
        messages: [
          { role: "assistant", content: "ok" },
          {
            role: "user",
            content: "   Continue work on ingestion retry failure investigation and release checklists   ",
          },
        ],
      },
      { sessionKey },
    );

    expect(resolveSessionQuery("/new", sessionKey)).toBe(
      "Continue work on ingestion retry failure investigation and release checklists",
    );
  });

  it("does not stash when last user message is shorter than minimum length", () => {
    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:reset-short-user";

    handler(
      {
        messages: [{ role: "user", content: "thanks team" }],
      },
      { sessionKey },
    );

    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
  });

  it("does not modify stash when there are no user messages", () => {
    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);

    handler(
      {
        messages: [{ role: "assistant", content: "no user content" }],
      },
      { sessionKey: "agent:main:reset-no-user" },
    );

    expect(resolveSessionQuery("/new", "agent:main:reset-no-user")).toBeUndefined();
  });

  it("does not stash when messages are undefined or empty", () => {
    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:reset-empty-messages";

    handler({}, { sessionKey });
    handler({ messages: [] }, { sessionKey });

    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
  });

  it("overwrites stash with newer value when before_reset fires twice", () => {
    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:reset-overwrite";

    handler(
      {
        messages: [{ role: "user", content: "First long message about parsing adapters and migrations safety" }],
      },
      { sessionKey },
    );
    handler(
      {
        messages: [{ role: "user", content: "Second long message about session query seeding behavior updates" }],
      },
      { sessionKey },
    );

    expect(resolveSessionQuery("/new", sessionKey)).toBe(
      "Second long message about session query seeding behavior updates",
    );
  });

  it("does not stash anything when sessionKey is undefined", () => {
    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);

    handler(
      {
        messages: [{ role: "user", content: "Long topic text that should never be stashed without a session key" }],
      },
      {},
    );

    expect(resolveSessionQuery("/new", "agent:main:missing-session-key")).toBeUndefined();
  });

  it("does not stash when concatenated text has fewer than five words", () => {
    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:reset-few-words";

    handler(
      {
        messages: [
          { role: "user", content: "nice" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "great" },
          { role: "user", content: "ok" },
        ],
      },
      { sessionKey },
    );

    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
  });

  it("does not stash when concatenated text meets length but has fewer than five words", () => {
    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:reset-long-few-words";

    handler(
      {
        messages: [
          {
            role: "user",
            content: "Superlongpaddddddddddddddddddddddddd one",
          },
        ],
      },
      { sessionKey },
    );

    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
  });

  it("stashes concatenated result from the last three user messages", () => {
    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:reset-last-three";

    handler(
      {
        messages: [
          { role: "user", content: "Let us review the deployment pipeline" },
          { role: "assistant", content: "sure" },
          { role: "user", content: "Focus on the retry logic" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "And then check the alert thresholds" },
        ],
      },
      { sessionKey },
    );

    expect(resolveSessionQuery("/new", sessionKey)).toBe(
      "Let us review the deployment pipeline Focus on the retry logic And then check the alert thresholds",
    );
  });

  it("stashes array-content user messages correctly", () => {
    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);
    const sessionKey = "agent:main:reset-array-content";

    handler(
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Continue the migration work and validate every rollback path" }],
          },
          { role: "assistant", content: "sure" },
          { role: "user", content: "Then verify the final release checklist before deploying to production" },
        ],
      },
      { sessionKey },
    );

    expect(resolveSessionQuery("/new", sessionKey)).toBe(
      "Continue the migration work and validate every rollback path Then verify the final release checklist before deploying to production",
    );
  });

  it("before_reset stores a session handoff entry when last user text is non-empty", async () => {
    let capturedStdinPayload: unknown;
    const mockChild = createMockChild({ code: 0 });
    mockChild.stdin.write = vi.fn((chunk: string) => {
      capturedStdinPayload = JSON.parse(chunk);
    });
    spawnMock.mockReturnValueOnce(mockChild);

    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);

    handler(
      {
        messages: [
          { role: "user", content: "Working on the session handoff feature and testing auto-retire behavior" },
        ],
      },
      { sessionKey: "agent:main:handoff-store-test" },
    );

    await new Promise<void>((resolve) => {
      process.nextTick(resolve);
    });

    expect(Array.isArray(capturedStdinPayload)).toBe(true);
    const entries = capturedStdinPayload as Array<{ type: string; importance: number; subject: string }>;
    expect(entries[0]?.type).toBe("event");
    expect(entries[0]?.importance).toBe(10);
    expect(entries[0]?.subject).toMatch(/^session handoff/i);
  });
});

describe("isThinPrompt", () => {
  it("returns true for empty and reset commands", () => {
    expect(isThinPrompt("")).toBe(true);
    expect(isThinPrompt("/new")).toBe(true);
    expect(isThinPrompt("/reset")).toBe(true);
  });

  it("returns true for case-insensitive reset commands", () => {
    expect(isThinPrompt("/NEW")).toBe(true);
    expect(isThinPrompt("/Reset")).toBe(true);
  });

  it("returns true for whitespace-only prompts", () => {
    expect(isThinPrompt("   ")).toBe(true);
  });

  it("returns false for substantive prompts", () => {
    expect(isThinPrompt("hi")).toBe(false);
    expect(isThinPrompt("ok")).toBe(false);
    expect(isThinPrompt("what is the status?")).toBe(false);
  });
});

describe("extractLastUserText", () => {
  it("returns trimmed user string content", () => {
    const text = extractLastUserText([{ role: "user", content: "  hello world  " }]);
    expect(text).toBe("hello world");
  });

  it("returns user text from a single text part array", () => {
    const text = extractLastUserText([
      { role: "user", content: [{ type: "text", text: "single part" }] },
    ]);
    expect(text).toBe("single part");
  });

  it("joins multiple text parts in a content array", () => {
    const text = extractLastUserText([
      { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
    ]);
    expect(text).toBe("first second");
  });

  it("returns empty string when content array has only non-text parts", () => {
    const text = extractLastUserText([
      { role: "user", content: [{ type: "image", source: "img" }] },
    ]);
    expect(text).toBe("");
  });

  it("returns only text parts from mixed content arrays", () => {
    const text = extractLastUserText([
      {
        role: "user",
        content: [
          { type: "image", source: "img" },
          { type: "text", text: "keep this" },
          { type: "tool_use", name: "x" },
          { type: "text", text: "and this" },
        ],
      },
    ]);
    expect(text).toBe("keep this and this");
  });

  it("collects up to the last three non-empty user messages", () => {
    const text = extractLastUserText([
      { role: "user", content: "oldest message should be ignored" },
      { role: "user", content: "second message should be included" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "third message should be included" },
      { role: "user", content: "fourth message should be included" },
    ]);
    expect(text).toBe(
      "second message should be included third message should be included fourth message should be included",
    );
  });

  it("returns empty string when user content is null", () => {
    const text = extractLastUserText([{ role: "user", content: null }]);
    expect(text).toBe("");
  });

  it("returns empty string when user content is undefined", () => {
    const text = extractLastUserText([{ role: "user" }]);
    expect(text).toBe("");
  });

  it("returns empty string when user content is an unexpected primitive", () => {
    const text = extractLastUserText([{ role: "user", content: 0 }]);
    expect(text).toBe("");
  });

  it("returns empty string when no user role messages are present", () => {
    const text = extractLastUserText([{ role: "assistant", content: "nope" }]);
    expect(text).toBe("");
  });

  it("returns prior user text when last message is assistant", () => {
    const text = extractLastUserText([
      { role: "user", content: "user message" },
      { role: "assistant", content: "assistant message" },
    ]);
    expect(text).toBe("user message");
  });

  it("returns empty string for empty messages array", () => {
    const text = extractLastUserText([]);
    expect(text).toBe("");
  });
});

describe("shouldStashTopic", () => {
  it("returns false for text under 40 chars", () => {
    expect(shouldStashTopic("one two three four")).toBe(false);
  });

  it("returns false for text >= 40 chars but fewer than five words", () => {
    expect(shouldStashTopic("Superlongpaddddddddddddddddddddddddd one")).toBe(false);
  });

  it("returns true for text >= 40 chars and >= five words", () => {
    expect(
      shouldStashTopic("Please keep working on release planning and rollback checks today"),
    ).toBe(true);
  });

  it("clearStash cancels the sweep interval handle", () => {
    clearStash();
    expect(sweepInterval).toBeUndefined();
  });
});

describe("resolveSessionQuery", () => {
  function seed(sessionKey: string, text: string): void {
    const api = makeApi();
    plugin.register(api);
    const handler = getBeforeResetHandler(api);
    seedStashWithMessage(handler, sessionKey, text);
  }

  it("returns high-signal prompt when no stash exists", () => {
    const result = resolveSessionQuery("What should we ship next?", "agent:main:no-stash");
    expect(result).toBe("What should we ship next?");
  });

  it("returns stash when live prompt is low-signal and stash exists", () => {
    const sessionKey = "agent:main:low-signal-live-stash";
    const stashedText = "Need release notes draft with rollback caveats and dependency warnings included";
    seed(sessionKey, stashedText);

    const result = resolveSessionQuery("Need release notes draft", sessionKey);

    expect(result).toBe(stashedText);
    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
  });

  it("blends stash and high-signal live prompt when both are present", () => {
    const sessionKey = "agent:main:blend-stash-high-signal";
    const stashedText = "Working on session-start recall query seeding and stash eviction logic";
    const livePrompt = "Let us continue fixing the recall blend for short first messages now";
    seed(sessionKey, stashedText);

    const result = resolveSessionQuery(livePrompt, sessionKey);

    expect(result).toBe(`${stashedText} ${livePrompt}`);
    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
  });

  it("strips /new prefix for high-signal prompts", () => {
    const result = resolveSessionQuery("/new let's continue the migration work", "agent:main:strip-new");
    expect(result).toBe("let's continue the migration work");
  });

  it("strips /reset prefix for high-signal prompts", () => {
    const result = resolveSessionQuery("/reset pick up where we left off", "agent:main:strip-reset");
    expect(result).toBe("pick up where we left off");
  });

  it("returns undefined for thin prompt when stash is missing", () => {
    const result = resolveSessionQuery("/new", "agent:main:thin-no-stash-unit");
    expect(result).toBeUndefined();
  });

  it("returns stash text for thin prompt when stash is valid", () => {
    const sessionKey = "agent:main:thin-valid-stash-unit";
    const stashedText = "Stashed value for release planning and deployment risk discussion";
    seed(sessionKey, stashedText);

    const result = resolveSessionQuery("/new", sessionKey);

    expect(result).toBe(stashedText);
    expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
  });

  it("returns undefined for expired stash and still consumes entry", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      const sessionKey = "agent:main:thin-expired-stash-unit";
      seed(
        sessionKey,
        "Old stashed value about rollout strategy and alert threshold tuning",
      );
      vi.advanceTimersByTime(SESSION_TOPIC_TTL_MS + 1);

      const result = resolveSessionQuery("/new", sessionKey);

      expect(result).toBeUndefined();
      expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not consume stash for other keys when sessionKey is undefined", () => {
    const otherKey = "agent:main:other-key";
    const stashedText = "Other key value for migration readiness and release sequencing checks";
    seed(otherKey, stashedText);

    const result = resolveSessionQuery("/new");

    expect(result).toBeUndefined();
    expect(resolveSessionQuery("/new", otherKey)).toBe(stashedText);
    clearStash();
  });

  it("treats exactly-ttl-age stash as valid", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      const sessionKey = "agent:main:ttl-boundary";
      seed(
        sessionKey,
        "Boundary value for release triage and deployment gate verification details",
      );
      vi.advanceTimersByTime(SESSION_TOPIC_TTL_MS);

      const result = resolveSessionQuery("/new", sessionKey);

      expect(result).toBe(
        "Boundary value for release triage and deployment gate verification details",
      );
      expect(resolveSessionQuery("/new", sessionKey)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
