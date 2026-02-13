import { createHash, randomUUID } from "node:crypto";
import { getDb } from "./client";

// Staging demo sessions inserted manually (for example, joe-session-001) must store
// hashToken("<demo-token>") in sessions.id after deploy; the console still uses the plaintext token.
const DEFAULT_SESSION_TTL_DAYS = 30;

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  lastActiveAt: string;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toSessionRecord(row: Record<string, unknown> | undefined): SessionRecord | null {
  if (!row) {
    return null;
  }

  const id = asString(row["id"]);
  const userId = asString(row["user_id"]);
  const expiresAt = asString(row["expires_at"]);
  const createdAt = asString(row["created_at"]);
  const lastActiveAt = asString(row["last_active_at"]);

  if (!id || !userId || !expiresAt || !createdAt || !lastActiveAt) {
    return null;
  }

  return {
    id,
    userId,
    expiresAt,
    createdAt,
    lastActiveAt,
  };
}

function parseSessionTtlDays(): number {
  const raw = process.env.AGENR_SESSION_TTL_DAYS;
  if (!raw?.trim()) {
    return DEFAULT_SESSION_TTL_DAYS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_TTL_DAYS;
  }

  return Math.floor(parsed);
}

function toExpiryIso(now: Date, ttlDays: number): string {
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  return expiresAt.toISOString();
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<SessionRecord & { token: string }> {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const token = randomUUID();
  const tokenHash = hashToken(token);
  const expiresAt = toExpiryIso(now, parseSessionTtlDays());

  await db.execute({
    sql: `INSERT INTO sessions (
      id,
      user_id,
      expires_at,
      created_at,
      last_active_at
    ) VALUES (?, ?, ?, ?, ?)`,
    args: [tokenHash, userId, expiresAt, nowIso, nowIso],
  });

  return {
    id: tokenHash,
    userId,
    expiresAt,
    createdAt: nowIso,
    lastActiveAt: nowIso,
    token,
  };
}

export async function validateSession(sessionId: string): Promise<SessionRecord | null> {
  const normalized = sessionId.trim();
  if (!normalized) {
    return null;
  }

  const hashed = hashToken(normalized);
  const nowIso = new Date().toISOString();
  const result = await getDb().execute({
    sql: `SELECT
      id,
      user_id,
      expires_at,
      created_at,
      last_active_at
    FROM sessions
    WHERE id = ? AND expires_at > ?`,
    args: [hashed, nowIso],
  });

  return toSessionRecord(result.rows[0] as Record<string, unknown> | undefined);
}

export async function touchSession(sessionId: string): Promise<void> {
  const normalized = sessionId.trim();
  if (!normalized) {
    return;
  }

  const hashed = hashToken(normalized);
  await getDb().execute({
    sql: `UPDATE sessions
      SET last_active_at = ?
      WHERE id = ?`,
    args: [new Date().toISOString(), hashed],
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  const normalized = sessionId.trim();
  if (!normalized) {
    return;
  }

  const hashed = hashToken(normalized);
  await getDb().execute({
    sql: "DELETE FROM sessions WHERE id = ?",
    args: [hashed],
  });
}

export async function cleanupExpiredSessions(nowMs: number = Date.now()): Promise<void> {
  await getDb().execute({
    sql: "DELETE FROM sessions WHERE expires_at <= ?",
    args: [new Date(nowMs).toISOString()],
  });
}
