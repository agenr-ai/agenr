import { describe, expect, it, vi } from "vitest";

import {
  createInternalBeforeTurnEvalRoute,
  type BeforeTurnEvalCaseRunner,
  INTERNAL_BEFORE_TURN_EVAL_ROUTE_PATH,
} from "../../../../src/adapters/api/routes/internal-before-turn-eval.js";
import type { CrossEncoderPort, CrossEncoderScore } from "../../../../src/core/ports.js";

describe("createInternalBeforeTurnEvalRoute", () => {
  it("exposes the expected internal POST route and returns JSON from the runner", async () => {
    const runner = vi.fn<BeforeTurnEvalCaseRunner>(async (request) => ({
      status: "ok",
      caseId: request.caseId,
      output: {
        abstained: true,
        selectedDurableIds: [],
        selectedProcedureKey: null,
        patch: {
          durableMemory: [],
          diagnostics: {
            recentTurnCount: 0,
            queryVariants: [],
            turnSignalLabels: [],
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
        selectedDurableIds: [],
        selectedProcedureKey: null,
        patch: {
          durableMemory: [],
          diagnostics: {
            recentTurnCount: 0,
            queryVariants: [],
            turnSignalLabels: [],
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

  it("accepts the options-form constructor with a custom runner for legacy test wiring", async () => {
    const runner = vi.fn<BeforeTurnEvalCaseRunner>(async (request) => ({
      status: "ok",
      caseId: request.caseId,
      output: {
        abstained: true,
        selectedDurableIds: [],
        selectedProcedureKey: null,
        patch: {
          durableMemory: [],
          diagnostics: {
            recentTurnCount: 0,
            queryVariants: [],
            turnSignalLabels: [],
            durableRecallUsed: false,
            durableRecallCandidateCount: 0,
            procedureRecallUsed: false,
            procedureCandidateCount: 0,
            abstained: true,
            abstentionReasons: ["stub"],
            notices: [],
          },
        },
      },
    }));
    const route = createInternalBeforeTurnEvalRoute({ runner });

    const response = await route.handler(
      new Request(`http://localhost${INTERNAL_BEFORE_TURN_EVAL_ROUTE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "case-options-form",
          memoryPool: [],
          beforeTurnInput: {
            currentTurnText: "hello",
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("accepts the options-form constructor with an optional cross-encoder port", async () => {
    const crossEncoder: CrossEncoderPort = {
      async rank(): Promise<CrossEncoderScore[]> {
        return [];
      },
    };
    const route = createInternalBeforeTurnEvalRoute({ crossEncoder });

    expect(route.method).toBe("POST");
    expect(route.path).toBe(INTERNAL_BEFORE_TURN_EVAL_ROUTE_PATH);

    const response = await route.handler(
      new Request(`http://localhost${INTERNAL_BEFORE_TURN_EVAL_ROUTE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          caseId: "case-cross-encoder-options",
          memoryPool: [],
          beforeTurnInput: {},
        }),
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { status: string; caseId?: string };
    expect(body.status).toBe("error");
    expect(body.caseId).toBe("case-cross-encoder-options");
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
