import { type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { maybeRunLightDream } from "../../../src/app/dreaming/background-triggers.js";
import { createTestClient, insertDurable } from "../../helpers/dreaming-reconcile.js";

const clients: Client[] = [];

describe("maybeRunLightDream", () => {
  afterEach(async () => {
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
});
