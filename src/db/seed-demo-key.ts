import { getDb } from "./client";
import { hashToken } from "./sessions";

export const DEMO_KEY_RAW = "ak_test_public_demo";
export const DEMO_KEY_ID = "demo-key-001";
const DEMO_KEY_LABEL = "Public demo key (read-only, rate-limited)";
const DEMO_KEY_TIER = "free";
const DEMO_KEY_USER_ID = "system";
const DEMO_KEY_OWNER_EMAIL = "demo@agenr.ai";
const DEMO_KEY_SCOPES = ["discover", "query", "execute"];

async function ensureSystemUser(): Promise<void> {
  const db = getDb();
  const existing = await db.execute({
    sql: "SELECT id FROM users WHERE id = ?",
    args: [DEMO_KEY_USER_ID],
  });
  if (existing.rows.length > 0) {
    return;
  }

  const nowIso = new Date().toISOString();
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      DEMO_KEY_USER_ID,
      DEMO_KEY_OWNER_EMAIL,
      "Agenr System",
      null,
      "system",
      "system",
      nowIso,
      nowIso,
    ],
  });
}

export async function seedPublicDemoKey(): Promise<void> {
  const db = getDb();
  const keyHash = hashToken(DEMO_KEY_RAW);

  const existing = await db.execute({
    sql: "SELECT id FROM api_keys WHERE key_hash = ?",
    args: [keyHash],
  });
  if (existing.rows.length > 0) {
    return;
  }

  await ensureSystemUser();

  await db.execute({
    sql: `INSERT INTO api_keys (
      id,
      key_hash,
      label,
      tier,
      user_id,
      owner_email,
      scopes,
      rate_limit_override,
      created_at,
      last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      DEMO_KEY_ID,
      keyHash,
      DEMO_KEY_LABEL,
      DEMO_KEY_TIER,
      DEMO_KEY_USER_ID,
      DEMO_KEY_OWNER_EMAIL,
      DEMO_KEY_SCOPES.join(","),
      null,
      new Date().toISOString(),
      null,
    ],
  });

}
