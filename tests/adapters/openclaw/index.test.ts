import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";

const registerAgenrOpenClawToolsMock = vi.hoisted(() => vi.fn());
const coerceAgenrOpenClawPluginConfigMock = vi.hoisted(() => vi.fn());
const createAgenrOpenClawPluginConfigSchemaMock = vi.hoisted(() => vi.fn(() => ({ parse: vi.fn() })));
const resolveStoreNudgeConfigMock = vi.hoisted(() => vi.fn());
const buildAgenrMemoryPromptSectionMock = vi.hoisted(() => vi.fn());
const handleAgenrAfterToolCallMock = vi.hoisted(() => vi.fn());
const handleAgenrBeforePromptBuildMock = vi.hoisted(() => vi.fn());
const handleAgenrSessionEndMock = vi.hoisted(() => vi.fn());
const routeOpenClawSessionMemoryTriggerMock = vi.hoisted(() => vi.fn(async () => undefined));
const buildAgenrMemoryFlushPlanMock = vi.hoisted(() => vi.fn());
const createAgenrMemoryRuntimeMock = vi.hoisted(() => vi.fn());
const createAgenrOpenClawServicesMock = vi.hoisted(() => vi.fn());
const createMidSessionTrackerMock = vi.hoisted(() => vi.fn());
const createSessionStartTrackerMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/adapters/openclaw/tools.js", () => ({
  registerAgenrOpenClawTools: registerAgenrOpenClawToolsMock,
}));

vi.mock("../../../src/adapters/openclaw/config.js", () => ({
  coerceAgenrOpenClawPluginConfig: coerceAgenrOpenClawPluginConfigMock,
  createAgenrOpenClawPluginConfigSchema: createAgenrOpenClawPluginConfigSchemaMock,
  resolveStoreNudgeConfig: resolveStoreNudgeConfigMock,
}));

vi.mock("../../../src/adapters/openclaw/format/prompt-section.js", () => ({
  buildAgenrMemoryPromptSection: buildAgenrMemoryPromptSectionMock,
}));

vi.mock("../../../src/adapters/openclaw/hooks/after-tool-call.js", () => ({
  handleAgenrAfterToolCall: handleAgenrAfterToolCallMock,
}));

vi.mock("../../../src/adapters/openclaw/hooks/before-prompt-build.js", () => ({
  handleAgenrBeforePromptBuild: handleAgenrBeforePromptBuildMock,
}));

vi.mock("../../../src/adapters/openclaw/hooks/session-end.js", () => ({
  handleAgenrSessionEnd: handleAgenrSessionEndMock,
}));

vi.mock("../../../src/adapters/openclaw/hooks/session-memory-routing.js", () => ({
  routeOpenClawSessionMemoryTrigger: routeOpenClawSessionMemoryTriggerMock,
}));

vi.mock("../../../src/adapters/openclaw/hooks/session-memory.js", () => ({
  buildOpenClawSessionBeforeCompactTriggerEvent: vi.fn(),
  buildOpenClawSessionBeforeTreeTriggerEvent: vi.fn(),
  buildOpenClawSessionCompactTriggerEvent: vi.fn(),
  buildOpenClawSessionStartTriggerEvent: vi.fn(),
}));

vi.mock("../../../src/adapters/openclaw/memory/flush-plan.js", () => ({
  buildAgenrMemoryFlushPlan: buildAgenrMemoryFlushPlanMock,
}));

vi.mock("../../../src/adapters/openclaw/memory/runtime.js", () => ({
  createAgenrMemoryRuntime: createAgenrMemoryRuntimeMock,
}));

vi.mock("../../../src/adapters/openclaw/runtime.js", () => ({
  createAgenrOpenClawServices: createAgenrOpenClawServicesMock,
}));

vi.mock("../../../src/app/plugin-runtime/session-tracking.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/plugin-runtime/session-tracking.js")>();
  return {
    ...actual,
    createSessionStartTracker: createSessionStartTrackerMock,
  };
});

vi.mock("../../../src/adapters/openclaw/session/state.js", () => ({
  createMidSessionTracker: createMidSessionTrackerMock,
}));

import agenrOpenClawPlugin from "../../../src/adapters/openclaw/index.js";

describe("agenr OpenClaw plugin entry", () => {
  it("registers the unified memory capability and keeps hook wiring intact", async () => {
    const fakeServices = {
      close: vi.fn(async () => undefined),
    };
    const sessionStartTracker = {
      consume: vi.fn(() => ({ isFirst: true, activeCount: 1 })),
    };
    const midSessionTracker = {
      clear: vi.fn(),
    };
    const pluginConfig = {
      dbPath: "/tmp/agenr/knowledge.db",
      storeNudge: {
        enabled: true,
      },
    };
    const storeNudgeConfig = {
      enabled: true,
      threshold: 8,
      maxPerSession: 5,
    };
    const memoryRuntime = {
      getMemorySearchManager: vi.fn(),
      resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
    };
    const hookHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const logger = createLogger();

    coerceAgenrOpenClawPluginConfigMock.mockReturnValue(pluginConfig);
    resolveStoreNudgeConfigMock.mockReturnValue(storeNudgeConfig);
    createSessionStartTrackerMock.mockReturnValue(sessionStartTracker);
    createMidSessionTrackerMock.mockReturnValue(midSessionTracker);
    createAgenrOpenClawServicesMock.mockResolvedValue(fakeServices);
    createAgenrMemoryRuntimeMock.mockReturnValue(memoryRuntime);
    buildAgenrMemoryFlushPlanMock.mockReturnValue(null);
    handleAgenrBeforePromptBuildMock.mockResolvedValue({ prependContext: "memory" });

    const api = createPluginApi({
      logger,
      on(eventName, handler) {
        hookHandlers.set(eventName, handler as (event: unknown, ctx: unknown) => unknown);
      },
    });

    agenrOpenClawPlugin.register(api);

    expect(createAgenrOpenClawServicesMock).toHaveBeenCalledWith(pluginConfig, {
      openClaw: {
        config: api.config,
        runtime: {
          agent: api.runtime.agent,
          state: api.runtime.state,
          modelAuth: api.runtime.modelAuth,
        },
      },
      resolvePath: api.resolvePath,
    });
    expect(createAgenrMemoryRuntimeMock).toHaveBeenCalledTimes(1);
    expect(registerAgenrOpenClawToolsMock).toHaveBeenCalledWith(api, expect.any(Promise), logger);
    expect(api.registerMemoryCapability).toHaveBeenCalledTimes(1);

    const registeredCapability = api.registerMemoryCapability.mock.calls[0]?.[0];
    expect(registeredCapability).toMatchObject({
      promptBuilder: buildAgenrMemoryPromptSectionMock,
      runtime: memoryRuntime,
    });

    const flushPlanResolver = registeredCapability?.flushPlanResolver;
    expect(flushPlanResolver).toBeTypeOf("function");
    expect(flushPlanResolver?.({ nowMs: 123 })).toBeNull();
    expect(buildAgenrMemoryFlushPlanMock).toHaveBeenCalledWith({ nowMs: 123 }, logger);

    expect(hookHandlers.has("session_start")).toBe(true);
    expect(hookHandlers.has("before_compaction")).toBe(true);
    expect(hookHandlers.has("after_compaction")).toBe(true);
    expect(hookHandlers.has("before_reset")).toBe(true);

    await expect(
      hookHandlers.get("before_prompt_build")?.(
        {
          prompt: "What changed?",
          messages: [],
        },
        {
          sessionId: "session-1",
          sessionKey: "agent:main:webchat:test",
        },
      ),
    ).resolves.toEqual({ prependContext: "memory" });
    expect(handleAgenrBeforePromptBuildMock).toHaveBeenCalledWith(
      {
        prompt: "What changed?",
        messages: [],
      },
      {
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:test",
      },
      {
        logger,
        servicesPromise: expect.any(Promise),
        tracker: sessionStartTracker,
        midSessionTracker,
        compactionPromptTracker: expect.objectContaining({
          shouldInject: expect.any(Function),
          markInjected: expect.any(Function),
          clear: expect.any(Function),
        }),
        lifecycleIntakeTracker: expect.objectContaining({
          track: expect.any(Function),
          wait: expect.any(Function),
          clear: expect.any(Function),
        }),
        storeNudgeConfig,
      },
    );

    hookHandlers.get("after_tool_call")?.(
      {
        toolName: "agenr_store",
        params: {},
      },
      {
        sessionId: "session-2",
        sessionKey: "agent:main:webchat:next",
      },
    );
    expect(handleAgenrAfterToolCallMock).toHaveBeenCalledWith(
      {
        toolName: "agenr_store",
        params: {},
      },
      {
        sessionId: "session-2",
        sessionKey: "agent:main:webchat:next",
      },
      {
        logger,
        midSessionTracker,
      },
    );

    await hookHandlers.get("session_end")?.(
      {
        sessionId: "session-2",
        sessionKey: "agent:main:webchat:next",
        messageCount: 4,
      },
      undefined,
    );
    expect(handleAgenrSessionEndMock).toHaveBeenCalledWith(
      {
        sessionId: "session-2",
        sessionKey: "agent:main:webchat:next",
        messageCount: 4,
      },
      {
        logger,
        servicesPromise: expect.any(Promise),
        midSessionTracker,
      },
    );

    await hookHandlers.get("gateway_stop")?.({}, undefined);
    expect(fakeServices.close).toHaveBeenCalledTimes(1);
  });

  it("logs startup failures without letting the registration promise go unhandled", async () => {
    const startupError = new Error("Unsupported agenr database because the durables.retired column is present. Create a fresh database with `agenr db reset`.");
    const logger = createLogger();

    coerceAgenrOpenClawPluginConfigMock.mockReturnValue({});
    resolveStoreNudgeConfigMock.mockReturnValue({
      enabled: true,
      threshold: 8,
      maxPerSession: 5,
    });
    createSessionStartTrackerMock.mockReturnValue({
      consume: vi.fn(() => ({ isFirst: true, activeCount: 1 })),
    });
    createMidSessionTrackerMock.mockReturnValue({
      clear: vi.fn(),
    });
    createAgenrOpenClawServicesMock.mockRejectedValue(startupError);
    createAgenrMemoryRuntimeMock.mockReturnValue({
      getMemorySearchManager: vi.fn(),
      resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
    });

    const api = createPluginApi({
      logger,
      on: vi.fn(),
    });

    agenrOpenClawPlugin.register(api);
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledWith(`[agenr] startup failed: ${startupError.message}`);
  });
});

function createPluginApi(overrides: { logger: ReturnType<typeof createLogger>; on: NonNullable<OpenClawPluginApi["on"]> }): OpenClawPluginApi & {
  registerMemoryCapability: ReturnType<typeof vi.fn>;
} {
  return {
    pluginConfig: {},
    config: { plugins: {} },
    runtime: {
      agent: {
        resolveAgentDir: vi.fn(),
        resolveAgentWorkspaceDir: vi.fn(),
        runEmbeddedPiAgent: vi.fn(),
      },
      state: {
        resolveStateDir: vi.fn(),
      },
      modelAuth: {
        resolveApiKeyForProvider: vi.fn(),
      },
    },
    logger: overrides.logger,
    registerMemoryCapability: vi.fn(),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerSpeechProvider: vi.fn(),
    registerMediaUnderstandingProvider: vi.fn(),
    registerImageGenerationProvider: vi.fn(),
    registerWebSearchProvider: vi.fn(),
    registerInteractiveHandler: vi.fn(),
    onConversationBindingResolved: vi.fn(),
    registerCommand: vi.fn(),
    registerContextEngine: vi.fn(),
    registerMemoryPromptSection: vi.fn(),
    registerMemoryFlushPlan: vi.fn(),
    registerMemoryRuntime: vi.fn(),
    resolvePath: vi.fn((input: string) => input),
    on: overrides.on,
  } as unknown as OpenClawPluginApi & {
    registerMemoryCapability: ReturnType<typeof vi.fn>;
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
