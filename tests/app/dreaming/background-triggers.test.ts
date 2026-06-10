import { type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { maybeRunLightDream } from "../../../src/app/dreaming/background-triggers.js";
import { beginEpisodeWrite, resetDreamingConcurrencyStateForTests, tryAcquireDreamingRunLock } from "../../../src/app/dreaming/concurrency.js";
import { createTestClient, insertDurable } from "../../helpers/dreaming-reconcile.js";

const clients: Client[] = [];

async function insertEpisode(client: Client, id: string, summary: string): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO episodes (id, source, source_id, started_at, ended_at, summary, created_at, updated_at)
      VALUES (?, 'skeln', ?, '2026-06-05T10:00:00.000Z', '2026-06-05T11:00:00.000Z', ?, '2026-06-05T11:00:00.000Z', '2026-06-05T11:00:00.000Z')
    `,
    args: [id, `session-${id}`, summary],
  });
}

describe("maybeRunLightDream", () => {
  afterEach(async () => {
    resetDreamingConcurrencyStateForTests();
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("runs a light dream when accumulated durable importance crosses the threshold", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    await insertDurable(client, {
      id: "important-store",
      subject: "Important store",
      content: "Important store should trigger background dreaming.",
      importance: 30,
      created_at: "2026-06-05T12:00:00.000Z",
      updated_at: "2026-06-05T12:00:00.000Z",
    });

    const result = await maybeRunLightDream(
      { trigger: "importance", now: () => new Date("2026-06-05T12:05:00.000Z") },
      {
        port,
        config: { dreaming: { triggers: { importanceThreshold: 25, minIntervalMinutes: 0 } } },
      },
    );

    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      throw new Error("Expected light dream to run.");
    }
    expect(result.unsynthesizedImportanceSum).toBe(30);
    expect(result.result.tier).toBe("light");
    expect(result.result.completionSummary?.stages_skipped).toEqual([
      { stage: "reconcile", reason: "light_tier" },
      { stage: "prune", reason: "light_tier" },
    ]);
    expect(result.result.completionSummary?.reconcile).toBeUndefined();
    expect(result.result.completionSummary?.prune).toBeUndefined();
    expect(result.result.completionSummary?.backupSkipped).toBe(true);

    const lastRun = await port.getLastRun();
    expect(lastRun?.tier).toBe("light");
    expect(lastRun?.summaryJson?.scan?.unsynthesizedImportanceSum).toBe(30);
  });

  it("skips the importance trigger below the configured threshold", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    await insertDurable(client, {
      id: "ordinary-store",
      subject: "Ordinary store",
      content: "Ordinary store should stay below the trigger threshold.",
      importance: 6,
      created_at: "2026-06-05T12:00:00.000Z",
      updated_at: "2026-06-05T12:00:00.000Z",
    });

    const result = await maybeRunLightDream(
      { trigger: "importance", now: () => new Date("2026-06-05T12:05:00.000Z") },
      {
        port,
        config: { dreaming: { triggers: { importanceThreshold: 25, minIntervalMinutes: 0 } } },
      },
    );

    expect(result).toEqual({
      status: "skipped",
      reason: "importance_below_threshold",
      unsynthesizedImportanceSum: 6,
    });
    expect(await port.getLastRun()).toBeNull();
  });

  it("runs a post-session light dream when an unsynthesized episode exists", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    await insertEpisode(client, "ep-fresh", "Session that just ended and still needs mining.");

    const result = await maybeRunLightDream(
      { trigger: "post_session", now: () => new Date("2026-06-05T12:05:00.000Z") },
      {
        port,
        config: { dreaming: { triggers: { minIntervalMinutes: 0 } } },
      },
    );

    expect(result.status).toBe("ran");
  });

  it("skips the post-session trigger when every episode is already synthesized", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    await insertEpisode(client, "ep-mined", "Session already mined by an earlier run.");
    await port.markEpisodesSynthesized({ episodeIds: ["ep-mined"], runId: "run-prior", synthesizedAt: "2026-06-05T11:00:00.000Z" });

    const result = await maybeRunLightDream(
      { trigger: "post_session", now: () => new Date("2026-06-05T12:05:00.000Z") },
      {
        port,
        config: { dreaming: { triggers: { minIntervalMinutes: 0 } } },
      },
    );

    expect(result).toEqual({ status: "skipped", reason: "no_evidence", unsynthesizedImportanceSum: 0 });
    expect(await port.getLastRun()).toBeNull();
  });

  it("skips when another dreaming run already holds the lock", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    await insertDurable(client, {
      id: "locked-store",
      subject: "Locked store",
      content: "Should not run while the lock is held.",
      importance: 30,
      created_at: "2026-06-05T12:00:00.000Z",
      updated_at: "2026-06-05T12:00:00.000Z",
    });

    const lock = await tryAcquireDreamingRunLock(port, ":memory:");
    expect(lock).toBeTruthy();

    const result = await maybeRunLightDream(
      { trigger: "importance", now: () => new Date("2026-06-05T12:05:00.000Z") },
      {
        port,
        dbPath: ":memory:",
        config: { dreaming: { triggers: { importanceThreshold: 25, minIntervalMinutes: 0 } } },
      },
    );

    expect(result).toEqual({ status: "skipped", reason: "run_in_progress" });
    await lock!.release();
  });

  it("skips the importance trigger while an episode write is in progress", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);
    await insertDurable(client, {
      id: "episode-write-store",
      subject: "Episode write store",
      content: "Should not run during episode write.",
      importance: 30,
      created_at: "2026-06-05T12:00:00.000Z",
      updated_at: "2026-06-05T12:00:00.000Z",
    });

    beginEpisodeWrite(":memory:");

    const result = await maybeRunLightDream(
      { trigger: "importance", now: () => new Date("2026-06-05T12:05:00.000Z") },
      {
        port,
        dbPath: ":memory:",
        config: { dreaming: { triggers: { importanceThreshold: 25, minIntervalMinutes: 0 } } },
      },
    );

    expect(result).toEqual({ status: "skipped", reason: "episode_write_in_progress" });
  });
});
