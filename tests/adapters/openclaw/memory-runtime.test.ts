import { describe, expect, it, vi } from "vitest";

const searchAgenrDurablesThroughMemoryHostMock = vi.hoisted(() =>
  vi.fn(async () => [{ path: "user/preference/theme", startLine: 1, endLine: 1, score: 0.9, snippet: "prefers dark mode", source: "memory" as const }]),
);

vi.mock("../../../src/adapters/openclaw/memory/search-bridge.js", () => ({
  searchAgenrDurablesThroughMemoryHost: searchAgenrDurablesThroughMemoryHostMock,
}));

import { createAgenrMemoryRuntime } from "../../../src/adapters/openclaw/memory/runtime.js";
import type { AgenrOpenClawServices } from "../../../src/adapters/openclaw/types.js";

describe("createAgenrMemoryRuntime", () => {
  it("bridges durable recall into the generic memory-host search surface", async () => {
    const services = {
      config: {
        dbPath: "/tmp/agenr/knowledge.db",
        configPath: "/tmp/agenr/config.json",
      },
      embeddingStatus: {
        available: true,
        provider: "openai",
        requestedProvider: "openai",
        model: "text-embedding-3-small",
      },
      memory: {
        getMemoryStatusSnapshot: vi.fn(async () => ({
          activeEntries: 12,
          coreEntries: 3,
          sourceFiles: 4,
        })),
        probeVectorAvailability: vi.fn(async () => true),
      },
      close: vi.fn(async () => undefined),
    } as unknown as AgenrOpenClawServices;

    const runtime = createAgenrMemoryRuntime(Promise.resolve(services));
    const result = await runtime.getMemorySearchManager({
      agentId: "main",
      cfg: {} as AgenrOpenClawServices["openClaw"]["config"],
      purpose: "status",
    });

    expect(result.error).toBeUndefined();
    expect(await result.manager?.search("workflow policy", { maxResults: 3, sessionKey: "agent:main:webchat:test" })).toEqual([
      {
        path: "user/preference/theme",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "prefers dark mode",
        source: "memory",
      },
    ]);
    expect(searchAgenrDurablesThroughMemoryHostMock).toHaveBeenCalledWith("workflow policy", services, {
      maxResults: 3,
      minScore: undefined,
      sessionKey: "agent:main:webchat:test",
    });
    await expect(result.manager?.readFile({ relPath: "memory.md" })).rejects.toThrow('[agenr] memory file reads are not supported for "memory.md"');
    expect(result.manager?.status()).toMatchObject({
      backend: "builtin",
      provider: "agenr",
      dbPath: "/tmp/agenr/knowledge.db",
      files: 4,
      chunks: 12,
      vector: {
        enabled: true,
        available: true,
      },
    });
    await expect(result.manager?.probeEmbeddingAvailability()).resolves.toEqual({
      ok: true,
    });
    await expect(result.manager?.probeVectorAvailability()).resolves.toBe(true);

    await runtime.closeAllMemorySearchManagers?.();
    expect(services.close).toHaveBeenCalledTimes(1);
  });

  it("returns a stable error payload when startup services fail", async () => {
    const runtime = createAgenrMemoryRuntime(
      Promise.reject(new Error("Unsupported agenr database because the durables.retired column is present. Create a fresh database with `agenr db reset`.")),
    );
    const result = await runtime.getMemorySearchManager({
      agentId: "main",
      cfg: {} as AgenrOpenClawServices["openClaw"]["config"],
      purpose: "status",
    });

    expect(result.manager).toBeNull();
    expect(result.error).toContain("[agenr] memory runtime unavailable:");
    expect(result.error).toContain("Unsupported agenr database because the durables.retired column is present.");
    await expect(runtime.closeAllMemorySearchManagers?.()).resolves.toBeUndefined();
  });
});
