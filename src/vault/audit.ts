import { getDb } from "../db/client";
import { createHash } from "node:crypto";
import { logger } from "../utils/logger";
import type { AuditEntry } from "./audit-types";

const INTERNAL_SERVICE_ID = "vault";
const GENESIS_HASH_INPUT = "genesis";
const SENSITIVE_METADATA_KEY_PATTERN =
  /(access[_-]?token|refresh[_-]?token|accessToken|refreshToken|password|secret|api[_-]?key|apiKey|private[_-]?key|privateKey|credential)/i;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parsePreviousAuditRow(row: Record<string, unknown> | undefined): { id: string; timestamp: string } | null {
  if (!row) {
    return null;
  }

  const id = row["id"];
  const timestamp = row["timestamp"];
  if (typeof id !== "string" || typeof timestamp !== "string") {
    throw new Error("Invalid previous audit row shape");
  }

  return { id, timestamp };
}

async function resolvePreviousHash(): Promise<string> {
  const db = getDb();
  const previousResult = await db.execute({
    sql: `SELECT id, timestamp
      FROM credential_audit_log
      ORDER BY timestamp DESC, id DESC
      LIMIT 1`,
  });

  const previousRow = parsePreviousAuditRow(previousResult.rows[0] as Record<string, unknown> | undefined);
  if (!previousRow) {
    return sha256Hex(GENESIS_HASH_INPUT);
  }

  return sha256Hex(`${previousRow.id}${previousRow.timestamp}`);
}

function sanitizeMetadataValue(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadataValue(item, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);

    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(record)) {
      if (SENSITIVE_METADATA_KEY_PATTERN.test(key)) {
        continue;
      }
      sanitized[key] = sanitizeMetadataValue(nestedValue, seen);
    }

    return sanitized;
  }

  return value;
}

function sanitizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  const sanitized = sanitizeMetadataValue(metadata, new WeakSet<object>());
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return undefined;
  }

  return sanitized as Record<string, unknown>;
}

function serializeMetadata(metadata?: Record<string, unknown>): string | null {
  if (!metadata) {
    return null;
  }

  return JSON.stringify(metadata);
}

type AuditWriteEntry = Omit<AuditEntry, "id" | "timestamp">;

async function writeAuditEntry(entry: AuditWriteEntry, timestamp: string): Promise<void> {
  const db = getDb();
  const metadata = sanitizeMetadata(entry.metadata);
  let previousHash: string | null = null;

  try {
    previousHash = await resolvePreviousHash();
  } catch (error) {
    logger.warn("vault_audit_prev_hash_compute_failed", {
      action: entry.action,
      userId: entry.userId,
      serviceId: entry.serviceId,
      error,
    });
    previousHash = null;
  }

  await db.execute({
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      entry.userId,
      entry.serviceId,
      entry.action,
      entry.executionId ?? null,
      entry.ipAddress ?? null,
      serializeMetadata(metadata),
      timestamp,
      previousHash,
    ],
  });
}

/**
 * Log a credential vault event. Fire-and-forget -- audit failures
 * should never block credential operations. Log warnings on failure.
 */
export async function logAudit(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void> {
  try {
    await writeAuditEntry(entry, new Date().toISOString());
  } catch (error) {
    logger.warn("vault_audit_write_failed", {
      action: entry.action,
      userId: entry.userId,
      serviceId: entry.serviceId,
      error,
    });
  }
}

export async function logAuditWithTimestamp(
  entry: Omit<AuditEntry, "id" | "timestamp">,
  timestamp: string,
): Promise<void> {
  const parsedTimestamp = Date.parse(timestamp);
  if (Number.isNaN(parsedTimestamp)) {
    throw new Error("Invalid audit timestamp");
  }

  await writeAuditEntry(entry, new Date(parsedTimestamp).toISOString());
}

export async function logCredentialStored(
  userId: string,
  serviceId: string,
  ipAddress?: string,
): Promise<void> {
  await logAudit({ userId, serviceId, action: "credential_stored", ipAddress });
}

export async function logCredentialRetrieved(
  userId: string,
  serviceId: string,
  executionId?: string,
): Promise<void> {
  await logAudit({ userId, serviceId, action: "credential_retrieved", executionId });
}

export async function logCredentialDeleted(
  userId: string,
  serviceId: string,
  ipAddress?: string,
): Promise<void> {
  await logAudit({ userId, serviceId, action: "credential_deleted", ipAddress });
}

export async function logCredentialRevokedByAdmin(
  targetUserId: string,
  serviceId: string,
  adminUserId: string,
): Promise<void> {
  await logAudit({
    userId: targetUserId,
    serviceId,
    action: "credential_revoked_by_admin",
    metadata: { revokedBy: adminUserId },
  });
}

export async function logCredentialRotated(userId: string, serviceId: string): Promise<void> {
  await logAudit({ userId, serviceId, action: "credential_rotated" });
}

export async function logDekGenerated(userId: string): Promise<void> {
  await logAudit({ userId, serviceId: INTERNAL_SERVICE_ID, action: "dek_generated" });
}

export async function logDekUnwrapped(
  userId: string,
  serviceId: string,
  executionId?: string,
): Promise<void> {
  await logAudit({ userId, serviceId, action: "dek_unwrapped", executionId });
}

export async function logConnectionInitiated(
  userId: string,
  serviceId: string,
  ipAddress?: string,
): Promise<void> {
  await logAudit({ userId, serviceId, action: "connection_initiated", ipAddress });
}

export async function logConnectionCompleted(
  userId: string,
  serviceId: string,
  ipAddress?: string,
): Promise<void> {
  await logAudit({ userId, serviceId, action: "connection_completed", ipAddress });
}

export async function logConnectionFailed(
  userId: string,
  serviceId: string,
  ipAddress?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await logAudit({
    userId,
    serviceId,
    action: "connection_failed",
    ipAddress,
    metadata,
  });
}
