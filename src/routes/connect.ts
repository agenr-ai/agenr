import { Hono } from "hono";

import type { AdapterRegistry } from "../core/adapter-registry";
import { apiKeyAuthMiddleware } from "../middleware/auth";
import { logger } from "../utils/logger";
import { sanitizeProviderResponse } from "../utils/sanitize";
import { getBaseUrl } from "../connections/base-url";
import { cleanExpiredStates, createState, validateAndConsumeState } from "../connections/oauth-state";
import { hasAppCredential, retrieveAppCredential } from "../vault/app-credential-store";
import { storeCredential } from "../vault/credential-store";
import {
  logConnectionCompleted,
  logConnectionFailed,
  logConnectionInitiated,
  logCredentialStored,
} from "../vault/audit";
import type { CredentialPayload } from "../vault/types";
import type { OAuthManifestConfig } from "../adapters/manifest";

interface OAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  scopes?: string[];
}

function normalizeService(service: string): string {
  return service.trim().toLowerCase();
}

function firstForwardedIp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const first = value
    .split(",")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return first;
}

function clientIp(headers: Headers): string | undefined {
  return (
    firstForwardedIp(headers.get("x-forwarded-for") ?? undefined) ??
    headers.get("x-real-ip") ??
    headers.get("cf-connecting-ip") ??
    undefined
  );
}

function parseScopes(rawScope: unknown): string[] {
  if (typeof rawScope !== "string") {
    return [];
  }

  return rawScope
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

function parseExpiresIn(rawExpiresIn: unknown): number | undefined {
  if (typeof rawExpiresIn === "number" && Number.isFinite(rawExpiresIn) && rawExpiresIn > 0) {
    return rawExpiresIn;
  }

  if (typeof rawExpiresIn === "string" && rawExpiresIn.trim() !== "") {
    const parsed = Number(rawExpiresIn);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function parseTokenResponse(payload: Record<string, unknown>): OAuthTokenResponse {
  const accessToken = typeof payload["access_token"] === "string" ? payload["access_token"] : null;
  if (!accessToken) {
    throw new Error("OAuth token exchange did not return access_token");
  }

  return {
    accessToken,
    refreshToken: typeof payload["refresh_token"] === "string" ? payload["refresh_token"] : undefined,
    tokenType: typeof payload["token_type"] === "string" ? payload["token_type"] : undefined,
    expiresIn: parseExpiresIn(payload["expires_in"]),
    scopes: parseScopes(payload["scope"]),
  };
}

function buildCredentialPayload(tokenResponse: OAuthTokenResponse): CredentialPayload {
  return {
    access_token: tokenResponse.accessToken,
    refresh_token: tokenResponse.refreshToken,
    token_type: tokenResponse.tokenType,
    expires_in: tokenResponse.expiresIn,
  };
}

function buildTokenRequestBody(
  tokenContentType: "form" | "json" | undefined,
  params: Record<string, string>,
): { body: string; contentType: string } {
  if (tokenContentType === "json") {
    return {
      body: JSON.stringify(params),
      contentType: "application/json",
    };
  }

  return {
    body: new URLSearchParams(params).toString(),
    contentType: "application/x-www-form-urlencoded",
  };
}

async function getAppCredentials(
  service: string,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const normalizedService = normalizeService(service);

  try {
    return await retrieveAppCredential(normalizedService);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Credential not found")) {
      return null;
    }

    throw error;
  }
}

async function exchangeAuthorizationCode(
  oauth: OAuthManifestConfig,
  clientCredentials: { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
): Promise<OAuthTokenResponse> {
  const requestPayload: Record<string, string> = {
    client_id: clientCredentials.clientId,
    client_secret: clientCredentials.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  };
  const request = buildTokenRequestBody(oauth.tokenContentType, requestPayload);

  const response = await fetch(oauth.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": request.contentType,
      accept: "application/json",
    },
    body: request.body,
  });

  if (!response.ok) {
    const responseText = await response.text();
    const sanitized = sanitizeProviderResponse(responseText);
    throw new Error(`Token exchange failed (${response.status}): ${sanitized}`);
  }

  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Token exchange returned invalid payload");
  }

  return parseTokenResponse(payload as Record<string, unknown>);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toServiceTitle(service: string): string {
  return service
    .split(/[-_\s]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

export function createConnectRoutes(registry: AdapterRegistry): Hono {
  const connectApp = new Hono();

  connectApp.get("/services", apiKeyAuthMiddleware, async (c) => {
    const groupedByService = new Map<string, { name: string; platforms: Set<string> }>();
    for (const adapter of registry.listOAuthAdapters()) {
      const existing = groupedByService.get(adapter.oauthService);
      if (existing) {
        existing.platforms.add(adapter.platform);
      } else {
        groupedByService.set(adapter.oauthService, {
          name: adapter.name,
          platforms: new Set([adapter.platform]),
        });
      }
    }

    const services: Array<{ service: string; name: string; platforms: string[] }> = [];
    for (const [service, entry] of groupedByService.entries()) {
      if (await hasAppCredential(service)) {
        services.push({
          service,
          name: entry.name,
          platforms: Array.from(entry.platforms).sort((left, right) => left.localeCompare(right)),
        });
      }
    }

    services.sort((left, right) => left.name.localeCompare(right.name));

    return c.json({ services });
  });

  connectApp.get("/:service", apiKeyAuthMiddleware, async (c) => {
    const service = normalizeService(c.req.param("service"));
    const oauthAdapter = registry.getOAuthAdapter(service);
    if (!oauthAdapter) {
      return c.json({ error: "Unknown service" }, 400);
    }

    const clientCredentials = await getAppCredentials(oauthAdapter.oauthService);
    if (!clientCredentials) {
      const displayName = toServiceTitle(oauthAdapter.oauthService);
      return c.json(
        {
          error: `OAuth credentials for ${displayName} are not configured. Ask the admin to set up OAuth app credentials.`,
        },
        404,
      );
    }

    await cleanExpiredStates();
    const userId = c.get("userId") ?? c.get("apiKeyId") ?? "admin";
    const state = await createState(userId, oauthAdapter.oauthService);
    const requestIp = clientIp(c.req.raw.headers);
    await logConnectionInitiated(userId, oauthAdapter.oauthService, requestIp);
    const redirectUri = `${getBaseUrl()}/connect/${oauthAdapter.oauthService}/callback`;

    const params = new URLSearchParams({
      client_id: clientCredentials.clientId,
      state,
      response_type: "code",
      redirect_uri: redirectUri,
      ...(oauthAdapter.oauth.extraAuthParams ?? {}),
    });

    if (oauthAdapter.scopes.length > 0) {
      params.set("scope", oauthAdapter.scopes.join(" "));
    }

    return c.redirect(`${oauthAdapter.oauth.authorizationUrl}?${params.toString()}`, 302);
  });

  connectApp.get("/:service/callback", async (c) => {
    await cleanExpiredStates();

    const code = c.req.query("code");
    const state = c.req.query("state");
    const oauthError = c.req.query("error");
    const oauthErrorDescription = c.req.query("error_description");
    const requestIp = clientIp(c.req.raw.headers);

    if (oauthError) {
      const routeService = normalizeService(c.req.param("service"));
      let userId = "unknown";
      let serviceId = routeService;

      if (state) {
        const stateRecord = await validateAndConsumeState(state);
        if (stateRecord) {
          userId = stateRecord.userId;
          serviceId = stateRecord.service;
        }
      }

      await logConnectionFailed(userId, serviceId, requestIp, {
        error: oauthError,
        error_description: oauthErrorDescription,
      });

      return c.json({ error: "OAuth authorization failed", reason: oauthError }, 400);
    }

    if (!code || !state) {
      return c.json({ error: "Missing code or state parameter" }, 400);
    }

    const stateRecord = await validateAndConsumeState(state);
    if (!stateRecord) {
      return c.json({ error: "Invalid or expired state" }, 400);
    }

    const routeService = normalizeService(c.req.param("service"));
    if (routeService !== stateRecord.service) {
      await logConnectionFailed(stateRecord.userId, stateRecord.service, requestIp, {
        error: "service_mismatch",
        routeService,
        stateService: stateRecord.service,
      });
      return c.json({ error: "Invalid service callback" }, 400);
    }

    try {
      const oauthAdapter = registry.getOAuthAdapter(stateRecord.service);
      if (!oauthAdapter) {
        throw new Error(`Unknown service '${stateRecord.service}'`);
      }

      const clientCredentials = await getAppCredentials(oauthAdapter.oauthService);
      if (!clientCredentials) {
        throw new Error(`OAuth app credentials missing for service '${oauthAdapter.oauthService}'`);
      }

      const redirectUri = `${getBaseUrl()}/connect/${oauthAdapter.oauthService}/callback`;
      const tokenResponse = await exchangeAuthorizationCode(
        oauthAdapter.oauth,
        clientCredentials,
        code,
        redirectUri,
      );
      const credentialPayload = buildCredentialPayload(tokenResponse);
      const scopes = tokenResponse.scopes && tokenResponse.scopes.length > 0 ? tokenResponse.scopes : undefined;

      await storeCredential(stateRecord.userId, oauthAdapter.oauthService, "oauth2", credentialPayload, scopes);
      await logCredentialStored(stateRecord.userId, oauthAdapter.oauthService, requestIp);
      await logConnectionCompleted(stateRecord.userId, oauthAdapter.oauthService, requestIp);

      const serviceLabel = htmlEscape(toServiceTitle(oauthAdapter.oauthService));
      return c.html(`<!DOCTYPE html>
<html><body style="font-family:system-ui;text-align:center;padding:4rem">
  <h1>Connected to ${serviceLabel}!</h1>
  <p>You can close this window.</p>
</body></html>`);
    } catch (error) {
      logger.error("connect_callback_token_exchange_failed", {
        service: stateRecord.service,
        userId: stateRecord.userId,
        error,
      });
      await logConnectionFailed(stateRecord.userId, stateRecord.service, requestIp, {
        stage: "token_exchange",
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Token exchange failed" }, 502);
    }
  });

  return connectApp;
}
