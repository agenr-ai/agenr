import {
  runRecallEvalCase,
  type RecallEvalCaseDependencies,
  type RecallEvalCaseRequest,
  type RecallEvalCaseResponse,
} from "../../../app/evals/recall/index.js";
import type { InternalApiRoute } from "../internal-api-route.js";
import {
  mapRecallEvalCaseRequestDto,
  parseRecallEvalCaseRequest,
  RecallEvalRequestValidationError,
  type RecallEvalValidationIssue,
} from "../validation/recall-eval-request.js";

/** Stable internal route path for the recall eval seam. */
const INTERNAL_RECALL_EVAL_ROUTE_PATH = "/internal/evals/recall/run";

export { INTERNAL_RECALL_EVAL_ROUTE_PATH };

/**
 * App-layer runner signature used by the internal recall eval route.
 */
export type RecallEvalCaseRunner = (request: RecallEvalCaseRequest) => Promise<RecallEvalCaseResponse>;

/**
 * Construction options for the internal recall eval HTTP route.
 */
export interface InternalRecallEvalRouteOptions {
  /** App-layer runner used to execute the validated recall eval case. */
  runner?: RecallEvalCaseRunner;
  /**
   * Optional cross-encoder port attached to the default runner so phase 4
   * rerank is actually exercised through the HTTP seam. Ignored when a
   * custom `runner` is supplied (callers that mock the runner own the
   * dependency graph themselves). Typed through the app-layer contract
   * so the route handler stays thin and does not import core ports.
   */
  crossEncoder?: RecallEvalCaseDependencies["crossEncoder"];
}

/**
 * Structured boundary error response returned from the HTTP adapter.
 */
export interface RecallEvalBoundaryErrorResponse {
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
    details?: RecallEvalValidationIssue[];
  };
}

/**
 * JSON response union returned by the internal recall eval route.
 */
export type InternalRecallEvalRouteResponse = RecallEvalCaseResponse | RecallEvalBoundaryErrorResponse;

const INTERNAL_RECALL_EVAL_ROUTE: Pick<InternalApiRoute, "method" | "path"> = {
  method: "POST",
  path: INTERNAL_RECALL_EVAL_ROUTE_PATH,
};

/**
 * Creates the narrow internal recall eval HTTP route.
 *
 * Accepts either a bare runner (legacy positional form used by tests that
 * mock the runner) or an options object with an optional cross-encoder
 * port that the default runner will wire into the recall ports for every
 * case executed through this route.
 *
 * @param optionsOrRunner - Runner override or options bundle.
 * @returns Route definition with a thin JSON handler.
 */
export function createInternalRecallEvalRoute(optionsOrRunner: RecallEvalCaseRunner | InternalRecallEvalRouteOptions = {}): InternalApiRoute {
  const options: InternalRecallEvalRouteOptions = typeof optionsOrRunner === "function" ? { runner: optionsOrRunner } : optionsOrRunner;
  const crossEncoder = options.crossEncoder;
  const runner: RecallEvalCaseRunner = options.runner ?? ((request: RecallEvalCaseRequest) => runRecallEvalCase(request, { crossEncoder }));

  return {
    ...INTERNAL_RECALL_EVAL_ROUTE,
    handler: async (request: Request): Promise<Response> => {
      let validatedRequest: RecallEvalCaseRequest | undefined;

      try {
        validatedRequest = await parseValidatedRequest(request);
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
            caseId: validatedRequest?.caseId,
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

/** Parses and maps the HTTP payload into the app-layer request contract. */
const parseValidatedRequest = async (request: Request): Promise<RecallEvalCaseRequest> => {
  const payload = await parseJsonBody(request);
  const requestDto = parseRecallEvalCaseRequest(payload);
  return mapRecallEvalCaseRequestDto(requestDto);
};

/** Encodes a stable JSON response body for the internal API route. */
const jsonResponse = (body: InternalRecallEvalRouteResponse, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
