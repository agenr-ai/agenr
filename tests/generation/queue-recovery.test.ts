import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";

import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import {
  ORPHANED_JOB_ERROR,
  completeJob,
  createJob,
  getJob,
  recoverStaleJobs,
} from "../../src/jobs/generation-queue";

let testDb: Client | null = null;

beforeEach(async () => {
  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
});

afterEach(async () => {
  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;
});

describe("generation queue stale recovery", () => {
  test("recoverStaleJobs marks only running jobs as failed", async () => {
    const running = await createJob({ platform: "running" });
    const queued = await createJob({ platform: "queued" });
    const complete = await createJob({ platform: "complete" });

    await getDb().execute({
      sql: "UPDATE generation_jobs SET status = 'running', started_at = ? WHERE id = ?",
      args: [new Date().toISOString(), running.id],
    });
    await completeJob(complete.id, { ok: true });

    const recoveredCount = await recoverStaleJobs();
    expect(recoveredCount).toBe(1);

    const recovered = await getJob(running.id);
    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toBe(ORPHANED_JOB_ERROR);
    expect(recovered?.completedAt).not.toBeNull();

    const queuedJob = await getJob(queued.id);
    expect(queuedJob?.status).toBe("queued");
    expect(queuedJob?.error).toBeNull();
    expect(queuedJob?.completedAt).toBeNull();

    const completeJobAfterRecovery = await getJob(complete.id);
    expect(completeJobAfterRecovery?.status).toBe("complete");
    expect(completeJobAfterRecovery?.error).toBeNull();
    expect(completeJobAfterRecovery?.result).toEqual({ ok: true });

    const secondRunCount = await recoverStaleJobs();
    expect(secondRunCount).toBe(0);
  });
});
