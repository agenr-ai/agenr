import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartResult,
  PluginHookAgentContext,
} from "../../src/openclaw-plugin/types.js";

type BeforeAgentStartHandler = (
  event: BeforeAgentStartEvent,
  ctx?: PluginHookAgentContext
) => Promise<BeforeAgentStartResult | undefined>;

const recallModulePath = "../../src/openclaw-plugin/recall.js";
const indexModulePath = "../../src/openclaw-plugin/index.js";

async function registerPlugin(
  pluginConfig?: Record<string, unknown>
): Promise<{
  handler: BeforeAgentStartHandler;
  loggerWarn: ReturnType<typeof vi.fn>;
}> {
  const mod = await import(indexModulePath);
  const plugin = mod.default;

  let capturedHandler: BeforeAgentStartHandler | null = null;
  const loggerWarn = vi.fn();
  const mockApi = {
    id: "agenr",
    name: "agenr",
    pluginConfig,
    logger: { warn: loggerWarn, error: vi.fn() },
    on: (_hook: string, handler: BeforeAgentStartHandler) => {
      capturedHandler = handler;
    },
  };

  plugin.register(mockApi as never);
  if (!capturedHandler) {
    throw new Error("Expected before_agent_start handler to be registered");
  }

  return { handler: capturedHandler, loggerWarn };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock(recallModulePath);
});

describe("agenr OpenClaw plugin", () => {
  it("exports a default object with id 'agenr' and a register function", async () => {
    vi.resetModules();
    const mod = await import(indexModulePath);
    const plugin = mod.default;
    expect(plugin.id).toBe("agenr");
    expect(typeof plugin.register).toBe("function");
  });

  it("register calls api.on with 'before_agent_start'", async () => {
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
      formatRecallAsSummary: vi.fn(() => "## agenr Memory\n\n1 entries recalled."),
      writeAgenrMd: vi.fn(async () => {}),
    }));

    const { handler } = await registerPlugin();
    const result = await handler(
      { prompt: "test prompt" },
      { sessionKey: "agent:main:test-prepend-context", workspaceDir: "/tmp/workspace" }
    );

    expect(result?.prependContext).toContain("## agenr Memory Context");
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
      formatRecallAsSummary: vi.fn(() => "## agenr Memory\n\n1 entries recalled."),
      writeAgenrMd: vi.fn(async () => {}),
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
      formatRecallAsSummary: vi.fn(() => "## agenr Memory\n\n1 entries recalled."),
      writeAgenrMd: vi.fn(async () => {}),
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
      formatRecallAsSummary: vi.fn(() => "## agenr Memory\n\n1 entries recalled."),
      writeAgenrMd: vi.fn(async () => {}),
    }));

    const { handler } = await registerPlugin();
    const result = await handler(
      { sessionKey: "agent:main:interactive" },
      { sessionKey: "agent:main:subagent:abc123" }
    );

    expect(result).toBeUndefined();
    expect(runRecall).not.toHaveBeenCalled();
  });

  it("calls writeAgenrMd with summary content and ctx.workspaceDir when markdown is present", async () => {
    vi.resetModules();
    const writeAgenrMd = vi.fn(async () => {});
    const summaryOutput = [
      "## agenr Memory -- 2026-02-19 13:51",
      "",
      "1 entries recalled. Full context injected into this session automatically.",
      "To pull specific memories: ask your agent, or run:",
      '  mcporter call agenr.agenr_recall query="your topic" limit=5',
      "",
      "### Facts and Events (1)",
      "",
      "- subject",
    ].join("\n");
    vi.doMock(recallModulePath, () => ({
      resolveAgenrPath: vi.fn(() => "/tmp/agenr-cli.js"),
      resolveBudget: vi.fn(() => 2000),
      runRecall: vi.fn(async () => ({
        query: "",
        results: [{ entry: { type: "fact", subject: "subject", content: "full content body" }, score: 0.99 }],
      })),
      formatRecallAsMarkdown: vi.fn(() => "## agenr Memory Context\n\n### Facts and Events\n\n- [subject] full content body"),
      formatRecallAsSummary: vi.fn(() => summaryOutput),
      writeAgenrMd,
    }));

    const { handler } = await registerPlugin();
    await handler({}, { sessionKey: "agent:main:test-write-md", workspaceDir: "/tmp/workspace" });

    expect(writeAgenrMd).toHaveBeenCalledTimes(1);
    const [content, workspace] = writeAgenrMd.mock.calls[0] as [string, string];
    expect(workspace).toBe("/tmp/workspace");
    expect(content).toContain("mcporter call agenr.agenr_recall");
    expect(content).toContain("## agenr Memory");
    expect(content).not.toContain("full content body");
  });

  it("does not reject when writeAgenrMd fails", async () => {
    vi.resetModules();
    const writeAgenrMd = vi.fn(async () => {});
    vi.doMock(recallModulePath, () => ({
      resolveAgenrPath: vi.fn(() => "/tmp/agenr-cli.js"),
      resolveBudget: vi.fn(() => 2000),
      runRecall: vi.fn(async () => ({
        query: "",
        results: [{ entry: { type: "fact", subject: "subject", content: "content" }, score: 0.99 }],
      })),
      formatRecallAsMarkdown: vi.fn(() => "## agenr Memory Context"),
      formatRecallAsSummary: vi.fn(() => "## agenr Memory\n\n1 entries recalled."),
      writeAgenrMd,
    }));

    const { handler } = await registerPlugin();
    await expect(
      handler({}, { sessionKey: "agent:main:test-write-failure", workspaceDir: "/tmp/workspace" })
    ).resolves.toEqual({ prependContext: "## agenr Memory Context" });
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
      formatRecallAsSummary: vi.fn(() => "## agenr Memory\n\n1 entries recalled."),
      writeAgenrMd: vi.fn(async () => {}),
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
      formatRecallAsSummary: vi.fn(() => "## agenr Memory\n\n1 entries recalled."),
      writeAgenrMd: vi.fn(async () => {}),
    }));

    const { handler } = await registerPlugin({ enabled: false });
    const result = await handler({}, { sessionKey: "agent:main:test-disabled-config" });

    expect(result).toBeUndefined();
    expect(runRecall).not.toHaveBeenCalled();
  });
});
