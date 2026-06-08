import type { ValidationIssue } from "../shared/validation.js";

/** Stable machine-readable error codes returned by the web API boundary. */
export type WebApiErrorCode = "invalid_request" | "not_found" | "conflict" | "internal_error" | "forbidden";

/**
 * Structured error thrown by web API routes and serialized at the boundary.
 *
 * Routes throw this to short-circuit with a stable status and code; the server
 * renders it as `{ status: "error", error: { code, message, details? } }`.
 */
export class WebApiError extends Error {
  /** HTTP status code to send. */
  public readonly statusCode: number;
  /** Stable machine-readable error code. */
  public readonly code: WebApiErrorCode;
  /** Optional field-level validation issues. */
  public readonly issues?: ValidationIssue[];

  /**
   * Creates a structured web API error.
   *
   * @param statusCode - HTTP status code to send.
   * @param code - Stable machine-readable error code.
   * @param message - Human-readable failure summary.
   * @param issues - Optional field-level validation issues.
   */
  public constructor(statusCode: number, code: WebApiErrorCode, message: string, issues?: ValidationIssue[]) {
    super(message);
    this.name = "WebApiError";
    this.statusCode = statusCode;
    this.code = code;
    if (issues && issues.length > 0) {
      this.issues = issues;
    }
  }

  /**
   * Builds a 400 invalid-request error from validation issues.
   *
   * @param issues - Field-level validation issues.
   * @param message - Optional summary override.
   * @returns Validation error instance.
   */
  public static invalid(issues: ValidationIssue[], message = "Invalid request."): WebApiError {
    return new WebApiError(400, "invalid_request", message, issues);
  }

  /**
   * Builds a 404 not-found error.
   *
   * @param message - Human-readable failure summary.
   * @returns Not-found error instance.
   */
  public static notFound(message: string): WebApiError {
    return new WebApiError(404, "not_found", message);
  }

  /**
   * Builds a 409 conflict error.
   *
   * @param message - Human-readable failure summary.
   * @returns Conflict error instance.
   */
  public static conflict(message: string): WebApiError {
    return new WebApiError(409, "conflict", message);
  }
}

/**
 * Serializable error envelope returned by the web API boundary.
 */
export interface WebApiErrorBody {
  /** Discriminator for failed responses. */
  status: "error";
  /** Structured error payload. */
  error: {
    /** Stable machine-readable error code. */
    code: WebApiErrorCode;
    /** Human-readable failure summary. */
    message: string;
    /** Optional field-level validation issues. */
    details?: ValidationIssue[];
  };
}

/**
 * Converts an unknown thrown value into a structured error body and status.
 *
 * @param error - Thrown value from a route handler.
 * @returns HTTP status code plus serializable error body.
 */
export function toErrorResponse(error: unknown): { statusCode: number; body: WebApiErrorBody } {
  if (error instanceof WebApiError) {
    return {
      statusCode: error.statusCode,
      body: {
        status: "error",
        error: {
          code: error.code,
          message: error.message,
          ...(error.issues ? { details: error.issues } : {}),
        },
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    statusCode: 500,
    body: { status: "error", error: { code: "internal_error", message } },
  };
}
