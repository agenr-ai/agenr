import { afterEach, describe, expect, it, vi } from "vitest";

const createAgenrSkelnServicesMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/adapters/skeln/runtime.js", () => ({
  createAgenrSkelnServices: createAgenrSkelnServicesMock,
}));

describe("createAgenrSkelnMemoryProvider", () => {
  afterEach(() => {
    createAgenrSkelnServicesMock.mockReset();
  });

  it("returns the agenr provider identity", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");

    const provider = createAgenrSkelnMemoryProvider();

    expect(provider.id).toBe("agenr");
    expect(provider.label.length).toBeGreaterThan(0);
  });

  it("keeps phase-1 context hooks disabled", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();

    await expect(provider.buildSessionStartContext({ sessionId: "session-1" })).resolves.toBeUndefined();
    await expect(provider.buildBeforeTurnContext({ sessionId: "session-1" })).resolves.toBeUndefined();
  });

  it("returns the recall tool by default without initializing services", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();

    const tools = provider.tools?.({ sessionId: "session-1" }) ?? [];

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("agenr_recall");
    expect(createAgenrSkelnServicesMock).not.toHaveBeenCalled();
  });

  it("exposes a recall approval target without initializing services", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();
    const tool = (provider.tools?.({ sessionId: "session-1" }) ?? [])[0];

    expect(tool?.approvalTarget?.({ query: "deployment decision" })).toEqual({ target: "deployment decision" });
    expect(tool?.approvalTarget?.({ query: "" })).toEqual({ target: "agenr memory recall" });
    expect(createAgenrSkelnServicesMock).not.toHaveBeenCalled();
  });

  it("omits the recall tool when recall is disabled", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider({ tools: { recall: false } });

    expect(provider.tools?.({ sessionId: "session-1" })).toEqual([]);
  });

  it("returns a readable error result when services cannot initialize", async () => {
    createAgenrSkelnServicesMock.mockRejectedValue(new Error("database unavailable"));
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider({ databasePath: "/tmp/missing.db" });
    const tool = (provider.tools?.({ sessionId: "session-1" }) ?? [])[0];

    if (!tool) {
      throw new Error("Expected recall tool.");
    }

    const result = await tool.execute("call-1", { query: "deployment decision" });

    expect(result).toEqual({
      content: [{ type: "text", text: "agenr_recall failed: database unavailable" }],
      details: { error: "database unavailable" },
      isError: true,
    });
  });

  it("allows dispose to be called twice", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();

    await provider.dispose?.();
    await provider.dispose?.();
  });
});
