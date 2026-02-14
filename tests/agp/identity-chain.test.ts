import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { AdapterRegistry } from "../../src/core/adapter-registry";
import { AgpService } from "../../src/core/agp-service";
import { createApiKey } from "../../src/db/api-keys";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { createSession } from "../../src/db/sessions";
import { upsertOAuthUser } from "../../src/db/users";
import { apiKeyAuthMiddleware, requireScope } from "../../src/middleware/auth";
import { credentialsApp } from "../../src/routes/credentials";
import { InteractionProfileStore } from "../../src/store/interaction-profile-store";
import { ProfileStore } from "../../src/store/profile-store";
import { TransactionStore } from "../../src/store/transaction-store";
import { storeCredential } from "../../src/vault/credential-store";

let testDb: Client | null = null;
let tempRoot: string;

type QueryBody = {
  transactionId: string;
  status: "succeeded";
  data: { injectedApiKey: string | null };
};

function resolveCallerId(c: { get(name: "apiKeyId"): string | undefined; get(name: "userId"): string | undefined }): string {
  return c.get("userId") ?? c.get("apiKeyId") ?? "admin";
}

async function createApiKeyEchoServer(): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const server = createServer((req, res) => {
    const header = req.headers["x-api-key"];
    const injectedApiKey = Array.isArray(header) ? (header[0] ?? null) : (header ?? null);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ injectedApiKey }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve local echo server address");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    stop: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}

async function createServiceWithAuthEchoAdapter(): Promise<{
  service: AgpService;
  stop: () => Promise<void>;
}> {
  const profilePath = path.join(tempRoot, "user-profile.json");
  const interactionDir = path.join(tempRoot, "interaction-profiles");
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

  const echoServer = await createApiKeyEchoServer();

  const registry = new AdapterRegistry();
  registry.registerPublic(
    "stripe",
    () => ({
      discover: async () => ({ ok: true }),
      query: async (_request, ctx) => {
        const response = await ctx.fetch(`${echoServer.url}inspect`);
        return response.json();
      },
      execute: async () => ({ ok: true }),
    }),
    "/tmp/stripe-identity-chain.ts",
    undefined,
    {
      platform: "stripe",
      auth: {
        type: "api_key",
        strategy: "api-key-header",
        headerName: "X-Api-Key",
      },
      authenticatedDomains: ["localhost", "127.0.0.1"],
      allowedDomains: [],
    },
  );

  return {
    service: new AgpService(
      new ProfileStore(profilePath),
      new InteractionProfileStore(interactionDir),
      new TransactionStore(),
      registry,
    ),
    stop: async () => {
      await echoServer.stop();
    },
  };
}

function createTestApp(service: AgpService): Hono {
  const app = new Hono();
  app.route("/credentials", credentialsApp);
  app.use("/agp/*", apiKeyAuthMiddleware);
  app.post("/agp/query", requireScope("query"), async (c) => {
    try {
      const body = await c.req.json();
      const result = await service.query(body, resolveCallerId(c));
      return c.json(result);
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  });

  return app;
}

function keyHeaders(rawKey: string): Record<string, string> {
  return { "x-api-key": rawKey };
}

function bearerHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function queryStripe(app: Hono, headers: Record<string, string>): Promise<Response> {
  return app.request("/agp/query", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      businessId: "biz-stripe",
      request: { ping: true },
    }),
  });
}

beforeEach(async () => {
  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
  tempRoot = await mkdtemp(path.join(tmpdir(), "agenr-identity-chain-"));
});

afterEach(async () => {
  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("AGP identity chain", () => {
  test("API key linked to user resolves credentials stored under user id", async () => {
    const harness = await createServiceWithAuthEchoAdapter();
    const app = createTestApp(harness.service);
    try {
      const user = await upsertOAuthUser({
        provider: "github",
        providerId: "identity-linked-user",
        email: "linked-user@example.com",
        name: "Linked User",
      });
      const key = await createApiKey({
        label: "linked-key",
        tier: "paid",
        userId: user.id,
      });
      await storeCredential(user.id, "stripe", "api_key", { api_key: "user-scope-secret" });

      const response = await queryStripe(app, keyHeaders(key.raw));
      expect(response.status).toBe(200);
      const body = (await response.json()) as QueryBody;
      expect(body.data.injectedApiKey).toBe("user-scope-secret");
    } finally {
      await harness.stop();
    }
  });

  test("API key without userId falls back to key id for credential lookup", async () => {
    const harness = await createServiceWithAuthEchoAdapter();
    const app = createTestApp(harness.service);
    try {
      const key = await createApiKey({
        label: "unlinked-key",
        tier: "paid",
      });
      await storeCredential(key.record.id, "stripe", "api_key", { api_key: "key-scope-secret" });

      const response = await queryStripe(app, keyHeaders(key.raw));
      expect(response.status).toBe(200);
      const body = (await response.json()) as QueryBody;
      expect(body.data.injectedApiKey).toBe("key-scope-secret");
    } finally {
      await harness.stop();
    }
  });

  test("session auth resolves credentials stored under the session user", async () => {
    const harness = await createServiceWithAuthEchoAdapter();
    const app = createTestApp(harness.service);
    try {
      const user = await upsertOAuthUser({
        provider: "google",
        providerId: "identity-session-user",
        email: "session-user@example.com",
        name: "Session User",
      });
      const session = await createSession(user.id);
      await storeCredential(user.id, "stripe", "api_key", { api_key: "session-secret" });

      const response = await queryStripe(app, bearerHeaders(session.token));
      expect(response.status).toBe(200);
      const body = (await response.json()) as QueryBody;
      expect(body.data.injectedApiKey).toBe("session-secret");
    } finally {
      await harness.stop();
    }
  });

  test("cross-user isolation blocks access to another user's credentials", async () => {
    const harness = await createServiceWithAuthEchoAdapter();
    const app = createTestApp(harness.service);
    try {
      const userA = await upsertOAuthUser({
        provider: "github",
        providerId: "identity-user-a",
        email: "user-a@example.com",
        name: "User A",
      });
      const userB = await upsertOAuthUser({
        provider: "google",
        providerId: "identity-user-b",
        email: "user-b@example.com",
        name: "User B",
      });
      const keyB = await createApiKey({
        label: "user-b-key",
        tier: "paid",
        userId: userB.id,
      });
      await storeCredential(userA.id, "stripe", "api_key", { api_key: "user-a-secret" });

      const response = await queryStripe(app, keyHeaders(keyB.raw));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "No credential available for stripe" });
    } finally {
      await harness.stop();
    }
  });

  test("credential stored via session auth is usable through linked API key AGP calls", async () => {
    const harness = await createServiceWithAuthEchoAdapter();
    const app = createTestApp(harness.service);
    try {
      const user = await upsertOAuthUser({
        provider: "github",
        providerId: "identity-session-store",
        email: "session-store@example.com",
        name: "Session Store User",
      });
      const session = await createSession(user.id);
      const key = await createApiKey({
        label: "session-linked-key",
        tier: "paid",
        userId: user.id,
      });

      const storeResponse = await app.request("/credentials/stripe", {
        method: "POST",
        headers: {
          ...bearerHeaders(session.token),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          auth_type: "api_key",
          api_key: "stored-via-session",
        }),
      });
      expect(storeResponse.status).toBe(200);

      const agpResponse = await queryStripe(app, keyHeaders(key.raw));
      expect(agpResponse.status).toBe(200);
      const body = (await agpResponse.json()) as QueryBody;
      expect(body.data.injectedApiKey).toBe("stored-via-session");
    } finally {
      await harness.stop();
    }
  });
});
