import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cluster } from "../src/consolidate/cluster.js";
import type { ConsolidationStats } from "../src/consolidate/rules.js";
import type { LlmClient } from "../src/types.js";

const baseRulesStats: ConsolidationStats = {
  entriesBefore: 100,
  entriesAfter: 90,
  expiredCount: 5,
  mergedCount: 5,
  orphanedRelationsCleaned: 1,
  backupPath: "/tmp/backup.db",
};

function makeCluster(ids: string[]): Cluster {
  return {
    entries: ids.map((id, index) => ({
      id,
      type: "fact",
      subject: "Subject",
      content: id,
      importance: 5,
      embedding: [1, 0, 0, ...Array.from({ length: 509 }, () => 0)],
      confirmations: 1,
      recallCount: 1,
      createdAt: new Date(2026, 1, index + 1).toISOString(),
    })),
  };
}

function makeLlmClient(): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId: "gpt-4o",
      model: {} as any,
    },
    credentials: {
      apiKey: "test-key",
      source: "test",
    },
  };
}

describe("consolidate orchestrator", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];
  const resetModules = () => {
    if (typeof vi.resetModules === "function") {
      vi.resetModules();
    }
  };

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    resetModules();
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  async function setupModule() {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-orchestrate-home-"));
    tempDirs.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    resetModules();
    return import("../src/consolidate/orchestrate.js");
  }

  function makeDeps(overrides?: Partial<{
    buildClustersFn: (typeFilter?: string, simThreshold?: number, minCluster?: number) => Cluster[];
    mergeThrows: boolean;
  }>) {
    const acquireLockFn = vi.fn();
    const releaseLockFn = vi.fn();
    const rebuildVectorIndexFn = vi.fn(async () => ({ embeddingCount: 0, durationMs: 1 }));
    const walCheckpointFn = vi.fn(async () => undefined);

    const buildClustersFn = vi.fn(async (_db: Client, options: { typeFilter?: string; simThreshold?: number; minCluster?: number }) => {
      if (overrides?.buildClustersFn) {
        return overrides.buildClustersFn(options.typeFilter, options.simThreshold, options.minCluster);
      }
      return [];
    });

    const mergeClusterFn = vi.fn(async () => {
      if (overrides?.mergeThrows) {
        throw new Error("merge failed");
      }
      return {
        mergedEntryId: "merged",
        sourceIds: ["a", "b"],
        flagged: false,
      };
    });

    return {
      deps: {
        acquireLockFn,
        releaseLockFn,
        consolidateRulesFn: vi.fn(async () => baseRulesStats),
        buildClustersFn,
        mergeClusterFn,
        rebuildVectorIndexFn,
        walCheckpointFn,
        countActiveEntriesFn: vi.fn(async () => 70),
        countActiveEmbeddedEntriesFn: vi.fn(async (_db: Client, type?: string) => (type ? 10 : 50)),
      },
      spies: {
        acquireLockFn,
        releaseLockFn,
        buildClustersFn,
        mergeClusterFn,
        rebuildVectorIndexFn,
        walCheckpointFn,
      },
    };
  }

  it("runs type-scoped Phase 1 and skips Phase 2 when type filter is provided", async () => {
    const mod = await setupModule();
    const { deps, spies } = makeDeps({
      buildClustersFn: (typeFilter) => (typeFilter === "decision" ? [makeCluster(["d1", "d2"])] : []),
    });

    const report = await mod.runConsolidationOrchestrator(
      {} as Client,
      "/tmp/knowledge.db",
      makeLlmClient(),
      "embed-key",
      { type: "decision" },
      deps,
    );

    expect(spies.buildClustersFn).toHaveBeenCalledTimes(1);
    expect(spies.buildClustersFn.mock.calls[0]?.[1]).toMatchObject({ typeFilter: "decision" });
    expect(report.phase2).toBeUndefined();
    expect(report.phase1.types).toHaveLength(1);
    expect(report.phase1.types[0]?.clustersProcessed).toBe(1);
  });

  it("uses minCluster=2 and phase thresholds 0.82/0.88 by default", async () => {
    const mod = await setupModule();
    const { deps, spies } = makeDeps();

    await mod.runConsolidationOrchestrator({} as Client, "/tmp/knowledge.db", makeLlmClient(), "embed-key", {}, deps);

    const calls = spies.buildClustersFn.mock.calls.map((call) => call[1] as { typeFilter?: string; simThreshold?: number; minCluster?: number });
    const phase1FactCall = calls.find((call) => call.typeFilter === "fact");
    const phase2Call = calls.find((call) => !call.typeFilter);
    expect(phase1FactCall?.minCluster).toBe(2);
    expect(phase1FactCall?.simThreshold).toBe(0.82);
    expect(phase2Call?.minCluster).toBe(2);
    expect(phase2Call?.simThreshold).toBe(0.88);
  });

  it("stops after batch limit and persists checkpoint", async () => {
    const mod = await setupModule();
    const { deps } = makeDeps({
      buildClustersFn: (typeFilter) => {
        if (typeFilter === "fact") {
          return [makeCluster(["a", "b"]), makeCluster(["c", "d"]), makeCluster(["e", "f"])];
        }
        return [];
      },
    });

    const report = await mod.runConsolidationOrchestrator(
      {} as Client,
      "/tmp/knowledge.db",
      makeLlmClient(),
      "embed-key",
      { batch: 2, resume: false },
      deps,
    );

    expect(report.progress.partial).toBe(true);
    expect(report.progress.processedClusters).toBe(2);
    const raw = await fs.readFile(mod.CONSOLIDATION_CHECKPOINT_PATH, "utf8");
    const checkpoint = JSON.parse(raw) as { phase: number; typeIndex: number; clusterIndex: number; startedAt: string };
    expect(checkpoint.phase).toBe(1);
    expect(typeof checkpoint.typeIndex).toBe("number");
    expect(typeof checkpoint.clusterIndex).toBe("number");
    expect(typeof checkpoint.startedAt).toBe("string");
  });

  it("resumes from checkpoint and skips already processed cluster fingerprints", async () => {
    const mod = await setupModule();
    const firstRun = makeDeps({
      buildClustersFn: (typeFilter) => {
        if (typeFilter === "fact") {
          return [makeCluster(["a", "b"]), makeCluster(["c", "d"])];
        }
        return [];
      },
    });

    const firstReport = await mod.runConsolidationOrchestrator(
      {} as Client,
      "/tmp/knowledge.db",
      makeLlmClient(),
      "embed-key",
      { batch: 1, resume: false, onLog: () => undefined },
      firstRun.deps,
    );
    expect(firstReport.progress.partial).toBe(true);

    const checkpointRaw = await fs.readFile(mod.CONSOLIDATION_CHECKPOINT_PATH, "utf8");
    const checkpoint = JSON.parse(checkpointRaw) as { processed?: { phase1?: Record<string, string[]> } };
    expect((checkpoint.processed?.phase1?.fact ?? []).length).toBe(1);

    const resumeLogs: string[] = [];
    const secondRun = makeDeps({
      buildClustersFn: (typeFilter) => {
        if (typeFilter === "fact") {
          return [makeCluster(["a", "b"]), makeCluster(["c", "d"])];
        }
        return [];
      },
    });

    const report = await mod.runConsolidationOrchestrator(
      {} as Client,
      "/tmp/knowledge.db",
      makeLlmClient(),
      "embed-key",
      { onLog: (line) => resumeLogs.push(line) },
      secondRun.deps,
    );

    expect(secondRun.spies.mergeClusterFn).toHaveBeenCalledTimes(1);
    expect(report.progress.resumed || resumeLogs.some((line) => line.includes("Resuming from checkpoint"))).toBe(true);
    await expect(fs.access(mod.CONSOLIDATION_CHECKPOINT_PATH)).rejects.toThrow();
  });

  it("releases lock on merge failure and runs final rebuild/checkpoint only once per invocation", async () => {
    const mod = await setupModule();
    const { deps, spies } = makeDeps({
      buildClustersFn: (typeFilter) => (typeFilter === "fact" ? [makeCluster(["a", "b"])] : []),
      mergeThrows: true,
    });

    await expect(
      mod.runConsolidationOrchestrator({} as Client, "/tmp/knowledge.db", makeLlmClient(), "embed-key", {}, deps),
    ).rejects.toThrow("merge failed");
    expect(spies.acquireLockFn).toHaveBeenCalledTimes(1);
    expect(spies.releaseLockFn).toHaveBeenCalledTimes(1);
    expect(spies.rebuildVectorIndexFn).toHaveBeenCalledTimes(0);
    expect(spies.walCheckpointFn).toHaveBeenCalledTimes(0);

    const success = makeDeps({
      buildClustersFn: () => [],
    });
    await mod.runConsolidationOrchestrator({} as Client, "/tmp/knowledge.db", makeLlmClient(), "embed-key", {}, success.deps);
    expect(success.spies.rebuildVectorIndexFn).toHaveBeenCalledTimes(1);
    expect(success.spies.walCheckpointFn).toHaveBeenCalledTimes(1);
  });
});
