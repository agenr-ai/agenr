import { describe, expect, it, vi } from "vitest";

import { createAgenrMemoryRuntime } from "../../../src/adapters/openclaw/memory/runtime.js";
import type { AgenrOpenClawServices } from "../../../src/adapters/openclaw/types.js";

describe("createAgenrMemoryRuntime", () => {
  it("bridges status probes while leaving generic memory-host search empty", async () => {
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
    expect(await result.manager?.search("workflow policy")).toEqual([]);
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
    const runtime = createAgenrMemoryRuntime(Promise.reject(new Error('Unsupported agenr database schema version "10".')));
    const result = await runtime.getMemorySearchManager({
      agentId: "main",
      cfg: {} as AgenrOpenClawServices["openClaw"]["config"],
      purpose: "status",
    });

    expect(result.manager).toBeNull();
    expect(result.error).toContain("[agenr] memory runtime unavailable:");
    expect(result.error).toContain('Unsupported agenr database schema version "10".');
    await expect(runtime.closeAllMemorySearchManagers?.()).resolves.toBeUndefined();
  });
});
