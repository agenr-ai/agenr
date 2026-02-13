import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { createHash } from "node:crypto";

import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { logAudit } from "../../src/vault/audit";
import { executeAuditReadQuery } from "../../src/vault/audit-queries";
import { verifyAuditChain } from "../../src/vault/audit-verification";

const HEX_64_PATTERN = /^[a-f0-9]{64}$/;

let testDb: Client | null = null;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function insertAuditEntry(userId: string, serviceId: string): Promise<void> {
  await logAudit({
    userId,
    serviceId,
    action: "credential_stored",
  });
}

async function insertLegacyAuditEntry(id: string, userId: string, serviceId: string): Promise<void> {
  await getDb().execute({
    sql: `INSERT INTO credential_audit_log (
      id,
      user_id,
      service_id,
      action,
      execution_id,
      ip_address,
      metadata,
      timestamp,
      prev_hash
    ) VALUES (?, ?, ?, 'credential_stored', NULL, NULL, NULL, ?, NULL)`,
    args: [id, userId, serviceId, new Date().toISOString()],
  });
}

async function loadOrderedEntries(): Promise<Array<{ id: string; timestamp: string; prevHash: string | null }>> {
  const result = await getDb().execute({
    sql: `SELECT id, timestamp, prev_hash
      FROM credential_audit_log
      ORDER BY timestamp ASC, id ASC`,
  });

  return result.rows.map((row) => {
    const parsed = row as Record<string, unknown>;
    return {
      id: String(parsed["id"]),
      timestamp: String(parsed["timestamp"]),
      prevHash: typeof parsed["prev_hash"] === "string" ? parsed["prev_hash"] : null,
    };
  });
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

describe("append-only credential audit log", () => {
  test("audit entry includes prev_hash", async () => {
    await insertAuditEntry("user-1", "stripe");

    const result = await getDb().execute({
      sql: "SELECT prev_hash FROM credential_audit_log LIMIT 1",
    });
    const row = result.rows[0] as Record<string, unknown>;
    const prevHash = row["prev_hash"];

    expect(typeof prevHash).toBe("string");
    expect((prevHash as string).length).toBe(64);
    expect(prevHash as string).toMatch(HEX_64_PATTERN);
  });

  test("audit chain links entries correctly", async () => {
    await insertAuditEntry("user-2", "stripe");
    await Bun.sleep(2);
    await insertAuditEntry("user-2", "stripe");
    await Bun.sleep(2);
    await insertAuditEntry("user-2", "stripe");

    const entries = await loadOrderedEntries();
    expect(entries.length).toBe(3);
    expect(entries[0]?.prevHash).toBe(sha256Hex("genesis"));
    expect(entries[1]?.prevHash).toBe(sha256Hex(`${entries[0]?.id}${entries[0]?.timestamp}`));
    expect(entries[2]?.prevHash).toBe(sha256Hex(`${entries[1]?.id}${entries[1]?.timestamp}`));

    const verification = await verifyAuditChain();
    expect(verification.valid).toBe(true);
  });

  test("DELETE on audit log is rejected", async () => {
    await insertAuditEntry("user-3", "square");
    const rows = await loadOrderedEntries();
    const id = rows[0]?.id;
    if (!id) {
      throw new Error("Expected audit row");
    }

    await expect(
      getDb().execute({
        sql: "DELETE FROM credential_audit_log WHERE id = ?",
        args: [id],
      }),
    ).rejects.toThrow("cannot be deleted");
  });

  test("UPDATE on audit log is rejected", async () => {
    await insertAuditEntry("user-4", "toast");
    const rows = await loadOrderedEntries();
    const id = rows[0]?.id;
    if (!id) {
      throw new Error("Expected audit row");
    }

    await expect(
      getDb().execute({
        sql: "UPDATE credential_audit_log SET action = 'tampered' WHERE id = ?",
        args: [id],
      }),
    ).rejects.toThrow("cannot be updated");
  });

  test("verifyAuditChain detects tampering", async () => {
    await insertAuditEntry("user-5", "stripe");
    await Bun.sleep(2);
    await insertAuditEntry("user-5", "stripe");
    await Bun.sleep(2);
    await insertAuditEntry("user-5", "stripe");

    const clean = await verifyAuditChain();
    expect(clean.valid).toBe(true);

    const rows = await loadOrderedEntries();
    const tampered = rows[2];
    if (!tampered) {
      throw new Error("Expected third audit row");
    }

    await getDb().execute("DROP TRIGGER IF EXISTS audit_log_no_update");
    await getDb().execute({
      sql: "UPDATE credential_audit_log SET prev_hash = ? WHERE id = ?",
      args: ["0".repeat(64), tampered.id],
    });

    const verification = await verifyAuditChain();
    expect(verification.valid).toBe(false);
    expect(verification.brokenAt?.id).toBe(tampered.id);
  });

  test("legacy entries without prev_hash are skipped", async () => {
    await insertLegacyAuditEntry("legacy-audit-1", "legacy-user", "stripe");
    await Bun.sleep(2);
    await insertAuditEntry("legacy-user", "stripe");

    const verification = await verifyAuditChain();
    expect(verification.valid).toBe(true);
    expect(verification.checkedEntries).toBe(1);
  });

  test("audit query guard rejects mutating statements", async () => {
    await expect(executeAuditReadQuery("DELETE FROM credential_audit_log WHERE id = 'x'")).rejects.toThrow(
      "UPDATE/DELETE",
    );
    await expect(
      executeAuditReadQuery("UPDATE credential_audit_log SET action = 'tampered' WHERE id = 'x'"),
    ).rejects.toThrow("UPDATE/DELETE");
  });
});
