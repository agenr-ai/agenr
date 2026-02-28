import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbClient from "../db/client.js";
import { __testing } from "./index.js";
import plugin from "./index.js";
import * as pluginRecall from "./recall.js";
import * as sessionQuery from "./session-query.js";
import * as pluginSignals from "./signals.js";
import * as pluginTools from "./tools.js";
import { getMidSessionState } from "./mid-session-recall.js";
import { runExtractTool, runRecallTool, runRetireTool, runStoreTool } from "./tools.js";
import type { BeforePromptBuildResult, PluginApi, PluginTool } from "./types.js";

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

function getRegisteredTool(api: PluginApi, name: string): PluginTool {
  const registerToolMock = api.registerTool as ReturnType<typeof vi.fn> | undefined;
  if (!registerToolMock) {
    throw new Error("registerTool mock is required");
  }
  const call = registerToolMock.mock.calls.find(
    (args) => ((args[0] as { name?: unknown }).name === name),
  );
  if (!call) {
    throw new Error(`tool not registered: ${name}`);
  }
  return call[0] as PluginTool;
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
      undefined,
    );
    expect(runRecallMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.any(Number),
      "plugin-scope",
      prompt,
      undefined,
      undefined,
    );
  });
});

describe("before_prompt_build mid-session recall", () => {
  it("skips recall for trivial subsequent messages and still checks signals", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "[browse]",
      results: [],
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
    const sessionKey = "agent:main:mid-trivial";

    await handler({ prompt: "hello" }, { sessionKey, sessionId: "uuid-mid-trivial" });
    const second = await handler({ prompt: "yes" }, { sessionKey, sessionId: "uuid-mid-trivial" });

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(checkSignalsMock).toHaveBeenCalledTimes(2);
    expect(second?.prependContext).toContain("AGENR SIGNAL");
    expect(second?.prependContext).not.toContain("## Recalled context");
  });

  it("fires recall for complex subsequent messages and injects recalled context", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall");
    runRecallMock
      .mockResolvedValueOnce({
        query: "[browse]",
        results: [],
      })
      .mockResolvedValueOnce({
        query: "Tell me about Ava",
        results: [
          {
            entry: {
              id: "ava-1",
              type: "fact",
              subject: "Ava",
              content: "Maintains the release checklist",
            },
            score: 0.92,
          },
        ],
      });
    vi.spyOn(pluginSignals, "checkSignals").mockResolvedValue(null);
    vi.spyOn(dbClient, "getDb").mockReturnValue({} as never);
    vi.spyOn(dbClient, "initDb").mockResolvedValue(undefined);

    const api = makeApi({ pluginConfig: { signalCooldownMs: 0, signalMaxPerSession: 10 } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const sessionKey = "agent:main:mid-complex";

    await handler({ prompt: "hello" }, { sessionKey, sessionId: "uuid-mid-complex" });
    const second = await handler(
      { prompt: "Tell me about Ava" },
      { sessionKey, sessionId: "uuid-mid-complex" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(2);
    expect(runRecallMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.any(Number),
      undefined,
      expect.stringContaining("Tell me about Ava"),
      { limit: 8 },
      undefined,
    );
    expect(second?.prependContext).toContain("## Recalled context");
    expect(second?.prependContext).toContain("[Ava] Maintains the release checklist");
  });

  it("deduplicates mid-session recall results against session-start recalled ids", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall");
    runRecallMock
      .mockResolvedValueOnce({
        query: "[browse]",
        results: [
          {
            entry: {
              id: "dup-id",
              type: "fact",
              subject: "Duplicate subject",
              content: "session-start content",
            },
            score: 0.9,
          },
        ],
      })
      .mockResolvedValueOnce({
        query: "Tell me about Ava",
        results: [
          {
            entry: {
              id: "dup-id",
              type: "fact",
              subject: "Duplicate subject",
              content: "mid-session duplicate content",
            },
            score: 0.8,
          },
          {
            entry: {
              id: "fresh-id",
              type: "fact",
              subject: "Fresh subject",
              content: "fresh content",
            },
            score: 0.7,
          },
        ],
      });
    vi.spyOn(pluginSignals, "checkSignals").mockResolvedValue(null);
    vi.spyOn(dbClient, "getDb").mockReturnValue({} as never);
    vi.spyOn(dbClient, "initDb").mockResolvedValue(undefined);

    const api = makeApi({ pluginConfig: { signalCooldownMs: 0, signalMaxPerSession: 10 } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const sessionKey = "agent:main:mid-dedup-start";

    await handler({ prompt: "hello" }, { sessionKey, sessionId: "uuid-mid-dedup-start" });
    const second = await handler(
      { prompt: "Tell me about Ava" },
      { sessionKey, sessionId: "uuid-mid-dedup-start" },
    );

    expect(second?.prependContext).toContain("[Fresh subject] fresh content");
    expect(second?.prependContext).not.toContain("mid-session duplicate content");
  });

  it("deduplicates mid-session recall results against prior mid-session recalls", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall");
    runRecallMock
      .mockResolvedValueOnce({
        query: "[browse]",
        results: [],
      })
      .mockResolvedValueOnce({
        query: "Tell me about Ava",
        results: [
          {
            entry: {
              id: "repeat-id",
              type: "fact",
              subject: "Repeat subject",
              content: "repeat content",
            },
            score: 0.95,
          },
        ],
      })
      .mockResolvedValueOnce({
        query: "Can you check PR #312?",
        results: [
          {
            entry: {
              id: "repeat-id",
              type: "fact",
              subject: "Repeat subject",
              content: "repeat content",
            },
            score: 0.9,
          },
          {
            entry: {
              id: "fresh-id",
              type: "fact",
              subject: "Fresh second pass",
              content: "new content",
            },
            score: 0.85,
          },
        ],
      });
    vi.spyOn(pluginSignals, "checkSignals").mockResolvedValue(null);
    vi.spyOn(dbClient, "getDb").mockReturnValue({} as never);
    vi.spyOn(dbClient, "initDb").mockResolvedValue(undefined);

    const api = makeApi({ pluginConfig: { signalCooldownMs: 0, signalMaxPerSession: 10 } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const sessionKey = "agent:main:mid-dedup-mid";

    await handler({ prompt: "hello" }, { sessionKey, sessionId: "uuid-mid-dedup-mid" });
    await handler({ prompt: "Tell me about Ava" }, { sessionKey, sessionId: "uuid-mid-dedup-mid" });
    const third = await handler(
      { prompt: "Can you check PR #312?" },
      { sessionKey, sessionId: "uuid-mid-dedup-mid" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(3);
    expect(third?.prependContext).toContain("[Fresh second pass] new content");
    expect(third?.prependContext).not.toContain("repeat content");
  });

  it("skips recall when a subsequent query is too similar to the previous one", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall");
    runRecallMock
      .mockResolvedValueOnce({
        query: "[browse]",
        results: [],
      })
      .mockResolvedValueOnce({
        query: "Tell me about Ava",
        results: [
          {
            entry: {
              id: "ava-1",
              type: "fact",
              subject: "Ava",
              content: "Maintains the release checklist",
            },
            score: 0.92,
          },
        ],
      });
    vi.spyOn(pluginSignals, "checkSignals").mockResolvedValue(null);
    vi.spyOn(dbClient, "getDb").mockReturnValue({} as never);
    vi.spyOn(dbClient, "initDb").mockResolvedValue(undefined);

    const api = makeApi({ pluginConfig: { signalCooldownMs: 0, signalMaxPerSession: 10 } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const sessionKey = "agent:main:mid-similar";

    await handler({ prompt: "hello" }, { sessionKey, sessionId: "uuid-mid-similar" });
    await handler({ prompt: "Tell me about Ava" }, { sessionKey, sessionId: "uuid-mid-similar" });
    const third = await handler(
      { prompt: "Tell me about Ava" },
      { sessionKey, sessionId: "uuid-mid-similar" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(2);
    expect(third).toBeUndefined();
  });

  it("retries the same query after a failed mid-session recall attempt", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall");
    runRecallMock
      .mockResolvedValueOnce({
        query: "[browse]",
        results: [],
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        query: "Tell me about Ava",
        results: [
          {
            entry: {
              id: "ava-retry",
              type: "fact",
              subject: "Ava",
              content: "Retry recall succeeded",
            },
            score: 0.93,
          },
        ],
      });
    vi.spyOn(pluginSignals, "checkSignals").mockResolvedValue(null);
    vi.spyOn(dbClient, "getDb").mockReturnValue({} as never);
    vi.spyOn(dbClient, "initDb").mockResolvedValue(undefined);

    const api = makeApi({ pluginConfig: { signalCooldownMs: 0, signalMaxPerSession: 10 } });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const sessionKey = "agent:main:mid-retry-after-failure";

    await handler({ prompt: "hello" }, { sessionKey, sessionId: "uuid-mid-retry-after-failure" });
    await handler({ prompt: "Tell me about Ava" }, { sessionKey, sessionId: "uuid-mid-retry-after-failure" });
    const third = await handler(
      { prompt: "Tell me about Ava" },
      { sessionKey, sessionId: "uuid-mid-retry-after-failure" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(3);
    expect(runRecallMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.any(Number),
      undefined,
      expect.stringContaining("Tell me about Ava"),
      { limit: 8 },
      undefined,
    );
    expect(runRecallMock).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      expect.any(Number),
      undefined,
      expect.stringContaining("Tell me about Ava"),
      { limit: 8 },
      undefined,
    );
    expect(third?.prependContext).toContain("## Recalled context");
    expect(third?.prependContext).toContain("[Ava] Retry recall succeeded");
  });

  it("disables mid-session recall when configured off", async () => {
    const runRecallMock = vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "[browse]",
      results: [],
    });
    vi.spyOn(pluginSignals, "checkSignals").mockResolvedValue(null);
    vi.spyOn(dbClient, "getDb").mockReturnValue({} as never);
    vi.spyOn(dbClient, "initDb").mockResolvedValue(undefined);

    const api = makeApi({
      pluginConfig: {
        signalCooldownMs: 0,
        signalMaxPerSession: 10,
        midSessionRecall: {
          enabled: false,
        },
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const sessionKey = "agent:main:mid-disabled";

    await handler({ prompt: "hello" }, { sessionKey, sessionId: "uuid-mid-disabled" });
    const second = await handler(
      { prompt: "Tell me about Ava" },
      { sessionKey, sessionId: "uuid-mid-disabled" },
    );

    expect(runRecallMock).toHaveBeenCalledTimes(1);
    expect(second).toBeUndefined();
  });
});

describe("before_prompt_build store nudging", () => {
  const hasMemoryCheck = (result: BeforePromptBuildResult | undefined): boolean =>
    result?.prependContext?.includes("[MEMORY CHECK]") ?? false;

  it("injects a nudge after 8 turns without agenr_store calls", async () => {
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "[browse]",
      results: [],
    });
    const api = makeApi({
      pluginConfig: {
        signalsEnabled: false,
        midSessionRecall: { enabled: false },
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const ctx = { sessionKey: "agent:main:store-nudge-threshold", sessionId: "uuid-store-nudge-threshold" };

    await handler({ prompt: "start" }, ctx);
    for (let turn = 1; turn <= 7; turn += 1) {
      const result = await handler({ prompt: `turn-${turn}` }, ctx);
      expect(hasMemoryCheck(result)).toBe(false);
    }
    const eighthTurn = await handler({ prompt: "turn-8" }, ctx);

    expect(hasMemoryCheck(eighthTurn)).toBe(true);
  });

  it("fires again only after the full gap re-accumulates after agenr_store", async () => {
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "[browse]",
      results: [],
    });
    const registerTool = vi.fn();
    const api = makeApi({
      registerTool,
      pluginConfig: {
        signalsEnabled: false,
        midSessionRecall: { enabled: false },
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const storeTool = getRegisteredTool(api, "agenr_store");
    const ctx = { sessionKey: "agent:main:store-nudge-store-call", sessionId: "uuid-store-nudge-store-call" };

    await handler({ prompt: "start" }, ctx);
    for (let turn = 1; turn <= 4; turn += 1) {
      await handler({ prompt: `turn-${turn}` }, ctx);
    }
    await storeTool.execute("tool-call-store", {
      entries: [{ content: "remember this", type: "fact" }],
    });

    for (let turn = 5; turn <= 11; turn += 1) {
      const result = await handler({ prompt: `turn-${turn}` }, ctx);
      expect(hasMemoryCheck(result)).toBe(false);
    }
    const twelfthTurn = await handler({ prompt: "turn-12" }, ctx);
    expect(hasMemoryCheck(twelfthTurn)).toBe(true);
  });

  it("spaces nudges by threshold after each delivery", async () => {
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "[browse]",
      results: [],
    });
    const api = makeApi({
      pluginConfig: {
        signalsEnabled: false,
        midSessionRecall: { enabled: false },
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const ctx = { sessionKey: "agent:main:store-nudge-spacing", sessionId: "uuid-store-nudge-spacing" };

    await handler({ prompt: "start" }, ctx);
    for (let turn = 1; turn <= 7; turn += 1) {
      const result = await handler({ prompt: `turn-${turn}` }, ctx);
      expect(hasMemoryCheck(result)).toBe(false);
    }
    const eighthTurn = await handler({ prompt: "turn-8" }, ctx);
    const ninthTurn = await handler({ prompt: "turn-9" }, ctx);
    for (let turn = 10; turn <= 15; turn += 1) {
      const result = await handler({ prompt: `turn-${turn}` }, ctx);
      expect(hasMemoryCheck(result)).toBe(false);
    }
    const sixteenthTurn = await handler({ prompt: "turn-16" }, ctx);

    expect(hasMemoryCheck(eighthTurn)).toBe(true);
    expect(hasMemoryCheck(ninthTurn)).toBe(false);
    expect(hasMemoryCheck(sixteenthTurn)).toBe(true);
  });

  it("allows store on the threshold turn and nudges again after a full gap", async () => {
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "[browse]",
      results: [],
    });
    const registerTool = vi.fn();
    const api = makeApi({
      registerTool,
      pluginConfig: {
        signalsEnabled: false,
        midSessionRecall: { enabled: false },
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const storeTool = getRegisteredTool(api, "agenr_store");
    const ctx = {
      sessionKey: "agent:main:store-nudge-threshold-store",
      sessionId: "uuid-store-nudge-threshold-store",
    };

    await handler({ prompt: "start" }, ctx);
    for (let turn = 1; turn <= 7; turn += 1) {
      const result = await handler({ prompt: `turn-${turn}` }, ctx);
      expect(hasMemoryCheck(result)).toBe(false);
    }
    const eighthTurn = await handler({ prompt: "turn-8" }, ctx);
    expect(hasMemoryCheck(eighthTurn)).toBe(true);

    await storeTool.execute("tool-call-threshold-turn", {
      entries: [{ content: "store on turn 8", type: "fact" }],
    });

    for (let turn = 9; turn <= 15; turn += 1) {
      const result = await handler({ prompt: `turn-${turn}` }, ctx);
      expect(hasMemoryCheck(result)).toBe(false);
    }
    const sixteenthTurn = await handler({ prompt: "turn-16" }, ctx);
    expect(hasMemoryCheck(sixteenthTurn)).toBe(true);
  });

  it("does not inject nudges after the per-session max is reached", async () => {
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "[browse]",
      results: [],
    });
    const api = makeApi({
      pluginConfig: {
        signalsEnabled: false,
        midSessionRecall: { enabled: false },
        storeNudge: { threshold: 2, maxPerSession: 3 },
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const ctx = { sessionKey: "agent:main:store-nudge-cap", sessionId: "uuid-store-nudge-cap" };

    await handler({ prompt: "start" }, ctx);
    const turn1 = await handler({ prompt: "turn-1" }, ctx);
    const turn2 = await handler({ prompt: "turn-2" }, ctx);
    const turn3 = await handler({ prompt: "turn-3" }, ctx);
    const turn4 = await handler({ prompt: "turn-4" }, ctx);
    const turn5 = await handler({ prompt: "turn-5" }, ctx);
    const turn6 = await handler({ prompt: "turn-6" }, ctx);
    const turn7 = await handler({ prompt: "turn-7" }, ctx);
    const turn8 = await handler({ prompt: "turn-8" }, ctx);
    const state = getMidSessionState(ctx.sessionId);

    expect(hasMemoryCheck(turn1)).toBe(false);
    expect(hasMemoryCheck(turn2)).toBe(true);
    expect(hasMemoryCheck(turn3)).toBe(false);
    expect(hasMemoryCheck(turn4)).toBe(true);
    expect(hasMemoryCheck(turn5)).toBe(false);
    expect(hasMemoryCheck(turn6)).toBe(true);
    expect(hasMemoryCheck(turn7)).toBe(false);
    expect(hasMemoryCheck(turn8)).toBe(false);
    expect(state.nudgeCount).toBe(3);
  });

  it("does not inject nudges when storeNudge is disabled", async () => {
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "[browse]",
      results: [],
    });
    const api = makeApi({
      pluginConfig: {
        signalsEnabled: false,
        midSessionRecall: { enabled: false },
        storeNudge: { enabled: false },
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const ctx = { sessionKey: "agent:main:store-nudge-disabled", sessionId: "uuid-store-nudge-disabled" };

    await handler({ prompt: "start" }, ctx);
    for (let turn = 1; turn <= 12; turn += 1) {
      const result = await handler({ prompt: `turn-${turn}` }, ctx);
      expect(hasMemoryCheck(result)).toBe(false);
    }
  });

  it("marks store calls from the agenr_store tool wrapper", async () => {
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "[browse]",
      results: [],
    });
    const registerTool = vi.fn();
    const api = makeApi({
      registerTool,
      pluginConfig: {
        signalsEnabled: false,
        midSessionRecall: { enabled: false },
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const storeTool = getRegisteredTool(api, "agenr_store");
    const ctx = {
      sessionKey: "agent:main:store-wrapper",
      sessionId: "uuid-store-wrapper",
    };

    await handler({ prompt: "start" }, ctx);
    await handler({ prompt: "turn-1" }, ctx);
    await handler({ prompt: "turn-2" }, ctx);
    const state = getMidSessionState(ctx.sessionId);
    expect(state.turnCount).toBe(2);
    expect(state.lastStoreTurn).toBe(0);

    await storeTool.execute("tool-call-store-wrapper", {
      entries: [{ content: "store marker", type: "fact" }],
    });

    expect(state.lastStoreTurn).toBe(2);
  });

  it("increments nudgeCount on each delivered nudge", async () => {
    vi.spyOn(pluginRecall, "runRecall").mockResolvedValue({
      query: "[browse]",
      results: [],
    });
    const api = makeApi({
      pluginConfig: {
        signalsEnabled: false,
        midSessionRecall: { enabled: false },
        storeNudge: { threshold: 2, maxPerSession: 5 },
      },
    });
    plugin.register(api);
    const handler = getBeforePromptBuildHandler(api);
    const ctx = {
      sessionKey: "agent:main:store-nudge-count",
      sessionId: "uuid-store-nudge-count",
    };

    await handler({ prompt: "start" }, ctx);
    await handler({ prompt: "turn-1" }, ctx);
    const secondTurn = await handler({ prompt: "turn-2" }, ctx);
    const thirdTurn = await handler({ prompt: "turn-3" }, ctx);
    const fourthTurn = await handler({ prompt: "turn-4" }, ctx);
    const state = getMidSessionState(ctx.sessionId);

    expect(hasMemoryCheck(secondTurn)).toBe(true);
    expect(hasMemoryCheck(thirdTurn)).toBe(false);
    expect(hasMemoryCheck(fourthTurn)).toBe(true);
    expect(state.nudgeCount).toBe(2);
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
      undefined,
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
      undefined,
      undefined,
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
      false,
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
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockResolvedValue({
      content: [{ type: "text", text: "Stored 1 entries." }],
    });

    const api = makeApi({ pluginConfig: { debug: true } });
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
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[command] triggered action=new sessionKey=agent:main:command-new",
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith("[command] handoff complete");
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

  it("clears mid-session recall state for action=reset", async () => {
    const state = getMidSessionState("agent:main:command-reset-clears");
    state.turnCount = 3;
    state.lastRecallQuery = "Tell me about Ava";
    state.recalledIds.add("entry-1");
    state.recentMessages.push("Tell me about Ava");

    vi.spyOn(__testing, "readAndParseSessionJsonl").mockResolvedValue([]);
    const api = makeApi();
    plugin.register(api);
    const handler = getCommandHandler(api);

    await handler(
      {
        type: "command",
        action: "reset",
        sessionKey: "agent:main:command-reset-clears",
        timestamp: new Date(),
        messages: [],
        context: {
          sessionEntry: {
            sessionId: "session-reset-clears",
            sessionFile: "/tmp/session-reset-clears.jsonl",
          },
        },
      },
      { sessionKey: "agent:main:command-reset-clears", agentId: "main" },
    );

    const refreshed = getMidSessionState("agent:main:command-reset-clears");
    expect(refreshed).not.toBe(state);
    expect(refreshed.turnCount).toBe(0);
    expect(refreshed.lastRecallQuery).toBeNull();
    expect(refreshed.recalledIds.size).toBe(0);
    expect(refreshed.recentMessages.length).toBe(0);
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
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runStoreMock = vi.spyOn(pluginTools, "runStoreTool").mockResolvedValue({
      content: [{ type: "text", text: "Stored 1 entries." }],
    });

    const api = makeApi({ pluginConfig: { debug: true } });
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
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[command] dedup skip sessionId=session-210-cmd-dedup",
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
