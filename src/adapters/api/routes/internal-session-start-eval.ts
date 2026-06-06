import { runSessionStartEvalCase } from "../../../app/evals/session-start/index.js";
import type { SessionStartEvalCaseRequest, SessionStartEvalCaseResponse } from "../../../app/evals/session-start/index.js";
import {
  mapSessionStartEvalCaseRequestDto,
  parseSessionStartEvalCaseRequest,
  SessionStartEvalRequestValidationError,
  type SessionStartEvalValidationIssue,
} from "../validation/session-start-eval-request.js";
import type { InternalApiRoute } from "../internal-api-route.js";

const INTERNAL_SESSION_START_EVAL_ROUTE_PATH = "/internal/evals/session-start/run";

export { INTERNAL_SESSION_START_EVAL_ROUTE_PATH };

/** App-layer runner invoked by the internal session-start eval HTTP route. */
export type SessionStartEvalCaseRunner = (request: SessionStartEvalCaseRequest) => Promise<SessionStartEvalCaseResponse>;

/** Boundary error response emitted before a request reaches the app runner. */
export interface SessionStartEvalBoundaryErrorResponse {
  status: "error";
  caseId?: string;
  error: {
    code: "invalid_request" | "internal_error";
    message: string;
    details?: SessionStartEvalValidationIssue[];
  };
}

/** Full response union returned by the internal session-start eval route. */
export type InternalSessionStartEvalRouteResponse = SessionStartEvalCaseResponse | SessionStartEvalBoundaryErrorResponse;

const INTERNAL_SESSION_START_EVAL_ROUTE: Pick<InternalApiRoute, "method" | "path"> = {
  method: "POST",
  path: INTERNAL_SESSION_START_EVAL_ROUTE_PATH,
};

/** Creates the narrow internal session-start eval HTTP route. */
export function createInternalSessionStartEvalRoute(runner: SessionStartEvalCaseRunner = runSessionStartEvalCase): InternalApiRoute {
  return {
    ...INTERNAL_SESSION_START_EVAL_ROUTE,
    handler: async (request: Request): Promise<Response> => {
      let validatedRequest: SessionStartEvalCaseRequest | undefined;

      try {
        validatedRequest = await parseValidatedRequest(request);
        const result = await runner(validatedRequest);
        return jsonResponse(result, 200);
      } catch (error) {
        if (error instanceof SessionStartEvalRequestValidationError) {
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
              message: "Internal session-start eval adapter error.",
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
    throw new SessionStartEvalRequestValidationError([
      {
        path: "$",
        message: "Request body must be valid JSON.",
      },
    ]);
  }
};

const parseValidatedRequest = async (request: Request): Promise<SessionStartEvalCaseRequest> => {
  const payload = await parseJsonBody(request);
  const requestDto = parseSessionStartEvalCaseRequest(payload);
  return mapSessionStartEvalCaseRequestDto(requestDto);
};

const jsonResponse = (body: InternalSessionStartEvalRouteResponse, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
