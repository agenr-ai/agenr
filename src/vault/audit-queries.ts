import { getDb } from "../db/client";
import { AUDIT_ACTIONS, type AuditAction, type AuditEntry } from "./audit-types";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const AUDIT_ACTION_SET = new Set<string>(AUDIT_ACTIONS);
const AUDIT_TABLE_NAME = "credential_audit_log";
const AUDIT_MUTATION_SQL_PATTERN = /\b(update|delete)\b/i;

type AuditQueryArg = string | number | bigint | boolean | Uint8Array | null;

function assertAuditReadQuery(sql: string): void {
  const normalized = sql.trim().toLowerCase();
  if (AUDIT_MUTATION_SQL_PATTERN.test(normalized)) {
    throw new Error("Audit query guard: UPDATE/DELETE are forbidden for audit log queries");
  }

  if (!normalized.startsWith("select")) {
    throw new Error("Audit query guard: only SELECT statements are allowed");
  }

  if (!normalized.includes(AUDIT_TABLE_NAME)) {
    throw new Error("Audit query guard: query must target credential_audit_log");
  }
}

export async function executeAuditReadQuery(
  sql: string,
  args: AuditQueryArg[] = [],
) {
  assertAuditReadQuery(sql);
  const db = getDb();
  return db.execute({ sql, args });
}

function normalizeLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }

  const normalized = Math.floor(limit);
  if (normalized < 1) {
    return 1;
  }

  return Math.min(normalized, MAX_LIMIT);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function toAuditEntry(row: Record<string, unknown>): AuditEntry | null {
  const id = row["id"];
  const userId = row["user_id"];
  const serviceId = row["service_id"];
  const action = row["action"];
  const timestamp = row["timestamp"];

  if (
    typeof id !== "string" ||
    typeof userId !== "string" ||
    typeof serviceId !== "string" ||
    typeof action !== "string" ||
    typeof timestamp !== "string" ||
    !AUDIT_ACTION_SET.has(action)
  ) {
    return null;
  }

  return {
    id,
    userId,
    serviceId,
    action: action as AuditAction,
    executionId: readOptionalString(row["execution_id"]),
    ipAddress: readOptionalString(row["ip_address"]),
    metadata: parseMetadata(row["metadata"]),
    timestamp,
  };
}

function parseCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : 0;
  }

  if (typeof value === "string") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : 0;
  }

  return 0;
}

interface GetServiceAuditActivityParams {
  userId: string;
  serviceId: string;
  limit: number;
  before?: string;
}

interface ServiceAuditActivityResult {
  entries: AuditEntry[];
  hasMore: boolean;
}

interface GetUserAuditActivityParams {
  userId: string;
  actions: AuditAction[];
  limit: number;
  before?: string;
}

interface UserAuditActivityResult {
  entries: AuditEntry[];
  hasMore: boolean;
}

/** Get recent audit entries for a user */
export async function getAuditLog(userId: string, limit?: number): Promise<AuditEntry[]> {
  const result = await executeAuditReadQuery(
    `SELECT
      id,
      user_id,
      service_id,
      action,
      execution_id,
      ip_address,
      metadata,
      timestamp
    FROM credential_audit_log
    WHERE user_id = ?
    ORDER BY timestamp DESC
    LIMIT ?`,
    [userId, normalizeLimit(limit)],
  );

  return result.rows
    .map((row) => toAuditEntry(row as Record<string, unknown>))
    .filter((entry): entry is AuditEntry => entry !== null);
}

/** Get audit entries for a specific service connection */
export async function getServiceAuditLog(
  userId: string,
  serviceId: string,
  limit?: number,
): Promise<AuditEntry[]> {
  const result = await executeAuditReadQuery(
    `SELECT
      id,
      user_id,
      service_id,
      action,
      execution_id,
      ip_address,
      metadata,
      timestamp
    FROM credential_audit_log
    WHERE user_id = ?
      AND service_id = ?
    ORDER BY timestamp DESC
    LIMIT ?`,
    [userId, serviceId, normalizeLimit(limit)],
  );

  return result.rows
    .map((row) => toAuditEntry(row as Record<string, unknown>))
    .filter((entry): entry is AuditEntry => entry !== null);
}

export async function getServiceAuditActivity(
  params: GetServiceAuditActivityParams,
): Promise<ServiceAuditActivityResult> {
  const normalizedLimit = normalizeLimit(params.limit);
  const fetchLimit = normalizedLimit + 1;
  const args: Array<string | number> = [params.userId, params.serviceId];
  let sql = `SELECT
      id,
      user_id,
      service_id,
      action,
      execution_id,
      ip_address,
      metadata,
      timestamp
    FROM credential_audit_log
    WHERE user_id = ?
      AND service_id = ?`;

  if (params.before) {
    sql += `
      AND timestamp < ?`;
    args.push(params.before);
  }

  sql += `
    ORDER BY timestamp DESC
    LIMIT ?`;
  args.push(fetchLimit);

  const result = await executeAuditReadQuery(sql, args);

  const parsedEntries = result.rows
    .map((row) => toAuditEntry(row as Record<string, unknown>))
    .filter((entry): entry is AuditEntry => entry !== null);

  const hasMore = parsedEntries.length > normalizedLimit;
  const entries = hasMore ? parsedEntries.slice(0, normalizedLimit) : parsedEntries;

  return { entries, hasMore };
}

export async function getUserAuditActivityByActions(
  params: GetUserAuditActivityParams,
): Promise<UserAuditActivityResult> {
  const normalizedLimit = normalizeLimit(params.limit);
  const fetchLimit = normalizedLimit + 1;
  const actions = params.actions.filter((action) => AUDIT_ACTION_SET.has(action));
  if (actions.length === 0) {
    return {
      entries: [],
      hasMore: false,
    };
  }

  const actionPlaceholders = actions.map(() => "?").join(", ");
  const args: Array<string | number> = [params.userId, ...actions];
  let sql = `SELECT
      id,
      user_id,
      service_id,
      action,
      execution_id,
      ip_address,
      metadata,
      timestamp
    FROM credential_audit_log
    WHERE user_id = ?
      AND action IN (${actionPlaceholders})`;

  if (params.before) {
    sql += `
      AND timestamp < ?`;
    args.push(params.before);
  }

  sql += `
    ORDER BY timestamp DESC
    LIMIT ?`;
  args.push(fetchLimit);

  const result = await executeAuditReadQuery(sql, args);
  const parsedEntries = result.rows
    .map((row) => toAuditEntry(row as Record<string, unknown>))
    .filter((entry): entry is AuditEntry => entry !== null);

  const hasMore = parsedEntries.length > normalizedLimit;
  const entries = hasMore ? parsedEntries.slice(0, normalizedLimit) : parsedEntries;

  return { entries, hasMore };
}

/** Get audit entries by action type (e.g., all credential_retrieved events) */
export async function getAuditLogByAction(action: AuditAction, limit?: number): Promise<AuditEntry[]> {
  const result = await executeAuditReadQuery(
    `SELECT
      id,
      user_id,
      service_id,
      action,
      execution_id,
      ip_address,
      metadata,
      timestamp
    FROM credential_audit_log
    WHERE action = ?
    ORDER BY timestamp DESC
    LIMIT ?`,
    [action, normalizeLimit(limit)],
  );

  return result.rows
    .map((row) => toAuditEntry(row as Record<string, unknown>))
    .filter((entry): entry is AuditEntry => entry !== null);
}

/** Count audit events in a time window (for anomaly detection) */
export async function countRecentAuditEvents(action: AuditAction, windowMs: number): Promise<number> {
  const normalizedWindowMs = Number.isFinite(windowMs) ? Math.max(0, Math.floor(windowMs)) : 0;
  const since = new Date(Date.now() - normalizedWindowMs).toISOString();

  const result = await executeAuditReadQuery(
    `SELECT COUNT(*) AS total
    FROM credential_audit_log
    WHERE action = ?
      AND timestamp >= ?`,
    [action, since],
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return 0;
  }

  return parseCount(row["total"]);
}
