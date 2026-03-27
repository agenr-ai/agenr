import { describe, expect, it } from "vitest";

import { runRecallEvalCase, type RecallEvalCaseRequest } from "../../../../src/app/evals/recall/index.js";

describe("runRecallEvalCase", () => {
  it("returns the Phase 1 placeholder response envelope", async () => {
    const request: RecallEvalCaseRequest = {
      caseId: "case-123",
      sandbox: {
        root: "/tmp/evals/case-123",
        preserve: true,
      },
      memoryPool: [
        {
          type: "fact",
          subject: "Remember the pager rotation",
          content: "Alex is on call this week.",
          importance: 8,
          expiry: "temporary",
          tags: ["ops"],
        },
      ],
      recallRequest: {
        text: "Who is on call?",
        limit: 3,
      },
      options: {
        includeDiagnostics: true,
        includeCandidates: true,
        includeTimings: true,
      },
    };

    const response = await runRecallEvalCase(request);

    expect(response).toMatchObject({
      status: "ok",
      caseId: "case-123",
      result: {
        entries: [],
        entryIds: [],
      },
      diagnostics: {
        execution: {
          mode: "phase1-placeholder",
          memoryPoolCount: 1,
          requestedDiagnostics: true,
          requestedCandidates: true,
        },
      },
      sandbox: {
        root: "/tmp/evals/case-123",
        preserved: true,
      },
    });
    expect(response.timings?.totalMs).toBeGreaterThanOrEqual(0);
  });
});
