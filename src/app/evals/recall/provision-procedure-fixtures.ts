import { createHash } from "node:crypto";

import { computeProcedureRevisionHash, computeProcedureSourceHash } from "../../../core/procedures/hashing.js";
import { normalizeProcedureDefinition } from "../../../core/procedures/normalization.js";
import { composeProcedureRecallText } from "../../../core/procedures/recall-text.js";
import type { Procedure } from "../../../core/types.js";
import type { RecallEvalFixtureProcedure } from "./contracts.js";
import type { RecallEvalFixtureStore } from "./ports.js";

/**
 * Summary of exact procedure-fixture provisioning into isolated eval storage.
 */
export interface RecallEvalProcedureProvisioningResult {
  /** Number of fixture procedures written into isolated storage. */
  provisionedCount: number;
}

/**
 * Provisions the eval procedure pool directly into isolated storage.
 *
 * @param params - Case-local fixture procedures plus isolated database dependencies.
 * @returns Provisioning summary for the isolated case sandbox.
 */
export async function provisionRecallEvalProcedureFixtures(params: {
  caseId: string;
  procedurePool: RecallEvalFixtureProcedure[];
  store: RecallEvalFixtureStore;
  provisionedAt: string;
}): Promise<RecallEvalProcedureProvisioningResult> {
  const procedures = prepareProcedures(params.caseId, params.procedurePool, params.provisionedAt);
  if (procedures.length === 0) {
    return {
      provisionedCount: 0,
    };
  }

  await params.store.withTransaction(async (store) => {
    for (const procedure of procedures) {
      await store.insertProcedure(procedure);
    }
  });

  return {
    provisionedCount: procedures.length,
  };
}

/** Builds normalized stored procedure rows for direct fixture insertion. */
function prepareProcedures(caseId: string, fixtures: RecallEvalFixtureProcedure[], provisionedAt: string): Procedure[] {
  const resolvedIds = fixtures.map((fixture, index) => fixture.id ?? createFixtureId(caseId, index, fixture));
  const duplicateIds = findDuplicateIds(resolvedIds);
  if (duplicateIds.length > 0) {
    throw new Error(`Procedure fixture IDs must be unique. Duplicate IDs: ${duplicateIds.join(", ")}.`);
  }

  const knownIds = new Set(resolvedIds);
  return fixtures.map((fixture, index) => {
    if (fixture.superseded_by && !knownIds.has(fixture.superseded_by)) {
      throw new Error(`procedurePool[${index}].superseded_by references unknown fixture id "${fixture.superseded_by}".`);
    }

    const normalizedBody = normalizeProcedureDefinition(
      {
        procedure_key: fixture.procedure_key,
        title: fixture.title,
        goal: fixture.goal,
        when_to_use: fixture.when_to_use ?? [],
        when_not_to_use: fixture.when_not_to_use ?? [],
        prerequisites: fixture.prerequisites ?? [],
        steps: fixture.steps,
        verification: fixture.verification ?? [],
        failure_modes: fixture.failure_modes ?? [],
        sources: fixture.sources ?? [{ kind: "manual", label: "recall eval fixture" }],
      },
      `procedurePool[${index}]`,
    );
    const createdAt = fixture.created_at ?? provisionedAt;
    const updatedAt = fixture.updated_at ?? createdAt;

    return {
      id: resolvedIds[index] ?? "",
      ...normalizedBody,
      source_file: fixture.source_file,
      recall_text: composeProcedureRecallText(normalizedBody),
      revision_hash: computeProcedureRevisionHash(normalizedBody),
      source_hash: computeProcedureSourceHash(JSON.stringify(normalizedBody)),
      valid_from: fixture.valid_from,
      valid_to: fixture.valid_to,
      supersession_kind: fixture.supersession_kind,
      supersession_reason: fixture.supersession_reason,
      superseded_by: fixture.superseded_by,
      created_at: createdAt,
      updated_at: updatedAt,
    } satisfies Procedure;
  });
}

/** Creates a deterministic fallback fixture ID for repeatable eval runs. */
function createFixtureId(caseId: string, index: number, fixture: RecallEvalFixtureProcedure): string {
  const digest = createHash("sha256")
    .update(caseId)
    .update(":")
    .update(String(index))
    .update(":")
    .update(fixture.procedure_key)
    .update(":")
    .update(fixture.title)
    .update(":")
    .update(fixture.goal)
    .digest("hex");

  return `eval-procedure-${digest.slice(0, 24)}`;
}

/** Finds duplicate identifiers while preserving deterministic output ordering. */
function findDuplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const id of ids) {
    if (seen.has(id)) {
      if (!duplicates.includes(id)) {
        duplicates.push(id);
      }
      continue;
    }

    seen.add(id);
  }

  return duplicates;
}
