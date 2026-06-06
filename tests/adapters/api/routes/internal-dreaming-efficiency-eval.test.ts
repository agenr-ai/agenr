import { describe, expect, it, vi } from "vitest";

import {
  createInternalDreamingEfficiencyEvalRoute,
  type DreamingEfficiencyEvalCaseRunner,
} from "../../../../src/adapters/api/routes/internal-dreaming-efficiency-eval.js";

describe("createInternalDreamingEfficiencyEvalRoute", () => {
  it("exposes the expected internal POST route and returns JSON from the runner", async () => {
    const runner = vi.fn<DreamingEfficiencyEvalCaseRunner>(async (request) => ({
      status: "ok",
      caseId: request.caseId,
      efficiency: {
        evidenceItemsRead: 1,
        synthesizedDurableMutations: 0,
        costPerSynthesizedDurableUsd: null,
        profileInjectionTokenEstimate: 36,
        recomputeRatio: 0,
      },
      profileInjectionTokenEstimate: 36,
    }));

    const route = createInternalDreamingEfficiencyEvalRoute(runner);
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/internal/evals/dreaming-efficiency/run");

    const response = await route.handler(
      new Request("http://localhost/internal/evals/dreaming-efficiency/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          caseId: "dreaming.efficiency.light-low-recompute",
          memoryPool: [],
          dreamRunFixture: {
            tier: "light",
            summaryJson: {
              actions_taken: 0,
              durables_skipped: [],
              observations: [],
              recommendations: [],
              scan: {
                episodesSinceLastRun: 1,
                ingestFilesSinceLastRun: 0,
                durablesCreatedSinceLastRun: 0,
                evidenceRefs: [],
                unsynthesizedImportanceSum: 0,
              },
              extract: {
                episodesScanned: 1,
                candidatesEmitted: 0,
                newCandidates: 0,
                refineCandidates: 0,
                knownCandidates: 0,
                durablesInserted: 0,
              },
              project: {
                profileDurableCount: 1,
                directiveCount: 0,
                snapshotId: null,
                applied: true,
              },
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      caseId: "dreaming.efficiency.light-low-recompute",
      efficiency: {
        recomputeRatio: 0,
      },
    });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("returns 400 for invalid requests", async () => {
    const route = createInternalDreamingEfficiencyEvalRoute(async () => ({
      status: "ok",
      caseId: "unused",
      efficiency: {
        evidenceItemsRead: 0,
        synthesizedDurableMutations: 0,
        costPerSynthesizedDurableUsd: null,
        profileInjectionTokenEstimate: 0,
        recomputeRatio: 0,
      },
      profileInjectionTokenEstimate: 0,
    }));

    const response = await route.handler(
      new Request("http://localhost/internal/evals/dreaming-efficiency/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memoryPool: [] }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: "error",
      error: {
        code: "invalid_request",
      },
    });
  });
});
