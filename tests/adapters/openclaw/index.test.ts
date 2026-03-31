import { describe, expect, it, vi } from "vitest";

const {
  buildAgenrMemoryPromptSectionMock,
  buildAgenrMemoryFlushPlanMock,
  createAgenrMemoryRuntimeMock,
  createAgenrOpenClawPluginConfigSchemaMock,
  createAgenrOpenClawServicesMock,
  handleAgenrBeforePromptBuildMock,
  registerAgenrOpenClawToolsMock,
  tracker,
} = vi.hoisted(() => ({
  buildAgenrMemoryPromptSectionMock: vi.fn(),
  buildAgenrMemoryFlushPlanMock: vi.fn(),
  createAgenrMemoryRuntimeMock: vi.fn(() => ({ closeAllMemorySearchManagers: vi.fn() })),
  createAgenrOpenClawPluginConfigSchemaMock: vi.fn(() => ({})),
  createAgenrOpenClawServicesMock: vi.fn(() => Promise.resolve({ close: vi.fn() })),
  handleAgenrBeforePromptBuildMock: vi.fn(),
  registerAgenrOpenClawToolsMock: vi.fn(),
  tracker: {
    consume: vi.fn(),
    rememberSessionStart: vi.fn(),
    getResumedFrom: vi.fn(),
    getSessionStart: vi.fn(),
  },
}));

vi.mock("../../../src/adapters/openclaw/config.js", () => ({
  coerceAgenrOpenClawPluginConfig: vi.fn(() => ({})),
  createAgenrOpenClawPluginConfigSchema: createAgenrOpenClawPluginConfigSchemaMock,
}));

vi.mock("../../../src/adapters/openclaw/format/prompt-section.js", () => ({
  buildAgenrMemoryPromptSection: buildAgenrMemoryPromptSectionMock,
}));

vi.mock("../../../src/adapters/openclaw/hooks/before-prompt-build.js", () => ({
  handleAgenrBeforePromptBuild: handleAgenrBeforePromptBuildMock,
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

vi.mock("../../../src/adapters/openclaw/session/state.js", () => ({
  createSessionStartTracker: vi.fn(() => tracker),
}));

vi.mock("../../../src/adapters/openclaw/tools.js", () => ({
  registerAgenrOpenClawTools: registerAgenrOpenClawToolsMock,
}));

describe("openclaw plugin entry", () => {
  it("forwards session_start resumedFrom facts into the tracker", async () => {
    const { default: plugin } = await import("../../../src/adapters/openclaw/index.js");
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const api = {
      config: {},
      logger,
      on: vi.fn((event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
        handlers.set(event, handler);
      }),
      pluginConfig: {},
      registerMemoryFlushPlan: vi.fn(),
      registerMemoryPromptSection: vi.fn(),
      registerMemoryRuntime: vi.fn(),
      resolvePath: vi.fn((value: string) => value),
      runtime: {
        agent: {},
        state: {},
      },
    };

    plugin.register(api as never);

    const sessionStartHandler = handlers.get("session_start");
    expect(sessionStartHandler).toBeTypeOf("function");

    sessionStartHandler?.({
      resumedFrom: "session-prev",
      sessionId: "session-next",
      sessionKey: "agent:main:main",
    });

    expect(tracker.rememberSessionStart).toHaveBeenCalledWith("session-next", "agent:main:main", "session-prev");
    expect(logger.debug).toHaveBeenCalledWith(
      "[agenr] session-start tracker: remembered session_start for session=session-next key=agent:main:main resumedFrom=session-prev",
    );
  });
});
