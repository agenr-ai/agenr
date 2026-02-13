import { getDb } from "./client";

const ECHO_BUSINESS_ID = "echo";
const ECHO_BUSINESS_NAME = "Echo Labs";
const ECHO_OWNER_ID = "system";
const ECHO_PLATFORM = "echo";

export async function seedEchoBusiness(): Promise<void> {
  const db = getDb();
  const existing = await db.execute({
    sql: "SELECT id FROM businesses WHERE id = ?",
    args: [ECHO_BUSINESS_ID],
  });

  if (existing.rows.length > 0) {
    return;
  }

  const nowIso = new Date().toISOString();
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      ECHO_BUSINESS_ID,
      ECHO_OWNER_ID,
      ECHO_BUSINESS_NAME,
      ECHO_PLATFORM,
      null,
      "Deterministic fake business for AGP SDK hello-world flows.",
      "demo",
      null,
      "active",
      nowIso,
      nowIso,
    ],
  });
}
