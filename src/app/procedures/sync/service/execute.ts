import { randomUUID } from "node:crypto";

import type { Procedure } from "../../../../core/types.js";
import type { ProcedureSyncPorts } from "../ports.js";
import type {
  PreparedProcedureCandidate,
  ProcedureSyncCreateItem,
  ProcedureSyncExecutionItem,
  ProcedureSyncExecutionResult,
  ProcedureSyncExecutionTotals,
  ProcedureSyncPlan,
  ProcedureSyncPlanItem,
  ProcedureSyncSupersedeItem,
} from "../types.js";

/**
 * Applies one valid sync plan by embedding new revisions and persisting writes.
 *
 * @param plan - Prepared sync plan to execute.
 * @param ports - Database and embedding adapters used for execution.
 * @returns Execution result with per-file outcomes.
 */
export async function executeProcedureSync(
  plan: ProcedureSyncPlan,
  ports: Pick<ProcedureSyncPorts, "db" | "embedding">,
): Promise<ProcedureSyncExecutionResult> {
  const invalidItems = plan.items.filter((item): item is Extract<ProcedureSyncPlanItem, { action: "invalid" }> => item.action === "invalid");
  if (invalidItems.length > 0) {
    throw new Error(formatInvalidPlanError(invalidItems));
  }

  const itemsNeedingEmbeddings = plan.items.filter(
    (item): item is ProcedureSyncCreateItem | ProcedureSyncSupersedeItem => item.action === "create" || item.action === "supersede",
  );
  const embeddings = itemsNeedingEmbeddings.length > 0 ? await ports.embedding.embed(itemsNeedingEmbeddings.map((item) => item.candidate.recallText)) : [];
  if (embeddings.length !== itemsNeedingEmbeddings.length) {
    throw new Error(`Procedure embedding count mismatch: expected ${itemsNeedingEmbeddings.length}, received ${embeddings.length}.`);
  }

  const embeddingByFilePath = new Map<string, number[]>();
  itemsNeedingEmbeddings.forEach((item, index) => {
    const embedding = embeddings[index];
    if (!embedding) {
      throw new Error(`Missing embedding for procedure file ${item.candidate.filePath}.`);
    }

    embeddingByFilePath.set(item.candidate.filePath, embedding);
  });

  const items = await ports.db.withTransaction(async (db) => {
    const executionItems: ProcedureSyncExecutionItem[] = [];

    for (const item of plan.items) {
      switch (item.action) {
        case "create": {
          const now = new Date().toISOString();
          const stored = await db.upsertProcedure(
            buildProcedureRecord({
              candidate: item.candidate,
              id: randomUUID(),
              createdAt: now,
              updatedAt: now,
              embedding: embeddingByFilePath.get(item.candidate.filePath),
              retired: false,
            }),
          );
          executionItems.push({
            action: "created",
            filePath: item.candidate.filePath,
            procedureKey: item.candidate.procedure.procedure_key,
            procedureId: stored.id,
          });
          break;
        }
        case "update_source_only": {
          const stored = await db.upsertProcedure(
            buildProcedureRecord({
              candidate: item.candidate,
              existing: item.existing,
              id: item.existing.id,
              createdAt: item.existing.created_at,
              updatedAt: new Date().toISOString(),
              embedding: item.existing.embedding,
              retired: false,
            }),
          );
          executionItems.push({
            action: "updated_source_only",
            filePath: item.candidate.filePath,
            procedureKey: item.candidate.procedure.procedure_key,
            procedureId: stored.id,
          });
          break;
        }
        case "supersede": {
          const now = new Date().toISOString();
          const replacementId = randomUUID();
          const staged = buildProcedureRecord({
            candidate: item.candidate,
            id: replacementId,
            createdAt: now,
            updatedAt: now,
            embedding: embeddingByFilePath.get(item.candidate.filePath),
            retired: true,
          });
          await db.upsertProcedure(staged);
          const superseded = await db.supersedeProcedure(item.existing.id, replacementId, "procedure revision updated");
          if (!superseded) {
            throw new Error(`Failed to supersede active procedure ${item.existing.id} for ${item.candidate.procedure.procedure_key}.`);
          }

          const activated = await db.upsertProcedure({
            ...staged,
            retired: false,
            retired_at: undefined,
            retired_reason: undefined,
            superseded_by: undefined,
            updated_at: new Date().toISOString(),
          });
          executionItems.push({
            action: "superseded",
            filePath: item.candidate.filePath,
            procedureKey: item.candidate.procedure.procedure_key,
            procedureId: activated.id,
            previousProcedureId: item.existing.id,
          });
          break;
        }
        case "unchanged":
          executionItems.push({
            action: "unchanged",
            filePath: item.candidate.filePath,
            procedureKey: item.candidate.procedure.procedure_key,
            procedureId: item.existing.id,
          });
          break;
        case "invalid":
          throw new Error(`Invalid procedure plan item for ${item.filePath}: ${item.error}`);
      }
    }

    return executionItems;
  });

  return {
    plan,
    items,
    totals: summarizeExecution(items),
  };
}

/**
 * Builds one canonical stored procedure payload from a prepared candidate.
 *
 * @param params - Candidate data plus stored lifecycle metadata.
 * @returns Canonical procedure row payload ready for persistence.
 */
function buildProcedureRecord(params: {
  candidate: PreparedProcedureCandidate;
  id: string;
  createdAt: string;
  updatedAt: string;
  embedding?: number[];
  existing?: Procedure;
  retired: boolean;
}): Procedure {
  const { candidate, existing } = params;
  return {
    id: params.id,
    ...candidate.procedure,
    recall_text: candidate.recallText,
    revision_hash: candidate.revisionHash,
    source_hash: candidate.sourceHash,
    source_file: candidate.filePath,
    embedding: params.embedding ?? existing?.embedding,
    retired: params.retired,
    retired_at: existing?.retired_at,
    retired_reason: existing?.retired_reason,
    superseded_by: existing?.superseded_by,
    created_at: params.createdAt,
    updated_at: params.updatedAt,
  };
}

/**
 * Summarizes execution counts for CLI display and tests.
 *
 * @param items - Per-file execution items.
 * @returns Aggregate execution totals.
 */
function summarizeExecution(items: ProcedureSyncExecutionItem[]): ProcedureSyncExecutionTotals {
  return items.reduce<ProcedureSyncExecutionTotals>(
    (totals, item) => {
      switch (item.action) {
        case "created":
          totals.created += 1;
          break;
        case "updated_source_only":
          totals.updatedSourceOnly += 1;
          break;
        case "superseded":
          totals.superseded += 1;
          break;
        case "unchanged":
          totals.unchanged += 1;
          break;
      }

      return totals;
    },
    {
      created: 0,
      updatedSourceOnly: 0,
      superseded: 0,
      unchanged: 0,
    },
  );
}

/**
 * Formats one execution-preflight error for plans that still contain invalid items.
 *
 * @param invalidItems - Invalid plan items that block execution.
 * @returns Human-readable error message.
 */
function formatInvalidPlanError(invalidItems: Array<Extract<ProcedureSyncPlanItem, { action: "invalid" }>>): string {
  const details = invalidItems.map((item) => `${item.filePath}: ${item.error}`).join(" | ");
  return `Procedure sync plan contains ${invalidItems.length} invalid file(s): ${details}`;
}
