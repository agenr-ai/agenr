import { getDb } from "./client";

export type ApiKeyTier = "free" | "paid" | "admin";

export interface ApiKey {
  id: string;
  keyHash: string;
  label: string;
  tier: ApiKeyTier;
  userId: string | null;
  ownerEmail: string | null;
  scopes: string[];
  rateLimitOverride: number | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export const FREE_TIER_SCOPES = ["discover", "query", "execute"] as const;
export const PAID_TIER_SCOPES = ["discover", "query", "execute", "generate"] as const;

const API_KEY_FORMAT_PREFIX = "agenr";
const RAW_KEY_RANDOM_BYTES = 16; // 16 bytes => 32 hex chars

function normalizeScopes(scopes: string[]): string[] {
  const deduped = new Set<string>();

  for (const scope of scopes) {
    const normalized = scope.trim().toLowerCase();
    if (normalized.length === 0) {
      continue;
    }
    deduped.add(normalized);
  }

  return Array.from(deduped.values());
}

function defaultScopesForTier(tier: Exclude<ApiKeyTier, "admin">): string[] {
  if (tier === "paid") {
    return [...PAID_TIER_SCOPES];
  }
  return [...FREE_TIER_SCOPES];
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function generateRawKey(tier: Exclude<ApiKeyTier, "admin">): string {
  const randomBytes = new Uint8Array(RAW_KEY_RANDOM_BYTES);
  crypto.getRandomValues(randomBytes);
  return `${API_KEY_FORMAT_PREFIX}_${tier}_${toHex(randomBytes)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toHex(new Uint8Array(digest));
}

function readNumericValue(value: unknown): number | null {
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

function parseTier(value: unknown): ApiKeyTier | null {
  if (value === "free" || value === "paid" || value === "admin") {
    return value;
  }
  return null;
}

function parseScopes(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return normalizeScopes(value.split(","));
}

function toApiKey(row: Record<string, unknown>): ApiKey | null {
  const id = row["id"];
  const keyHash = row["key_hash"];
  const label = row["label"];
  const tier = parseTier(row["tier"]);
  const createdAt = row["created_at"];

  if (
    typeof id !== "string" ||
    typeof keyHash !== "string" ||
    typeof label !== "string" ||
    !tier ||
    typeof createdAt !== "string"
  ) {
    return null;
  }

  const ownerEmail = row["owner_email"];
  const userId = row["user_id"];
  const lastUsedAt = row["last_used_at"];

  return {
    id,
    keyHash,
    label,
    tier,
    userId: typeof userId === "string" ? userId : null,
    ownerEmail: typeof ownerEmail === "string" ? ownerEmail : null,
    scopes: tier === "admin" ? ["*"] : parseScopes(row["scopes"]),
    rateLimitOverride: readNumericValue(row["rate_limit_override"]),
    createdAt,
    lastUsedAt: typeof lastUsedAt === "string" ? lastUsedAt : null,
  };
}

export async function createApiKey(params: {
  label: string;
  tier: "free" | "paid";
  userId?: string;
  ownerEmail?: string;
  scopes?: string[];
}): Promise<{ raw: string; record: ApiKey }> {
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const label = params.label.trim();
  const ownerEmail = params.ownerEmail?.trim() || null;
  const userId = params.userId?.trim() || null;
  const scopes = params.scopes ? normalizeScopes(params.scopes) : defaultScopesForTier(params.tier);
  const raw = generateRawKey(params.tier);
  const keyHash = await sha256Hex(raw);

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
    args: [id, keyHash, label, params.tier, userId, ownerEmail, scopes.join(","), null, createdAt, null],
  });

  return {
    raw,
    record: {
      id,
      keyHash,
      label,
      tier: params.tier,
      userId,
      ownerEmail,
      scopes,
      rateLimitOverride: null,
      createdAt,
      lastUsedAt: null,
    },
  };
}

export async function resolveApiKey(rawKey: string): Promise<ApiKey | null> {
  const key = rawKey.trim();
  if (!key) {
    return null;
  }

  const db = getDb();
  const keyHash = await sha256Hex(key);
  const result = await db.execute({
    sql: `SELECT
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
    FROM api_keys
    WHERE key_hash = ?`,
    args: [keyHash],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return toApiKey(row);
}

export async function getApiKeyById(id: string): Promise<ApiKey | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT
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
    FROM api_keys
    WHERE id = ?`,
    args: [id],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return toApiKey(row);
}

export async function touchApiKey(id: string): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: "UPDATE api_keys SET last_used_at = ? WHERE id = ?",
    args: [new Date().toISOString(), id],
  });
}

export async function listApiKeys(): Promise<ApiKey[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT
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
    FROM api_keys
    ORDER BY created_at DESC`,
  });

  return result.rows
    .map((row) => toApiKey(row as Record<string, unknown>))
    .filter((row): row is ApiKey => row !== null);
}

export async function revokeApiKey(id: string): Promise<boolean> {
  const db = getDb();
  const existing = await db.execute({
    sql: "SELECT id FROM api_keys WHERE id = ?",
    args: [id],
  });

  if (existing.rows.length === 0) {
    return false;
  }

  await db.execute({
    sql: "DELETE FROM api_keys WHERE id = ?",
    args: [id],
  });

  return true;
}

export async function linkApiKeyToUser(id: string, userId: string): Promise<boolean> {
  const apiKeyId = id.trim();
  const normalizedUserId = userId.trim();
  if (!apiKeyId || !normalizedUserId) {
    return false;
  }

  const db = getDb();
  const existing = await db.execute({
    sql: "SELECT id FROM api_keys WHERE id = ?",
    args: [apiKeyId],
  });
  if (existing.rows.length === 0) {
    return false;
  }

  await db.execute({
    sql: "UPDATE api_keys SET user_id = ? WHERE id = ?",
    args: [normalizedUserId, apiKeyId],
  });

  return true;
}
