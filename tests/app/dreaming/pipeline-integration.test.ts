import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { getDurable } from "../../../src/adapters/db/queries.js";
import { runDream } from "../../../src/app/dreaming/service.js";
import type { LlmPort } from "../../../src/core/ports.js";
import { createDeterministicEmbedding, createTestClient, insertDurable } from "../../helpers/dreaming-reconcile.js";

/** Extraction LLM double returning a fixed durable set for pipeline wiring tests. */
class PipelineExtractLlm implements LlmPort {
  public readonly metadata = { usage: { inputTokens: 0, outputTokens: 0, totalCost: 0 } };

  public constructor(
    private readonly durables: Array<Record<string, unknown>>,
    private readonly costPerCall = 0,
  ) {}

  public async complete(): Promise<string> {
    throw new Error("complete() is not used by the extract stage.");
  }

  public async completeJson<T>(): Promise<T> {
    this.metadata.usage.inputTokens += 1;
    this.metadata.usage.totalCost += this.costPerCall;
    return { durables: this.durables } as T;
  }
}

describe("runDream pipeline integration", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("runs extract and temporalize, inserting new durables and superseding revised ones", async () => {
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
    await insertEpisode(client, "ep-1", "Session covering the move to San Francisco and a coffee preference.");

    const llm = new PipelineExtractLlm(
      [
        { type: "preference", subject: "Coffee", content: "Prefers oat milk in coffee during daily standups.", claim_key: "user/coffee_preference" },
        { type: "fact", subject: "Home base", content: "Home base is now San Francisco for the foreseeable future.", claim_key: "user/home_base" },
      ],
      0.25,
    );

    const result = await runDream(
      { tier: "standard", apply: true, verbose: false, json: false, skipBackup: true },
      {
        port,
        config: null,
        now: () => new Date("2026-04-04T15:00:00.000Z"),
        createExtractLlm: () => llm,
        embedding: createDeterministicEmbedding(),
      },
    );

    expect(result.status).toBe("completed");
    expect(result.completionSummary?.extract?.newCandidates).toBe(1);
    expect(result.completionSummary?.extract?.durablesInserted).toBe(1);
    expect(result.completionSummary?.temporalize?.revisionsApplied).toBe(1);

    const successorRow = await client.execute({
      sql: `SELECT embedding FROM durables WHERE claim_key_source = 'dreaming_temporalize' LIMIT 1`,
      args: [],
    });
    expect(successorRow.rows[0]?.embedding).toBeTruthy();

    const predecessor = await client.execute({ sql: `SELECT superseded_by, valid_to FROM durables WHERE id = ?`, args: ["home-1"] });
    expect(predecessor.rows[0]?.superseded_by).toBeTruthy();
    expect(predecessor.rows[0]?.valid_to).toBe("2026-04-04T15:00:00.000Z");

    const successor = await getDurable(client, predecessor.rows[0]?.superseded_by as string);
    expect(successor?.content).toBe("Home base is now San Francisco for the foreseeable future.");
    expect(successor?.claim_key_source).toBe("dreaming_temporalize");

    const activeProfile = await port.getActiveProfileSnapshot();
    expect(activeProfile?.id).toBe(result.completionSummary?.project?.snapshotId);
    expect(activeProfile?.durableIds.length).toBeGreaterThan(0);
    expect(result.completionSummary?.project).toMatchObject({
      applied: true,
      profileDurableCount: expect.any(Number),
    });
  });
});

async function insertEpisode(client: Client, id: string, summary: string): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO episodes (id, source, source_id, started_at, ended_at, summary, created_at, updated_at)
      VALUES (?, 'openclaw', ?, '2026-04-04T10:00:00.000Z', '2026-04-04T11:00:00.000Z', ?, '2026-04-04T11:00:00.000Z', '2026-04-04T11:00:00.000Z')
    `,
    args: [id, `session-${id}`, summary],
  });
}
