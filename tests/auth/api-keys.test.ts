import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClient, type Client } from "@libsql/client";

import {
  createApiKey,
  FREE_TIER_SCOPES,
  getApiKeyById,
  PAID_TIER_SCOPES,
  resolveApiKey,
  revokeApiKey,
  touchApiKey,
} from "../../src/db/api-keys";
import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";

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

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("api keys db module", () => {
  test("createApiKey generates expected raw format and stores hash, not raw", async () => {
    const created = await createApiKey({
      label: "My App",
      tier: "free",
    });

    expect(created.raw).toMatch(/^agenr_free_[a-f0-9]{32}$/);

    const rowResult = await getDb().execute({
      sql: "SELECT key_hash FROM api_keys WHERE id = ?",
      args: [created.record.id],
    });
    const row = rowResult.rows[0] as Record<string, unknown> | undefined;
    const storedHash = row?.["key_hash"];

    expect(typeof storedHash).toBe("string");
    expect(storedHash).not.toBe(created.raw);
    expect(storedHash).toBe(await sha256Hex(created.raw));
  });

  test("resolveApiKey resolves valid raw key and returns null for invalid", async () => {
    const created = await createApiKey({
      label: "Lookup Key",
      tier: "free",
    });

    const resolved = await resolveApiKey(created.raw);
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(created.record.id);
    expect(resolved?.tier).toBe("free");

    const missing = await resolveApiKey("agenr_free_deadbeefdeadbeefdeadbeefdeadbeef");
    expect(missing).toBeNull();
  });

  test("getApiKeyById returns key metadata and null for missing ids", async () => {
    const created = await createApiKey({
      label: "By Id Key",
      tier: "paid",
    });

    const found = await getApiKeyById(created.record.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.record.id);
    expect(found?.label).toBe(created.record.label);
    expect(found?.tier).toBe(created.record.tier);
    expect(found?.scopes).toEqual(created.record.scopes);
    expect(found?.ownerEmail).toBe(created.record.ownerEmail);
    expect(found?.rateLimitOverride).toBe(created.record.rateLimitOverride);
    expect(found?.createdAt).toBe(created.record.createdAt);
    expect(found?.lastUsedAt).toBe(created.record.lastUsedAt);

    const missing = await getApiKeyById(crypto.randomUUID());
    expect(missing).toBeNull();
  });

  test("touchApiKey updates last_used_at", async () => {
    const created = await createApiKey({
      label: "Touch Key",
      tier: "free",
    });

    const before = await resolveApiKey(created.raw);
    expect(before?.lastUsedAt).toBeNull();

    await touchApiKey(created.record.id);

    const after = await resolveApiKey(created.raw);
    expect(after?.lastUsedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(after?.lastUsedAt ?? ""))).toBe(false);
  });

  test("revokeApiKey removes key and resolveApiKey returns null", async () => {
    const created = await createApiKey({
      label: "Revoke Key",
      tier: "paid",
    });

    expect(await revokeApiKey(created.record.id)).toBe(true);
    expect(await resolveApiKey(created.raw)).toBeNull();
    expect(await revokeApiKey(created.record.id)).toBe(false);
  });

  test("tier defaults set free and paid scopes correctly", async () => {
    const free = await createApiKey({
      label: "Free Key",
      tier: "free",
    });
    expect(free.record.scopes).toEqual([...FREE_TIER_SCOPES]);

    const paid = await createApiKey({
      label: "Paid Key",
      tier: "paid",
    });
    expect(paid.record.scopes).toEqual([...PAID_TIER_SCOPES]);
    expect(paid.record.scopes.includes("generate")).toBe(true);
  });
});
