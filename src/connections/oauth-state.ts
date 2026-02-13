import { getDb } from "../db/client";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStateRecord {
  userId: string;
  service: string;
  codeVerifier: string | null;
}

function normalizeService(service: string): string {
  return service.trim().toLowerCase();
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function createState(userId: string, service: string, codeVerifier?: string): Promise<string> {
  const state = crypto.randomUUID();
  const db = getDb();

  await db.execute({
    sql: `INSERT INTO oauth_states (state, user_id, service, code_verifier, created_at)
      VALUES (?, ?, ?, ?, ?)`,
    args: [state, userId, normalizeService(service), codeVerifier ?? null, new Date().toISOString()],
  });

  return state;
}

export async function validateAndConsumeState(state: string): Promise<OAuthStateRecord | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `DELETE FROM oauth_states
      WHERE state = ?
      RETURNING user_id, service, code_verifier`,
    args: [state],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  const userId = asString(row["user_id"]);
  const service = asString(row["service"]);
  const codeVerifier = asString(row["code_verifier"]);
  if (!userId || !service) {
    return null;
  }

  return { userId, service, codeVerifier };
}

export async function cleanExpiredStates(nowMs: number = Date.now()): Promise<void> {
  const cutoff = new Date(nowMs - OAUTH_STATE_TTL_MS).toISOString();
  await getDb().execute({
    sql: `DELETE FROM oauth_states
      WHERE created_at < ?`,
    args: [cutoff],
  });
}
