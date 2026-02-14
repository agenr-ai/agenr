import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClient, type Client } from "@libsql/client";

import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import {
  appendJobLog,
  claimNextJob,
  completeJob,
  createJob,
  failJob,
  getJob,
  listJobs,
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

describe("generation queue", () => {
  test("createJob creates a queued job", async () => {
    const job = await createJob({ platform: "Toast" });

    expect(typeof job.id).toBe("string");
    expect(job.platform).toBe("toast");
    expect(job.status).toBe("queued");
    expect(job.logs).toEqual([]);
    expect(job.startedAt).toBeNull();
    expect(job.completedAt).toBeNull();
  });

  test("claimNextJob claims the oldest queued job and marks it running", async () => {
    const first = await createJob({ platform: "first" });
    const second = await createJob({ platform: "second" });

    await getDb().execute({
      sql: "UPDATE generation_jobs SET created_at = ? WHERE id = ?",
      args: ["2026-01-01T00:00:00.000Z", first.id],
    });
    await getDb().execute({
      sql: "UPDATE generation_jobs SET created_at = ? WHERE id = ?",
      args: ["2026-01-01T00:00:01.000Z", second.id],
    });

    const claimed = await claimNextJob();
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt).not.toBeNull();

    const fetchedFirst = await getJob(first.id);
    const fetchedSecond = await getJob(second.id);
    expect(fetchedFirst?.status).toBe("running");
    expect(fetchedSecond?.status).toBe("queued");
  });

  test("claimNextJob returns null when no jobs are queued", async () => {
    const claimed = await claimNextJob();
    expect(claimed).toBeNull();
  });

  test("claimNextJob skips running jobs", async () => {
    const running = await createJob({ platform: "running" });
    await getDb().execute({
      sql: "UPDATE generation_jobs SET status = 'running', started_at = ? WHERE id = ?",
      args: [new Date().toISOString(), running.id],
    });

    const queued = await createJob({ platform: "queued" });
    const claimed = await claimNextJob();

    expect(claimed?.id).toBe(queued.id);
    expect(claimed?.status).toBe("running");
  });

  test("appendJobLog appends to logs array", async () => {
    const job = await createJob({ platform: "logs" });

    await appendJobLog(job.id, "line 1");
    await appendJobLog(job.id, "line 2");

    const updated = await getJob(job.id);
    expect(updated?.logs).toEqual(["line 1", "line 2"]);
  });

  test("completeJob sets status complete and result", async () => {
    const job = await createJob({ platform: "done" });

    await completeJob(job.id, { adapterPath: "data/adapters/done.ts", attempts: 1 });

    const updated = await getJob(job.id);
    expect(updated?.status).toBe("complete");
    expect(updated?.result).toEqual({ adapterPath: "data/adapters/done.ts", attempts: 1 });
    expect(updated?.completedAt).not.toBeNull();
    expect(updated?.error).toBeNull();
  });

  test("failJob sets status failed and error", async () => {
    const job = await createJob({ platform: "broken" });

    await failJob(job.id, "boom");

    const updated = await getJob(job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("boom");
    expect(updated?.completedAt).not.toBeNull();
  });

  test("getJob returns null for non-existent id", async () => {
    const job = await getJob("does-not-exist");
    expect(job).toBeNull();
  });

  test("listJobs filters by status", async () => {
    const queued = await createJob({ platform: "queued" });
    const running = await createJob({ platform: "running" });

    await getDb().execute({
      sql: "UPDATE generation_jobs SET status = 'running', started_at = ? WHERE id = ?",
      args: [new Date().toISOString(), running.id],
    });

    const queuedOnly = await listJobs({ status: "queued" });

    expect(queuedOnly.some((job) => job.id === queued.id)).toBe(true);
    expect(queuedOnly.some((job) => job.id === running.id)).toBe(false);
  });

  test("listJobs returns most recent first", async () => {
    const older = await createJob({ platform: "older" });
    const newer = await createJob({ platform: "newer" });

    await getDb().execute({
      sql: "UPDATE generation_jobs SET created_at = ? WHERE id = ?",
      args: ["2026-01-01T00:00:00.000Z", older.id],
    });
    await getDb().execute({
      sql: "UPDATE generation_jobs SET created_at = ? WHERE id = ?",
      args: ["2026-01-01T00:00:10.000Z", newer.id],
    });

    const jobs = await listJobs();

    expect(jobs[0]?.id).toBe(newer.id);
    expect(jobs[1]?.id).toBe(older.id);
  });


  test("two jobs with identical created_at are both returned (not skipped)", async () => {
    const jobA = await createJob({ platform: "dup-a" });
    const jobB = await createJob({ platform: "dup-b" });

    const ts = "2026-01-15T12:00:00.000Z";
    await getDb().execute({
      sql: "UPDATE generation_jobs SET created_at = ? WHERE id = ?",
      args: [ts, jobA.id],
    });
    await getDb().execute({
      sql: "UPDATE generation_jobs SET created_at = ? WHERE id = ?",
      args: [ts, jobB.id],
    });

    const jobs = await listJobs();
    const ids = jobs.map((j) => j.id);
    expect(ids).toContain(jobA.id);
    expect(ids).toContain(jobB.id);
  });

  test("cursor pagination with beforeId returns next page without gaps", async () => {
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      jobs.push(await createJob({ platform: `page-${i}` }));
    }

    const ts = "2026-02-01T00:00:00.000Z";
    for (const job of jobs) {
      await getDb().execute({
        sql: "UPDATE generation_jobs SET created_at = ? WHERE id = ?",
        args: [ts, job.id],
      });
    }

    // Sort by id DESC to match ORDER BY created_at DESC, id DESC with same timestamps
    const sortedIds = jobs.map((j) => j.id).sort().reverse();

    // Get first page
    const page1 = await listJobs({ limit: 2 });
    expect(page1).toHaveLength(2);
    expect(page1[0]!.id).toBe(sortedIds[0]);
    expect(page1[1]!.id).toBe(sortedIds[1]);

    // Get second page using compound cursor
    const page2 = await listJobs({
      beforeCreatedAt: page1[1]!.createdAt,
      beforeId: page1[1]!.id,
      limit: 2,
    });
    expect(page2).toHaveLength(2);
    expect(page2[0]!.id).toBe(sortedIds[2]);
    expect(page2[1]!.id).toBe(sortedIds[3]);

    // No gaps — all IDs accounted for
    const allIds = [...page1, ...page2].map((j) => j.id);
    expect(new Set(allIds).size).toBe(4);
  });

  test("without beforeId, pagination falls back to beforeCreatedAt only", async () => {
    const older = await createJob({ platform: "fallback-old" });
    const newer = await createJob({ platform: "fallback-new" });

    await getDb().execute({
      sql: "UPDATE generation_jobs SET created_at = ? WHERE id = ?",
      args: ["2026-03-01T00:00:00.000Z", older.id],
    });
    await getDb().execute({
      sql: "UPDATE generation_jobs SET created_at = ? WHERE id = ?",
      args: ["2026-03-01T00:00:10.000Z", newer.id],
    });

    const jobs = await listJobs({ beforeCreatedAt: "2026-03-01T00:00:05.000Z" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(older.id);
  });
});
