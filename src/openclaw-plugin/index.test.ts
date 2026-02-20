import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as dbClient from "../db/client.js";
import plugin from "./index.js";
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

function getBeforePromptBuildHandler(
  api: PluginApi,
): (event: Record<string, unknown>, ctx: { sessionKey?: string }) => Promise<BeforePromptBuildResult | undefined> {
  const onMock = api.on as unknown as ReturnType<typeof vi.fn>;
  const call = onMock.mock.calls.find((args) => args[0] === "before_prompt_build");
  if (!call) {
    throw new Error("before_prompt_build handler not registered");
  }
  return call[1] as (event: Record<string, unknown>, ctx: { sessionKey?: string }) => Promise<BeforePromptBuildResult | undefined>;
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

  it("runRetireTool returns success message on exit code 0", async () => {
    spawnMock.mockReturnValueOnce(createMockChild({ code: 0 }));

    const result = await runRetireTool("/path/to/agenr", { entry_id: "test-id-123" });

    expect(result.content[0]?.text).toContain("Retired entry test-id-123");
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
