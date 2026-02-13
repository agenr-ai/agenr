import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClient, type Client } from "@libsql/client";

import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import {
  cacheIdempotencyResponse,
  cleanupExpiredIdempotencyEntries,
  getCachedIdempotencyResponse,
} from "../../src/middleware/idempotency";
import {
  cleanupExpiredConfirmationTokens,
  consumeConfirmationToken,
  getConfirmationToken,
  prepareExecuteConfirmation,
  storeConfirmationToken,
} from "../../src/middleware/policy";
import { TransactionStore } from "../../src/store/transaction-store";

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

describe("transaction store integration", () => {
  const store = new TransactionStore();

  test("create and retrieve a transaction", async () => {
    const created = await store.create("discover", "stripe", { foo: "bar" }, "owner-a");
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.status).toBe("pending");
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(created.updatedAt))).toBe(false);

    const fetched = await store.get(created.id, "owner-a");
    expect(fetched).toEqual(created);
  });

  test("update transaction status", async () => {
    const created = await store.create("query", "stripe", { foo: "bar" }, "owner-a");
    const updated = await store.update(created.id, "succeeded", { result: { ok: true } });

    expect(updated).not.toBeUndefined();
    expect(updated?.status).toBe("succeeded");
    expect(updated?.result).toEqual({ ok: true });

    const fetched = await store.get(created.id, "owner-a");
    expect(fetched?.status).toBe("succeeded");
    expect(fetched?.result).toEqual({ ok: true });
  });

  test("update with error", async () => {
    const created = await store.create("execute", "stripe", { foo: "bar" }, "owner-a");
    const updated = await store.update(created.id, "failed", { error: "something broke" });

    expect(updated).not.toBeUndefined();
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("something broke");

    const fetched = await store.get(created.id, "owner-a");
    expect(fetched?.status).toBe("failed");
    expect(fetched?.error).toBe("something broke");
  });

  test("get returns undefined for unknown id", async () => {
    const transaction = await store.get("nonexistent", "owner-a");
    expect(transaction).toBeUndefined();
  });

  test("get hides transaction for different owner", async () => {
    const created = await store.create("discover", "stripe", { foo: "bar" }, "owner-a");
    const transaction = await store.get(created.id, "owner-b");
    expect(transaction).toBeUndefined();
  });
});

describe("idempotency cache integration", () => {
  test("cache and retrieve idempotency response", async () => {
    await cacheIdempotencyResponse(
      "owner-a",
      "test-key-1",
      201,
      { "content-type": "application/json" },
      '{"ok":true}',
    );

    const cached = await getCachedIdempotencyResponse("owner-a", "test-key-1");
    expect(cached).not.toBeNull();
    expect(cached?.status).toBe(201);
    expect(cached?.headers).toEqual({ "content-type": "application/json" });
    expect(cached?.body).toBe('{"ok":true}');
  });

  test("returns null for unknown key", async () => {
    const cached = await getCachedIdempotencyResponse("owner-a", "unknown");
    expect(cached).toBeNull();
  });

  test("cleanup removes expired entries", async () => {
    await getDb().execute({
      sql: `INSERT INTO idempotency_cache (
        idempotency_key,
        principal_id,
        status,
        headers,
        body,
        created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["owner-a:expired-key", "owner-a", 200, "{}", '{"ok":true}', 0],
    });

    await cleanupExpiredIdempotencyEntries();

    const result = await getDb().execute({
      sql: "SELECT idempotency_key FROM idempotency_cache WHERE idempotency_key = ?",
      args: ["owner-a:expired-key"],
    });
    expect(result.rows.length).toBe(0);
  });
});

describe("confirmation token integration", () => {
  test("prepare and retrieve confirmation token", async () => {
    const input = {
      businessId: "stripe",
      request: { amount_cents: 1234, nested: { z: 1, a: 2 } },
    };

    const prepared = await prepareExecuteConfirmation(input);
    const stored = await getConfirmationToken(prepared.confirmationToken);

    expect(stored).not.toBeNull();
    expect(stored?.businessId).toBe(input.businessId);
    expect(stored?.summary).toBe(prepared.summary);
    expect(stored?.requestHash).toBe(expectedRequestHash(input));
  });

  test("token consumption (single-use)", async () => {
    const prepared = await prepareExecuteConfirmation({
      businessId: "stripe",
      request: { amount: 99 },
    });

    const consumed = await consumeConfirmationToken(prepared.confirmationToken);
    expect(consumed).not.toBeNull();

    const consumedAgain = await consumeConfirmationToken(prepared.confirmationToken);
    expect(consumedAgain).toBeNull();
  });

  test("expired tokens cleaned up", async () => {
    await storeConfirmationToken({
      token: "expired-token",
      businessId: "stripe",
      requestHash: "hash",
      summary: "summary",
      createdAtMs: 0,
      expiresAtMs: 1,
    });

    await cleanupExpiredConfirmationTokens();

    const token = await getConfirmationToken("expired-token");
    expect(token).toBeNull();
  });
});

function expectedRequestHash(input: { businessId: string; request: Record<string, unknown> }): string {
  const normalizedRequest = normalizeForStableJson(input.request);
  const payload = `${input.businessId}:${JSON.stringify(normalizedRequest)}`;
  return createHash("sha256").update(payload).digest("hex");
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableJson(entry));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
      normalized[key] = normalizeForStableJson(record[key]);
    }
    return normalized;
  }

  return value;
}
