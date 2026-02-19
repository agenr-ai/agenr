import { describe, expect, it, vi } from "vitest";
import type { BeforeAgentStartEvent, BeforeAgentStartResult } from "../../src/openclaw-plugin/types.js";

describe("agenr OpenClaw plugin", () => {
  it("exports a default object with id 'agenr' and a register function", async () => {
    const mod = await import("../../src/openclaw-plugin/index.js");
    const plugin = mod.default;
    expect(plugin.id).toBe("agenr");
    expect(typeof plugin.register).toBe("function");
  });

  it("register calls api.on with 'before_agent_start'", async () => {
    const mod = await import("../../src/openclaw-plugin/index.js");
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

    await plugin.register(mockApi as never);
    expect(registeredHooks).toContain("before_agent_start");
  });

  it("before_agent_start handler returns prependContext when recall returns valid content", async () => {
    vi.resetModules();
    vi.doMock("../../src/openclaw-plugin/recall.js", () => ({
      resolveAgenrPath: vi.fn(() => "/tmp/agenr-cli.js"),
      resolveBudget: vi.fn(() => 2000),
      runRecall: vi.fn(async () => ({
        query: "",
        results: [
          {
            entry: { type: "fact", subject: "subject", content: "content" },
            score: 0.99,
          },
        ],
      })),
      formatRecallAsMarkdown: vi.fn(() => "## agenr Memory Context\n\n### Facts and Events\n\n- [subject] content"),
    }));

    const mod = await import("../../src/openclaw-plugin/index.js");
    const plugin = mod.default;

    let capturedHandler:
      | ((event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>)
      | null = null;
    const mockApi = {
      id: "agenr",
      name: "agenr",
      pluginConfig: undefined,
      logger: { warn: vi.fn(), error: vi.fn() },
      on: (
        _hook: string,
        handler: (event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>
      ) => {
        capturedHandler = handler;
      },
    };

    await plugin.register(mockApi as never);
    expect(capturedHandler).not.toBeNull();

    const result = await capturedHandler?.({
      sessionKey: "agent:main:interactive",
      prompt: "test prompt",
    });
    expect(result?.prependContext).toContain("## agenr Memory Context");

    vi.doUnmock("../../src/openclaw-plugin/recall.js");
    vi.resetModules();
  });

  it("before_agent_start handler returns undefined for subagent sessions", async () => {
    const mod = await import("../../src/openclaw-plugin/index.js");
    const plugin = mod.default;

    let capturedHandler:
      | ((event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>)
      | null = null;
    const mockApi = {
      id: "agenr",
      name: "agenr",
      pluginConfig: { agenrPath: "/nonexistent/cli.js" },
      logger: { warn: vi.fn(), error: vi.fn() },
      on: (
        _hook: string,
        handler: (event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>
      ) => {
        capturedHandler = handler;
      },
    };

    await plugin.register(mockApi as never);
    expect(capturedHandler).not.toBeNull();

    const result = await capturedHandler?.({
      sessionKey: "agent:main:subagent:abc123",
    });
    expect(result).toBeUndefined();
  });

  it("before_agent_start handler returns undefined for cron sessions", async () => {
    const mod = await import("../../src/openclaw-plugin/index.js");
    const plugin = mod.default;

    let capturedHandler:
      | ((event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>)
      | null = null;
    const mockApi = {
      id: "agenr",
      name: "agenr",
      pluginConfig: { agenrPath: "/nonexistent/cli.js" },
      logger: { warn: vi.fn(), error: vi.fn() },
      on: (
        _hook: string,
        handler: (event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>
      ) => {
        capturedHandler = handler;
      },
    };

    await plugin.register(mockApi as never);

    const result = await capturedHandler?.({
      sessionKey: "agent:main:cron:heartbeat",
    });

    expect(result).toBeUndefined();
  });

  it("before_agent_start handler returns undefined when config.enabled is false", async () => {
    const mod = await import("../../src/openclaw-plugin/index.js");
    const plugin = mod.default;

    let capturedHandler:
      | ((event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>)
      | null = null;
    const mockApi = {
      id: "agenr",
      name: "agenr",
      pluginConfig: { enabled: false },
      logger: { warn: vi.fn(), error: vi.fn() },
      on: (
        _hook: string,
        handler: (event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>
      ) => {
        capturedHandler = handler;
      },
    };

    await plugin.register(mockApi as never);

    const result = await capturedHandler?.({
      sessionKey: "agent:main",
    });

    expect(result).toBeUndefined();
  });

  it("before_agent_start handler resolves without throwing when agenr path does not exist", async () => {
    const mod = await import("../../src/openclaw-plugin/index.js");
    const plugin = mod.default;

    let capturedHandler:
      | ((event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>)
      | null = null;
    const mockApi = {
      id: "agenr",
      name: "agenr",
      pluginConfig: { agenrPath: "/nonexistent/path/that/does/not/exist/cli.js" },
      logger: { warn: vi.fn(), error: vi.fn() },
      on: (
        _hook: string,
        handler: (event: BeforeAgentStartEvent) => Promise<BeforeAgentStartResult | undefined>
      ) => {
        capturedHandler = handler;
      },
    };

    await plugin.register(mockApi as never);

    await expect(capturedHandler?.({ sessionKey: "agent:main" })).resolves.toBeUndefined();
  });
});
