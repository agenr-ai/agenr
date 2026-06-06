import { createHash, randomUUID } from "node:crypto";

import type { EvalProfileSnapshotFixture } from "../../app/evals/ablation-arm.js";
import { createProfileSnapshot, updateDreamState } from "./dreaming-run-lifecycle.js";
import type { SqlExecutor } from "./queries.js";

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

  await createProfileSnapshot(executor, {
    id: snapshotId,
    durableIds,
    directiveIds,
    asOf,
    contentHash,
    runId: fixture.runId ?? null,
    createdAt,
  });
  await updateDreamState(executor, {
    activeProfileSnapshotId: snapshotId,
    updatedAt: createdAt,
  });

  return { snapshotId };
}
