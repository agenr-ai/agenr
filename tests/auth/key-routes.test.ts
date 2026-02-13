import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { createApiKey, getApiKeyById } from "../../src/db/api-keys";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { createSession } from "../../src/db/sessions";
import { upsertOAuthUser } from "../../src/db/users";
import { createKeyRoutes } from "../../src/routes/keys";

let testDb: Client | null = null;
let originalApiKey: string | undefined;
let originalAdminEmails: string | undefined;

function createTestApp(): Hono {
  const app = new Hono();
  app.route("/", createKeyRoutes());
  return app;
}

beforeEach(async () => {
  originalApiKey = process.env.AGENR_API_KEY;
  originalAdminEmails = process.env.AGENR_ADMIN_EMAILS;

  process.env.AGENR_API_KEY = "admin-key";
  process.env.AGENR_ADMIN_EMAILS = "admin@example.com";

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

  if (originalApiKey === undefined) {
    delete process.env.AGENR_API_KEY;
  } else {
    process.env.AGENR_API_KEY = originalApiKey;
  }

  if (originalAdminEmails === undefined) {
    delete process.env.AGENR_ADMIN_EMAILS;
  } else {
    process.env.AGENR_ADMIN_EMAILS = originalAdminEmails;
  }
});

describe("key routes", () => {
  test("POST /keys allows non-admin signed-in sessions and links key to session user", async () => {
    const app = createTestApp();
    const user = await upsertOAuthUser({
      provider: "google",
      providerId: "key-create-session-user",
      email: "member@example.com",
      name: "Member User",
    });
    const session = await createSession(user.id);

    const response = await app.request("/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        label: "Session User Key",
        tier: "free",
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    const stored = await getApiKeyById(body.id as string);
    expect(stored?.userId).toBe(user.id);
  });

  test("POST /keys links created key to admin session user id", async () => {
    const app = createTestApp();
    const user = await upsertOAuthUser({
      provider: "github",
      providerId: "key-create-admin-user",
      email: "admin@example.com",
      name: "Admin User",
    });
    const session = await createSession(user.id);

    const response = await app.request("/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        label: "Session Created Key",
        tier: "paid",
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(typeof body.id).toBe("string");

    const stored = await getApiKeyById(body.id as string);
    expect(stored).not.toBeNull();
    expect(stored?.userId).toBe(user.id);
  });

  test("POST /keys rejects API key-authenticated callers", async () => {
    const app = createTestApp();
    const key = await createApiKey({
      label: "caller-key",
      tier: "paid",
    });

    const response = await app.request("/keys", {
      method: "POST",
      headers: {
        "x-api-key": key.raw,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        label: "Should Fail",
        tier: "free",
      }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({ error: "Forbidden" });
    expect(typeof body.message).toBe("string");
    expect((body.message as string).toLowerCase()).toContain("signed-in");
  });

  test("POST /keys/:id/link assigns an existing key to a user", async () => {
    const app = createTestApp();
    const user = await upsertOAuthUser({
      provider: "google",
      providerId: "key-link-user",
      email: "owner@example.com",
      name: "Owner User",
    });
    const key = await createApiKey({
      label: "Unlinked Key",
      tier: "paid",
    });
    expect(key.record.userId).toBeNull();

    const response = await app.request(`/keys/${key.record.id}/link`, {
      method: "POST",
      headers: {
        authorization: "Bearer admin-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: user.id }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: key.record.id,
      userId: user.id,
      status: "linked",
    });

    const stored = await getApiKeyById(key.record.id);
    expect(stored?.userId).toBe(user.id);
  });
});
