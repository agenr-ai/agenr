import { getDb } from "../db/client";
import type { OAuthTokenContentType } from "../adapters/manifest";
import type { CredentialPayload } from "./types";
import { retrieveCredential, storeCredential } from "./credential-store";
import { retrieveAppCredential } from "./app-credential-store";
import { logCredentialRotated } from "./audit";
import { logger } from "../utils/logger";
import { sanitizeProviderResponse } from "../utils/sanitize";

const REFRESH_WINDOW_MS = 5 * 60 * 1000;

interface CredentialRefreshMetadata {
  authType: string;
  expiresAt: string | null;
  scopes: string[] | undefined;
}

interface RefreshResponse {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
}

export interface OAuthRefreshConfig {
  tokenUrl: string;
  tokenContentType?: OAuthTokenContentType;
}

function normalizeService(serviceId: string): string {
  return serviceId.trim().toLowerCase();
}

function parseJsonScopes(rawScopes: unknown): string[] | undefined {
  if (typeof rawScopes !== "string" || rawScopes.trim() === "") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawScopes) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const scopes = parsed.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0);
    return scopes.length > 0 ? scopes : undefined;
  } catch {
    return undefined;
  }
}

async function loadCredentialMetadata(
  userId: string,
  serviceId: string,
): Promise<CredentialRefreshMetadata | null> {
  const result = await getDb().execute({
    sql: `SELECT auth_type, expires_at, scopes
      FROM credentials
      WHERE user_id = ? AND service_id = ?
      LIMIT 1`,
    args: [userId, normalizeService(serviceId)],
  });

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }

  return {
    authType: typeof row["auth_type"] === "string" ? row["auth_type"] : "",
    expiresAt: typeof row["expires_at"] === "string" ? row["expires_at"] : null,
    scopes: parseJsonScopes(row["scopes"]),
  };
}

function shouldRefresh(expiresAt: string | null): boolean {
  if (!expiresAt) {
    return false;
  }

  const expiresMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresMs)) {
    return false;
  }

  return expiresMs <= Date.now() + REFRESH_WINDOW_MS;
}

function parseExpiresIn(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function parseRefreshResponse(payload: Record<string, unknown>): RefreshResponse {
  const accessToken = payload["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Token refresh response missing access_token");
  }

  return {
    accessToken,
    refreshToken: typeof payload["refresh_token"] === "string" ? payload["refresh_token"] : undefined,
    tokenType: typeof payload["token_type"] === "string" ? payload["token_type"] : undefined,
    expiresIn: parseExpiresIn(payload["expires_in"]),
  };
}

function buildRefreshBody(
  tokenContentType: OAuthTokenContentType | undefined,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): { body: string; contentType: string } {
  const payload = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  };

  if (tokenContentType === "json") {
    return {
      body: JSON.stringify(payload),
      contentType: "application/json",
    };
  }

  return {
    body: new URLSearchParams(payload).toString(),
    contentType: "application/x-www-form-urlencoded",
  };
}

function nextCredentialPayload(current: CredentialPayload, refreshed: RefreshResponse): CredentialPayload {
  return {
    access_token: refreshed.accessToken,
    refresh_token: refreshed.refreshToken ?? current.refresh_token,
    token_type: refreshed.tokenType ?? current.token_type,
    expires_in: refreshed.expiresIn ?? current.expires_in,
  };
}

async function getAppCredentials(serviceId: string): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    return await retrieveAppCredential(serviceId);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Credential not found")) {
      return null;
    }

    throw error;
  }
}

export async function refreshIfNeeded(
  userId: string,
  serviceId: string,
  oauth: OAuthRefreshConfig | null,
  force?: boolean,
): Promise<void> {
  const normalizedServiceId = normalizeService(serviceId);
  const credential = await loadCredentialMetadata(userId, normalizedServiceId);
  if (
    !credential ||
    credential.authType !== "oauth2" ||
    (!force && !shouldRefresh(credential.expiresAt))
  ) {
    return;
  }

  const decrypted = await retrieveCredential(userId, normalizedServiceId);
  if (!decrypted.refresh_token) {
    return;
  }

  if (!oauth) {
    logger.warn("token_refresh_provider_not_configured", {
      userId,
      serviceId: normalizedServiceId,
    });
    return;
  }

  const clientCredentials = await getAppCredentials(normalizedServiceId);
  if (!clientCredentials) {
    logger.warn("token_refresh_client_credentials_missing", {
      userId,
      serviceId: normalizedServiceId,
      source: "vault",
    });
    return;
  }

  try {
    const request = buildRefreshBody(
      oauth.tokenContentType,
      clientCredentials.clientId,
      clientCredentials.clientSecret,
      decrypted.refresh_token,
    );
    const response = await fetch(oauth.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": request.contentType,
        accept: "application/json",
      },
      body: request.body,
    });
    if (!response.ok) {
      const body = await response.text();
      const sanitized = sanitizeProviderResponse(body);
      throw new Error(`Token refresh failed (${response.status}): ${sanitized}`);
    }

    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Token refresh response is invalid");
    }

    const refreshed = parseRefreshResponse(payload as Record<string, unknown>);
    await storeCredential(
      userId,
      normalizedServiceId,
      "oauth2",
      nextCredentialPayload(decrypted, refreshed),
      credential.scopes,
    );
    await logCredentialRotated(userId, normalizedServiceId);
  } catch (error) {
    logger.warn("token_refresh_failed", {
      userId,
      serviceId: normalizedServiceId,
      error,
    });
  }
}
