import { getDb } from "../db/client";
import { deleteCredential, hasCredential, retrieveCredential, storeCredential } from "./credential-store";

const SYSTEM_USER_ID = "__system__";

export interface AppOAuthCredential {
  clientId: string;
  clientSecret: string;
}

function normalizeService(service: string): string {
  return service.trim().toLowerCase();
}

export async function storeAppCredential(service: string, credential: AppOAuthCredential): Promise<void> {
  await storeCredential(SYSTEM_USER_ID, normalizeService(service), "app_oauth", {
    client_id: credential.clientId,
    client_secret: credential.clientSecret,
  });
}

export async function retrieveAppCredential(service: string): Promise<AppOAuthCredential> {
  const normalizedService = normalizeService(service);
  const payload = await retrieveCredential(SYSTEM_USER_ID, normalizedService);

  const clientId = payload.client_id;
  const clientSecret = payload.client_secret;
  if (typeof clientId !== "string" || clientId.trim() === "") {
    throw new Error(`Invalid app OAuth credential: missing client_id for service '${normalizedService}'.`);
  }
  if (typeof clientSecret !== "string" || clientSecret.trim() === "") {
    throw new Error(`Invalid app OAuth credential: missing client_secret for service '${normalizedService}'.`);
  }

  return {
    clientId,
    clientSecret,
  };
}

export async function deleteAppCredential(service: string): Promise<void> {
  await deleteCredential(SYSTEM_USER_ID, normalizeService(service));
}

export async function hasAppCredential(service: string): Promise<boolean> {
  return hasCredential(SYSTEM_USER_ID, normalizeService(service));
}

export async function listAppCredentials(): Promise<Array<{ service: string; createdAt: string; updatedAt: string }>> {
  const result = await getDb().execute({
    sql: `SELECT service_id, created_at, updated_at
      FROM credentials
      WHERE user_id = ? AND auth_type = ?
      ORDER BY service_id ASC`,
    args: [SYSTEM_USER_ID, "app_oauth"],
  });

  return result.rows.flatMap((row) => {
    const record = row as Record<string, unknown>;
    const service = record["service_id"];
    const createdAt = record["created_at"];
    const updatedAt = record["updated_at"];

    if (typeof service !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string") {
      return [];
    }

    return [
      {
        service,
        createdAt,
        updatedAt,
      },
    ];
  });
}

