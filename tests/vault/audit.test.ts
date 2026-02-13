import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";

import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import {
  countRecentAuditEvents,
  getAuditLog,
  getAuditLogByAction,
  getServiceAuditLog,
  getUserAuditActivityByActions,
  logAudit,
  logConnectionFailed,
  logCredentialDeleted,
  logCredentialRetrieved,
  logCredentialStored,
} from "../../src/vault";
import type { AuditAction } from "../../src/vault";

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

async function insertAuditRow(params: {
  id: string;
  userId: string;
  serviceId: string;
  action: AuditAction;
  timestamp: string;
  executionId?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await getDb().execute({
    sql: `INSERT INTO credential_audit_log (
      id,
      user_id,
      service_id,
      action,
      execution_id,
      ip_address,
      metadata,
      timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      params.id,
      params.userId,
      params.serviceId,
      params.action,
      params.executionId ?? null,
      params.ipAddress ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.timestamp,
    ],
  });
}

describe("vault audit logging", () => {
  test("logCredentialStored writes entry with correct action and fields", async () => {
    await logCredentialStored("user-1", "square", "203.0.113.10");

    const result = await getDb().execute({
      sql: `SELECT user_id, service_id, action, ip_address
      FROM credential_audit_log`,
    });

    expect(result.rows.length).toBe(1);
    const row = result.rows[0] as Record<string, unknown>;
    expect(row["user_id"]).toBe("user-1");
    expect(row["service_id"]).toBe("square");
    expect(row["action"]).toBe("credential_stored");
    expect(row["ip_address"]).toBe("203.0.113.10");
  });

  test("logCredentialRetrieved includes executionId when provided", async () => {
    await logCredentialRetrieved("user-1", "stripe", "exec-123");

    const result = await getDb().execute({
      sql: `SELECT action, execution_id
      FROM credential_audit_log
      WHERE action = 'credential_retrieved'
      LIMIT 1`,
    });

    expect(result.rows.length).toBe(1);
    const row = result.rows[0] as Record<string, unknown>;
    expect(row["action"]).toBe("credential_retrieved");
    expect(row["execution_id"]).toBe("exec-123");
  });

  test("logCredentialDeleted writes entry", async () => {
    await logCredentialDeleted("user-2", "toast", "198.51.100.20");

    const result = await getDb().execute({
      sql: `SELECT action, user_id, service_id, ip_address
      FROM credential_audit_log
      WHERE action = 'credential_deleted'
      LIMIT 1`,
    });

    expect(result.rows.length).toBe(1);
    const row = result.rows[0] as Record<string, unknown>;
    expect(row["action"]).toBe("credential_deleted");
    expect(row["user_id"]).toBe("user-2");
    expect(row["service_id"]).toBe("toast");
    expect(row["ip_address"]).toBe("198.51.100.20");
  });

  test("logAudit does not throw on database failure (fire-and-forget)", async () => {
    const failingDb = {
      execute: async () => {
        throw new Error("simulated db outage");
      },
    } as unknown as Client;

    setDb(failingDb);

    await expect(
      logAudit({
        userId: "user-fail",
        serviceId: "stripe",
        action: "credential_stored",
      }),
    ).resolves.toBeUndefined();

    setDb(testDb);
  });
});

describe("vault audit queries", () => {
  test("getAuditLog returns entries for a specific user, ordered by timestamp desc", async () => {
    await insertAuditRow({
      id: "a-old",
      userId: "user-a",
      serviceId: "stripe",
      action: "credential_stored",
      timestamp: "2026-02-01T10:00:00.000Z",
    });
    await insertAuditRow({
      id: "a-new",
      userId: "user-a",
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp: "2026-02-01T12:00:00.000Z",
    });
    await insertAuditRow({
      id: "b-other",
      userId: "user-b",
      serviceId: "stripe",
      action: "credential_deleted",
      timestamp: "2026-02-01T13:00:00.000Z",
    });

    const entries = await getAuditLog("user-a");

    expect(entries.length).toBe(2);
    expect(entries[0]?.id).toBe("a-new");
    expect(entries[1]?.id).toBe("a-old");
    expect(entries.every((entry) => entry.userId === "user-a")).toBe(true);
  });

  test("getAuditLog respects limit parameter", async () => {
    await insertAuditRow({
      id: "l-1",
      userId: "user-limit",
      serviceId: "stripe",
      action: "credential_stored",
      timestamp: "2026-02-01T10:00:00.000Z",
    });
    await insertAuditRow({
      id: "l-2",
      userId: "user-limit",
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp: "2026-02-01T11:00:00.000Z",
    });
    await insertAuditRow({
      id: "l-3",
      userId: "user-limit",
      serviceId: "stripe",
      action: "credential_deleted",
      timestamp: "2026-02-01T12:00:00.000Z",
    });

    const entries = await getAuditLog("user-limit", 2);

    expect(entries.length).toBe(2);
    expect(entries[0]?.id).toBe("l-3");
    expect(entries[1]?.id).toBe("l-2");
  });

  test("getServiceAuditLog filters by userId + serviceId", async () => {
    await insertAuditRow({
      id: "svc-1",
      userId: "user-svc",
      serviceId: "stripe",
      action: "credential_stored",
      timestamp: "2026-02-01T10:00:00.000Z",
    });
    await insertAuditRow({
      id: "svc-2",
      userId: "user-svc",
      serviceId: "square",
      action: "credential_stored",
      timestamp: "2026-02-01T11:00:00.000Z",
    });
    await insertAuditRow({
      id: "svc-3",
      userId: "other-user",
      serviceId: "stripe",
      action: "credential_stored",
      timestamp: "2026-02-01T12:00:00.000Z",
    });

    const entries = await getServiceAuditLog("user-svc", "stripe");

    expect(entries.length).toBe(1);
    expect(entries[0]?.id).toBe("svc-1");
    expect(entries[0]?.userId).toBe("user-svc");
    expect(entries[0]?.serviceId).toBe("stripe");
  });

  test("getUserAuditActivityByActions filters by user and allowed actions", async () => {
    await insertAuditRow({
      id: "ua-1",
      userId: "user-activity",
      serviceId: "stripe",
      action: "credential_stored",
      timestamp: "2026-02-01T10:00:00.000Z",
    });
    await insertAuditRow({
      id: "ua-2",
      userId: "user-activity",
      serviceId: "square",
      action: "connection_failed",
      timestamp: "2026-02-01T11:00:00.000Z",
    });
    await insertAuditRow({
      id: "ua-3",
      userId: "user-activity",
      serviceId: "square",
      action: "credential_deleted",
      timestamp: "2026-02-01T12:00:00.000Z",
    });
    await insertAuditRow({
      id: "ua-4",
      userId: "other-user",
      serviceId: "stripe",
      action: "credential_stored",
      timestamp: "2026-02-01T13:00:00.000Z",
    });

    const result = await getUserAuditActivityByActions({
      userId: "user-activity",
      actions: ["credential_stored", "connection_failed"],
      limit: 10,
    });

    expect(result.hasMore).toBe(false);
    expect(result.entries.map((entry) => entry.id)).toEqual(["ua-2", "ua-1"]);
  });

  test("getUserAuditActivityByActions supports before cursor pagination", async () => {
    await insertAuditRow({
      id: "ub-1",
      userId: "user-before",
      serviceId: "stripe",
      action: "credential_stored",
      timestamp: "2026-02-02T10:00:00.000Z",
    });
    await insertAuditRow({
      id: "ub-2",
      userId: "user-before",
      serviceId: "stripe",
      action: "connection_completed",
      timestamp: "2026-02-02T10:01:00.000Z",
    });
    await insertAuditRow({
      id: "ub-3",
      userId: "user-before",
      serviceId: "stripe",
      action: "credential_stored",
      timestamp: "2026-02-02T10:02:00.000Z",
    });

    const firstPage = await getUserAuditActivityByActions({
      userId: "user-before",
      actions: ["credential_stored", "connection_completed"],
      limit: 2,
    });

    expect(firstPage.entries.map((entry) => entry.id)).toEqual(["ub-3", "ub-2"]);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await getUserAuditActivityByActions({
      userId: "user-before",
      actions: ["credential_stored", "connection_completed"],
      limit: 2,
      before: "2026-02-02T10:01:00.000Z",
    });

    expect(secondPage.entries.map((entry) => entry.id)).toEqual(["ub-1"]);
    expect(secondPage.hasMore).toBe(false);
  });

  test("getAuditLogByAction filters by action type", async () => {
    await insertAuditRow({
      id: "act-1",
      userId: "user-1",
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp: "2026-02-01T10:00:00.000Z",
    });
    await insertAuditRow({
      id: "act-2",
      userId: "user-2",
      serviceId: "square",
      action: "credential_deleted",
      timestamp: "2026-02-01T11:00:00.000Z",
    });

    const entries = await getAuditLogByAction("credential_retrieved");

    expect(entries.length).toBe(1);
    expect(entries[0]?.id).toBe("act-1");
    expect(entries[0]?.action).toBe("credential_retrieved");
  });

  test("countRecentAuditEvents counts events within time window", async () => {
    const now = Date.now();
    await insertAuditRow({
      id: "cnt-1",
      userId: "user-1",
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp: new Date(now - 1_000).toISOString(),
    });
    await insertAuditRow({
      id: "cnt-2",
      userId: "user-2",
      serviceId: "stripe",
      action: "credential_retrieved",
      timestamp: new Date(now - 9_000).toISOString(),
    });

    const count = await countRecentAuditEvents("credential_retrieved", 5_000);

    expect(count).toBe(1);
  });

  test("countRecentAuditEvents excludes events outside time window", async () => {
    const now = Date.now();
    await insertAuditRow({
      id: "cnt-out-1",
      userId: "user-1",
      serviceId: "stripe",
      action: "credential_deleted",
      timestamp: new Date(now - 10_000).toISOString(),
    });

    const count = await countRecentAuditEvents("credential_deleted", 500);

    expect(count).toBe(0);
  });

  test("audit entries contain no sensitive credential data in metadata", async () => {
    await logConnectionFailed("user-safe", "stripe", "203.0.113.50", {
      reason: "oauth_denied",
      retryable: false,
      access_token: "should-not-be-stored",
      nested: {
        refreshToken: "should-not-be-stored",
        detail: "safe-detail",
      },
    });

    const entries = await getAuditLogByAction("connection_failed", 1);
    expect(entries.length).toBe(1);

    const metadata = entries[0]?.metadata as Record<string, unknown>;
    expect(metadata["reason"]).toBe("oauth_denied");
    expect(metadata["retryable"]).toBe(false);
    expect(metadata["access_token"]).toBeUndefined();

    const nested = metadata["nested"] as Record<string, unknown>;
    expect(nested["detail"]).toBe("safe-detail");
    expect(nested["refreshToken"]).toBeUndefined();
  });
});
