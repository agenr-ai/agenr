import { describe, expect, it, vi } from "vitest";

import { createInternalRecallEvalRoute, type RecallEvalCaseRunner } from "../../../../src/adapters/api/routes/internal-recall-eval.js";

describe("createInternalRecallEvalRoute", () => {
  it("exposes the expected internal POST route and returns JSON from the runner", async () => {
    const runner = vi.fn<RecallEvalCaseRunner>(async (request) => ({
      status: "ok",
      caseId: request.caseId,
      result: {
        entries: [],
        entryIds: [],
      },
      diagnostics: {
        execution: {
          mode: "phase1-placeholder",
          memoryPoolCount: request.memoryPool.length,
          requestedDiagnostics: false,
          requestedCandidates: false,
        },
      },
    }));
    const route = createInternalRecallEvalRoute(runner);

    expect(route.method).toBe("POST");
    expect(route.path).toBe("/internal/evals/recall/run");

    const response = await route.handler(
      new Request("http://localhost/internal/evals/recall/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "  case-route  ",
          memoryPool: [],
          recallRequest: {
            text: "  what do we know?  ",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(runner).toHaveBeenCalledWith({
      caseId: "case-route",
      description: undefined,
      sandbox: undefined,
      memoryPool: [],
      recallRequest: {
        text: "what do we know?",
        limit: undefined,
        threshold: undefined,
        budget: undefined,
        types: undefined,
        tags: undefined,
        since: undefined,
        until: undefined,
        around: undefined,
        aroundRadius: undefined,
      },
      options: undefined,
    });
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      caseId: "case-route",
      result: {
        entries: [],
        entryIds: [],
      },
      diagnostics: {
        execution: {
          mode: "phase1-placeholder",
          memoryPoolCount: 0,
          requestedDiagnostics: false,
          requestedCandidates: false,
        },
      },
    });
  });

  it("returns a structured invalid_request response for malformed payloads", async () => {
    const route = createInternalRecallEvalRoute();

    const response = await route.handler(
      new Request("http://localhost/internal/evals/recall/run", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "case-invalid",
          memoryPool: [
            {
              type: "fact",
              subject: "",
              content: "still wrong",
            },
          ],
          recallRequest: {
            text: "",
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      status: "error",
      error: {
        code: "invalid_request",
        message: "Invalid recall eval request.",
        details: [
          {
            path: "memoryPool[0].subject",
            message: "Expected a non-empty string.",
          },
          {
            path: "recallRequest.text",
            message: "Expected a non-empty string.",
          },
        ],
      },
    });
  });
});
