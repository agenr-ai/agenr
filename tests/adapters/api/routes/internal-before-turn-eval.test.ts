import { describe, expect, it, vi } from "vitest";

import {
  createInternalBeforeTurnEvalRoute,
  type BeforeTurnEvalCaseRunner,
  INTERNAL_BEFORE_TURN_EVAL_ROUTE_PATH,
} from "../../../../src/adapters/api/routes/internal-before-turn-eval.js";

describe("createInternalBeforeTurnEvalRoute", () => {
  it("exposes the expected internal POST route and returns JSON from the runner", async () => {
    const runner = vi.fn<BeforeTurnEvalCaseRunner>(async (request) => ({
      status: "ok",
      caseId: request.caseId,
      output: {
        abstained: true,
        selectedEntryIds: [],
        selectedProcedureKey: null,
        patch: {
          durableMemory: [],
          diagnostics: {
            recentTurnCount: 0,
            durableRecallUsed: false,
            durableRecallCandidateCount: 0,
            procedureRecallUsed: false,
            procedureCandidateCount: 0,
            abstained: true,
            abstentionReasons: ["Current turn was a short social greeting, so before-turn recall abstained."],
            notices: [],
          },
        },
      },
    }));
    const route = createInternalBeforeTurnEvalRoute(runner);

    expect(route.method).toBe("POST");
    expect(route.path).toBe(INTERNAL_BEFORE_TURN_EVAL_ROUTE_PATH);

    const response = await route.handler(
      new Request(`http://localhost${INTERNAL_BEFORE_TURN_EVAL_ROUTE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "  case-route  ",
          memoryPool: [],
          beforeTurnInput: {
            currentTurnText: "hello",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(runner).toHaveBeenCalledWith({
      caseId: "case-route",
      description: undefined,
      sandbox: undefined,
      memoryPool: [],
      procedurePool: undefined,
      beforeTurnInput: {
        sessionKey: undefined,
        currentTurnText: "hello",
        recentTurns: undefined,
        trigger: undefined,
        policy: undefined,
      },
      options: undefined,
    });
    expect(await response.json()).toEqual({
      status: "ok",
      caseId: "case-route",
      output: {
        abstained: true,
        selectedEntryIds: [],
        selectedProcedureKey: null,
        patch: {
          durableMemory: [],
          diagnostics: {
            recentTurnCount: 0,
            durableRecallUsed: false,
            durableRecallCandidateCount: 0,
            procedureRecallUsed: false,
            procedureCandidateCount: 0,
            abstained: true,
            abstentionReasons: ["Current turn was a short social greeting, so before-turn recall abstained."],
            notices: [],
          },
        },
      },
    });
  });

  it("maps invalid requests into a 400 boundary response", async () => {
    const route = createInternalBeforeTurnEvalRoute();

    const response = await route.handler(
      new Request(`http://localhost${INTERNAL_BEFORE_TURN_EVAL_ROUTE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "case-invalid",
          memoryPool: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      status: "error",
      caseId: "case-invalid",
      error: {
        code: "invalid_request",
        message: "Invalid before-turn eval request.",
        details: [
          {
            path: "beforeTurnInput",
            message: "Expected an object.",
          },
        ],
      },
    });
  });
});
