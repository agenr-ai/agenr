import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryRepository } from "../../../src/app/memory/ports.js";
import type { DatabasePort } from "../../../src/core/ports.js";
import type { Entry } from "../../../src/core/types.js";
import type { AgenrSkelnServices, SkelnToolLike } from "../../../src/adapters/skeln/types.js";

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
    expect(provider.requiredCapabilities).toEqual(["external-persistence"]);
  });

  it("keeps phase-1 context hooks disabled", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();

    await expect(provider.buildSessionStartContext({ sessionId: "session-1" })).resolves.toBeUndefined();
    await expect(provider.buildBeforeTurnContext({ sessionId: "session-1" })).resolves.toBeUndefined();
  });

  it("returns the memory tools by default without initializing services", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();

    const tools = provider.tools?.({ sessionId: "session-1" }) ?? [];

    expect(tools).toHaveLength(2);
    expect(tools.map((tool) => tool.name)).toEqual(["agenr_recall", "agenr_update"]);
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

    expect((provider.tools?.({ sessionId: "session-1" }) ?? []).map((tool) => tool.name)).toEqual(["agenr_update"]);
  });

  it("omits the update tool when update is disabled", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider({ tools: { update: false } });

    expect((provider.tools?.({ sessionId: "session-1" }) ?? []).map((tool) => tool.name)).toEqual(["agenr_recall"]);
  });

  it("exposes an update approval target without initializing services", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();
    const tool = findTool(provider.tools?.({ sessionId: "session-1" }) ?? [], "agenr_update");

    expect(tool.approvalTarget?.({ id: "entry-1", subject: "deployment decision" })).toEqual({ target: "entry-1" });
    expect(tool.approvalTarget?.({ subject: "deployment decision" })).toEqual({ target: "deployment decision" });
    expect(tool.approvalTarget?.({ subject: "" })).toEqual({ target: "agenr update" });
    expect(createAgenrSkelnServicesMock).not.toHaveBeenCalled();
  });

  it("throws a readable recall error when services cannot initialize", async () => {
    createAgenrSkelnServicesMock.mockRejectedValue(new Error("database unavailable"));
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider({ databasePath: "/tmp/missing.db" });
    const tool = findTool(provider.tools?.({ sessionId: "session-1" }) ?? [], "agenr_recall");

    await expect(tool.execute("call-1", { query: "deployment decision" })).rejects.toThrow("agenr_recall failed: database unavailable");
  });

  it("throws a readable update error when services cannot initialize", async () => {
    createAgenrSkelnServicesMock.mockRejectedValue(new Error("database unavailable"));
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider({ databasePath: "/tmp/missing.db" });
    const tool = findTool(provider.tools?.({ sessionId: "session-1" }) ?? [], "agenr_update");

    await expect(tool.execute("call-1", { id: "entry-1", importance: 8 })).rejects.toThrow("agenr_update failed: database unavailable");
  });

  it("updates an entry and returns a Skeln-shaped success result", async () => {
    const entry = createEntry({
      id: "entry-1",
      subject: "deployment decision",
      valid_from: "2026-01-01T00:00:00.000Z",
    });
    const updateEntry = vi.fn<DatabasePort["updateEntry"]>(async () => true);
    const services = createServices({
      entries: {
        getEntry: vi.fn<DatabasePort["getEntry"]>(async () => entry),
        updateEntry,
      },
      memory: {
        findEntryBySubject: vi.fn<MemoryRepository["findEntryBySubject"]>(async () => null),
        findMostRecentEntry: vi.fn<MemoryRepository["findMostRecentEntry"]>(async () => null),
        getEntryTrace: vi.fn<MemoryRepository["getEntryTrace"]>(async () => null),
      },
    });
    createAgenrSkelnServicesMock.mockResolvedValue(services);
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();
    const tool = findTool(provider.tools?.({ sessionId: "session-1", sessionKey: "skeln-key-1" }) ?? [], "agenr_update");

    expect(tool.executionMode).toBe("sequential");

    const result = await tool.execute("call-1", {
      id: "entry-1",
      importance: 8,
      expiry: "core",
      claimKey: "project/deploy_strategy",
      validTo: "2026-02-01T00:00:00.000Z",
    });

    expect(updateEntry).toHaveBeenCalledWith(
      "entry-1",
      expect.objectContaining({
        importance: 8,
        expiry: "core",
        claim_key: "project/deploy_strategy",
        claim_key_status: "trusted",
        claim_key_source: "manual",
        claim_key_confidence: 1,
        claim_key_rationale: "manual claim key supplied by caller",
        claim_support_source_kind: "tool_call",
        claim_support_locator: "skeln-session:skeln-key-1#agenr_update",
        claim_support_observed_at: expect.any(String),
        claim_support_mode: "explicit",
        valid_to: "2026-02-01T00:00:00.000Z",
      }),
    );
    expect(result).toEqual({
      content: [{ type: "text", text: 'Updated "deployment decision".' }],
      details: {
        status: "updated",
        entryId: "entry-1",
        subject: "deployment decision",
        sessionKey: "skeln-key-1",
        importance: 8,
        expiry: "core",
        claimKey: "project/deploy_strategy",
        validTo: "2026-02-01T00:00:00.000Z",
      },
    });
  });

  it("allows dispose to be called twice", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();

    await provider.dispose?.();
    await provider.dispose?.();
  });
});

function findTool(tools: SkelnToolLike[], name: string): SkelnToolLike {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected ${name} tool.`);
  }
  return tool;
}

function createServices(overrides: {
  entries: Pick<DatabasePort, "getEntry" | "updateEntry">;
  memory: Pick<MemoryRepository, "findEntryBySubject" | "findMostRecentEntry" | "getEntryTrace">;
}): AgenrSkelnServices {
  return {
    dbPath: "/tmp/agenr.db",
    entries: overrides.entries as DatabasePort,
    episodes: {} as AgenrSkelnServices["episodes"],
    procedures: {} as AgenrSkelnServices["procedures"],
    memory: {
      ...overrides.memory,
      getMemoryStatusSnapshot: vi.fn<MemoryRepository["getMemoryStatusSnapshot"]>(),
      probeVectorAvailability: vi.fn<MemoryRepository["probeVectorAvailability"]>(),
    },
    recall: {} as AgenrSkelnServices["recall"],
    embeddingStatus: { available: false },
    async close(): Promise<void> {},
  };
}

function createEntry(overrides: Partial<Entry>): Entry {
  return {
    id: "entry-1",
    type: "fact",
    subject: "subject",
    content: "content",
    importance: 7,
    expiry: "permanent",
    tags: [],
    quality_score: 0.5,
    recall_count: 0,
    retired: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
