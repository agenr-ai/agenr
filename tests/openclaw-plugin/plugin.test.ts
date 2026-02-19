import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("agenr OpenClaw plugin", () => {
  it("exports a default object with id 'agenr' and a register function", async () => {
    const mod = await import("../../src/openclaw-plugin/index.js");
    const plugin = mod.default;
    expect(plugin.id).toBe("agenr");
    expect(typeof plugin.register).toBe("function");
  });

  it("register calls api.registerHook with 'agent:bootstrap'", async () => {
    const mod = await import("../../src/openclaw-plugin/index.js");
    const plugin = mod.default;

    const registeredEvents: string[] = [];
    const mockApi = {
      id: "agenr",
      name: "agenr",
      pluginConfig: undefined,
      logger: { warn: vi.fn(), error: vi.fn() },
      registerHook: (events: string | string[], _handler: unknown) => {
        const list = Array.isArray(events) ? events : [events];
        registeredEvents.push(...list);
      },
    };

    await plugin.register(mockApi as never);
    expect(registeredEvents).toContain("agent:bootstrap");
  });

  it("bootstrap handler pushes exactly one file when recall returns valid content", async () => {
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

    let capturedHandler: ((event: unknown) => Promise<void>) | null = null;
    const mockApi = {
      id: "agenr",
      name: "agenr",
      pluginConfig: undefined,
      logger: { warn: vi.fn(), error: vi.fn() },
      registerHook: (_events: unknown, handler: (event: unknown) => Promise<void>) => {
        capturedHandler = handler;
      },
    };

    await plugin.register(mockApi as never);

    const bootstrapFiles: Array<{ path?: string; name?: string; content?: string }> = [];
    await capturedHandler?.({
      type: "agent",
      action: "bootstrap",
      sessionKey: "agent:main:interactive",
      context: { bootstrapFiles, sessionKey: "agent:main:interactive" },
      timestamp: new Date(),
      messages: [],
    });

    expect(bootstrapFiles).toHaveLength(1);
    expect(bootstrapFiles[0]?.name).toBe("AGENR.md");
    expect(bootstrapFiles[0]?.path).toBe(path.join(os.homedir(), ".agenr", "AGENR.md"));
    expect(bootstrapFiles[0]?.content).toContain("## agenr Memory Context");

    vi.doUnmock("../../src/openclaw-plugin/recall.js");
    vi.resetModules();
  });

  it("bootstrap handler does not push to bootstrapFiles for subagent sessions", async () => {
    const mod = await import("../../src/openclaw-plugin/index.js");
    const plugin = mod.default;

    let capturedHandler: ((event: unknown) => Promise<void>) | null = null;
    const mockApi = {
      id: "agenr",
      name: "agenr",
      pluginConfig: { agenrPath: "/nonexistent/cli.js" },
      logger: { warn: vi.fn(), error: vi.fn() },
      registerHook: (_events: unknown, handler: (event: unknown) => Promise<void>) => {
        capturedHandler = handler;
      },
    };

    await plugin.register(mockApi as never);
    expect(capturedHandler).not.toBeNull();

    const bootstrapFiles: unknown[] = [];
    await capturedHandler?.({
      type: "agent",
      action: "bootstrap",
      sessionKey: "agent:main:subagent:abc123",
      context: {
        bootstrapFiles,
        sessionKey: "agent:main:subagent:abc123",
      },
      timestamp: new Date(),
      messages: [],
    });

    expect(bootstrapFiles).toHaveLength(0);
  });

  it("bootstrap handler does not push to bootstrapFiles for cron sessions", async () => {
    const mod = await import("../../src/openclaw-plugin/index.js");
    const plugin = mod.default;

    let capturedHandler: ((event: unknown) => Promise<void>) | null = null;
    const mockApi = {
      id: "agenr",
      name: "agenr",
      pluginConfig: { agenrPath: "/nonexistent/cli.js" },
      logger: { warn: vi.fn(), error: vi.fn() },
      registerHook: (_events: unknown, handler: (event: unknown) => Promise<void>) => {
        capturedHandler = handler;
      },
    };

    await plugin.register(mockApi as never);

    const bootstrapFiles: unknown[] = [];
    await capturedHandler?.({
      type: "agent",
      action: "bootstrap",
      sessionKey: "agent:main:cron:heartbeat",
      context: {
        bootstrapFiles,
        sessionKey: "agent:main:cron:heartbeat",
      },
      timestamp: new Date(),
      messages: [],
    });

    expect(bootstrapFiles).toHaveLength(0);
  });

  it("bootstrap handler does not push when config.enabled is false", async () => {
    const mod = await import("../../src/openclaw-plugin/index.js");
    const plugin = mod.default;

    let capturedHandler: ((event: unknown) => Promise<void>) | null = null;
    const mockApi = {
      id: "agenr",
      name: "agenr",
      pluginConfig: { enabled: false },
      logger: { warn: vi.fn(), error: vi.fn() },
      registerHook: (_events: unknown, handler: (event: unknown) => Promise<void>) => {
        capturedHandler = handler;
      },
    };

    await plugin.register(mockApi as never);

    const bootstrapFiles: unknown[] = [];
    await capturedHandler?.({
      type: "agent",
      action: "bootstrap",
      sessionKey: "agent:main",
      context: { bootstrapFiles, sessionKey: "agent:main" },
      timestamp: new Date(),
      messages: [],
    });

    expect(bootstrapFiles).toHaveLength(0);
  });

  it("bootstrap handler resolves without throwing when agenr path does not exist", async () => {
    const mod = await import("../../src/openclaw-plugin/index.js");
    const plugin = mod.default;

    let capturedHandler: ((event: unknown) => Promise<void>) | null = null;
    const mockApi = {
      id: "agenr",
      name: "agenr",
      pluginConfig: { agenrPath: "/nonexistent/path/that/does/not/exist/cli.js" },
      logger: { warn: vi.fn(), error: vi.fn() },
      registerHook: (_events: unknown, handler: (event: unknown) => Promise<void>) => {
        capturedHandler = handler;
      },
    };

    await plugin.register(mockApi as never);

    const bootstrapFiles: unknown[] = [];
    await expect(
      capturedHandler?.({
        type: "agent",
        action: "bootstrap",
        sessionKey: "agent:main",
        context: { bootstrapFiles, sessionKey: "agent:main" },
        timestamp: new Date(),
        messages: [],
      })
    ).resolves.toBeUndefined();

    expect(bootstrapFiles).toHaveLength(0);
  });
});
