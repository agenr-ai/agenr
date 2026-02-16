import * as clack from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConsolidateCommand } from "../../src/commands/consolidate.js";
import type { ConsolidationOrchestratorReport } from "../../src/consolidate/orchestrate.js";

function reportFixture(): ConsolidationOrchestratorReport {
  return {
    entriesBefore: 100,
    entriesAfter: 70,
    entriesAfterRules: 90,
    expiredCount: 5,
    mergedCount: 5,
    orphanedRelationsCleaned: 1,
    backupPath: "/tmp/knowledge.db.pre-consolidate-2026-02-16",
    estimate: {
      totalClusters: 4,
      estimatedLlmCalls: 4,
      phase1ByType: [],
      phase2Clusters: 1,
    },
    phase1: {
      totals: {
        entries: 20,
        clustersFound: 3,
        skippedByResume: 0,
        clustersProcessed: 3,
        clustersMerged: 2,
        mergesFlagged: 1,
        llmCalls: 3,
        entriesConsolidatedFrom: 6,
        canonicalEntriesCreated: 2,
      },
      types: [],
    },
    phase2: {
      entries: 10,
      clustersFound: 1,
      skippedByResume: 0,
      clustersProcessed: 1,
      clustersMerged: 1,
      mergesFlagged: 0,
      llmCalls: 1,
      entriesConsolidatedFrom: 2,
      canonicalEntriesCreated: 1,
    },
    progress: {
      resumed: false,
      checkpointPath: "/tmp/checkpoint",
      partial: false,
      processedClusters: 4,
      remainingClusters: 0,
    },
    summary: {
      totalLlmCalls: 4,
      totalFlagged: 1,
      totalCanonicalEntriesCreated: 3,
      totalEntriesConsolidatedFrom: 8,
    },
  };
}

describe("consolidate command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeDeps() {
    return {
      readConfigFn: vi.fn(() => ({ db: { path: "/tmp/knowledge.db" } })),
      getDbFn: vi.fn(() => ({}) as any),
      closeDbFn: vi.fn(() => undefined),
      initSchemaFn: vi.fn(async () => undefined),
      createLlmClientFn: vi.fn(() => ({} as any)),
      resolveEmbeddingApiKeyFn: vi.fn(() => "embed-key"),
      showFlaggedMergesFn: vi.fn(async () => undefined),
      runConsolidationOrchestratorFn: vi.fn(async (_db, _dbPath, _llm, _key, options) => {
        options.onLog?.("progress");
        options.onWarn?.("warning");
        return reportFixture();
      }),
    };
  }

  it("uses plain stderr logging and no clack output when --json is enabled", async () => {
    const deps = makeDeps();
    const infoSpy = vi.spyOn(clack.log, "info");
    const warnSpy = vi.spyOn(clack.log, "warn");
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runConsolidateCommand({ json: true }, deps);

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    const stderr = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(stderr).toContain("progress");
    expect(stderr).toContain("warning");

    const stdout = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    const parsed = JSON.parse(stdout) as { entriesBefore: number; entriesAfter: number };
    expect(parsed.entriesBefore).toBe(100);
    expect(parsed.entriesAfter).toBe(70);
  });

  it("bypasses clack in non-tty mode and emits plain text report", async () => {
    const deps = makeDeps();
    const infoSpy = vi.spyOn(clack.log, "info");
    const warnSpy = vi.spyOn(clack.log, "warn");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });

    try {
      await runConsolidateCommand({ json: false }, deps);
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Knowledge Consolidation");
    expect(output.includes("\u001b[")).toBe(false);
  });
});
