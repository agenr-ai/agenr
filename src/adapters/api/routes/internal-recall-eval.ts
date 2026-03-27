import { runRecallEvalCase, type RecallEvalCaseRequest, type RecallEvalCaseResponse } from "../../../app/evals/recall/index.js";
import { parseRecallEvalCaseRequest, RecallEvalRequestValidationError, type RecallEvalValidationIssue } from "../validation/recall-eval-request.js";

/**
 * Minimal route definition shape for internal API handlers.
 */
export interface InternalApiRoute {
  /** Stable HTTP method for the route definition. */
  method: "POST";
  /** Stable path for the route definition. */
  path: string;
  /** Request handler implementing the route behavior. */
  handler(request: Request): Promise<Response>;
}

/**
 * App-layer runner signature used by the internal recall eval route.
 */
export type RecallEvalCaseRunner = (request: RecallEvalCaseRequest) => Promise<RecallEvalCaseResponse>;

/**
 * Structured invalid-request response returned from the HTTP boundary.
 */
export interface RecallEvalInvalidRequestResponse {
  /** Normalized status for boundary validation failures. */
  status: "error";
  /** Parseable case identifier echoed when the request envelope exposed one. */
  caseId?: string;
  /** Structured error payload with stable machine-readable details. */
  error: {
    /** Stable code used for request-validation failures. */
    code: "invalid_request";
    /** Human-readable validation failure summary. */
    message: string;
    /** Structured field-level validation details. */
    details: RecallEvalValidationIssue[];
  };
}

/**
 * JSON response union returned by the internal recall eval route.
 */
export type InternalRecallEvalRouteResponse = RecallEvalCaseResponse | RecallEvalInvalidRequestResponse;

const INTERNAL_RECALL_EVAL_ROUTE: Pick<InternalApiRoute, "method" | "path"> = {
  method: "POST",
  path: "/internal/evals/recall/run",
};

/**
 * Creates the narrow internal recall eval HTTP route.
 *
 * @param runner - App-layer service used to execute the validated recall eval case.
 * @returns Route definition with a thin JSON handler.
 */
export function createInternalRecallEvalRoute(runner: RecallEvalCaseRunner = runRecallEvalCase): InternalApiRoute {
  return {
    ...INTERNAL_RECALL_EVAL_ROUTE,
    handler: async (request: Request): Promise<Response> => {
      try {
        const payload = await parseJsonBody(request);
        const validatedRequest = parseRecallEvalCaseRequest(payload);
        const result = await runner(validatedRequest);
        return jsonResponse(result, 200);
      } catch (error) {
        if (error instanceof RecallEvalRequestValidationError) {
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
            error: {
              code: "internal_error",
              message: "Internal recall eval adapter error.",
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
    throw new RecallEvalRequestValidationError([
      {
        path: "$",
        message: "Request body must be valid JSON.",
      },
    ]);
  }
};

/** Encodes a stable JSON response body for the internal API route. */
const jsonResponse = (body: InternalRecallEvalRouteResponse | { status: "error"; error: { code: string; message: string } }, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
