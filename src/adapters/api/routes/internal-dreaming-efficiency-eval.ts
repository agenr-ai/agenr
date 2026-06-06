import { runDreamingEfficiencyEvalCase } from "../../../app/evals/dreaming-efficiency/index.js";
import type { DreamingEfficiencyEvalCaseRequest, DreamingEfficiencyEvalCaseResponse } from "../../../app/evals/dreaming-efficiency/index.js";
import {
  DreamingEfficiencyEvalRequestValidationError,
  mapDreamingEfficiencyEvalCaseRequestDto,
  parseDreamingEfficiencyEvalCaseRequest,
  type DreamingEfficiencyEvalValidationIssue,
} from "../validation/dreaming-efficiency-eval-request.js";
import type { InternalApiRoute } from "../internal-api-route.js";

const INTERNAL_DREAMING_EFFICIENCY_EVAL_ROUTE_PATH = "/internal/evals/dreaming-efficiency/run";

export { INTERNAL_DREAMING_EFFICIENCY_EVAL_ROUTE_PATH };

/** App-layer runner invoked by the internal dreaming-efficiency eval HTTP route. */
export type DreamingEfficiencyEvalCaseRunner = (request: DreamingEfficiencyEvalCaseRequest) => Promise<DreamingEfficiencyEvalCaseResponse>;

/** Boundary error response emitted before a request reaches the app runner. */
export interface DreamingEfficiencyEvalBoundaryErrorResponse {
  status: "error";
  caseId?: string;
  error: {
    code: "invalid_request" | "internal_error";
    message: string;
    details?: DreamingEfficiencyEvalValidationIssue[];
  };
}

/** Full response union returned by the internal dreaming-efficiency eval route. */
export type InternalDreamingEfficiencyEvalRouteResponse = DreamingEfficiencyEvalCaseResponse | DreamingEfficiencyEvalBoundaryErrorResponse;

const INTERNAL_DREAMING_EFFICIENCY_EVAL_ROUTE: Pick<InternalApiRoute, "method" | "path"> = {
  method: "POST",
  path: INTERNAL_DREAMING_EFFICIENCY_EVAL_ROUTE_PATH,
};

/** Creates the narrow internal dreaming-efficiency eval HTTP route. */
export function createInternalDreamingEfficiencyEvalRoute(runner: DreamingEfficiencyEvalCaseRunner = runDreamingEfficiencyEvalCase): InternalApiRoute {
  return {
    ...INTERNAL_DREAMING_EFFICIENCY_EVAL_ROUTE,
    handler: async (request: Request): Promise<Response> => {
      let validatedRequest: DreamingEfficiencyEvalCaseRequest | undefined;

      try {
        validatedRequest = await parseValidatedRequest(request);
        const result = await runner(validatedRequest);
        return jsonResponse(result, 200);
      } catch (error) {
        if (error instanceof DreamingEfficiencyEvalRequestValidationError) {
          return jsonResponse(
            {
              status: "error",
              caseId: error.caseId,
              error: {
                code: "invalid_request",
                message: error.message,
                details: error.issues,
              },
            },
            400,
          );
        }

        return jsonResponse(
          {
            status: "error",
            caseId: validatedRequest?.caseId,
            error: {
              code: "internal_error",
              message: "Internal dreaming-efficiency eval adapter error.",
            },
          },
          500,
        );
      }
    },
  };
}

const parseJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new DreamingEfficiencyEvalRequestValidationError([
      {
        path: "$",
        message: "Request body must be valid JSON.",
      },
    ]);
  }
};

const parseValidatedRequest = async (request: Request): Promise<DreamingEfficiencyEvalCaseRequest> => {
  const payload = await parseJsonBody(request);
  const requestDto = parseDreamingEfficiencyEvalCaseRequest(payload);
  return mapDreamingEfficiencyEvalCaseRequestDto(requestDto);
};

const jsonResponse = (body: InternalDreamingEfficiencyEvalRouteResponse, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
