import { parseOptionalTrimmedString, parseRequiredTrimmedString, pushIssue, requireObject, throwIfIssues } from "./field-parsers.js";

/** Allowed body keys for a procedure-validate request. */
const PROCEDURE_VALIDATE_KEYS = new Set<string>(["content", "relativePath"]);

/**
 * Validated procedure-save request.
 */
export interface ParsedProcedureSaveBody {
  relativePath: string;
  content: string;
}

/**
 * Validated procedure-validate request.
 */
export interface ParsedProcedureValidateBody {
  content: string;
  relativePath: string;
}

/**
 * Parses and validates a procedure-validate request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated YAML content and relative path label.
 * @throws {WebApiError} 400 when the body is malformed.
 */
export function parseProcedureValidateBody(input: unknown): ParsedProcedureValidateBody {
  const { record, issues } = requireObject(input, PROCEDURE_VALIDATE_KEYS);
  const content = typeof record.content === "string" ? record.content : "";
  if (typeof record.content !== "string") {
    pushIssue(issues, "content", "Expected a string.");
  }

  const relativePath = parseOptionalTrimmedString(record.relativePath, "relativePath", issues) ?? "procedure.yaml";
  throwIfIssues(issues);
  return { content, relativePath };
}

/**
 * Parses and validates a procedure-save request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated relative path and content.
 * @throws {WebApiError} 400 when the body is malformed.
 */
export function parseProcedureSaveBody(input: unknown): ParsedProcedureSaveBody {
  const { record, issues } = requireObject(input, new Set(["relativePath", "content"]));
  const relativePath = parseRequiredTrimmedString(record.relativePath, "relativePath", issues) ?? "";
  const content = typeof record.content === "string" ? record.content : "";
  if (typeof record.content !== "string") {
    pushIssue(issues, "content", "Expected a string.");
  }
  throwIfIssues(issues);
  return { relativePath, content };
}
