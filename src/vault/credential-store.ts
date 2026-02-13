import { decryptDataKey, generateDataKey, getVaultKmsKeyId } from "./kms";
import { encrypt, withDecryptedCredential, zeroFill } from "./encryption";
import type { AuthType, CredentialPayload, EncryptedBlob, StoredCredential } from "./types";
import { getDb } from "../db/client";

function normalizeServiceId(serviceId: string): string {
  return serviceId.trim().toLowerCase();
}

function readBlob(value: unknown, fieldName: string): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value));
  }

  throw new Error(`Expected ${fieldName} to be a BLOB.`);
}

function parseAuthType(value: unknown): AuthType | null {
  if (
    value === "oauth2" ||
    value === "api_key" ||
    value === "cookie" ||
    value === "basic" ||
    value === "app_oauth" ||
    value === "client_credentials"
  ) {
    return value;
  }

  return null;
}

function mapStoredCredential(row: Record<string, unknown>): StoredCredential | null {
  const id = row["id"];
  const userId = row["user_id"];
  const serviceId = row["service_id"];
  const authType = parseAuthType(row["auth_type"]);
  const createdAt = row["created_at"];
  const updatedAt = row["updated_at"];

  if (
    typeof id !== "string" ||
    typeof userId !== "string" ||
    typeof serviceId !== "string" ||
    !authType ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id,
    userId,
    serviceId,
    authType,
    scopes: typeof row["scopes"] === "string" ? row["scopes"] : null,
    expiresAt: typeof row["expires_at"] === "string" ? row["expires_at"] : null,
    lastUsedAt: typeof row["last_used_at"] === "string" ? row["last_used_at"] : null,
    createdAt,
    updatedAt,
  };
}

function getExpiresAt(authType: AuthType, payload: CredentialPayload): string | null {
  if (authType !== "oauth2" || typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in)) {
    return null;
  }

  const expiresMs = Date.now() + payload.expires_in * 1000;
  return new Date(expiresMs).toISOString();
}

async function getOrCreateUserDek(userId: string): Promise<Buffer> {
  const db = getDb();
  const keyResult = await db.execute({
    sql: `SELECT encrypted_dek
      FROM user_keys
      WHERE user_id = ?`,
    args: [userId],
  });

  const existingKeyRow = keyResult.rows[0] as Record<string, unknown> | undefined;
  if (existingKeyRow) {
    const encryptedDek = readBlob(existingKeyRow["encrypted_dek"], "user_keys.encrypted_dek");
    return decryptDataKey(encryptedDek);
  }

  const generated = await generateDataKey(getVaultKmsKeyId());
  const now = new Date().toISOString();

  try {
    await db.execute({
      sql: `INSERT INTO user_keys (
        user_id,
        encrypted_dek,
        kms_key_id,
        created_at,
        rotated_at
      ) VALUES (?, ?, ?, ?, ?)`,
      args: [userId, generated.encrypted, getVaultKmsKeyId(), now, null],
    });

    return generated.plaintext;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (!message.includes("unique")) {
      throw error;
    }

    zeroFill(generated.plaintext);

    const retryResult = await db.execute({
      sql: `SELECT encrypted_dek
        FROM user_keys
        WHERE user_id = ?`,
      args: [userId],
    });
    const retryRow = retryResult.rows[0] as Record<string, unknown> | undefined;
    if (!retryRow) {
      throw error;
    }

    const encryptedDek = readBlob(retryRow["encrypted_dek"], "user_keys.encrypted_dek");
    return decryptDataKey(encryptedDek);
  }
}

export async function storeCredential(
  userId: string,
  serviceId: string,
  authType: AuthType,
  payload: CredentialPayload,
  scopes?: string[],
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const normalizedServiceId = normalizeServiceId(serviceId);

  let dek: Buffer | null = null;
  let payloadBuffer: Buffer | null = null;

  try {
    dek = await getOrCreateUserDek(userId);
    payloadBuffer = Buffer.from(JSON.stringify(payload), "utf8");
    const encryptedPayload = encrypt(payloadBuffer, dek);

    await db.execute({
      sql: `INSERT INTO credentials (
        id,
        user_id,
        service_id,
        auth_type,
        encrypted_payload,
        iv,
        auth_tag,
        scopes,
        expires_at,
        last_used_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, service_id) DO UPDATE SET
        id = excluded.id,
        auth_type = excluded.auth_type,
        encrypted_payload = excluded.encrypted_payload,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        scopes = excluded.scopes,
        expires_at = excluded.expires_at,
        last_used_at = NULL,
        updated_at = excluded.updated_at`,
      args: [
        id,
        userId,
        normalizedServiceId,
        authType,
        encryptedPayload.ciphertext,
        encryptedPayload.iv,
        encryptedPayload.authTag,
        scopes ? JSON.stringify(scopes) : null,
        getExpiresAt(authType, payload),
        null,
        now,
        now,
      ],
    });
  } finally {
    if (payloadBuffer) {
      zeroFill(payloadBuffer);
    }
    if (dek) {
      zeroFill(dek);
    }
  }
}

export async function retrieveCredential(userId: string, serviceId: string): Promise<CredentialPayload> {
  const db = getDb();
  const normalizedServiceId = normalizeServiceId(serviceId);

  const result = await db.execute({
    sql: `SELECT
      c.encrypted_payload,
      c.iv,
      c.auth_tag,
      u.encrypted_dek
    FROM credentials c
    INNER JOIN user_keys u ON c.user_id = u.user_id
    WHERE c.user_id = ? AND c.service_id = ?`,
    args: [userId, normalizedServiceId],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error(`Credential not found for service '${normalizedServiceId}'.`);
  }

  const encryptedBlob: EncryptedBlob = {
    ciphertext: readBlob(row["encrypted_payload"], "credentials.encrypted_payload"),
    iv: readBlob(row["iv"], "credentials.iv"),
    authTag: readBlob(row["auth_tag"], "credentials.auth_tag"),
  };
  const encryptedDek = readBlob(row["encrypted_dek"], "user_keys.encrypted_dek");

  return withDecryptedCredential(encryptedDek, encryptedBlob, async (credential) => {
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE credentials
        SET last_used_at = ?, updated_at = ?
        WHERE user_id = ? AND service_id = ?`,
      args: [now, now, userId, normalizedServiceId],
    });

    return credential;
  });
}

export async function deleteCredential(userId: string, serviceId: string): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `DELETE FROM credentials
      WHERE user_id = ? AND service_id = ?`,
    args: [userId, normalizeServiceId(serviceId)],
  });
}

export async function listConnections(userId: string): Promise<StoredCredential[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT
      id,
      user_id,
      service_id,
      auth_type,
      scopes,
      expires_at,
      last_used_at,
      created_at,
      updated_at
    FROM credentials
    WHERE user_id = ?
    ORDER BY created_at DESC`,
    args: [userId],
  });

  return result.rows
    .map((row) => mapStoredCredential(row as Record<string, unknown>))
    .filter((connection): connection is StoredCredential => connection !== null);
}

export async function hasCredential(userId: string, serviceId: string): Promise<boolean> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT id
      FROM credentials
      WHERE user_id = ? AND service_id = ?
      LIMIT 1`,
    args: [userId, normalizeServiceId(serviceId)],
  });

  return result.rows.length > 0;
}
