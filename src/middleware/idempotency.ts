import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client";

export interface IdempotencyEntry {
  status: number;
  headers: Record<string, string>;
  body: string;
  createdAtMs: number;
}

const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;

function readHeaders(value: unknown): Record<string, string> {
  if (typeof value !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const headers: Record<string, string> = {};
    for (const [key, raw] of Object.entries(parsed)) {
      if (typeof raw === "string") {
        headers[key] = raw;
      }
    }
    return headers;
  } catch {
    return {};
  }
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : null;
  }
  return null;
}

function readIdempotencyKey(rawValue: string | undefined): string | null {
  if (!rawValue) return null;
  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPrincipalId(rawValue: string | undefined): string {
  if (!rawValue) {
    return "admin";
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : "admin";
}

function buildScopedIdempotencyKey(principalId: string, key: string): string {
  return `${principalId}:${key}`;
}

export async function cleanupExpiredIdempotencyEntries(nowMs = Date.now()): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: "DELETE FROM idempotency_cache WHERE created_at_ms + ? <= ?",
    args: [IDEMPOTENCY_TTL_MS, nowMs],
  });
}

export async function getCachedIdempotencyResponse(
  principalId: string,
  key: string,
  nowMs = Date.now(),
): Promise<IdempotencyEntry | null> {
  const db = getDb();
  const scopedKey = buildScopedIdempotencyKey(principalId, key);
  const cachedResult = await db.execute({
    sql: `SELECT
      status,
      headers,
      body,
      created_at_ms
    FROM idempotency_cache
    WHERE idempotency_key = ?
      AND principal_id = ?`,
    args: [scopedKey, principalId],
  });

  const cachedRow = cachedResult.rows[0] as Record<string, unknown> | undefined;
  if (!cachedRow) {
    return null;
  }

  const status = readInteger(cachedRow["status"]);
  const body = cachedRow["body"];
  const createdAtMs = readInteger(cachedRow["created_at_ms"]);

  if (
    status === null ||
    typeof body !== "string" ||
    createdAtMs === null ||
    createdAtMs + IDEMPOTENCY_TTL_MS <= nowMs
  ) {
    return null;
  }

  return {
    status,
    headers: readHeaders(cachedRow["headers"]),
    body,
    createdAtMs,
  };
}

export async function cacheIdempotencyResponse(
  principalId: string,
  key: string,
  status: number,
  headers: Record<string, string>,
  body: string,
): Promise<void> {
  const db = getDb();
  const scopedKey = buildScopedIdempotencyKey(principalId, key);
  await db.execute({
    sql: `INSERT OR REPLACE INTO idempotency_cache (
      idempotency_key,
      principal_id,
      status,
      headers,
      body,
      created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [scopedKey, principalId, status, JSON.stringify(headers), body, Date.now()],
  });
}

export const idempotencyMiddleware = createMiddleware(async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (c.req.method !== "POST" || pathname !== "/agp/execute") {
    await next();
    return;
  }

  const nowMs = Date.now();
  await cleanupExpiredIdempotencyEntries(nowMs);

  const idempotencyKey = readIdempotencyKey(c.req.header("idempotency-key"));
  if (!idempotencyKey) {
    await next();
    return;
  }
  const principalId = readPrincipalId(c.get("apiKeyId") ?? c.get("userId"));

  const cachedEntry = await getCachedIdempotencyResponse(principalId, idempotencyKey, nowMs);
  if (cachedEntry) {
    return new Response(cachedEntry.body, {
      status: cachedEntry.status,
      headers: cachedEntry.headers,
    });
  }

  await next();

  if (c.res.status < 200 || c.res.status >= 300) {
    return;
  }

  try {
    const cloned = c.res.clone();
    const body = await cloned.text();
    const headers: Record<string, string> = {};

    for (const [key, value] of c.res.headers.entries()) {
      headers[key] = value;
    }

    await cacheIdempotencyResponse(principalId, idempotencyKey, c.res.status, headers, body);
  } catch {
    // If response cloning/parsing fails, skip caching and keep response behavior unchanged.
  }
});
