import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import {
  DEMO_KEY_ID,
  DEMO_KEY_RAW,
  seedPublicDemoKey,
} from "../../src/db/seed-demo-key";
import { apiKeyAuthMiddleware, requireScope } from "../../src/middleware/auth";

let testDb: Client | null = null;

function createProtectedApp(): Hono {
  const app = new Hono();

  app.use("/protected/*", apiKeyAuthMiddleware);
  app.get("/protected/ping", (c) =>
    c.json({
      ok: true,
      apiKeyId: c.get("apiKeyId"),
      scopes: c.get("apiKeyScopes") ?? [],
    }),
  );
  app.get("/protected/generate", requireScope("generate"), (c) => c.json({ ok: true }));

  return app;
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

describe("seedPublicDemoKey", () => {
  test("seedPublicDemoKey creates key on first run", async () => {
    await seedPublicDemoKey();

    const result = await getDb().execute({
      sql: `SELECT id, tier, scopes, owner_email, user_id
        FROM api_keys
        WHERE id = ?`,
      args: [DEMO_KEY_ID],
    });

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as Record<string, unknown>;
    expect(row["tier"]).toBe("free");
    expect(row["scopes"]).toBe("discover,query,execute");
    expect(row["owner_email"]).toBe("demo@agenr.ai");
    expect(row["user_id"]).toBe("system");
  });

  test("seedPublicDemoKey is idempotent", async () => {
    await seedPublicDemoKey();
    await seedPublicDemoKey();

    const result = await getDb().execute({
      sql: "SELECT COUNT(*) AS count FROM api_keys WHERE id = ?",
      args: [DEMO_KEY_ID],
    });
    const row = result.rows[0] as Record<string, unknown>;
    expect(Number(row["count"])).toBe(1);
  });

  test("demo key authenticates successfully", async () => {
    await seedPublicDemoKey();
    const app = createProtectedApp();

    const response = await app.request("/protected/ping", {
      headers: {
        authorization: `Bearer ${DEMO_KEY_RAW}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.apiKeyId).toBe(DEMO_KEY_ID);
  });

  test("demo key has correct scopes", async () => {
    await seedPublicDemoKey();
    const app = createProtectedApp();

    const response = await app.request("/protected/ping", {
      headers: {
        authorization: `Bearer ${DEMO_KEY_RAW}`,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scopes).toEqual(["discover", "query", "execute"]);
    expect(body.scopes.includes("admin")).toBe(false);
    expect(body.scopes.includes("generate")).toBe(false);

    const generateResponse = await app.request("/protected/generate", {
      headers: {
        authorization: `Bearer ${DEMO_KEY_RAW}`,
      },
    });
    expect(generateResponse.status).toBe(403);
  });
});
