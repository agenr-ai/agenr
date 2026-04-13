import type { Row } from "@libsql/client";

import { normalizeProcedureDefinition } from "../../core/procedures/normalization.js";
import type { Procedure, ProcedureDefinition } from "../../core/types.js";
import { readBoolean, readEmbedding, readOptionalString, readRequiredString } from "./row-mapping.js";

const ACTIVE_PROCEDURE_CLAUSE = "retired = 0 AND superseded_by IS NULL";
const PROCEDURE_SELECT_COLUMNS = `
  id,
  procedure_key,
  title,
  goal,
  body_json,
  recall_text,
  source_file,
  source_hash,
  revision_hash,
  embedding,
  retired,
  retired_at,
  retired_reason,
  superseded_by,
  created_at,
  updated_at
`;

export { ACTIVE_PROCEDURE_CLAUSE, PROCEDURE_SELECT_COLUMNS };

/**
 * Builds the SQL predicate that filters out retired and superseded procedures.
 *
 * @param alias - Optional table alias to prefix column references.
 * @returns Active-procedure predicate for raw SQL fragments.
 */
export function buildActiveProcedureClause(alias?: string): string {
  if (!alias) {
    return ACTIVE_PROCEDURE_CLAUSE;
  }

  return `${alias}.retired = 0 AND ${alias}.superseded_by IS NULL`;
}

/**
 * Serializes one normalized procedure body for database persistence.
 *
 * @param procedure - Canonical normalized procedure body.
 * @returns Stable JSON string for storage.
 */
export function serializeProcedureBody(procedure: ProcedureDefinition): string {
  return JSON.stringify(procedure);
}

/**
 * Maps one raw procedure row into the canonical procedure domain type.
 *
 * @param row - Raw libSQL result row.
 * @returns Canonical stored procedure.
 */
export function mapProcedureRow(row: Row): Procedure {
  const definition = parseProcedureBody(readRequiredString(row, "body_json"));

  return {
    id: readRequiredString(row, "id"),
    procedure_key: readRequiredString(row, "procedure_key"),
    title: readRequiredString(row, "title"),
    goal: readRequiredString(row, "goal"),
    when_to_use: definition.when_to_use,
    when_not_to_use: definition.when_not_to_use,
    prerequisites: definition.prerequisites,
    steps: definition.steps,
    verification: definition.verification,
    failure_modes: definition.failure_modes,
    sources: definition.sources,
    recall_text: readRequiredString(row, "recall_text"),
    revision_hash: readRequiredString(row, "revision_hash"),
    source_hash: readRequiredString(row, "source_hash"),
    source_file: readOptionalString(row, "source_file"),
    embedding: readEmbedding(row, "embedding"),
    retired: readBoolean(row, "retired"),
    retired_at: readOptionalString(row, "retired_at"),
    retired_reason: readOptionalString(row, "retired_reason"),
    superseded_by: readOptionalString(row, "superseded_by"),
    created_at: readRequiredString(row, "created_at"),
    updated_at: readRequiredString(row, "updated_at"),
  };
}

/**
 * Parses and validates one stored `body_json` payload from the database.
 *
 * @param bodyJson - Serialized canonical procedure body.
 * @returns Normalized procedure definition.
 */
function parseProcedureBody(bodyJson: string): ProcedureDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid procedures.body_json payload: ${message}`, {
      cause: error,
    });
  }

  return normalizeProcedureDefinition(parsed, "procedures.body_json");
}
