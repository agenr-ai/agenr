import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { randomUUID } from "node:crypto";

import { DEMO_USERS, runDemoReset } from "../../src/cli/demo-reset";
import { setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { hashToken } from "../../src/db/sessions";

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

async function insertUser(
  db: Client,
  user: { id: string; email: string; name: string; provider: string; providerId: string },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO users (
      id,
      email,
      name,
      avatar_url,
      provider,
      provider_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, datetime('now'), datetime('now'))`,
    args: [user.id, user.email, user.name, user.provider, user.providerId],
  });
}

async function insertBusiness(db: Client, ownerId: string, platform = "stripe"): Promise<void> {
  await db.execute({
    sql: `INSERT INTO businesses (
      id,
      owner_id,
      name,
      platform,
      location,
      description,
      category,
      preferences,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'active', datetime('now'), datetime('now'))`,
    args: [`biz-${ownerId}-${randomUUID()}`, ownerId, `${ownerId}-business`, platform],
  });
}

async function insertCredential(db: Client, userId: string, serviceId = "stripe", authType = "oauth2"): Promise<void> {
  await db.execute({
    sql: `INSERT INTO credentials (
      id,
      user_id,
      service_id,
      auth_type,
      encrypted_payload,
      iv,
      auth_tag,
      scopes,
      expires_at,
      last_used_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, datetime('now'), datetime('now'))`,
    args: [
      `cred-${userId}-${serviceId}-${randomUUID()}`,
      userId,
      serviceId,
      authType,
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ],
  });
}

async function insertUserKey(db: Client, userId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO user_keys (
      user_id,
      encrypted_dek,
      kms_key_id,
      created_at,
      rotated_at
    ) VALUES (?, ?, ?, datetime('now'), NULL)`,
    args: [userId, new Uint8Array([10, 11]), "kms-local-key"],
  });
}

async function insertAuditLog(db: Client, userId: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO credential_audit_log (
      id,
      user_id,
      service_id,
      action,
      execution_id,
      ip_address,
      metadata,
      timestamp
    ) VALUES (?, ?, 'stripe', 'read', NULL, NULL, NULL, datetime('now'))`,
    args: [`audit-${userId}-${randomUUID()}`, userId],
  });
}

async function insertSession(db: Client, userId: string, token: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO sessions (
      id,
      user_id,
      expires_at,
      created_at,
      last_active_at
    ) VALUES (?, ?, '2027-01-01T00:00:00.000Z', datetime('now'), datetime('now'))`,
    args: [hashToken(token), userId],
  });
}

async function countRows(db: Client, sql: string, args: unknown[] = []): Promise<number> {
  const result = await db.execute({ sql, args });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const value = row?.["count"];
  return typeof value === "number" ? value : Number(value ?? 0);
}

describe("demo reset", () => {
  test("resets demo user businesses and credentials", async () => {
    if (!testDb) throw new Error("Test DB not initialized");

    for (const user of DEMO_USERS) {
      await insertUser(testDb, user);
      await insertBusiness(testDb, user.id);
      await insertCredential(testDb, user.id);
      await insertUserKey(testDb, user.id);
      await insertAuditLog(testDb, user.id);
      await insertSession(testDb, user.id, `legacy-${user.id}`);
    }

    await runDemoReset(":memory:", "", { client: testDb, log: () => {} });

    const demoIds = DEMO_USERS.map((user) => user.id);
    const placeholders = demoIds.map(() => "?").join(", ");

    expect(
      await countRows(testDb, `SELECT COUNT(*) AS count FROM businesses WHERE owner_id IN (${placeholders})`, demoIds),
    ).toBe(0);
    expect(
      await countRows(testDb, `SELECT COUNT(*) AS count FROM credentials WHERE user_id IN (${placeholders})`, demoIds),
    ).toBe(0);
    expect(await countRows(testDb, `SELECT COUNT(*) AS count FROM user_keys WHERE user_id IN (${placeholders})`, demoIds)).toBe(
      0,
    );
    expect(
      await countRows(testDb, `SELECT COUNT(*) AS count FROM credential_audit_log WHERE user_id IN (${placeholders})`, demoIds),
    ).toBe(DEMO_USERS.length);

    for (const user of DEMO_USERS) {
      const userResult = await testDb.execute({
        sql: "SELECT email, name, provider FROM users WHERE id = ?",
        args: [user.id],
      });
      expect(userResult.rows.length).toBe(1);
      const row = userResult.rows[0] as Record<string, unknown>;
      expect(row["email"]).toBe(user.email);
      expect(row["name"]).toBe(user.name);
      expect(row["provider"]).toBe(user.provider);

      const sessionsResult = await testDb.execute({
        sql: "SELECT id FROM sessions WHERE user_id = ?",
        args: [user.id],
      });
      expect(sessionsResult.rows.length).toBe(1);
      const sessionRow = sessionsResult.rows[0] as Record<string, unknown>;
      expect(sessionRow["id"]).toBe(hashToken(user.sessionToken));
    }
  });

  test("preserves non-demo data", async () => {
    if (!testDb) throw new Error("Test DB not initialized");

    const nonDemoUser = {
      id: "jim-admin-001",
      email: "jim@example.com",
      name: "Jim",
      provider: "github",
      providerId: "jim-github-001",
    };
    await insertUser(testDb, nonDemoUser);
    await insertBusiness(testDb, nonDemoUser.id, "square");
    await insertCredential(testDb, nonDemoUser.id, "square");
    await insertUserKey(testDb, nonDemoUser.id);
    await insertAuditLog(testDb, nonDemoUser.id);
    await insertSession(testDb, nonDemoUser.id, "jim-session");

    const demoUser = DEMO_USERS[0];
    await insertUser(testDb, demoUser);
    await insertBusiness(testDb, demoUser.id);
    await insertCredential(testDb, demoUser.id);
    await insertUserKey(testDb, demoUser.id);
    await insertAuditLog(testDb, demoUser.id);
    await insertSession(testDb, demoUser.id, "legacy-demo-session");

    await runDemoReset(":memory:", "", { client: testDb, log: () => {} });

    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM businesses WHERE owner_id = ?", [nonDemoUser.id])).toBe(1);
    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM credentials WHERE user_id = ?", [nonDemoUser.id])).toBe(1);
    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM user_keys WHERE user_id = ?", [nonDemoUser.id])).toBe(1);
    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM credential_audit_log WHERE user_id = ?", [nonDemoUser.id])).toBe(
      1,
    );
    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?", [nonDemoUser.id])).toBe(1);

    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM businesses WHERE owner_id = ?", [demoUser.id])).toBe(0);
    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM credentials WHERE user_id = ?", [demoUser.id])).toBe(0);
    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM user_keys WHERE user_id = ?", [demoUser.id])).toBe(0);
    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM credential_audit_log WHERE user_id = ?", [demoUser.id])).toBe(1);
    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?", [demoUser.id])).toBe(1);

    const demoSession = await testDb.execute({
      sql: "SELECT id FROM sessions WHERE user_id = ?",
      args: [demoUser.id],
    });
    const demoSessionRow = demoSession.rows[0] as Record<string, unknown>;
    expect(demoSessionRow["id"]).toBe(hashToken(demoUser.sessionToken));
  });

  test("preserves app_oauth credentials", async () => {
    if (!testDb) throw new Error("Test DB not initialized");

    const demoUser = DEMO_USERS[1];
    await insertUser(testDb, demoUser);
    await insertCredential(testDb, demoUser.id, "stripe", "oauth2");
    await insertCredential(testDb, "__system__", "stripe", "app_oauth");

    await runDemoReset(":memory:", "", { client: testDb, log: () => {} });

    expect(
      await countRows(
        testDb,
        "SELECT COUNT(*) AS count FROM credentials WHERE user_id = '__system__' AND service_id = 'stripe' AND auth_type = 'app_oauth'",
      ),
    ).toBe(1);
    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM credentials WHERE user_id = ?", [demoUser.id])).toBe(0);
  });

  test("preserves adapters", async () => {
    if (!testDb) throw new Error("Test DB not initialized");

    await testDb.execute({
      sql: `INSERT INTO adapters (
        id,
        platform,
        owner_id,
        status,
        file_path,
        source_code,
        source_hash,
        created_at
      ) VALUES (?, 'stripe', 'admin', 'public', 'data/adapters/stripe.ts', '// source', 'hash1', datetime('now'))`,
      args: ["adapter-public-1"],
    });
    await testDb.execute({
      sql: `INSERT INTO adapters (
        id,
        platform,
        owner_id,
        status,
        file_path,
        source_code,
        source_hash,
        created_at
      ) VALUES (?, 'toast', 'joe-user-001', 'sandbox', 'data/adapters/joe/toast.ts', '// source', 'hash2', datetime('now'))`,
      args: ["adapter-sandbox-1"],
    });

    await runDemoReset(":memory:", "", { client: testDb, log: () => {} });

    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM adapters")).toBe(2);
    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM adapters WHERE platform = 'stripe'")).toBe(1);
    expect(await countRows(testDb, "SELECT COUNT(*) AS count FROM adapters WHERE platform = 'toast'")).toBe(1);
  });
});
