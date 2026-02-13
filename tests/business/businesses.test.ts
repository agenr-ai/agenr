import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";

import { createApiKey } from "../../src/db/api-keys";
import { getBusinessById } from "../../src/db/businesses";
import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { AdapterRegistry } from "../../src/core/adapter-registry";
import { createBusinessRoutes } from "../../src/routes/businesses";

function createTestApp(): Hono {
  const app = new Hono();
  app.route("/businesses", createBusinessRoutes(new AdapterRegistry()));
  return app;
}

function keyHeaders(rawKey: string): Record<string, string> {
  return { "x-api-key": rawKey };
}

interface BusinessActivityEntryResponse {
  id: string;
  timestamp: string;
  action: string;
  service: string;
  metadata: Record<string, unknown> | null;
}

interface BusinessActivityResponse {
  businessId: string;
  entries: BusinessActivityEntryResponse[];
  has_more: boolean;
}

async function createBusinessViaApi(
  app: Hono,
  rawKey: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  return app.request("/businesses", {
    method: "POST",
    headers: {
      ...keyHeaders(rawKey),
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function insertAuditRow(params: {
  id: string;
  userId: string;
  serviceId: string;
  action: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await getDb().execute({
    sql: `INSERT INTO credential_audit_log (
      id,
      user_id,
      service_id,
      action,
      metadata,
      timestamp
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      params.id,
      params.userId,
      params.serviceId,
      params.action,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.timestamp,
    ],
  });
}

let testDb: Client | null = null;

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

describe("businesses routes", () => {
  test("POST /businesses creates a business and returns it", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-create", tier: "paid" });

    const response = await createBusinessViaApi(app, key.raw, {
      name: "Joe's Pizza",
      platform: "toast",
      location: "Austin, TX",
      description: "Neighborhood pizza shop",
      category: "restaurant",
      preferences: { delivery: true },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe("joes-pizza");
    expect(body.ownerId).toBe(key.record.id);
    expect(body.name).toBe("Joe's Pizza");
    expect(body.platform).toBe("toast");
    expect(body.location).toBe("Austin, TX");
    expect(body.description).toBe("Neighborhood pizza shop");
    expect(body.category).toBe("restaurant");
    expect(body.preferences).toEqual({ delivery: true });
    expect(body.status).toBe("active");
    expect(typeof body.createdAt).toBe("string");
    expect(typeof body.updatedAt).toBe("string");
  });

  test("POST /businesses requires name and platform", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-required", tier: "paid" });

    const response = await createBusinessViaApi(app, key.raw, {});

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Invalid request");
  });

  test("POST /businesses rejects empty name", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-empty-name", tier: "paid" });

    const response = await createBusinessViaApi(app, key.raw, {
      name: "   ",
      platform: "square",
    });

    expect(response.status).toBe(400);
  });

  test("GET /businesses returns only the caller's businesses", async () => {
    const app = createTestApp();
    const ownerA = await createApiKey({ label: "owner-a", tier: "paid" });
    const ownerB = await createApiKey({ label: "owner-b", tier: "paid" });

    await createBusinessViaApi(app, ownerA.raw, { name: "A One", platform: "toast" });
    await createBusinessViaApi(app, ownerB.raw, { name: "B One", platform: "square" });

    const response = await app.request("/businesses", {
      headers: keyHeaders(ownerA.raw),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].ownerId).toBe(ownerA.record.id);
    expect(body[0].name).toBe("A One");
  });

  test("GET /businesses/:id returns the business", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-get", tier: "paid" });

    const created = await createBusinessViaApi(app, key.raw, {
      name: "Gettable Biz",
      platform: "toast",
    });
    const createdBody = await created.json();

    const response = await app.request(`/businesses/${createdBody.id}`, {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe(createdBody.id);
    expect(body.name).toBe("Gettable Biz");
  });

  test("GET /businesses/:id returns 404 for non-existent business", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-missing", tier: "paid" });

    const response = await app.request("/businesses/does-not-exist", {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Business not found" });
  });

  test("GET /businesses/:id returns 403 for another user's business", async () => {
    const app = createTestApp();
    const ownerA = await createApiKey({ label: "owner-a-403", tier: "paid" });
    const ownerB = await createApiKey({ label: "owner-b-403", tier: "paid" });

    const created = await createBusinessViaApi(app, ownerA.raw, {
      name: "Private Biz",
      platform: "toast",
    });
    const createdBody = await created.json();

    const response = await app.request(`/businesses/${createdBody.id}`, {
      headers: keyHeaders(ownerB.raw),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
  });

  test("GET /businesses/:id/activity returns filtered owner activity with pagination", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-activity-owner", tier: "paid" });
    const other = await createApiKey({ label: "business-activity-other", tier: "paid" });

    const created = await createBusinessViaApi(app, key.raw, {
      name: "Activity Biz",
      platform: "square",
    });
    const createdBody = await created.json();

    await insertAuditRow({
      id: "act-1",
      userId: key.record.id,
      serviceId: "square",
      action: "credential_stored",
      timestamp: "2026-02-12T10:00:00.000Z",
      metadata: { adapter: "square" },
    });
    await insertAuditRow({
      id: "act-2",
      userId: key.record.id,
      serviceId: "square",
      action: "connection_failed",
      timestamp: "2026-02-12T10:01:00.000Z",
    });
    await insertAuditRow({
      id: "act-3",
      userId: key.record.id,
      serviceId: "square",
      action: "dek_generated",
      timestamp: "2026-02-12T10:02:00.000Z",
    });
    await insertAuditRow({
      id: "act-4",
      userId: key.record.id,
      serviceId: "square",
      action: "credential_retrieved",
      timestamp: "2026-02-12T10:03:00.000Z",
    });
    await insertAuditRow({
      id: "act-5",
      userId: other.record.id,
      serviceId: "square",
      action: "credential_stored",
      timestamp: "2026-02-12T10:04:00.000Z",
    });

    const firstResponse = await app.request(`/businesses/${createdBody.id}/activity?limit=2`, {
      headers: keyHeaders(key.raw),
    });

    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as BusinessActivityResponse;
    expect(firstBody.businessId).toBe(createdBody.id);
    expect(firstBody.entries.map((entry) => entry.id)).toEqual(["act-4", "act-2"]);
    expect(firstBody.has_more).toBe(true);

    const secondResponse = await app.request(
      `/businesses/${createdBody.id}/activity?limit=2&before=${encodeURIComponent("2026-02-12T10:01:00.000Z")}`,
      {
        headers: keyHeaders(key.raw),
      },
    );
    expect(secondResponse.status).toBe(200);
    const secondBody = (await secondResponse.json()) as BusinessActivityResponse;
    expect(secondBody.entries.map((entry) => entry.id)).toEqual(["act-1"]);
    expect(secondBody.has_more).toBe(false);
  });

  test("GET /businesses/:id/activity returns 403 for another user's business", async () => {
    const app = createTestApp();
    const owner = await createApiKey({ label: "business-activity-owner-403", tier: "paid" });
    const other = await createApiKey({ label: "business-activity-other-403", tier: "paid" });

    const created = await createBusinessViaApi(app, owner.raw, {
      name: "Hidden Activity Biz",
      platform: "toast",
    });
    const createdBody = await created.json();

    const response = await app.request(`/businesses/${createdBody.id}/activity`, {
      headers: keyHeaders(other.raw),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
  });

  test("GET /businesses/:id/activity returns 400 when before is invalid", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-activity-invalid-before", tier: "paid" });

    const created = await createBusinessViaApi(app, key.raw, {
      name: "Bad Cursor Biz",
      platform: "stripe",
    });
    const createdBody = await created.json();

    const response = await app.request(`/businesses/${createdBody.id}/activity?before=not-a-date`, {
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid before cursor" });
  });

  test("PUT /businesses/:id updates fields", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-update", tier: "paid" });

    const created = await createBusinessViaApi(app, key.raw, {
      name: "Update Biz",
      platform: "toast",
    });
    const createdBody = await created.json();

    const response = await app.request(`/businesses/${createdBody.id}`, {
      method: "PUT",
      headers: {
        ...keyHeaders(key.raw),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Updated Name",
        location: "Seattle",
        description: "Updated description",
        category: "service",
        preferences: { pickup: false },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.name).toBe("Updated Name");
    expect(body.location).toBe("Seattle");
    expect(body.description).toBe("Updated description");
    expect(body.category).toBe("service");
    expect(body.preferences).toEqual({ pickup: false });
    expect(body.platform).toBe("toast");
  });

  test("PUT /businesses/:id rejects platform change", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-platform-change", tier: "paid" });

    const created = await createBusinessViaApi(app, key.raw, {
      name: "No Platform Change",
      platform: "toast",
    });
    const createdBody = await created.json();

    const response = await app.request(`/businesses/${createdBody.id}`, {
      method: "PUT",
      headers: {
        ...keyHeaders(key.raw),
        "content-type": "application/json",
      },
      body: JSON.stringify({ platform: "square" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "platform cannot be changed" });
  });

  test("DELETE /businesses/:id soft deletes", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-delete", tier: "paid" });

    const created = await createBusinessViaApi(app, key.raw, {
      name: "Delete Biz",
      platform: "toast",
    });
    const createdBody = await created.json();

    const response = await app.request(`/businesses/${createdBody.id}`, {
      method: "DELETE",
      headers: keyHeaders(key.raw),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "deleted" });

    const stored = await getBusinessById(createdBody.id);
    expect(stored?.status).toBe("deleted");
  });

  test("Deleted businesses don't appear in GET /businesses list", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-delete-list", tier: "paid" });

    const created = await createBusinessViaApi(app, key.raw, {
      name: "Delete List Biz",
      platform: "toast",
    });
    const createdBody = await created.json();

    await app.request(`/businesses/${createdBody.id}`, {
      method: "DELETE",
      headers: keyHeaders(key.raw),
    });

    const listResponse = await app.request("/businesses", {
      headers: keyHeaders(key.raw),
    });

    expect(listResponse.status).toBe(200);
    const rows = await listResponse.json();
    expect(rows).toEqual([]);
  });

  test("Slug generation converts Joe's Pizza to joes-pizza", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-slug", tier: "paid" });

    const response = await createBusinessViaApi(app, key.raw, {
      name: "Joe's Pizza",
      platform: "toast",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe("joes-pizza");
  });

  test("Duplicate slug gets random suffix", async () => {
    const app = createTestApp();
    const key = await createApiKey({ label: "business-duplicate-slug", tier: "paid" });

    const first = await createBusinessViaApi(app, key.raw, {
      name: "Joe's Pizza",
      platform: "toast",
    });
    const second = await createBusinessViaApi(app, key.raw, {
      name: "Joe's Pizza",
      platform: "toast",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(firstBody.id).toBe("joes-pizza");
    expect(secondBody.id).toMatch(/^joes-pizza-[a-z0-9]{4}$/);
    expect(secondBody.id).not.toBe(firstBody.id);
  });
});
