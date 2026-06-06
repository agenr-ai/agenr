import type { EvalDreamRunFixture, EvalDreamRunRecord, EvalDreamRunStore } from "../../app/evals/dream-run-fixture.js";
import { completeDreamRun, createDreamRun } from "./dreaming-run-lifecycle.js";
import { mapRunRow } from "./dreaming-run-shared.js";
import type { SqlExecutor } from "./queries.js";

/** Creates the adapter-backed dream-run fixture store for one eval sandbox. */
export function createEvalDreamRunStore(executor: SqlExecutor): EvalDreamRunStore {
  return {
    provisionDreamRun: (fixture) => provisionEvalDreamRun(executor, fixture),
    getDreamRun: (runId) => getEvalDreamRun(executor, runId),
  };
}

/**
 * Inserts one completed dreaming run row with a pre-baked completion summary.
 *
 * @param executor - SQL executor backed by the eval sandbox database.
 * @param fixture - Tier and completion summary to persist.
 * @returns Persisted dreaming run identifier.
 */
export async function provisionEvalDreamRun(executor: SqlExecutor, fixture: EvalDreamRunFixture): Promise<{ runId: string }> {
  const completedAt = fixture.completedAt ?? new Date().toISOString();
  const runId = await createDreamRun(executor, {
    tier: fixture.tier,
    dryRun: false,
    startedAt: completedAt,
  });

  const efficiency = fixture.summaryJson.efficiency;
  const estimatedCostUsd =
    fixture.estimatedCostUsd ??
    (efficiency?.costPerSynthesizedDurableUsd !== undefined && efficiency?.costPerSynthesizedDurableUsd !== null && efficiency.synthesizedDurableMutations > 0
      ? efficiency.costPerSynthesizedDurableUsd * efficiency.synthesizedDurableMutations
      : 0);

  await completeDreamRun(executor, runId, {
    status: "completed",
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd,
    actionsTaken: fixture.summaryJson.actions_taken ?? 0,
    actionsSkipped: 0,
    durablesStaled: fixture.summaryJson.prune?.durablesStaled ?? 0,
    summaryJson: fixture.summaryJson,
    completedAt,
  });

  return { runId };
}

/**
 * Loads one seeded eval dreaming run by identifier.
 *
 * @param executor - SQL executor backed by the eval sandbox database.
 * @param runId - Dreaming run identifier returned by provisioning.
 * @returns Persisted eval run record, or null when absent.
 */
export async function getEvalDreamRun(executor: SqlExecutor, runId: string): Promise<EvalDreamRunRecord | null> {
  const result = await executor.execute({
    sql: `
      SELECT
        id,
        tier,
        project,
        started_at,
        completed_at,
        status,
        input_tokens,
        output_tokens,
        estimated_cost_usd,
        model,
        actions_taken,
        actions_skipped,
        durables_staled,
        summary_json,
        error,
        dry_run,
        config_json
      FROM dream_runs
      WHERE id = ?
      LIMIT 1
    `,
    args: [runId.trim()],
  });

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const run = mapRunRow(row);
  return {
    runId: run.id,
    status: run.status,
    completedAt: run.completedAt,
    estimatedCostUsd: run.estimatedCostUsd,
    summaryJson: run.summaryJson,
  };
}
