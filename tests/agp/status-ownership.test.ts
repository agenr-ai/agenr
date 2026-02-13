import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AdapterRegistry } from "../../src/core/adapter-registry";
import { AgpService } from "../../src/core/agp-service";
import { createApiKey } from "../../src/db/api-keys";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { apiKeyAuthMiddleware, requireScope } from "../../src/middleware/auth";
import { InteractionProfileStore } from "../../src/store/interaction-profile-store";
import { ProfileStore } from "../../src/store/profile-store";
import { TransactionStore } from "../../src/store/transaction-store";

let testDb: Client | null = null;
let tempRoot: string;
let originalApiKey: string | undefined;

function resolveCallerId(c: { get(name: "apiKeyId"): string | undefined; get(name: "userId"): string | undefined }): string {
  return c.get("userId") ?? c.get("apiKeyId") ?? "admin";
}

async function createService(): Promise<AgpService> {
  const profilePath = path.join(tempRoot, "user-profile.json");
  const interactionDir = path.join(tempRoot, "interaction-profiles");
  await mkdir(interactionDir, { recursive: true });
  await Bun.write(
    profilePath,
    JSON.stringify(
      {
        user: "test-user",
        businesses: [
          {
            id: "biz-stripe",
            name: "Stripe Biz",
            platform: "stripe",
            preferences: {},
          },
        ],
      },
      null,
      2,
    ),
  );
  await Bun.write(
    path.join(interactionDir, "stripe.json"),
    JSON.stringify(
      {
        platform: "stripe",
        version: "1.0",
        generated: "2026-01-01",
        method: "manual",
        capabilities: {
          query: {
            operation: "query",
            method: "POST",
            endpoint: "/query",
            authRequired: true,
            description: "query",
          },
        },
      },
      null,
      2,
    ),
  );

  const registry = new AdapterRegistry();
  registry.registerPublic(
    "stripe",
    () => ({
      discover: async () => ({ ok: true }),
      query: async () => ({ ok: true }),
      execute: async () => ({ ok: true }),
    }),
    "/tmp/stripe-public.ts",
  );

  return new AgpService(
    new ProfileStore(profilePath),
    new InteractionProfileStore(interactionDir),
    new TransactionStore(),
    registry,
  );
}

function createTestApp(service: AgpService): Hono {
  const app = new Hono();
  app.use("/agp/*", apiKeyAuthMiddleware);

  app.post("/agp/query", requireScope("query"), async (c) => {
    const body = await c.req.json();
    const response = await service.query(body, resolveCallerId(c));
    return c.json(response);
  });

  app.get("/agp/status/:id", async (c) => {
    const transaction = await service.status(c.req.param("id"), resolveCallerId(c));
    if (!transaction) {
      return c.json({ error: "Transaction not found" }, 404);
    }
    return c.json(transaction);
  });

  return app;
}

beforeEach(async () => {
  originalApiKey = process.env.AGENR_API_KEY;
  delete process.env.AGENR_API_KEY;

  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
  tempRoot = await mkdtemp(path.join(tmpdir(), "agenr-status-owner-"));
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
  await rm(tempRoot, { recursive: true, force: true });
});

describe("agp status ownership", () => {
  test("caller can only read their own transaction status", async () => {
    const app = createTestApp(await createService());
    const ownerA = await createApiKey({ label: "owner-a", tier: "paid" });
    const ownerB = await createApiKey({ label: "owner-b", tier: "paid" });

    const queryResponse = await app.request("/agp/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ownerA.raw,
      },
      body: JSON.stringify({
        businessId: "biz-stripe",
        request: { ping: true },
      }),
    });
    expect(queryResponse.status).toBe(200);
    const queryBody = await queryResponse.json();
    const transactionId = queryBody.transactionId as string;

    const forbiddenStatus = await app.request(`/agp/status/${transactionId}`, {
      headers: { "x-api-key": ownerB.raw },
    });
    expect(forbiddenStatus.status).toBe(404);
    expect(await forbiddenStatus.json()).toEqual({ error: "Transaction not found" });

    const ownerStatus = await app.request(`/agp/status/${transactionId}`, {
      headers: { "x-api-key": ownerA.raw },
    });
    expect(ownerStatus.status).toBe(200);
    const ownerBody = await ownerStatus.json();
    expect(ownerBody.id).toBe(transactionId);
    expect(ownerBody.status).toBe("succeeded");
  });
});
