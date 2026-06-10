import { type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { countUnsynthesizedEpisodes, listUnsynthesizedEpisodeEvidence, markEpisodesSynthesized } from "../../../src/adapters/db/dreaming-queries.js";
import { completeDreamRun, createDreamRun } from "../../../src/adapters/db/dreaming-run-lifecycle.js";
import { getLastCompletedDreamRun, getLastDreamRun } from "../../../src/adapters/db/dreaming-run-read.js";
import { createTestClient } from "../../helpers/dreaming-reconcile.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
});

async function insertEpisode(
  client: Client,
  overrides: { id: string; summary?: string; startedAt?: string; project?: string; supersededBy?: string },
): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO episodes (id, source, source_id, started_at, ended_at, summary, project, superseded_by, created_at, updated_at)
      VALUES (?, 'skeln', ?, ?, '2026-06-05T11:00:00.000Z', ?, ?, ?, '2026-06-05T11:00:00.000Z', '2026-06-05T11:00:00.000Z')
    `,
    args: [
      overrides.id,
      `session-${overrides.id}`,
      overrides.startedAt ?? "2026-06-05T10:00:00.000Z",
      overrides.summary ?? `Summary for ${overrides.id}.`,
      overrides.project ?? null,
      overrides.supersededBy ?? null,
    ],
  });
}

describe("episode synthesis tracking queries", () => {
  it("excludes synthesized and inactive episodes from listing and counting", async () => {
    const client = await createTestClient(clients);

    await insertEpisode(client, { id: "ep-active" });
    await insertEpisode(client, { id: "ep-mined" });
    await insertEpisode(client, { id: "ep-superseded", supersededBy: "ep-active" });
    await markEpisodesSynthesized(client, { episodeIds: ["ep-mined"], runId: "run-1", synthesizedAt: "2026-06-05T12:00:00.000Z" });

    const rows = await listUnsynthesizedEpisodeEvidence(client);
    expect(rows.map((row) => row.id)).toEqual(["ep-active"]);
    expect(await countUnsynthesizedEpisodes(client)).toBe(1);
  });

  it("selects the newest episodes under the limit and returns them oldest-first", async () => {
    const client = await createTestClient(clients);

    await insertEpisode(client, { id: "ep-oldest", startedAt: "2026-06-01T10:00:00.000Z" });
    await insertEpisode(client, { id: "ep-middle", startedAt: "2026-06-02T10:00:00.000Z" });
    await insertEpisode(client, { id: "ep-newest", startedAt: "2026-06-03T10:00:00.000Z" });

    const rows = await listUnsynthesizedEpisodeEvidence(client, { limit: 2 });
    expect(rows.map((row) => row.id)).toEqual(["ep-middle", "ep-newest"]);
  });

  it("keeps the first synthesis record when an episode is marked twice", async () => {
    const client = await createTestClient(clients);

    await insertEpisode(client, { id: "ep-1" });
    await markEpisodesSynthesized(client, { episodeIds: ["ep-1"], runId: "run-first", synthesizedAt: "2026-06-05T12:00:00.000Z" });
    await markEpisodesSynthesized(client, { episodeIds: ["ep-1"], runId: "run-second", synthesizedAt: "2026-06-05T13:00:00.000Z" });

    const result = await client.execute("SELECT run_id FROM dream_synthesized_episodes WHERE episode_id = 'ep-1'");
    expect(result.rows[0]?.run_id).toBe("run-first");
  });

  it("filters unsynthesized episodes by project", async () => {
    const client = await createTestClient(clients);

    await insertEpisode(client, { id: "ep-agenr", project: "agenr" });
    await insertEpisode(client, { id: "ep-other", project: "other" });

    expect(await countUnsynthesizedEpisodes(client, "agenr")).toBe(1);
    const rows = await listUnsynthesizedEpisodeEvidence(client, { project: "agenr" });
    expect(rows.map((row) => row.id)).toEqual(["ep-agenr"]);
  });
});

describe("getLastCompletedDreamRun", () => {
  it("ignores a newer in-flight run and returns the last completed run", async () => {
    const client = await createTestClient(clients);

    const completedRunId = await createDreamRun(client, { tier: "light", dryRun: false, startedAt: "2026-06-05T12:00:00.000Z" });
    await completeDreamRun(client, completedRunId, {
      status: "completed",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      actionsTaken: 0,
      actionsSkipped: 0,
      durablesStaled: 0,
      completedAt: "2026-06-05T12:01:00.000Z",
    });
    const runningRunId = await createDreamRun(client, { tier: "light", dryRun: false, startedAt: "2026-06-05T13:00:00.000Z" });

    // Regression: the unfiltered latest-run lookup observes the in-flight row,
    // which used to reset the scan cursor to the epoch on every run.
    expect((await getLastDreamRun(client))?.id).toBe(runningRunId);
    expect((await getLastCompletedDreamRun(client))?.id).toBe(completedRunId);
    expect((await getLastCompletedDreamRun(client))?.completedAt).toBe("2026-06-05T12:01:00.000Z");
  });

  it("returns null when no run has completed", async () => {
    const client = await createTestClient(clients);
    await createDreamRun(client, { tier: "standard", dryRun: true });

    expect(await getLastCompletedDreamRun(client)).toBeNull();
  });
});
