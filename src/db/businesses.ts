import { getDb } from "./client";

export type BusinessStatus = "active" | "suspended" | "deleted";

export interface BusinessRecord {
  id: string;
  ownerId: string;
  name: string;
  platform: string;
  location: string | null;
  description: string | null;
  category: string | null;
  preferences: Record<string, unknown> | null;
  status: BusinessStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBusinessInput {
  id?: string;
  ownerId: string;
  name: string;
  platform: string;
  location?: string | null;
  description?: string | null;
  category?: string | null;
  preferences?: Record<string, unknown> | null;
  status?: BusinessStatus;
}

export interface UpdateBusinessInput {
  name?: string;
  location?: string | null;
  description?: string | null;
  category?: string | null;
  preferences?: Record<string, unknown> | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseStatus(value: unknown): BusinessStatus | null {
  if (value === "active" || value === "suspended" || value === "deleted") {
    return value;
  }

  return null;
}

function parsePreferences(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function serializePreferences(value: Record<string, unknown> | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return JSON.stringify(value);
}

function toBusinessRecord(row: Record<string, unknown> | undefined): BusinessRecord | null {
  if (!row) {
    return null;
  }

  const id = asString(row["id"]);
  const ownerId = asString(row["owner_id"]);
  const name = asString(row["name"]);
  const platform = asString(row["platform"]);
  const status = parseStatus(row["status"]);
  const createdAt = asString(row["created_at"]);
  const updatedAt = asString(row["updated_at"]);

  if (!id || !ownerId || !name || !platform || !status || !createdAt || !updatedAt) {
    return null;
  }

  return {
    id,
    ownerId,
    name,
    platform,
    location: asNullableString(row["location"]),
    description: asNullableString(row["description"]),
    category: asNullableString(row["category"]),
    preferences: parsePreferences(row["preferences"]),
    status,
    createdAt,
    updatedAt,
  };
}

function normalizeRequired(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }

  return normalized;
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export async function createBusiness(input: CreateBusinessInput): Promise<BusinessRecord> {
  const db = getDb();
  const id = input.id?.trim() || crypto.randomUUID();
  const ownerId = normalizeRequired(input.ownerId, "ownerId");
  const name = normalizeRequired(input.name, "name");
  const platform = normalizeRequired(input.platform, "platform").toLowerCase();
  const status = input.status ?? "active";
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
      id,
      ownerId,
      name,
      platform,
      normalizeOptional(input.location),
      normalizeOptional(input.description),
      normalizeOptional(input.category),
      serializePreferences(input.preferences),
      status,
      nowIso,
      nowIso,
    ],
  });

  const created = await getBusinessById(id);
  if (!created) {
    throw new Error("Failed to load created business");
  }

  return created;
}

export async function getBusinessById(id: string): Promise<BusinessRecord | null> {
  const businessId = id.trim();
  if (!businessId) {
    return null;
  }

  const result = await getDb().execute({
    sql: `SELECT
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
    FROM businesses
    WHERE id = ?`,
    args: [businessId],
  });

  return toBusinessRecord(result.rows[0] as Record<string, unknown> | undefined);
}

export async function listBusinessesByOwner(ownerId: string): Promise<BusinessRecord[]> {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId) {
    return [];
  }

  const result = await getDb().execute({
    sql: `SELECT
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
    FROM businesses
    WHERE owner_id = ? AND status = 'active'
    ORDER BY created_at DESC`,
    args: [normalizedOwnerId],
  });

  return result.rows
    .map((row) => toBusinessRecord(row as Record<string, unknown>))
    .filter((row): row is BusinessRecord => row !== null);
}

export async function listAllBusinesses(): Promise<BusinessRecord[]> {
  const result = await getDb().execute({
    sql: `SELECT
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
    FROM businesses
    ORDER BY created_at DESC`,
  });

  return result.rows
    .map((row) => toBusinessRecord(row as Record<string, unknown>))
    .filter((row): row is BusinessRecord => row !== null);
}

export async function updateBusiness(
  id: string,
  input: UpdateBusinessInput,
): Promise<BusinessRecord | null> {
  const existing = await getBusinessById(id);
  if (!existing || existing.status === "deleted") {
    return null;
  }

  const updates: string[] = [];
  const args: Array<string | null> = [];

  if (input.name !== undefined) {
    updates.push("name = ?");
    args.push(normalizeRequired(input.name, "name"));
  }

  if (input.location !== undefined) {
    updates.push("location = ?");
    args.push(normalizeOptional(input.location));
  }

  if (input.description !== undefined) {
    updates.push("description = ?");
    args.push(normalizeOptional(input.description));
  }

  if (input.category !== undefined) {
    updates.push("category = ?");
    args.push(normalizeOptional(input.category));
  }

  if (input.preferences !== undefined) {
    updates.push("preferences = ?");
    args.push(serializePreferences(input.preferences));
  }

  if (updates.length === 0) {
    return existing;
  }

  const nowIso = new Date().toISOString();
  updates.push("updated_at = ?");
  args.push(nowIso);
  args.push(existing.id);

  await getDb().execute({
    sql: `UPDATE businesses
      SET ${updates.join(", ")}
      WHERE id = ?`,
    args,
  });

  return getBusinessById(existing.id);
}

export async function deleteBusiness(id: string): Promise<void> {
  const businessId = id.trim();
  if (!businessId) {
    return;
  }

  await getDb().execute({
    sql: `UPDATE businesses
      SET status = 'deleted',
          updated_at = ?
      WHERE id = ?`,
    args: [new Date().toISOString(), businessId],
  });
}
