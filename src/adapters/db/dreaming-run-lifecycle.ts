import { randomUUID } from "node:crypto";

import type { DreamCompletionSummary, DreamRunStatus } from "../../core/dreaming/types.js";
import type { DreamTier } from "../../core/dreaming/domain/pass-types.js";
import { readNumber } from "./row-mapping.js";
import type { SqlExecutor } from "./queries.js";
import { normalizeInteger, normalizeNumber, normalizeOptionalString, normalizeTimestamp } from "./dreaming-run-shared.js";

/**
 * Inserts a new dreaming run row and returns the generated run ID.
 *
 * @param executor - SQL executor used for the insert.
 * @param run - Initial run metadata.
 * @returns Persisted dreaming run identifier.
 */
export async function createDreamRun(
  executor: SqlExecutor,
  run: {
    tier: DreamTier;
    project?: string;
    model?: string | null;
    dryRun: boolean;
    config?: Record<string, unknown> | null;
    startedAt?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const startedAt = normalizeTimestamp(run.startedAt) ?? new Date().toISOString();

  await executor.execute({
    sql: `
      INSERT INTO dream_runs (
        id,
        tier,
        project,
        started_at,
        status,
        model,
        dry_run,
        config_json
      )
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
    `,
    args: [
      id,
      run.tier,
      normalizeOptionalString(run.project),
      startedAt,
      normalizeOptionalString(run.model ?? undefined),
      run.dryRun ? 1 : 0,
      JSON.stringify(run.config ?? null),
    ],
  });

  return id;
}

/**
 * Finalizes a dreaming run with the completed run summary.
 *
 * @param executor - SQL executor used for the update.
 * @param runId - Existing run identifier.
 * @param result - Final run outcome and metrics.
 */
export async function completeDreamRun(
  executor: SqlExecutor,
  runId: string,
  result: {
    status: DreamRunStatus;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    actionsTaken: number;
    actionsSkipped: number;
    durablesRetired: number;
    summaryJson?: DreamCompletionSummary | null;
    error?: string | null;
    completedAt?: string;
  },
): Promise<void> {
  await executor.execute({
    sql: `
      UPDATE dream_runs
      SET completed_at = ?,
          status = ?,
          input_tokens = ?,
          output_tokens = ?,
          estimated_cost_usd = ?,
          actions_taken = ?,
          actions_skipped = ?,
          durables_retired = ?,
          summary_json = ?,
          error = ?
      WHERE id = ?
    `,
    args: [
      normalizeTimestamp(result.completedAt) ?? new Date().toISOString(),
      result.status,
      normalizeInteger(result.inputTokens),
      normalizeInteger(result.outputTokens),
      normalizeNumber(result.estimatedCostUsd),
      normalizeInteger(result.actionsTaken),
      normalizeInteger(result.actionsSkipped),
      normalizeInteger(result.durablesRetired),
      JSON.stringify(result.summaryJson ?? null),
      normalizeOptionalString(result.error ?? undefined),
      runId.trim(),
    ],
  });
}

/**
 * Updates singleton dream_state cursors and counters.
 *
 * @param executor - SQL executor used for the update.
 * @param input - Partial dream_state fields to persist.
 */
export async function updateDreamState(
  executor: SqlExecutor,
  input: {
    lastSuccessfulRunAt?: string;
    unsynthesizedImportanceSum?: number;
    updatedAt: string;
  },
): Promise<void> {
  const fields: string[] = ["updated_at = ?"];
  const args: Array<string | number> = [input.updatedAt];

  if (input.lastSuccessfulRunAt !== undefined) {
    fields.push("last_successful_run_at = ?");
    args.push(input.lastSuccessfulRunAt);
  }
  if (input.unsynthesizedImportanceSum !== undefined) {
    fields.push("unsynthesized_importance_sum = ?");
    args.push(input.unsynthesizedImportanceSum);
  }

  await executor.execute({
    sql: `
      UPDATE dream_state
      SET ${fields.join(", ")}
      WHERE id = 'default'
    `,
    args,
  });
}

/**
 * Returns the rolling 24-hour dreaming spend total.
 *
 * @param executor - SQL executor used for the lookup.
 * @param now - Current timestamp used to bound the query window.
 * @returns Estimated USD spent in the last 24 hours.
 */
export async function getDailyDreamCost(executor: SqlExecutor, now = new Date()): Promise<number> {
  const sinceIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const result = await executor.execute({
    sql: `
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
      FROM dream_runs
      WHERE started_at >= ?
    `,
    args: [sinceIso],
  });

  const row = result.rows[0];
  return row ? readNumber(row, "total_cost", 0) : 0;
}
