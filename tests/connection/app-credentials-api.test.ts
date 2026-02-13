import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { createApiKey } from "../../src/db/api-keys";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { apiKeyAuthMiddleware } from "../../src/middleware/auth";
import { appCredentialsApp } from "../../src/routes/app-credentials";

const ORIGINAL_ADMIN_API_KEY = process.env.AGENR_API_KEY;
const TEST_ADMIN_API_KEY = "admin-secret";

let testDb: Client | null = null;

function createTestApp(): Hono {
  const app = new Hono();
  app.use("/app-credentials/*", apiKeyAuthMiddleware);
  app.route("/app-credentials", appCredentialsApp);
  return app;
}

function keyHeaders(rawKey: string): Record<string, string> {
  return { "x-api-key": rawKey };
}

beforeEach(async () => {
  process.env.AGENR_API_KEY = TEST_ADMIN_API_KEY;
  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
});

afterEach(async () => {
  if (ORIGINAL_ADMIN_API_KEY === undefined) {
    delete process.env.AGENR_API_KEY;
  } else {
    process.env.AGENR_API_KEY = ORIGINAL_ADMIN_API_KEY;
  }

  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;
});

describe("app credentials api routes", () => {
  test("POST and DELETE reject invalid service identifiers", async () => {
    const app = createTestApp();
    const invalidServices = ["stripe$prod", "a".repeat(65), "%20%20"];

    for (const invalidService of invalidServices) {
      const postResponse = await app.request(`/app-credentials/${invalidService}`, {
        method: "POST",
        headers: {
          ...keyHeaders(TEST_ADMIN_API_KEY),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_id: "ca_test_123",
          client_secret: "sk_test_123",
        }),
      });
      expect(postResponse.status).toBe(400);
      expect(await postResponse.json()).toEqual({ error: "Invalid service identifier" });

      const deleteResponse = await app.request(`/app-credentials/${invalidService}`, {
        method: "DELETE",
        headers: keyHeaders(TEST_ADMIN_API_KEY),
      });
      expect(deleteResponse.status).toBe(400);
      expect(await deleteResponse.json()).toEqual({ error: "Invalid service identifier" });
    }
  });

  test("POST accepts valid normalized service identifiers", async () => {
    const app = createTestApp();
    const validServices = [
      { path: "stripe", normalized: "stripe" },
      { path: "%20My-Service%20", normalized: "my-service" },
      { path: "TOAST_POS", normalized: "toast_pos" },
    ] as const;

    for (const entry of validServices) {
      const response = await app.request(`/app-credentials/${entry.path}`, {
        method: "POST",
        headers: {
          ...keyHeaders(TEST_ADMIN_API_KEY),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_id: `client-${entry.normalized}`,
          client_secret: `secret-${entry.normalized}`,
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "configured",
        service: entry.normalized,
      });
    }
  });

  test("POST, GET, and DELETE manage app oauth credentials", async () => {
    const app = createTestApp();

    const postResponse = await app.request("/app-credentials/stripe", {
      method: "POST",
      headers: {
        ...keyHeaders(TEST_ADMIN_API_KEY),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: "ca_test_123",
        client_secret: "sk_test_123",
      }),
    });
    expect(postResponse.status).toBe(200);
    expect(await postResponse.json()).toEqual({
      status: "configured",
      service: "stripe",
    });

    const listResponse = await app.request("/app-credentials", {
      headers: keyHeaders(TEST_ADMIN_API_KEY),
    });
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as Array<Record<string, unknown>>;
    expect(listBody).toHaveLength(1);
    expect(listBody[0]?.service).toBe("stripe");
    expect(typeof listBody[0]?.created_at).toBe("string");
    expect(typeof listBody[0]?.updated_at).toBe("string");
    expect(listBody[0]?.client_id).toBeUndefined();
    expect(listBody[0]?.client_secret).toBeUndefined();

    const deleteResponse = await app.request("/app-credentials/stripe", {
      method: "DELETE",
      headers: keyHeaders(TEST_ADMIN_API_KEY),
    });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({
      status: "removed",
      service: "stripe",
    });

    const listAfterDeleteResponse = await app.request("/app-credentials", {
      headers: keyHeaders(TEST_ADMIN_API_KEY),
    });
    expect(listAfterDeleteResponse.status).toBe(200);
    expect(await listAfterDeleteResponse.json()).toEqual([]);
  });

  test("non-admin key is rejected", async () => {
    const app = createTestApp();
    const paidKey = await createApiKey({ label: "paid-user", tier: "paid" });

    const response = await app.request("/app-credentials/stripe", {
      method: "POST",
      headers: {
        ...keyHeaders(paidKey.raw),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: "ca_test_123",
        client_secret: "sk_test_123",
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Forbidden",
      message: "Missing required scope: admin",
    });
  });
});
