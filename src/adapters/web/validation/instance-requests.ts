import type { RegisterInstanceInput } from "../../../app/web/instance-registry.js";
import { parseOptionalTrimmedString, parseRequiredTrimmedString, requireObject, throwIfIssues } from "./field-parsers.js";

/**
 * Parses and validates an instance-registration request body.
 *
 * @param input - Raw JSON request body.
 * @returns Validated instance registration input.
 * @throws {WebApiError} 400 when the body is malformed.
 */
export function parseRegisterInstanceBody(input: unknown): RegisterInstanceInput {
  const { record, issues } = requireObject(input, new Set(["name", "configPath", "dbPath", "proceduresDir"]));
  const name = parseRequiredTrimmedString(record.name, "name", issues) ?? "";
  const configPath = parseOptionalTrimmedString(record.configPath, "configPath", issues);
  const dbPath = parseOptionalTrimmedString(record.dbPath, "dbPath", issues);
  const proceduresDir = parseOptionalTrimmedString(record.proceduresDir, "proceduresDir", issues);
  throwIfIssues(issues);
  return {
    name,
    ...(configPath ? { configPath } : {}),
    ...(dbPath ? { dbPath } : {}),
    ...(proceduresDir ? { proceduresDir } : {}),
  };
}
