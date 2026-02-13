import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient, type Client } from "@libsql/client";

import type { AdapterContext } from "../../src/adapters/context";
import { AdapterRegistry } from "../../src/core/adapter-registry";
import { AgpService } from "../../src/core/agp-service";
import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { InteractionProfileStore } from "../../src/store/interaction-profile-store";
import { ProfileStore } from "../../src/store/profile-store";
import { TransactionStore } from "../../src/store/transaction-store";
import { storeCredential } from "../../src/vault/credential-store";

let testDb: Client | null = null;
let tempRoot: string;

beforeEach(async () => {
  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
  tempRoot = await mkdtemp(path.join(tmpdir(), "agenr-agp-service-"));
});

afterEach(async () => {
  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;
  await rm(tempRoot, { recursive: true, force: true });
});

async function createServiceWithRegistry(registry: AdapterRegistry): Promise<AgpService> {
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
          discover: {
            operation: "discover",
            method: "GET",
            endpoint: "/discover",
            authRequired: true,
            description: "discover",
          },
          query: {
            operation: "query",
            method: "POST",
            endpoint: "/query",
            authRequired: true,
            description: "query",
          },
          execute: {
            operation: "execute",
            method: "POST",
            endpoint: "/execute",
            authRequired: true,
            description: "execute",
          },
        },
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CapturedContexts {
  constructed: AdapterContext[];
  discover: AdapterContext[];
  query: AdapterContext[];
  execute: AdapterContext[];
}

function createFactory(tag: string, captured?: CapturedContexts) {
  return (_business: { platform: string }, ctx: AdapterContext) => {
    captured?.constructed.push(ctx);

    return {
      discover: async (callCtx: AdapterContext) => {
        captured?.discover.push(callCtx);
        return { tag, op: "discover" };
      },
      query: async (_request: Record<string, unknown>, callCtx: AdapterContext) => {
        captured?.query.push(callCtx);
        return { tag, op: "query" };
      },
      execute: async (
        _request: Record<string, unknown>,
        _options: { idempotencyKey?: string } | undefined,
        callCtx: AdapterContext,
      ) => {
        captured?.execute.push(callCtx);
        return { tag, op: "execute" };
      },
    };
  };
}

describe("AgpService owner-aware adapter resolution", () => {
  test("query prefers caller sandbox adapter and falls back to public adapter", async () => {
    const registry = new AdapterRegistry();
    registry.registerPublic("stripe", createFactory("public"), "/tmp/public.ts");
    registry.registerScoped("stripe", "owner-1", createFactory("sandbox"), "/tmp/sandbox.ts");
    const service = await createServiceWithRegistry(registry);

    const sandboxResult = await service.query(
      {
        businessId: "biz-stripe",
        request: { test: true },
      },
      "owner-1",
    );

    const publicResult = await service.query(
      {
        businessId: "biz-stripe",
        request: { test: true },
      },
      "owner-2",
    );

    expect(sandboxResult.data).toEqual({ tag: "sandbox", op: "query" });
    expect(publicResult.data).toEqual({ tag: "public", op: "query" });
  });

  test("execute uses public adapter when caller id is undefined", async () => {
    const registry = new AdapterRegistry();
    registry.registerPublic("stripe", createFactory("public"), "/tmp/public.ts");
    registry.registerScoped("stripe", "owner-1", createFactory("sandbox"), "/tmp/sandbox.ts");
    const service = await createServiceWithRegistry(registry);

    const result = await service.execute(
      {
        businessId: "biz-stripe",
        request: { amount: 100 },
      },
      undefined,
    );

    expect(result.data).toEqual({ tag: "public", op: "execute" });
  });

  test("constructs AdapterContext per operation and passes it to adapter methods", async () => {
    const registry = new AdapterRegistry();
    const captured: CapturedContexts = {
      constructed: [],
      discover: [],
      query: [],
      execute: [],
    };

    registry.registerPublic("stripe", createFactory("public", captured), "/tmp/public.ts");
    const service = await createServiceWithRegistry(registry);

    await service.discover({ businessId: "biz-stripe" }, "owner-ctx");
    await service.query({ businessId: "biz-stripe", request: { test: true } }, "owner-ctx");
    await service.execute({ businessId: "biz-stripe", request: { amount: 100 } }, "owner-ctx");

    expect(captured.constructed).toHaveLength(3);
    expect(captured.discover).toHaveLength(1);
    expect(captured.query).toHaveLength(1);
    expect(captured.execute).toHaveLength(1);

    expect(captured.discover[0]).toBe(captured.constructed[0]);
    expect(captured.query[0]).toBe(captured.constructed[1]);
    expect(captured.execute[0]).toBe(captured.constructed[2]);

    for (const ctx of captured.constructed) {
      expect(ctx.platform).toBe("stripe");
      expect(ctx.userId).toBe("owner-ctx");
      expect(ctx.executionId).toMatch(UUID_PATTERN);
    }
  });
});

describe("AgpService credential vault integration", () => {
  test("ctx.resolveCredential retrieves vault credential and logs retrieval", async () => {
    const registry = new AdapterRegistry();
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return Response.json({
          authorization: req.headers.get("Authorization"),
        });
      },
    });

    try {
      registry.registerScoped(
        "stripe",
        "owner-cred",
        (_business, _ctx) => ({
          discover: async () => ({ ok: true }),
          query: async (_request, callCtx) => {
            const response = await callCtx.fetch(`${server.url}check`);
            return response.json();
          },
          execute: async () => ({ ok: true }),
        }),
        "/tmp/secure-adapter.ts",
        undefined,
        {
          platform: "stripe",
          auth: {
            type: "oauth2",
            strategy: "bearer",
          },
          authenticatedDomains: ["localhost"],
          allowedDomains: [],
        },
      );

      await storeCredential("owner-cred", "stripe", "oauth2", {
        access_token: "vault-token-123",
      });

      const service = await createServiceWithRegistry(registry);
      const result = await service.query(
        {
          businessId: "biz-stripe",
          request: { ping: true },
        },
        "owner-cred",
      );

      expect(result.data).toEqual({ authorization: "Bearer vault-token-123" });

      const credentialsResult = await getDb().execute({
        sql: `SELECT last_used_at
          FROM credentials
          WHERE user_id = ? AND service_id = ?`,
        args: ["owner-cred", "stripe"],
      });
      const credentialRow = credentialsResult.rows[0] as Record<string, unknown> | undefined;
      expect(typeof credentialRow?.["last_used_at"]).toBe("string");

      const auditResult = await getDb().execute({
        sql: `SELECT action, execution_id
          FROM credential_audit_log
          WHERE user_id = ? AND service_id = ?
          ORDER BY timestamp DESC
          LIMIT 1`,
        args: ["owner-cred", "stripe"],
      });
      const auditRow = auditResult.rows[0] as Record<string, unknown> | undefined;
      expect(auditRow?.["action"]).toBe("credential_retrieved");
      expect(typeof auditRow?.["execution_id"]).toBe("string");
    } finally {
      await server.stop(true);
    }
  });

  test("missing vault credential yields clear auth error when manifest requires auth", async () => {
    const registry = new AdapterRegistry();
    const service = await createServiceWithRegistry(registry);

    registry.registerPublic(
      "stripe",
      (_business, _ctx) => ({
        discover: async () => ({ ok: true }),
        query: async (_request, callCtx) => {
          await callCtx.fetch("http://localhost:12345/will-not-run");
          return { ok: true };
        },
        execute: async () => ({ ok: true }),
      }),
      "/tmp/auth-required.ts",
      undefined,
      {
        platform: "stripe",
        auth: {
          type: "oauth2",
          strategy: "bearer",
        },
        authenticatedDomains: ["localhost"],
        allowedDomains: [],
      },
    );

    await expect(
      service.query({ businessId: "biz-stripe", request: {} }, "owner-without-credential"),
    ).rejects.toThrow("No credential available for stripe");
  });
});

describe("AgpService dynamic adapter fallback (no static profile)", () => {
  async function createServiceWithEmptyProfile(registry: AdapterRegistry): Promise<AgpService> {
    const profilePath = path.join(tempRoot, "empty-profile.json");
    const interactionDir = path.join(tempRoot, "interaction-profiles-empty");
    await mkdir(interactionDir, { recursive: true });
    await Bun.write(
      profilePath,
      JSON.stringify({ user: "test-user", businesses: [] }, null, 2),
    );
    return new AgpService(
      new ProfileStore(profilePath),
      new InteractionProfileStore(interactionDir),
      new TransactionStore(),
      registry,
    );
  }

  test("discover resolves sandbox adapter when no static profile exists", async () => {
    const registry = new AdapterRegistry();
    registry.registerScoped("jsonplaceholder", "key-123", createFactory("sandbox-jp"), "/tmp/jp.ts", {
      name: "JSONPlaceholder",
      version: "1.0",
    });
    const service = await createServiceWithEmptyProfile(registry);

    const result = await service.discover(
      { businessId: "jsonplaceholder" },
      "key-123",
    );

    expect(result.status).toBe("succeeded");
    expect(result.data.business.id).toBe("jsonplaceholder");
    expect(result.data.business.name).toBe("JSONPlaceholder");
    expect(result.data.business.platform).toBe("jsonplaceholder");
  });

  test("query works with dynamic adapter and no static profile", async () => {
    const registry = new AdapterRegistry();
    registry.registerScoped("jsonplaceholder", "key-123", createFactory("sandbox-jp"), "/tmp/jp.ts");
    const service = await createServiceWithEmptyProfile(registry);

    const result = await service.query(
      { businessId: "jsonplaceholder", request: { q: "posts" } },
      "key-123",
    );

    expect(result.status).toBe("succeeded");
    expect(result.data).toEqual({ tag: "sandbox-jp", op: "query" });
  });

  test("execute works with dynamic adapter and no static profile", async () => {
    const registry = new AdapterRegistry();
    registry.registerScoped("jsonplaceholder", "key-123", createFactory("sandbox-jp"), "/tmp/jp.ts");
    const service = await createServiceWithEmptyProfile(registry);

    const result = await service.execute(
      { businessId: "jsonplaceholder", request: { action: "create" } },
      "key-123",
    );

    expect(result.status).toBe("succeeded");
    expect(result.data).toEqual({ tag: "sandbox-jp", op: "execute" });
  });

  test("discover without interaction profile omits capabilities", async () => {
    const registry = new AdapterRegistry();
    registry.registerScoped("newapi", "key-456", createFactory("dynamic"), "/tmp/newapi.ts", {
      name: "New API",
      version: "1.0",
    });
    const service = await createServiceWithEmptyProfile(registry);

    const result = await service.discover(
      { businessId: "newapi" },
      "key-456",
    );

    expect(result.data.business.name).toBe("New API");
    expect(result.data).not.toHaveProperty("capabilities");
  });

  test("throws when business not in profile store or adapter registry", async () => {
    const registry = new AdapterRegistry();
    const service = await createServiceWithEmptyProfile(registry);

    await expect(
      service.discover({ businessId: "nonexistent" }, "key-789"),
    ).rejects.toThrow("Unknown business 'nonexistent'");
  });

  test("sandbox adapter not visible to different caller", async () => {
    const registry = new AdapterRegistry();
    registry.registerScoped("myapi", "owner-a", createFactory("private"), "/tmp/myapi.ts");
    const service = await createServiceWithEmptyProfile(registry);

    await expect(
      service.discover({ businessId: "myapi" }, "owner-b"),
    ).rejects.toThrow("Unknown business 'myapi'");
  });
});
