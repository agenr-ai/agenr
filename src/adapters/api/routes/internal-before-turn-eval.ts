import { runBeforeTurnEvalCase, type BeforeTurnEvalCaseRequest, type BeforeTurnEvalCaseResponse } from "../../../app/evals/before-turn/index.js";
import type { InternalApiRoute } from "../internal-api-route.js";
import {
  mapBeforeTurnEvalCaseRequestDto,
  parseBeforeTurnEvalCaseRequest,
  BeforeTurnEvalRequestValidationError,
  type BeforeTurnEvalValidationIssue,
} from "../validation/before-turn-eval-request.js";

/** Stable internal route path for the before-turn eval seam. */
const INTERNAL_BEFORE_TURN_EVAL_ROUTE_PATH = "/internal/evals/before-turn/run";

export { INTERNAL_BEFORE_TURN_EVAL_ROUTE_PATH };

/**
 * App-layer runner signature used by the internal before-turn eval route.
 */
export type BeforeTurnEvalCaseRunner = (request: BeforeTurnEvalCaseRequest) => Promise<BeforeTurnEvalCaseResponse>;

/**
 * Structured boundary error response returned from the HTTP adapter.
 */
export interface BeforeTurnEvalBoundaryErrorResponse {
  /** Normalized status for boundary-level failures. */
  status: "error";
  /** Parseable case identifier echoed when the boundary can do so safely. */
  caseId?: string;
  /** Structured error payload with stable machine-readable details. */
  error: {
    /** Stable boundary error code. */
    code: "invalid_request" | "internal_error";
    /** Human-readable boundary failure summary. */
    message: string;
    /** Structured field-level validation details for invalid requests. */
    details?: BeforeTurnEvalValidationIssue[];
  };
}

/**
 * JSON response union returned by the internal before-turn eval route.
 */
export type InternalBeforeTurnEvalRouteResponse = BeforeTurnEvalCaseResponse | BeforeTurnEvalBoundaryErrorResponse;

/**
 * Creates the narrow internal before-turn eval HTTP route.
 *
 * @param runner - App-layer service used to execute the validated before-turn eval case.
 * @returns Route definition with a thin JSON handler.
 */
export function createInternalBeforeTurnEvalRoute(runner: BeforeTurnEvalCaseRunner = runBeforeTurnEvalCase): InternalApiRoute {
  return {
    method: "POST",
    path: INTERNAL_BEFORE_TURN_EVAL_ROUTE_PATH,
    handler: async (request: Request): Promise<Response> => {
      let validatedRequest: BeforeTurnEvalCaseRequest | undefined;

      try {
        validatedRequest = await parseValidatedRequest(request);
        const result = await runner(validatedRequest);
        return jsonResponse(result, 200);
      } catch (error) {
        if (error instanceof BeforeTurnEvalRequestValidationError) {
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
              message: "Internal before-turn eval adapter error.",
            },
          },
          500,
        );
      }
    },
  };
}

/** Parses the raw JSON request body and maps syntax failures into validation errors. */
const parseJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new BeforeTurnEvalRequestValidationError([
      {
        path: "$",
        message: "Request body must be valid JSON.",
      },
    ]);
  }
};

/** Parses and maps the HTTP payload into the app-layer request contract. */
const parseValidatedRequest = async (request: Request): Promise<BeforeTurnEvalCaseRequest> => {
  const payload = await parseJsonBody(request);
  const requestDto = parseBeforeTurnEvalCaseRequest(payload);
  return mapBeforeTurnEvalCaseRequestDto(requestDto);
};

/** Encodes a stable JSON response body for the internal API route. */
const jsonResponse = (body: InternalBeforeTurnEvalRouteResponse, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
