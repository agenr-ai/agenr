import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AdapterRegistry } from "../../src/core/adapter-registry";
import { AdapterExecutionTimeoutError, AgpService } from "../../src/core/agp-service";
import { createApiKey } from "../../src/db/api-keys";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { apiKeyAuthMiddleware, requireScope } from "../../src/middleware/auth";
import { requestIdMiddleware } from "../../src/middleware/request-id";
import { InteractionProfileStore } from "../../src/store/interaction-profile-store";
import { ProfileStore } from "../../src/store/profile-store";
import { TransactionStore } from "../../src/store/transaction-store";

let testDb: Client | null = null;
let tempRoot: string;
let originalApiKey: string | undefined;
let originalAdapterTimeoutMs: string | undefined;

function resolveCallerId(c: { get(name: "apiKeyId"): string | undefined; get(name: "userId"): string | undefined }): string {
  return c.get("userId") ?? c.get("apiKeyId") ?? "admin";
}

async function createService(queryDelayMs: number): Promise<AgpService> {
  const profilePath = path.join(tempRoot, `user-profile-${queryDelayMs}.json`);
  const interactionDir = path.join(tempRoot, `interaction-profiles-${queryDelayMs}`);
  await mkdir(interactionDir, { recursive: true });
  await writeFile(
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
  await writeFile(
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
      query: async () => {
        await new Promise((resolve) => setTimeout(resolve, queryDelayMs));
        return { ok: true, queryDelayMs };
      },
      execute: async () => ({ ok: true }),
    }),
    "/tmp/stripe-timeout.ts",
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
  app.use("*", requestIdMiddleware);
  app.use("/agp/*", apiKeyAuthMiddleware);

  app.post("/agp/query", requireScope("query"), async (c) => {
    try {
      const body = await c.req.json();
      const result = await service.query(body, resolveCallerId(c));
      return c.json(result);
    } catch (error) {
      if (error instanceof AdapterExecutionTimeoutError) {
        return c.json(
          {
            error: error.message,
            requestId: c.get("requestId") ?? "unknown",
          },
          504,
        );
      }
      throw error;
    }
  });

  return app;
}

beforeEach(async () => {
  originalApiKey = process.env.AGENR_API_KEY;
  delete process.env.AGENR_API_KEY;
  originalAdapterTimeoutMs = process.env.AGENR_ADAPTER_TIMEOUT_MS;
  process.env.AGENR_ADAPTER_TIMEOUT_MS = "20";

  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
  tempRoot = await mkdtemp(path.join(tmpdir(), "agenr-timeout-"));
});

afterEach(async () => {
  if (originalApiKey === undefined) {
    delete process.env.AGENR_API_KEY;
  } else {
    process.env.AGENR_API_KEY = originalApiKey;
  }

  if (originalAdapterTimeoutMs === undefined) {
    delete process.env.AGENR_ADAPTER_TIMEOUT_MS;
  } else {
    process.env.AGENR_ADAPTER_TIMEOUT_MS = originalAdapterTimeoutMs;
  }

  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("agp adapter timeout handling", () => {
  test("slow adapter query returns 504 with sanitized timeout payload", async () => {
    const app = createTestApp(await createService(80));
    const owner = await createApiKey({ label: "owner-timeout", tier: "paid" });

    const response = await app.request("/agp/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": owner.raw,
      },
      body: JSON.stringify({
        businessId: "biz-stripe",
        request: { ping: true },
      }),
    });

    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toBe("Adapter execution timed out");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  test("adapter call within timeout still succeeds", async () => {
    const app = createTestApp(await createService(1));
    const owner = await createApiKey({ label: "owner-fast", tier: "paid" });

    const response = await app.request("/agp/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": owner.raw,
      },
      body: JSON.stringify({
        businessId: "biz-stripe",
        request: { ping: true },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("succeeded");
    expect(body.data).toEqual({ ok: true, queryDelayMs: 1 });
  });
});
