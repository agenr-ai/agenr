import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClient, type Client } from "@libsql/client";

import { setDb, getDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import {
  deleteCredential,
  hasCredential,
  listConnections,
  retrieveCredential,
  storeCredential,
} from "../../src/vault/credential-store";

const ORIGINAL_KMS_KEY_ID = process.env.AGENR_KMS_KEY_ID;

let testDb: Client | null = null;

beforeEach(async () => {
  delete process.env.AGENR_KMS_KEY_ID;
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

  if (ORIGINAL_KMS_KEY_ID) {
    process.env.AGENR_KMS_KEY_ID = ORIGINAL_KMS_KEY_ID;
  } else {
    delete process.env.AGENR_KMS_KEY_ID;
  }
});

describe("vault credential store", () => {
  test("store and retrieve OAuth credential round-trip", async () => {
    await storeCredential("user-1", "stripe", "oauth2", {
      access_token: "access-1",
      refresh_token: "refresh-1",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const credential = await retrieveCredential("user-1", "stripe");
    expect(credential.access_token).toBe("access-1");
    expect(credential.refresh_token).toBe("refresh-1");
    expect(credential.token_type).toBe("Bearer");
    expect(credential.expires_in).toBe(3600);
  });

  test("store and retrieve API key credential round-trip", async () => {
    await storeCredential("user-1", "openai", "api_key", {
      api_key: "sk-live-1",
    });

    const credential = await retrieveCredential("user-1", "openai");
    expect(credential.api_key).toBe("sk-live-1");
  });

  test("store and retrieve cookie credential round-trip", async () => {
    await storeCredential("user-1", "vendor-cookie", "cookie", {
      cookie_name: "session",
      cookie_value: "cookie-123",
    });

    const credential = await retrieveCredential("user-1", "vendor-cookie");
    expect(credential.cookie_name).toBe("session");
    expect(credential.cookie_value).toBe("cookie-123");
  });

  test("store and retrieve client credentials round-trip", async () => {
    await storeCredential("user-1", "toast", "client_credentials", {
      client_id: "client-123",
      client_secret: "secret-123",
    });

    const credential = await retrieveCredential("user-1", "toast");
    expect(credential.client_id).toBe("client-123");
    expect(credential.client_secret).toBe("secret-123");
  });

  test("listConnections returns metadata but no secrets", async () => {
    await storeCredential(
      "user-list",
      "square",
      "oauth2",
      {
        access_token: "access-value",
        refresh_token: "refresh-value",
      },
      ["payments.read"],
    );

    const connections = await listConnections("user-list");
    expect(connections).toHaveLength(1);
    expect(connections[0]?.serviceId).toBe("square");
    expect(connections[0]?.scopes).toBe(JSON.stringify(["payments.read"]));
    expect((connections[0] as unknown as Record<string, unknown>)["encrypted_payload"]).toBeUndefined();
  });

  test("hasCredential returns true/false correctly", async () => {
    expect(await hasCredential("user-2", "stripe")).toBe(false);

    await storeCredential("user-2", "stripe", "oauth2", { access_token: "abc" });
    expect(await hasCredential("user-2", "stripe")).toBe(true);
    expect(await hasCredential("user-2", "square")).toBe(false);
  });

  test("deleteCredential removes the credential", async () => {
    await storeCredential("user-3", "stripe", "oauth2", { access_token: "abc" });
    expect(await hasCredential("user-3", "stripe")).toBe(true);

    await deleteCredential("user-3", "stripe");
    expect(await hasCredential("user-3", "stripe")).toBe(false);
  });

  test("storing same user+service upserts and overwrites payload", async () => {
    await storeCredential("user-4", "stripe", "oauth2", { access_token: "first-token" });
    await storeCredential("user-4", "stripe", "oauth2", { access_token: "second-token" });

    const credential = await retrieveCredential("user-4", "stripe");
    expect(credential.access_token).toBe("second-token");

    const countResult = await getDb().execute({
      sql: "SELECT COUNT(*) AS count FROM credentials WHERE user_id = ? AND service_id = ?",
      args: ["user-4", "stripe"],
    });
    expect(readCount(countResult.rows[0]?.["count"])).toBe(1);
  });

  test("first credential creates DEK and second reuses it", async () => {
    await storeCredential("user-5", "service-a", "api_key", { api_key: "key-a" });

    const firstDekResult = await getDb().execute({
      sql: "SELECT encrypted_dek FROM user_keys WHERE user_id = ?",
      args: ["user-5"],
    });
    expect(firstDekResult.rows.length).toBe(1);

    const firstDek = firstDekResult.rows[0]?.["encrypted_dek"];
    expect(firstDek).toBeDefined();

    await storeCredential("user-5", "service-b", "api_key", { api_key: "key-b" });

    const secondDekResult = await getDb().execute({
      sql: "SELECT encrypted_dek FROM user_keys WHERE user_id = ?",
      args: ["user-5"],
    });
    expect(secondDekResult.rows.length).toBe(1);

    const secondDek = secondDekResult.rows[0]?.["encrypted_dek"];
    expect(blobEquals(firstDek, secondDek)).toBe(true);
  });

  test("retrieveCredential updates last_used_at", async () => {
    await storeCredential("user-6", "stripe", "oauth2", { access_token: "abc" });

    const before = await getDb().execute({
      sql: "SELECT last_used_at FROM credentials WHERE user_id = ? AND service_id = ?",
      args: ["user-6", "stripe"],
    });
    expect(before.rows[0]?.["last_used_at"]).toBeNull();

    await retrieveCredential("user-6", "stripe");

    const after = await getDb().execute({
      sql: "SELECT last_used_at FROM credentials WHERE user_id = ? AND service_id = ?",
      args: ["user-6", "stripe"],
    });
    expect(typeof after.rows[0]?.["last_used_at"]).toBe("string");
  });
});

function readCount(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }

  return 0;
}

function blobEquals(left: unknown, right: unknown): boolean {
  const leftBuffer = asBuffer(left);
  const rightBuffer = asBuffer(right);
  return leftBuffer !== null && rightBuffer !== null && leftBuffer.equals(rightBuffer);
}

function asBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value));
  }

  return null;
}
