import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  PluginHookAgentContext,
} from "../../src/openclaw-plugin/types.js";

type BeforeAgentStartHandler = (
  event: BeforeAgentStartEvent,
  ctx?: PluginHookAgentContext
) => Promise<BeforeAgentStartResult | undefined>;

type BeforePromptBuildHandler = (
  event: BeforePromptBuildEvent,
  ctx?: PluginHookAgentContext
) => Promise<BeforePromptBuildResult | undefined>;

const recallModulePath = "../../src/openclaw-plugin/recall.js";
const dbClientModulePath = "../../src/db/client.js";
const signalsModulePath = "../../src/openclaw-plugin/signals.js";
const indexModulePath = "../../src/openclaw-plugin/index.js";
const tempDirs: string[] = [];

async function registerPlugin(
  pluginConfig?: Record<string, unknown>
): Promise<{
  handler: BeforeAgentStartHandler;
  beforePromptBuildHandler: BeforePromptBuildHandler;
  loggerWarn: ReturnType<typeof vi.fn>;
}> {
  const mod = await import(indexModulePath);
  const plugin = mod.default;

  let capturedHandler: BeforeAgentStartHandler | null = null;
  let capturedBeforePromptBuildHandler: BeforePromptBuildHandler | null = null;
  const loggerWarn = vi.fn();
  const mockApi = {
    id: "agenr",
    name: "agenr",
    pluginConfig,
    logger: { warn: loggerWarn, error: vi.fn() },
    on: (hook: string, handler: unknown) => {
      if (hook === "before_agent_start") {
        capturedHandler = handler as BeforeAgentStartHandler;
      }
      if (hook === "before_prompt_build") {
        capturedBeforePromptBuildHandler = handler as BeforePromptBuildHandler;
      }
    },
  };

  plugin.register(mockApi as never);
  if (!capturedHandler) {
    throw new Error("Expected before_agent_start handler to be registered");
  }
  if (!capturedBeforePromptBuildHandler) {
    throw new Error("Expected before_prompt_build handler to be registered");
  }

  return { handler: capturedHandler, beforePromptBuildHandler: capturedBeforePromptBuildHandler, loggerWarn };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock(recallModulePath);
  vi.doUnmock(dbClientModulePath);
  vi.doUnmock(signalsModulePath);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("agenr OpenClaw plugin", () => {
  it("exports a default object with id 'agenr' and a register function", async () => {
    vi.resetModules();
    const mod = await import(indexModulePath);
    const plugin = mod.default;
    expect(plugin.id).toBe("agenr");
    expect(typeof plugin.register).toBe("function");
  });

  it("register calls api.on with 'before_agent_start' and 'before_prompt_build'", async () => {
    vi.resetModules();
    const mod = await import(indexModulePath);
    const plugin = mod.default;

    const registeredHooks: string[] = [];
    const mockApi = {
      id: "agenr",
      name: "agenr",
      pluginConfig: undefined,
      logger: { warn: vi.fn(), error: vi.fn() },
      on: (hook: string, _handler: unknown) => {
        registeredHooks.push(hook);
      },
    };

    plugin.register(mockApi as never);
    expect(registeredHooks).toContain("before_agent_start");
    expect(registeredHooks).toContain("before_prompt_build");
  });

  it("before_agent_start returns prependContext when recall returns valid content", async () => {
    vi.resetModules();
    vi.doMock(recallModulePath, () => ({
      resolveAgenrPath: vi.fn(() => "/tmp/agenr-cli.js"),
      resolveBudget: vi.fn(() => 2000),
      runRecall: vi.fn(async () => ({
        query: "",
        results: [{ entry: { type: "fact", subject: "subject", content: "content" }, score: 0.99 }],
      })),
      formatRecallAsMarkdown: vi.fn(() => "## agenr Memory Context\n\n### Facts and Events\n\n- [subject] content"),
    }));

    const { handler } = await registerPlugin();
    const result = await handler(
      { prompt: "test prompt" },
      { sessionKey: "agent:main:test-prepend-context", workspaceDir: "/tmp/workspace" }
    );

    expect(result?.prependContext).toContain("## agenr Memory Context");
  });

  it("does not write AGENR.md to workspace", async () => {
    vi.resetModules();
    vi.doMock(recallModulePath, () => ({
      resolveAgenrPath: vi.fn(() => "/tmp/agenr-cli.js"),
      resolveBudget: vi.fn(() => 2000),
      runRecall: vi.fn(async () => ({
        query: "",
        results: [{ entry: { type: "fact", subject: "subject", content: "content" }, score: 0.99 }],
      })),
      formatRecallAsMarkdown: vi.fn(() => "## agenr Memory Context\n\n- memory"),
    }));

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-workspace-"));
    tempDirs.push(workspaceDir);

    const { handler } = await registerPlugin();
    await handler(
      { prompt: "test prompt" },
      { sessionKey: "agent:main:test-no-agenr-md", workspaceDir },
    );

    const agenrMdPath = path.join(workspaceDir, "AGENR.md");
    const exists = await fs
      .access(agenrMdPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("runs recall only once for repeated calls with the same sessionKey", async () => {
    vi.resetModules();
    const runRecall = vi.fn(async () => ({
      query: "",
      results: [{ entry: { type: "fact", subject: "subject", content: "content" }, score: 0.99 }],
    }));
    vi.doMock(recallModulePath, () => ({
      resolveAgenrPath: vi.fn(() => "/tmp/agenr-cli.js"),
      resolveBudget: vi.fn(() => 2000),
      runRecall,
      formatRecallAsMarkdown: vi.fn(() => "## agenr Memory Context"),
    }));

    const { handler } = await registerPlugin();
    const first = await handler({}, { sessionKey: "agent:main:test-dedup-same" });
    const second = await handler({}, { sessionKey: "agent:main:test-dedup-same" });

    expect(first?.prependContext).toContain("## agenr Memory Context");
    expect(second).toBeUndefined();
    expect(runRecall).toHaveBeenCalledTimes(1);
  });

  it("runs recall for each distinct sessionKey", async () => {
    vi.resetModules();
    const runRecall = vi.fn(async () => ({
      query: "",
      results: [{ entry: { type: "fact", subject: "subject", content: "content" }, score: 0.99 }],
    }));
    vi.doMock(recallModulePath, () => ({
      resolveAgenrPath: vi.fn(() => "/tmp/agenr-cli.js"),
      resolveBudget: vi.fn(() => 2000),
      runRecall,
      formatRecallAsMarkdown: vi.fn(() => "## agenr Memory Context"),
    }));

    const { handler } = await registerPlugin();
    await handler({}, { sessionKey: "agent:main:test-distinct-1" });
    await handler({}, { sessionKey: "agent:main:test-distinct-2" });

    expect(runRecall).toHaveBeenCalledTimes(2);
  });

  it("reads sessionKey from ctx (second arg), not from event", async () => {
    vi.resetModules();
    const runRecall = vi.fn(async () => ({
      query: "",
      results: [{ entry: { type: "fact", subject: "subject", content: "content" }, score: 0.99 }],
    }));
    vi.doMock(recallModulePath, () => ({
      resolveAgenrPath: vi.fn(() => "/tmp/agenr-cli.js"),
      resolveBudget: vi.fn(() => 2000),
      runRecall,
      formatRecallAsMarkdown: vi.fn(() => "## agenr Memory Context"),
    }));

    const { handler } = await registerPlugin();
    const result = await handler(
      { sessionKey: "agent:main:interactive" },
      { sessionKey: "agent:main:subagent:abc123" }
    );

    expect(result).toBeUndefined();
    expect(runRecall).not.toHaveBeenCalled();
  });

  it("does not consume session keys when config is disabled", async () => {
    vi.resetModules();
    const runRecall = vi.fn(async () => ({
      query: "",
      results: [{ entry: { type: "fact", subject: "subject", content: "content" }, score: 0.99 }],
    }));
    vi.doMock(recallModulePath, () => ({
      resolveAgenrPath: vi.fn(() => "/tmp/agenr-cli.js"),
      resolveBudget: vi.fn(() => 2000),
      runRecall,
      formatRecallAsMarkdown: vi.fn(() => "## agenr Memory Context"),
    }));

    const pluginConfig: { enabled: boolean } = { enabled: false };
    const { handler } = await registerPlugin(pluginConfig);
    const sessionKey = "agent:main:test-disabled-then-enabled";

    await handler({}, { sessionKey });
    pluginConfig.enabled = true;
    const result = await handler({}, { sessionKey });

    expect(result?.prependContext).toContain("## agenr Memory Context");
    expect(runRecall).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when config.enabled is false", async () => {
    vi.resetModules();
    const runRecall = vi.fn(async () => ({
      query: "",
      results: [{ entry: { type: "fact", subject: "subject", content: "content" }, score: 0.99 }],
    }));
    vi.doMock(recallModulePath, () => ({
      resolveAgenrPath: vi.fn(() => "/tmp/agenr-cli.js"),
      resolveBudget: vi.fn(() => 2000),
      runRecall,
      formatRecallAsMarkdown: vi.fn(() => "## agenr Memory Context"),
    }));

    const { handler } = await registerPlugin({ enabled: false });
    const result = await handler({}, { sessionKey: "agent:main:test-disabled-config" });

    expect(result).toBeUndefined();
    expect(runRecall).not.toHaveBeenCalled();
  });

  it("before_prompt_build skips sub-agent sessions", async () => {
    vi.resetModules();
    const getDb = vi.fn(() => ({ execute: vi.fn(), close: vi.fn() }));
    const initDb = vi.fn(async () => undefined);
    const checkSignals = vi.fn(async () => "AGENR SIGNAL: 1 new high-importance entry");

    vi.doMock(dbClientModulePath, () => ({
      getDb,
      initDb,
      closeDb: vi.fn(() => undefined),
    }));
    vi.doMock(signalsModulePath, () => ({
      checkSignals,
      resolveSignalConfig: vi.fn(() => ({ minImportance: 7, maxPerSignal: 5 })),
    }));

    const { beforePromptBuildHandler } = await registerPlugin();
    const result = await beforePromptBuildHandler({}, { sessionKey: "agent:main:subagent:123" });

    expect(result).toBeUndefined();
    expect(getDb).not.toHaveBeenCalled();
    expect(checkSignals).not.toHaveBeenCalled();
  });

  it("before_prompt_build skips when signalsEnabled=false", async () => {
    vi.resetModules();
    const getDb = vi.fn(() => ({ execute: vi.fn(), close: vi.fn() }));
    const initDb = vi.fn(async () => undefined);
    const checkSignals = vi.fn(async () => "AGENR SIGNAL: 1 new high-importance entry");

    vi.doMock(dbClientModulePath, () => ({
      getDb,
      initDb,
      closeDb: vi.fn(() => undefined),
    }));
    vi.doMock(signalsModulePath, () => ({
      checkSignals,
      resolveSignalConfig: vi.fn(() => ({ minImportance: 7, maxPerSignal: 5 })),
    }));

    const { beforePromptBuildHandler } = await registerPlugin({ signalsEnabled: false });
    const result = await beforePromptBuildHandler({}, { sessionKey: "agent:main:test-signals-disabled" });

    expect(result).toBeUndefined();
    expect(getDb).not.toHaveBeenCalled();
    expect(checkSignals).not.toHaveBeenCalled();
  });

  it("before_prompt_build skips when enabled=false (global disable)", async () => {
    vi.resetModules();
    vi.doMock(dbClientModulePath, () => ({
      getDb: vi.fn(() => ({ execute: vi.fn(), close: vi.fn() })),
      initDb: vi.fn(async () => undefined),
      closeDb: vi.fn(() => undefined),
    }));
    const checkSignals = vi.fn(async () => "AGENR SIGNAL: ...");
    vi.doMock(signalsModulePath, () => ({
      checkSignals,
      resolveSignalConfig: vi.fn(() => ({ minImportance: 7, maxPerSignal: 5 })),
    }));

    const { beforePromptBuildHandler } = await registerPlugin({ enabled: false });
    const result = await beforePromptBuildHandler({}, { sessionKey: "agent:main:test-global-disable" });
    expect(result).toBeUndefined();
    expect(checkSignals).not.toHaveBeenCalled();
  });

  it("before_prompt_build skips when sessionKey is empty string", async () => {
    vi.resetModules();
    const checkSignals = vi.fn(async () => "AGENR SIGNAL: ...");
    vi.doMock(dbClientModulePath, () => ({
      getDb: vi.fn(),
      initDb: vi.fn(),
      closeDb: vi.fn(),
    }));
    vi.doMock(signalsModulePath, () => ({
      checkSignals,
      resolveSignalConfig: vi.fn(() => ({ minImportance: 7, maxPerSignal: 5 })),
    }));

    const { beforePromptBuildHandler } = await registerPlugin();
    const result = await beforePromptBuildHandler({}, { sessionKey: "" });
    expect(result).toBeUndefined();
    expect(checkSignals).not.toHaveBeenCalled();
  });

  it("before_prompt_build returns prependContext with signal", async () => {
    vi.resetModules();
    const fakeDb = { execute: vi.fn(), close: vi.fn() };
    const getDb = vi.fn(() => fakeDb);
    const initDb = vi.fn(async () => undefined);
    const checkSignals = vi.fn(async () => "AGENR SIGNAL: 1 new high-importance entry");
    const resolveSignalConfig = vi.fn(() => ({ minImportance: 7, maxPerSignal: 5 }));

    vi.doMock(dbClientModulePath, () => ({
      getDb,
      initDb,
      closeDb: vi.fn(() => undefined),
    }));
    vi.doMock(signalsModulePath, () => ({
      checkSignals,
      resolveSignalConfig,
    }));

    const { beforePromptBuildHandler } = await registerPlugin();
    const result = await beforePromptBuildHandler({}, { sessionKey: "agent:main:test-signal-hit" });

    expect(result).toEqual({ prependContext: "AGENR SIGNAL: 1 new high-importance entry" });
    expect(getDb).toHaveBeenCalledTimes(1);
    expect(initDb).toHaveBeenCalledTimes(1);
    expect(resolveSignalConfig).toHaveBeenCalledTimes(1);
    expect(checkSignals).toHaveBeenCalledWith(fakeDb, "agent:main:test-signal-hit", {
      minImportance: 7,
      maxPerSignal: 5,
    });
  });

  it("before_prompt_build swallows errors", async () => {
    vi.resetModules();
    vi.doMock(dbClientModulePath, () => ({
      getDb: vi.fn(() => ({ execute: vi.fn(), close: vi.fn() })),
      initDb: vi.fn(async () => undefined),
      closeDb: vi.fn(() => undefined),
    }));
    vi.doMock(signalsModulePath, () => ({
      checkSignals: vi.fn(async () => {
        throw new Error("boom");
      }),
      resolveSignalConfig: vi.fn(() => ({ minImportance: 7, maxPerSignal: 5 })),
    }));

    const { beforePromptBuildHandler, loggerWarn } = await registerPlugin();
    const result = await beforePromptBuildHandler({}, { sessionKey: "agent:main:test-signal-error" });

    expect(result).toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("agenr plugin before_prompt_build signal check failed: boom"),
    );
  });
});
