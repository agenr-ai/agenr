import { getDb } from "./client";

export type AuthProvider = "google" | "github";

export interface UserRecord {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  provider: AuthProvider;
  providerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertOAuthUserInput {
  provider: AuthProvider;
  providerId: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toUserRecord(row: Record<string, unknown> | undefined): UserRecord | null {
  if (!row) {
    return null;
  }

  const id = asString(row["id"]);
  const email = asString(row["email"]);
  const provider = asString(row["provider"]);
  const providerId = asString(row["provider_id"]);
  const createdAt = asString(row["created_at"]);
  const updatedAt = asString(row["updated_at"]);

  if (!id || !email || !provider || !providerId || !createdAt || !updatedAt) {
    return null;
  }

  if (provider !== "google" && provider !== "github") {
    return null;
  }

  return {
    id,
    email,
    name: asNullableString(row["name"]),
    avatarUrl: asNullableString(row["avatar_url"]),
    provider,
    providerId,
    createdAt,
    updatedAt,
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  const result = await getDb().execute({
    sql: `SELECT
      id,
      email,
      name,
      avatar_url,
      provider,
      provider_id,
      created_at,
      updated_at
    FROM users
    WHERE id = ?`,
    args: [id],
  });

  return toUserRecord(result.rows[0] as Record<string, unknown> | undefined);
}

export async function findUserByProvider(
  provider: AuthProvider,
  providerId: string,
): Promise<UserRecord | null> {
  const result = await getDb().execute({
    sql: `SELECT
      id,
      email,
      name,
      avatar_url,
      provider,
      provider_id,
      created_at,
      updated_at
    FROM users
    WHERE provider = ? AND provider_id = ?`,
    args: [provider, providerId],
  });

  return toUserRecord(result.rows[0] as Record<string, unknown> | undefined);
}

export async function upsertOAuthUser(input: UpsertOAuthUserInput): Promise<UserRecord> {
  const db = getDb();
  const providerId = input.providerId.trim();
  const email = normalizeEmail(input.email);
  const name = input.name?.trim() || null;
  const avatarUrl = input.avatarUrl?.trim() || null;
  const now = new Date().toISOString();

  if (!providerId) {
    throw new Error("providerId is required");
  }
  if (!email) {
    throw new Error("email is required");
  }

  const existing = await findUserByProvider(input.provider, providerId);
  if (existing) {
    const needsUpdate =
      existing.email !== email ||
      (existing.name ?? null) !== name ||
      (existing.avatarUrl ?? null) !== avatarUrl;

    if (!needsUpdate) {
      return existing;
    }

    await db.execute({
      sql: `UPDATE users
        SET email = ?, name = ?, avatar_url = ?, updated_at = ?
        WHERE id = ?`,
      args: [email, name, avatarUrl, now, existing.id],
    });

    const updated = await getUserById(existing.id);
    if (!updated) {
      throw new Error("Failed to reload updated user");
    }

    return updated;
  }

  const id = crypto.randomUUID();
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
    args: [id, email, name, avatarUrl, input.provider, providerId, now, now],
  });

  const created = await getUserById(id);
  if (!created) {
    throw new Error("Failed to load created user");
  }

  return created;
}
