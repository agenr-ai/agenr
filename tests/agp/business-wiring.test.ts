import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { Hono, type Context } from "hono";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { AdapterRegistry } from "../../src/core/adapter-registry";
import { AgpService } from "../../src/core/agp-service";
import { createApiKey } from "../../src/db/api-keys";
import {
  createBusiness,
  listAllBusinesses,
} from "../../src/db/businesses";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { apiKeyAuthMiddleware, requireScope } from "../../src/middleware/auth";
import { createBusinessRoutes } from "../../src/routes/businesses";
import { InteractionProfileStore } from "../../src/store/interaction-profile-store";
import { ProfileStore } from "../../src/store/profile-store";
import { TransactionStore } from "../../src/store/transaction-store";
import { storeAppCredential } from "../../src/vault/app-credential-store";
import { storeCredential } from "../../src/vault/credential-store";

let testDb: Client | null = null;
let tempRoot: string;

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

function keyHeaders(rawKey: string): Record<string, string> {
  return { "x-api-key": rawKey };
}

function toAgpErrorResponse(c: Context, error: unknown): Response {
  if (
    error instanceof Error &&
    (error.message.startsWith("Unknown business '") ||
      error.message.startsWith("No adapter registered for platform '"))
  ) {
    return c.json({ error: error.message }, 400);
  }

  if (error instanceof Error) {
    return c.json({ error: error.message }, 500);
  }

  return c.json({ error: "Unknown error" }, 500);
}

function createTestApp(service: AgpService, registry: AdapterRegistry): Hono {
  const app = new Hono();

  app.get("/agp/businesses", async (c) => {
    const categoryQuery = c.req.query("category")?.trim().toLowerCase();
    const platformQuery = c.req.query("platform")?.trim().toLowerCase();
    const searchQuery = c.req.query("q")?.trim().toLowerCase();

    const businesses = (await listAllBusinesses())
      .filter((business) => business.status === "active")
      .filter((business) => {
        if (categoryQuery && business.category?.toLowerCase() !== categoryQuery) {
          return false;
        }

        if (platformQuery && business.platform.toLowerCase() !== platformQuery) {
          return false;
        }

        if (searchQuery && !business.name.toLowerCase().includes(searchQuery)) {
          return false;
        }

        return true;
      })
      .map((business) => ({
        id: business.id,
        name: business.name,
        platform: business.platform,
        location: business.location,
        category: business.category,
        description: business.description,
      }));

    return c.json({ businesses });
  });

  app.use("/agp/discover", apiKeyAuthMiddleware);
  app.use("/agp/query", apiKeyAuthMiddleware);
  app.use("/agp/execute", apiKeyAuthMiddleware);

  app.post("/agp/discover", requireScope("discover"), async (c) => {
    try {
      const body = (await c.req.json()) as { businessId: string };
      const result = await service.discover(
        { businessId: body.businessId },
        c.get("userId") ?? c.get("apiKeyId") ?? "admin",
      );
      return c.json(result);
    } catch (error) {
      return toAgpErrorResponse(c, error);
    }
  });

  app.post("/agp/query", requireScope("query"), async (c) => {
    try {
      const body = (await c.req.json()) as { businessId: string; request: Record<string, unknown> };
      const result = await service.query(
        { businessId: body.businessId, request: body.request },
        c.get("userId") ?? c.get("apiKeyId") ?? "admin",
      );
      return c.json(result);
    } catch (error) {
      return toAgpErrorResponse(c, error);
    }
  });

  app.post("/agp/execute", requireScope("execute"), async (c) => {
    try {
      const body = (await c.req.json()) as { businessId: string; request: Record<string, unknown> };
      const result = await service.execute(
        { businessId: body.businessId, request: body.request },
        c.get("userId") ?? c.get("apiKeyId") ?? "admin",
      );
      return c.json(result);
    } catch (error) {
      return toAgpErrorResponse(c, error);
    }
  });

  app.route("/businesses", createBusinessRoutes(registry));
  return app;
}

async function createService(
  registry: AdapterRegistry,
  profileBusinesses: Array<{
    id: string;
    name: string;
    platform: string;
    location?: string;
    preferences?: Record<string, unknown>;
  }> = [],
): Promise<AgpService> {
  const profilePath = path.join(tempRoot, `user-profile-${crypto.randomUUID()}.json`);
  const interactionDir = path.join(tempRoot, `interaction-profiles-${crypto.randomUUID()}`);
  await mkdir(interactionDir, { recursive: true });
  await writeFile(
    profilePath,
    JSON.stringify(
      {
        user: "test-user",
        businesses: profileBusinesses,
      },
      null,
      2,
    ),
  );

  return new AgpService(
    new ProfileStore(profilePath),
    new InteractionProfileStore(interactionDir),
    new TransactionStore(),
    registry,
  );
}

function registerPublicStripeAdapter(registry: AdapterRegistry): void {
  registry.registerPublic(
    "stripe",
    () => ({
      discover: async () => ({ ok: true }),
      query: async () => ({ op: "query" }),
      execute: async () => ({ op: "execute" }),
    }),
    "/tmp/stripe-public-scene3.ts",
    { name: "Stripe" },
    {
      platform: "stripe",
      auth: {
        type: "oauth2",
        strategy: "bearer",
        scopes: ["read_write"],
        oauth: {
          authorizationUrl: "https://connect.stripe.com/oauth/authorize",
          tokenUrl: "https://connect.stripe.com/oauth/token",
          tokenContentType: "form",
        },
      },
      authenticatedDomains: ["connect.stripe.com"],
      allowedDomains: [],
    },
  );
}

beforeEach(async () => {
  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
  tempRoot = await mkdtemp(path.join(tmpdir(), "agenr-scene3-wiring-"));
});

afterEach(async () => {
  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("AGP business wiring", () => {
  test("AGP discover resolves business from DB before profile fallback", async () => {
    const registry = new AdapterRegistry();
    registerPublicStripeAdapter(registry);
    const service = await createService(registry, [
      {
        id: "joes-pizza",
        name: "Profile Name",
        platform: "stripe",
      },
    ]);

    await createBusiness({
      id: "joes-pizza",
      ownerId: "owner-joe",
      name: "DB Name",
      platform: "stripe",
      location: "Dallas, TX",
      category: "restaurant",
    });

    const result = await service.discover({ businessId: "joes-pizza" }, "agent-1");
    expect(result.data.business.name).toBe("DB Name");
    expect(result.data.business.location).toBe("Dallas, TX");
  });

  test("AGP discover returns 400 for unknown businessId", async () => {
    const registry = new AdapterRegistry();
    registerPublicStripeAdapter(registry);
    const service = await createService(registry);
    const app = createTestApp(service, registry);
    const key = await createApiKey({ label: "scene3-unknown-business", tier: "paid" });

    const response = await app.request("/agp/discover", {
      method: "POST",
      headers: {
        ...keyHeaders(key.raw),
        "content-type": "application/json",
      },
      body: JSON.stringify({ businessId: "missing-business" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Unknown business 'missing-business'",
    });
  });

  test("AGP query and execute route through DB business", async () => {
    const registry = new AdapterRegistry();
    registerPublicStripeAdapter(registry);
    const service = await createService(registry);
    const app = createTestApp(service, registry);
    const key = await createApiKey({ label: "scene3-route-db", tier: "paid" });

    await createBusiness({
      id: "route-db-biz",
      ownerId: "owner-route-db",
      name: "Route Through DB",
      platform: "stripe",
      status: "active",
    });

    const queryResponse = await app.request("/agp/query", {
      method: "POST",
      headers: {
        ...keyHeaders(key.raw),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        businessId: "route-db-biz",
        request: { ping: true },
      }),
    });
    expect(queryResponse.status).toBe(200);
    const queryBody = await queryResponse.json();
    expect(queryBody.data).toEqual({ op: "query" });

    const executeResponse = await app.request("/agp/execute", {
      method: "POST",
      headers: {
        ...keyHeaders(key.raw),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        businessId: "route-db-biz",
        request: { amount: 100 },
      }),
    });
    expect(executeResponse.status).toBe(200);
    const executeBody = await executeResponse.json();
    expect(executeBody.data).toEqual({ op: "execute" });
  });

  test("credential resolution uses business ownerId instead of callerId", async () => {
    const registry = new AdapterRegistry();
    const echoServer = await createApiKeyEchoServer();

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
      "/tmp/stripe-credential-owner.ts",
      { name: "Stripe" },
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

    try {
      const service = await createService(registry);
      await createBusiness({
        id: "owner-routing-biz",
        ownerId: "joe-owner",
        name: "Owner Routing Biz",
        platform: "stripe",
      });

      await storeCredential("joe-owner", "stripe", "api_key", { api_key: "owner-secret" });
      await storeCredential("agent-caller", "stripe", "api_key", { api_key: "caller-secret" });

      const result = await service.query(
        {
          businessId: "owner-routing-biz",
          request: { ping: true },
        },
        "agent-caller",
      );

      expect(result.data).toEqual({ injectedApiKey: "owner-secret" });
    } finally {
      await echoServer.stop();
    }
  });

  test("GET /agp/businesses returns active businesses only", async () => {
    const registry = new AdapterRegistry();
    registerPublicStripeAdapter(registry);
    const service = await createService(registry);
    const app = createTestApp(service, registry);

    await createBusiness({
      id: "active-one",
      ownerId: "owner-a",
      name: "Active One",
      platform: "stripe",
      category: "restaurant",
      status: "active",
    });
    await createBusiness({
      id: "suspended-one",
      ownerId: "owner-b",
      name: "Suspended One",
      platform: "stripe",
      category: "restaurant",
      status: "suspended",
    });
    await createBusiness({
      id: "deleted-one",
      ownerId: "owner-c",
      name: "Deleted One",
      platform: "stripe",
      category: "restaurant",
      status: "deleted",
    });

    const response = await app.request("/agp/businesses");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.businesses).toEqual([
      {
        id: "active-one",
        name: "Active One",
        platform: "stripe",
        location: null,
        category: "restaurant",
        description: null,
      },
    ]);
  });

  test("GET /agp/businesses filters by category and platform", async () => {
    const registry = new AdapterRegistry();
    registerPublicStripeAdapter(registry);
    const service = await createService(registry);
    const app = createTestApp(service, registry);

    await createBusiness({
      id: "resto-stripe",
      ownerId: "owner-a",
      name: "Resto Stripe",
      platform: "stripe",
      category: "restaurant",
      status: "active",
    });
    await createBusiness({
      id: "retail-stripe",
      ownerId: "owner-b",
      name: "Retail Stripe",
      platform: "stripe",
      category: "retail",
      status: "active",
    });
    await createBusiness({
      id: "resto-square",
      ownerId: "owner-c",
      name: "Resto Square",
      platform: "square",
      category: "restaurant",
      status: "active",
    });

    const response = await app.request("/agp/businesses?category=restaurant&platform=stripe");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.businesses).toHaveLength(1);
    expect(body.businesses[0].id).toBe("resto-stripe");
  });

  test("GET /agp/businesses excludes deleted and suspended businesses", async () => {
    const registry = new AdapterRegistry();
    registerPublicStripeAdapter(registry);
    const service = await createService(registry);
    const app = createTestApp(service, registry);

    await createBusiness({
      id: "directory-active",
      ownerId: "owner-a",
      name: "Directory Active",
      platform: "stripe",
      status: "active",
    });
    await createBusiness({
      id: "directory-suspended",
      ownerId: "owner-b",
      name: "Directory Suspended",
      platform: "stripe",
      status: "suspended",
    });
    await createBusiness({
      id: "directory-deleted",
      ownerId: "owner-c",
      name: "Directory Deleted",
      platform: "stripe",
      status: "deleted",
    });

    const response = await app.request("/agp/businesses");
    expect(response.status).toBe(200);
    const body = await response.json();
    const ids = body.businesses.map((entry: { id: string }) => entry.id);
    expect(ids).toEqual(["directory-active"]);
  });

  test("business connect endpoint requires ownership", async () => {
    const registry = new AdapterRegistry();
    registerPublicStripeAdapter(registry);
    await storeAppCredential("stripe", {
      clientId: "ca_test_123",
      clientSecret: "sk_test_123",
    });
    const service = await createService(registry);
    const app = createTestApp(service, registry);

    const owner = await createApiKey({ label: "scene3-owner", tier: "paid" });
    const other = await createApiKey({ label: "scene3-other", tier: "paid" });

    await createBusiness({
      id: "owned-business",
      ownerId: owner.record.id,
      name: "Owned Business",
      platform: "stripe",
      status: "active",
    });

    const response = await app.request("/businesses/owned-business/connect/stripe", {
      method: "POST",
      headers: keyHeaders(other.raw),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
  });

  test("business connection status endpoint reports connected state", async () => {
    const registry = new AdapterRegistry();
    registerPublicStripeAdapter(registry);
    const service = await createService(registry);
    const app = createTestApp(service, registry);

    const owner = await createApiKey({ label: "scene3-status-owner", tier: "paid" });
    await createBusiness({
      id: "status-business",
      ownerId: owner.record.id,
      name: "Status Business",
      platform: "stripe",
      status: "active",
    });

    const before = await app.request("/businesses/status-business/connection-status", {
      headers: keyHeaders(owner.raw),
    });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({
      connected: false,
      service: "stripe",
      availableServices: ["stripe"],
    });

    await storeCredential(owner.record.id, "stripe", "oauth2", {
      access_token: "oauth-connected",
      token_type: "bearer",
      expires_in: 3600,
    });

    const after = await app.request("/businesses/status-business/connection-status", {
      headers: keyHeaders(owner.raw),
    });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({
      connected: true,
      service: "stripe",
      availableServices: ["stripe"],
    });
  });
});
