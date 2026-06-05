import { type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { runTemporalizeStage } from "../../../src/app/dreaming/temporalize.js";
import type { DreamCandidate } from "../../../src/core/dreaming/types.js";
import type { DurableKind } from "../../../src/core/types.js";
import { createDeterministicEmbedding, createTestClient, insertDurable, TEST_NOW } from "../../helpers/dreaming-reconcile.js";

const embedding = createDeterministicEmbedding();

function buildRefineCandidate(overrides: Partial<DreamCandidate> & Pick<DreamCandidate, "refinesDurableId">): DreamCandidate {
  return {
    id: overrides.id ?? "candidate-1",
    type: (overrides.type as DurableKind) ?? "fact",
    subject: overrides.subject ?? "Home base",
    content: overrides.content ?? "Home base is now San Francisco for the foreseeable future.",
    importance: overrides.importance ?? 6,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    claimKey: overrides.claimKey ?? "user/home_base",
    trust: overrides.trust ?? "tentative",
    disposition: "refines",
    refinesDurableId: overrides.refinesDurableId,
    evidenceRefs: overrides.evidenceRefs ?? [{ kind: "episode", locator: "ep-1", observedAt: "2026-04-04T11:00:00.000Z" }],
  };
}

async function readDurableRow(client: Client, id: string): Promise<Record<string, unknown> | undefined> {
  const result = await client.execute({ sql: `SELECT * FROM durables WHERE id = ? LIMIT 1`, args: [id] });
  return result.rows[0] as Record<string, unknown> | undefined;
}

describe("dreaming temporalize stage", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("supersedes the predecessor with a temporal revision and closes its window", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "home-1",
      subject: "Home base",
      content: "Home base is Boston for the foreseeable future.",
      type: "fact",
      claim_key: "user/home_base",
      claim_key_status: "trusted",
      valid_from: "2026-01-01T00:00:00.000Z",
    });

    const runId = await port.createRun({ tier: "standard", dryRun: false });
    const candidate = buildRefineCandidate({ refinesDurableId: "home-1" });

    const result = await runTemporalizeStage({ runId, candidates: [candidate], apply: true, now: () => TEST_NOW }, { port, embedding });

    expect(result.summary.revisionsIdentified).toBe(1);
    expect(result.summary.revisionsApplied).toBe(1);
    expect(result.summary.revisionsSkipped).toBe(0);

    const predecessor = await readDurableRow(client, "home-1");
    const successorId = predecessor?.superseded_by as string;
    expect(successorId).toBeTruthy();
    expect(predecessor?.valid_to).toBe(TEST_NOW.toISOString());

    const successor = await readDurableRow(client, successorId);
    expect(successor?.content).toBe(candidate.content);
    expect(successor?.claim_key).toBe("user/home_base");
    expect(successor?.claim_key_source).toBe("dreaming_temporalize");
    expect(successor?.valid_from).toBe(TEST_NOW.toISOString());
    expect(successor?.superseded_by).toBeNull();

    const actions = await port.getRunActions(runId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.actionType).toBe("supersede_durable");
    expect(actions[0]?.durableIds).toEqual(["home-1", successorId]);
  });

  it("identifies but does not write revisions during a dry run", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "home-1",
      subject: "Home base",
      content: "Home base is Boston.",
      type: "fact",
      claim_key: "user/home_base",
    });

    const runId = await port.createRun({ tier: "standard", dryRun: true });
    const result = await runTemporalizeStage(
      { runId, candidates: [buildRefineCandidate({ refinesDurableId: "home-1" })], apply: false, now: () => TEST_NOW },
      { port, embedding },
    );

    expect(result.summary.revisionsIdentified).toBe(1);
    expect(result.summary.revisionsApplied).toBe(0);

    const predecessor = await readDurableRow(client, "home-1");
    expect(predecessor?.superseded_by).toBeNull();
    expect(predecessor?.valid_to).toBeNull();
    expect(await port.getRunActions(runId)).toEqual([]);
  });

  it("skips revisions when the candidate type does not match the predecessor", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    await insertDurable(client, {
      id: "home-1",
      subject: "Home base",
      content: "Home base is Boston.",
      type: "fact",
      claim_key: "user/home_base",
    });

    const runId = await port.createRun({ tier: "standard", dryRun: false });
    const result = await runTemporalizeStage(
      { runId, candidates: [buildRefineCandidate({ refinesDurableId: "home-1", type: "preference" })], apply: true, now: () => TEST_NOW },
      { port, embedding },
    );

    expect(result.summary.revisionsIdentified).toBe(0);
    expect(result.summary.revisionsSkipped).toBe(1);

    const predecessor = await readDurableRow(client, "home-1");
    expect(predecessor?.superseded_by).toBeNull();
  });

  it("skips revisions when the predecessor is no longer active", async () => {
    const client = await createTestClient(clients);
    const port = createDreamPort(client);

    const runId = await port.createRun({ tier: "standard", dryRun: false });
    const result = await runTemporalizeStage(
      { runId, candidates: [buildRefineCandidate({ refinesDurableId: "missing-1" })], apply: true, now: () => TEST_NOW },
      { port, embedding },
    );

    expect(result.summary.revisionsIdentified).toBe(0);
    expect(result.summary.revisionsSkipped).toBe(1);
  });
});
