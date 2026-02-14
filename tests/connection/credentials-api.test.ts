import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { createApiKey } from "../../src/db/api-keys";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { upsertOAuthUser } from "../../src/db/users";
import { credentialsApp } from "../../src/routes/credentials";
import { hasCredential, retrieveCredential, storeCredential } from "../../src/vault/credential-store";

let testDb: Client | null = null;

function createTestApp(): Hono {
  const app = new Hono();
  app.route("/credentials", credentialsApp);
  return app;
}

function keyHeaders(rawKey: string): Record<string, string> {
  return { "x-api-key": rawKey };
}

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

describe("credentials api routes", () => {
  test("POST /credentials/:service rejects invalid service identifiers", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "invalid-service-owner", tier: "paid" });
    const invalidServices = ["svc!", "a".repeat(65), "%20%20"];

    for (const invalidService of invalidServices) {
      const response = await app.request(`/credentials/${invalidService}`, {
        method: "POST",
        headers: {
          ...keyHeaders(key.raw),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          auth_type: "api_key",
          api_key: "secret",
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid service identifier" });
    }
  });

  test("DELETE /credentials/:service rejects invalid service identifiers", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "invalid-delete-owner", tier: "paid" });
    const invalidServices = ["stripe$prod", "a".repeat(65), "%20%20"];

    for (const invalidService of invalidServices) {
      const response = await app.request(`/credentials/${invalidService}`, {
        method: "DELETE",
        headers: keyHeaders(key.raw),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid service identifier" });
    }
  });

  test("POST /credentials/:service accepts valid normalized identifiers", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "normalized-service-owner", tier: "paid" });
    const validServices = [
      { path: "stripe", normalized: "stripe" },
      { path: "%20My-Service%20", normalized: "my-service" },
      { path: "TOAST_POS", normalized: "toast_pos" },
    ] as const;

    for (const entry of validServices) {
      const response = await app.request(`/credentials/${entry.path}`, {
        method: "POST",
        headers: {
          ...keyHeaders(key.raw),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          auth_type: "api_key",
          api_key: `${entry.normalized}-secret`,
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "connected",
        service: entry.normalized,
      });
      expect(await hasCredential(key.record.id, entry.normalized)).toBe(true);
    }
  });

  test("POST /credentials/:service supports api_key auth type", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "api-key-owner", tier: "paid" });

    const response = await app.request("/credentials/toast", {
      method: "POST",
      headers: {
        ...keyHeaders(key.raw),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        auth_type: "api_key",
        api_key: "toast-secret",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "connected",
      service: "toast",
    });

    const credential = await retrieveCredential(key.record.id, "toast");
    expect(credential.api_key).toBe("toast-secret");
  });

  test("POST /credentials/:service stores credential under linked user id for API keys", async () => {
    const app = createTestApp();
    const user = await upsertOAuthUser({
      provider: "github",
      providerId: "credentials-linked-user",
      email: "credentials-linked-user@example.com",
      name: "Credentials Linked User",
    });
    const key = await createApiKey({
      label: "linked-user-key",
      tier: "paid",
      userId: user.id,
    });

    const response = await app.request("/credentials/stripe", {
      method: "POST",
      headers: {
        ...keyHeaders(key.raw),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        auth_type: "api_key",
        api_key: "linked-user-secret",
      }),
    });

    expect(response.status).toBe(200);
    expect(await hasCredential(user.id, "stripe")).toBe(true);
    expect(await hasCredential(key.record.id, "stripe")).toBe(false);

    const credential = await retrieveCredential(user.id, "stripe");
    expect(credential.api_key).toBe("linked-user-secret");
  });

  test("POST /credentials/:service supports client_credentials auth type", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "client-credentials-owner", tier: "paid" });

    const response = await app.request("/credentials/toast", {
      method: "POST",
      headers: {
        ...keyHeaders(key.raw),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        auth_type: "client_credentials",
        client_id: "toast-client-id",
        client_secret: "toast-client-secret",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "connected",
      service: "toast",
    });

    const credential = await retrieveCredential(key.record.id, "toast");
    expect(credential.client_id).toBe("toast-client-id");
    expect(credential.client_secret).toBe("toast-client-secret");
  });

  test("POST /credentials/:service supports cookie auth type", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "cookie-owner", tier: "paid" });

    const response = await app.request("/credentials/vendor-cookie", {
      method: "POST",
      headers: {
        ...keyHeaders(key.raw),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        auth_type: "cookie",
        cookie_name: "session",
        cookie_value: "cookie-123",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "connected",
      service: "vendor-cookie",
    });

    const credential = await retrieveCredential(key.record.id, "vendor-cookie");
    expect(credential.cookie_name).toBe("session");
    expect(credential.cookie_value).toBe("cookie-123");
  });

  test("GET /credentials returns connection list without secrets", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "list-owner", tier: "paid" });
    await storeCredential(key.record.id, "toast", "api_key", { api_key: "should-not-leak" });
    await storeCredential(key.record.id, "stripe", "oauth2", { access_token: "token", expires_in: -60 });

    const response = await app.request("/credentials", {
      headers: keyHeaders(key.raw),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    const toast = body.find((entry) => entry.service === "toast");
    const stripe = body.find((entry) => entry.service === "stripe");
    expect(toast).toBeTruthy();
    expect(stripe).toBeTruthy();
    expect(toast?.auth_type).toBe("api_key");
    expect(stripe?.auth_type).toBe("oauth2");
    expect(toast?.status).toBe("connected");
    expect(stripe?.status).toBe("expired");
    expect(toast?.api_key).toBeUndefined();
    expect(toast?.encrypted_payload).toBeUndefined();
    expect(stripe?.access_token).toBeUndefined();
  });

  test("DELETE /credentials/:service removes credential", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "delete-owner", tier: "paid" });
    await storeCredential(key.record.id, "stripe", "oauth2", { access_token: "to-delete" });

    const response = await app.request("/credentials/stripe", {
      method: "DELETE",
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "disconnected",
      service: "stripe",
    });
    expect(await hasCredential(key.record.id, "stripe")).toBe(false);
  });

  test("DELETE /credentials/:service returns 404 when credential missing", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "missing-owner", tier: "paid" });

    const response = await app.request("/credentials/missing-service", {
      method: "DELETE",
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Credential not found" });
  });
});
