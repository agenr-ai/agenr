import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { createApiKey } from "../../src/db/api-keys";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { apiKeyAuthMiddleware } from "../../src/middleware/auth";
import { idempotencyMiddleware } from "../../src/middleware/idempotency";

let testDb: Client | null = null;
let originalApiKey: string | undefined;

function createTestApp(): Hono {
  const app = new Hono();
  const executionCounts = new Map<string, number>();

  app.use("/agp/*", apiKeyAuthMiddleware);
  app.use("/agp/execute", idempotencyMiddleware);
  app.post("/agp/execute", (c) => {
    const principalId = c.get("apiKeyId") ?? "admin";
    const nextCount = (executionCounts.get(principalId) ?? 0) + 1;
    executionCounts.set(principalId, nextCount);
    return c.json({
      principalId,
      executionCount: nextCount,
      nonce: crypto.randomUUID(),
    });
  });

  return app;
}

beforeEach(async () => {
  originalApiKey = process.env.AGENR_API_KEY;
  delete process.env.AGENR_API_KEY;

  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
});

afterEach(async () => {
  if (originalApiKey === undefined) {
    delete process.env.AGENR_API_KEY;
  } else {
    process.env.AGENR_API_KEY = originalApiKey;
  }

  if (testDb) {
    await testDb.close();
  }

  setDb(null);
  testDb = null;
});

describe("idempotency middleware principal scoping", () => {
  test("same idempotency key does not leak cached responses across API keys", async () => {
    const app = createTestApp();
    const ownerA = await createApiKey({ label: "owner-a", tier: "paid" });
    const ownerB = await createApiKey({ label: "owner-b", tier: "paid" });

    const ownerAFirst = await app.request("/agp/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ownerA.raw,
        "idempotency-key": "shared-key",
      },
      body: JSON.stringify({ amount: 100 }),
    });
    const ownerAFirstBody = await ownerAFirst.json();

    const ownerBFirst = await app.request("/agp/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ownerB.raw,
        "idempotency-key": "shared-key",
      },
      body: JSON.stringify({ amount: 100 }),
    });
    const ownerBFirstBody = await ownerBFirst.json();

    expect(ownerAFirst.status).toBe(200);
    expect(ownerBFirst.status).toBe(200);
    expect(ownerAFirstBody.principalId).toBe(ownerA.record.id);
    expect(ownerBFirstBody.principalId).toBe(ownerB.record.id);
    expect(ownerAFirstBody.executionCount).toBe(1);
    expect(ownerBFirstBody.executionCount).toBe(1);
    expect(ownerAFirstBody.nonce).not.toBe(ownerBFirstBody.nonce);
  });

  test("same API key and idempotency key returns cached response", async () => {
    const app = createTestApp();
    const owner = await createApiKey({ label: "owner", tier: "paid" });

    const first = await app.request("/agp/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": owner.raw,
        "idempotency-key": "same-key",
      },
      body: JSON.stringify({ amount: 250 }),
    });
    const firstBody = await first.json();

    const second = await app.request("/agp/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": owner.raw,
        "idempotency-key": "same-key",
      },
      body: JSON.stringify({ amount: 250 }),
    });
    const secondBody = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondBody).toEqual(firstBody);
    expect(secondBody.executionCount).toBe(1);
  });
});
