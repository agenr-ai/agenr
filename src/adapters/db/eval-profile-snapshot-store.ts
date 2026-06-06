import { createHash, randomUUID } from "node:crypto";

import type { EvalProfileSnapshotFixture } from "../../app/evals/ablation-arm.js";
import { createProfileSnapshot, updateDreamState } from "./dreaming-run-lifecycle.js";
import type { SqlExecutor } from "./queries.js";

/**
 * Ensures one completed dreaming run row exists before profile snapshots reference it.
 *
 * @param executor - SQL executor for the isolated eval sandbox database.
 * @param runId - Dreaming run identifier referenced by the profile snapshot fixture.
 * @param provisionedAt - Timestamp used when seeding the eval run row.
 */
async function ensureEvalDreamRunExists(executor: SqlExecutor, runId: string, provisionedAt: string): Promise<void> {
  const normalizedRunId = runId.trim();
  if (normalizedRunId.length === 0) {
    return;
  }

  const existing = await executor.execute({
    sql: `
      SELECT id
      FROM dream_runs
      WHERE id = ?
      LIMIT 1
    `,
    args: [normalizedRunId],
  });
  if (existing.rows[0]) {
    return;
  }

  await executor.execute({
    sql: `
      INSERT INTO dream_runs (
        id,
        tier,
        started_at,
        completed_at,
        status,
        dry_run
      )
      VALUES (?, 'light', ?, ?, 'completed', 0)
    `,
    args: [normalizedRunId, provisionedAt, provisionedAt],
  });
}

/**
 * Seeds one active profile snapshot row plus dream_state activation for eval cases.
 *
 * @param executor - SQL executor for the isolated eval sandbox database.
 * @param fixture - Profile snapshot fixture supplied by the eval request.
 * @param provisionedAt - Default timestamp used when fixture timestamps are absent.
 * @returns The activated snapshot identifier.
 */
export async function provisionEvalProfileSnapshot(
  executor: SqlExecutor,
  fixture: EvalProfileSnapshotFixture,
  provisionedAt: string,
): Promise<{ snapshotId: string }> {
  const snapshotId = fixture.id?.trim() || `eval-profile-${randomUUID()}`;
  const durableIds = fixture.durableIds.map((id) => id.trim()).filter((id) => id.length > 0);
  const directiveIds = (fixture.directiveIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
  const createdAt = fixture.createdAt ?? provisionedAt;
  const asOf = fixture.asOf ?? createdAt;
  const contentHash = createHash("sha256").update(JSON.stringify({ durableIds, directiveIds, asOf })).digest("hex");
  const runId = fixture.runId?.trim();

  if (runId) {
    await ensureEvalDreamRunExists(executor, runId, createdAt);
  }

  await createProfileSnapshot(executor, {
    id: snapshotId,
    durableIds,
    directiveIds,
    asOf,
    contentHash,
    runId: runId ?? null,
    createdAt,
  });
  await updateDreamState(executor, {
    activeProfileSnapshotId: snapshotId,
    updatedAt: createdAt,
  });

  return { snapshotId };
}
