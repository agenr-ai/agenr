import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryRepository } from "../../../src/app/memory/ports.js";
import type { DatabasePort, EmbeddingPort, LlmPort } from "../../../src/core/ports.js";
import type { StoreEntriesDetailedResult } from "../../../src/core/store/pipeline.js";
import type { Entry } from "../../../src/core/types.js";
import type { AgenrSkelnServices, SkelnToolLike } from "../../../src/adapters/skeln/types.js";

const createAgenrSkelnServicesMock = vi.hoisted(() => vi.fn());
const storeEntriesDetailedMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/adapters/skeln/runtime.js", () => ({
  createAgenrSkelnServices: createAgenrSkelnServicesMock,
}));

vi.mock("../../../src/core/store/pipeline.js", () => ({
  storeEntriesDetailed: storeEntriesDetailedMock,
}));

describe("createAgenrSkelnMemoryProvider", () => {
  afterEach(() => {
    createAgenrSkelnServicesMock.mockReset();
    storeEntriesDetailedMock.mockReset();
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

    expect(tools).toHaveLength(3);
    expect(tools.map((tool) => tool.name)).toEqual(["agenr_store", "agenr_recall", "agenr_update"]);
    expect(createAgenrSkelnServicesMock).not.toHaveBeenCalled();
  });

  it("exposes a store approval target without initializing services", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();
    const tool = findTool(provider.tools?.({ sessionId: "session-1" }) ?? [], "agenr_store");

    expect(tool.approvalTarget?.({ subject: "deployment decision" })).toEqual({ target: "deployment decision" });
    expect(tool.approvalTarget?.({ subject: "" })).toEqual({ target: "agenr store" });
    expect(createAgenrSkelnServicesMock).not.toHaveBeenCalled();
  });

  it("exposes a recall approval target without initializing services", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();
    const tool = findTool(provider.tools?.({ sessionId: "session-1" }) ?? [], "agenr_recall");

    expect(tool?.approvalTarget?.({ query: "deployment decision" })).toEqual({ target: "deployment decision" });
    expect(tool?.approvalTarget?.({ query: "" })).toEqual({ target: "agenr memory recall" });
    expect(createAgenrSkelnServicesMock).not.toHaveBeenCalled();
  });

  it("omits the recall tool when recall is disabled", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider({ tools: { recall: false } });

    expect((provider.tools?.({ sessionId: "session-1" }) ?? []).map((tool) => tool.name)).toEqual(["agenr_store", "agenr_update"]);
  });

  it("omits the store tool when store is disabled", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider({ tools: { store: false } });

    expect((provider.tools?.({ sessionId: "session-1" }) ?? []).map((tool) => tool.name)).toEqual(["agenr_recall", "agenr_update"]);
  });

  it("omits the update tool when update is disabled", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider({ tools: { update: false } });

    expect((provider.tools?.({ sessionId: "session-1" }) ?? []).map((tool) => tool.name)).toEqual(["agenr_store", "agenr_recall"]);
  });

  it("omits all tools when enabled is false", async () => {
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider({ tools: { enabled: false } });

    expect(provider.tools?.({ sessionId: "session-1" }) ?? []).toEqual([]);
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

  it("throws a readable store error when services cannot initialize", async () => {
    createAgenrSkelnServicesMock.mockRejectedValue(new Error("database unavailable"));
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider({ databasePath: "/tmp/missing.db" });
    const tool = findTool(provider.tools?.({ sessionId: "session-1" }) ?? [], "agenr_store");

    await expect(tool.execute("call-1", { type: "fact", subject: "deployment decision", content: "Use feature flags." })).rejects.toThrow(
      "agenr_store failed: database unavailable",
    );
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

  it("stores an entry and passes Skeln provenance to the store pipeline", async () => {
    const entry = createEntry({
      id: "entry-2",
      subject: "feature flag policy",
    });
    const entries = {} as DatabasePort;
    const embedding = createEmbeddingPort();
    const claimExtraction = {
      llm: {} as LlmPort,
      config: {
        enabled: true,
        confidenceThreshold: 0.9,
        eligibleTypes: ["fact", "decision"],
        concurrency: 1,
      },
    };
    const storeResult = createStoreResult({ stored: 1 });
    storeEntriesDetailedMock.mockResolvedValue(storeResult);
    createAgenrSkelnServicesMock.mockResolvedValue(
      createServices({
        entries,
        embedding,
        claimExtraction,
        memory: {
          findEntryBySubject: vi.fn<MemoryRepository["findEntryBySubject"]>(async () => entry),
        },
      }),
    );
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();
    const tool = findTool(provider.tools?.({ sessionId: "session-1", sessionKey: "skeln-key-1" }) ?? [], "agenr_store");

    expect(tool.executionMode).toBe("sequential");

    const result = await tool.execute("call-1", {
      type: "decision",
      subject: "feature flag policy",
      content: "Gate risky rollout work behind a feature flag until verification is complete.",
      importance: 8,
      expiry: "permanent",
      tags: [" rollout ", "policy", "policy"],
      sourceContext: "User stated this during rollout planning.",
      supersedes: "entry-old",
      claimKey: "project/deploy_strategy",
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2026-02-01T00:00:00.000Z",
    });

    expect(storeEntriesDetailedMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          type: "decision",
          subject: "feature flag policy",
          content: "Gate risky rollout work behind a feature flag until verification is complete.",
          importance: 8,
          expiry: "permanent",
          tags: ["rollout", "policy"],
          source_context: "User stated this during rollout planning.",
          source_file: "skeln-session:skeln-key-1",
          supersedes: "entry-old",
          claim_key: "project/deploy_strategy",
          claim_key_raw: "project/deploy_strategy",
          claim_support_source_kind: "tool_call",
          claim_support_locator: "skeln-session:skeln-key-1#agenr_store",
          claim_support_observed_at: expect.any(String),
          claim_support_mode: "explicit",
          valid_from: "2026-01-01T00:00:00.000Z",
          valid_to: "2026-02-01T00:00:00.000Z",
        }),
      ],
      entries,
      embedding,
      {
        claimExtraction: {
          llm: claimExtraction.llm,
          db: entries,
          config: claimExtraction.config,
        },
      },
    );
    expect(result).toEqual({
      content: [{ type: "text", text: 'Stored "feature flag policy".' }],
      details: {
        status: "stored",
        subject: "feature flag policy",
        entryId: "entry-2",
        sessionKey: "skeln-key-1",
        result: storeResult,
      },
    });
  });

  it("returns a skipped result when the store pipeline detects a duplicate", async () => {
    const entry = createEntry({ id: "entry-duplicate", subject: "feature flag policy" });
    const storeResult = createStoreResult({ skipped: 1, details: [{ inputIndex: 0, outcome: "skipped", reason: "content_hash" }] });
    storeEntriesDetailedMock.mockResolvedValue(storeResult);
    createAgenrSkelnServicesMock.mockResolvedValue(
      createServices({
        memory: {
          findEntryBySubject: vi.fn<MemoryRepository["findEntryBySubject"]>(async () => entry),
        },
      }),
    );
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();
    const tool = findTool(provider.tools?.({ sessionId: "session-1" }) ?? [], "agenr_store");

    const result = await tool.execute("call-1", {
      type: "fact",
      subject: "feature flag policy",
      content: "Gate risky rollout work behind a feature flag.",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: 'Skipped "feature flag policy" because an active duplicate already exists.' }],
      details: {
        status: "skipped",
        subject: "feature flag policy",
        entryId: "entry-duplicate",
        result: storeResult,
      },
    });
  });

  it("throws a readable error when the store pipeline rejects the entry", async () => {
    storeEntriesDetailedMock.mockResolvedValue(createStoreResult({ rejected: 1, details: [{ inputIndex: 0, outcome: "rejected", reason: "validation" }] }));
    createAgenrSkelnServicesMock.mockResolvedValue(createServices());
    const { createAgenrSkelnMemoryProvider } = await import("../../../src/adapters/skeln/index.js");
    const provider = createAgenrSkelnMemoryProvider();
    const tool = findTool(provider.tools?.({ sessionId: "session-1" }) ?? [], "agenr_store");

    await expect(
      tool.execute("call-1", {
        type: "fact",
        subject: "feature flag policy",
        content: "Gate risky rollout work behind a feature flag.",
      }),
    ).rejects.toThrow('agenr_store failed: Rejected "feature flag policy". Check the supplied type, content, and metadata.');
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

function createServices(
  overrides: {
    entries?: Partial<DatabasePort>;
    embedding?: EmbeddingPort;
    claimExtraction?: AgenrSkelnServices["claimExtraction"];
    memory?: Partial<MemoryRepository>;
  } = {},
): AgenrSkelnServices {
  return {
    dbPath: "/tmp/agenr.db",
    entries: overrides.entries as DatabasePort,
    episodes: {} as AgenrSkelnServices["episodes"],
    procedures: {} as AgenrSkelnServices["procedures"],
    memory: {
      findEntryBySubject: vi.fn<MemoryRepository["findEntryBySubject"]>(async () => null),
      findMostRecentEntry: vi.fn<MemoryRepository["findMostRecentEntry"]>(async () => null),
      getEntryTrace: vi.fn<MemoryRepository["getEntryTrace"]>(async () => null),
      getMemoryStatusSnapshot: vi.fn<MemoryRepository["getMemoryStatusSnapshot"]>(),
      probeVectorAvailability: vi.fn<MemoryRepository["probeVectorAvailability"]>(),
      ...overrides.memory,
    },
    embedding: overrides.embedding ?? createEmbeddingPort(),
    recall: {} as AgenrSkelnServices["recall"],
    ...(overrides.claimExtraction ? { claimExtraction: overrides.claimExtraction } : {}),
    embeddingStatus: { available: false },
    async close(): Promise<void> {},
  };
}

function createEmbeddingPort(): EmbeddingPort {
  return {
    async embed(): Promise<number[][]> {
      return [[]];
    },
  };
}

function createStoreResult(overrides: Partial<StoreEntriesDetailedResult>): StoreEntriesDetailedResult {
  return {
    stored: 0,
    skipped: 0,
    rejected: 0,
    details: [],
    ...overrides,
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
