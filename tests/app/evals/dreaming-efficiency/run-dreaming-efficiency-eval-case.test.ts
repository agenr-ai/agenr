import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDreamingEfficiencyEvalCase } from "../../../../src/app/evals/dreaming-efficiency/index.js";
import { useIsolatedAgenrConfig } from "../../../helpers/isolated-config.js";
import { removeTestPath, waitForDatabaseRelease } from "../../../helpers/temp-paths.js";

const tempPaths: string[] = [];

beforeEach(async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), "agenr-dream-eff-eval-config-"));
  tempPaths.push(configRoot);
  await useIsolatedAgenrConfig(configRoot);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  delete process.env.AGENR_CONFIG_DIR;
  delete process.env.AGENR_CONFIG_PATH;
});

afterEach(async () => {
  await waitForDatabaseRelease();
  while (tempPaths.length > 0) {
    await removeTestPath(tempPaths.pop() ?? "");
  }
});

describe("runDreamingEfficiencyEvalCase", () => {
  it("derives pre-seeded efficiency telemetry from persisted counters without running live dreaming", async () => {
    const response = await runDreamingEfficiencyEvalCase({
      caseId: "dreaming.efficiency.known-candidates-zero-mutations",
      memoryPool: [],
      dreamRunFixture: {
        tier: "light",
        summaryJson: {
          actions_taken: 0,
          durables_skipped: [],
          observations: [],
          recommendations: [],
          scan: {
            episodesSinceLastRun: 2,
            ingestFilesSinceLastRun: 0,
            durablesCreatedSinceLastRun: 0,
            evidenceRefs: [],
            unsynthesizedImportanceSum: 0,
          },
          extract: {
            episodesScanned: 2,
            candidatesEmitted: 2,
            newCandidates: 0,
            refineCandidates: 0,
            knownCandidates: 2,
            durablesInserted: 0,
          },
          project: {
            profileDurableCount: 1,
            directiveCount: 0,
            snapshotId: null,
            applied: true,
          },
          efficiency: {
            evidenceItemsRead: 999,
            synthesizedDurableMutations: 999,
            costPerSynthesizedDurableUsd: 999,
            profileInjectionTokenEstimate: 999,
            recomputeRatio: 999,
          },
        },
      },
    });

    expect(response.status).toBe("ok");
    expect(response.efficiency).toMatchObject({
      evidenceItemsRead: 2,
      synthesizedDurableMutations: 0,
      recomputeRatio: 0,
    });
    expect(response.profileInjectionTokenEstimate).toBe(36);
  });

  it("computes store-only token equivalence from the memory pool", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", createEmbeddingFetchStub());
    const durableIds = ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "d10"];
    const response = await runDreamingEfficiencyEvalCase({
      caseId: "dreaming.efficiency.dreaming-on-profile-tokens",
      memoryPool: durableIds.map((id) => ({
        id,
        type: "fact" as const,
        subject: `Fact ${id}`,
        content: `Fact ${id} content.`,
      })),
      sandbox: {
        ablationArm: "dreaming-on",
        profileSnapshot: {
          durableIds: ["d1", "d2", "d3", "d4"],
        },
      },
      dreamRunFixture: {
        tier: "standard",
        estimatedCostUsd: 0.2,
        summaryJson: {
          actions_taken: 0,
          durables_skipped: [],
          observations: [],
          recommendations: [],
          scan: {
            episodesSinceLastRun: 10,
            ingestFilesSinceLastRun: 0,
            durablesCreatedSinceLastRun: 0,
            evidenceRefs: [],
            unsynthesizedImportanceSum: 0,
          },
          extract: {
            episodesScanned: 10,
            candidatesEmitted: 4,
            newCandidates: 4,
            refineCandidates: 0,
            knownCandidates: 0,
            durablesInserted: 4,
          },
          project: {
            profileDurableCount: 4,
            directiveCount: 0,
            snapshotId: null,
            applied: true,
          },
        },
      },
    });

    expect(response.status).toBe("ok");
    expect(response.profileInjectionTokenEstimate).toBe(144);
    expect(response.storeOnlyEquivalentTokenEstimate).toBe(360);
    expect(response.efficiency?.costPerSynthesizedDurableUsd).toBe(0.05);
    expect(response.profileInjectionTokenEstimate).toBeLessThan(response.storeOnlyEquivalentTokenEstimate ?? 0);
  });
});

function createEmbeddingFetchStub(): (url: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(
      JSON.stringify({
        data: body.input.map((text, index) => ({
          index,
          embedding: hashToVector(text, 1024),
        })),
      }),
      { status: 200 },
    );
  };
}

function hashToVector(text: string, dimensions: number): number[] {
  const vector: number[] = [];
  let counter = 0;

  while (vector.length < dimensions) {
    const block = createHash("sha256").update(text).update(String(counter)).digest();

    for (let offset = 0; offset + 4 <= block.length && vector.length < dimensions; offset += 4) {
      vector.push(block.readInt32LE(offset) / 0x7fffffff);
    }

    counter += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (magnitude === 0) {
    return Array.from({ length: dimensions }, (_, index) => (index === 0 ? 1 : 0));
  }

  return vector.map((value) => value / magnitude);
}
