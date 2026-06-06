import type { Row } from "@libsql/client";

import { normalizeProcedureDefinition } from "../../core/procedures/normalization.js";
import type { Procedure, ProcedureDefinition } from "../../core/types.js";
import { ACTIVE_PROCEDURE_CLAUSE, buildCurrentMemoryClause, readEmbedding, readOptionalString, readRequiredString } from "./row-mapping.js";

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
  valid_from,
  valid_to,
  supersession_kind,
  supersession_reason,
  superseded_by,
  created_at,
  updated_at
`;

export { ACTIVE_PROCEDURE_CLAUSE, PROCEDURE_SELECT_COLUMNS };

/**
 * Builds the SQL predicate that filters out superseded and stale procedures.
 *
 * Procedures share the canonical current-memory predicate, so this delegates to
 * {@link buildCurrentMemoryClause} instead of carrying a separate copy of the
 * SQL. A local copy previously drifted to an inclusive `valid_to` boundary while
 * the canonical predicate is exclusive; delegating keeps procedures in lockstep
 * with durables and episodes.
 *
 * @param alias - Optional table alias to prefix column references.
 * @returns Active-procedure predicate for raw SQL fragments.
 */
export function buildActiveProcedureClause(alias?: string): string {
  return buildCurrentMemoryClause(alias);
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
    valid_from: readOptionalString(row, "valid_from"),
    valid_to: readOptionalString(row, "valid_to"),
    supersession_kind: readOptionalString(row, "supersession_kind"),
    supersession_reason: readOptionalString(row, "supersession_reason"),
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
