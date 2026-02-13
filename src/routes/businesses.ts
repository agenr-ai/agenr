import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import type { OAuthManifestConfig } from "../adapters/manifest";
import type { AdapterRegistry } from "../core/adapter-registry";
import {
  createBusiness,
  deleteBusiness,
  getBusinessById,
  listAllBusinesses,
  listBusinessesByOwner,
  updateBusiness,
} from "../db/businesses";
import { getBaseUrl } from "../connections/base-url";
import { cleanExpiredStates, createState } from "../connections/oauth-state";
import { apiKeyAuthMiddleware, requireScope } from "../middleware/auth";
import { parseJsonBody } from "../utils/json-body";
import { hasAppCredential, retrieveAppCredential } from "../vault/app-credential-store";
import { logConnectionInitiated, logCredentialRevokedByAdmin } from "../vault/audit";
import { getUserAuditActivityByActions } from "../vault/audit-queries";
import type { AuditAction } from "../vault/audit-types";
import { deleteCredential, hasCredential, listConnections } from "../vault/credential-store";

const createBusinessSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  platform: z.string().trim().min(1, "platform is required"),
  location: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
});

const updateBusinessSchema = z.object({
  name: z.string().trim().min(1, "name cannot be empty").optional(),
  platform: z.string().optional(),
  location: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  preferences: z.record(z.string(), z.unknown()).nullable().optional(),
});

const BUSINESS_ACTIVITY_ACTIONS: AuditAction[] = [
  "credential_retrieved",
  "credential_stored",
  "connection_completed",
  "connection_failed",
];
const DEFAULT_ACTIVITY_LIMIT = 20;
const MAX_ACTIVITY_LIMIT = 200;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function resolveOwnerId(c: Context): string {
  return c.get("userId") ?? c.get("apiKeyId") ?? "admin";
}

function isAdmin(c: Context): boolean {
  const tier = c.get("apiKeyTier");
  const scopes = c.get("apiKeyScopes") ?? [];
  return tier === "admin" || scopes.includes("*");
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function randomSuffix(length = 4): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, length);
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.toLowerCase().includes("unique constraint failed");
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

function toServiceTitle(service: string): string {
  return service
    .split(/[-_\s]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

function parseScopes(scopes: string | null): string[] {
  if (!scopes) {
    return [];
  }

  try {
    const parsed = JSON.parse(scopes) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function normalizeActivityLimit(rawLimit: string | undefined): number {
  if (!rawLimit?.trim()) {
    return DEFAULT_ACTIVITY_LIMIT;
  }

  const parsed = Number(rawLimit);
  if (!Number.isInteger(parsed)) {
    return DEFAULT_ACTIVITY_LIMIT;
  }

  if (parsed < 1) {
    return 1;
  }

  return Math.min(parsed, MAX_ACTIVITY_LIMIT);
}

function parseBeforeCursor(before: string | undefined): string | null {
  if (!before?.trim()) {
    return null;
  }

  const value = before.trim();
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return value;
}

async function getAppCredentials(
  service: string,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const normalizedService = normalizeService(service);

  if (!(await hasAppCredential(normalizedService))) {
    return null;
  }

  try {
    return await retrieveAppCredential(normalizedService);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Credential not found")) {
      return null;
    }

    throw error;
  }
}

function resolveBusinessOauthConfig(
  registry: AdapterRegistry,
  platform: string,
): { oauth: OAuthManifestConfig; oauthService: string; scopes: string[] } | null {
  const entry = registry.getPublicEntry(platform);
  const manifest = entry?.manifest;
  if (!manifest || manifest.auth.type !== "oauth2" || !manifest.auth.oauth) {
    return null;
  }

  const oauthService = normalizeService(manifest.auth.oauth.oauthService ?? platform);
  if (!oauthService) {
    return null;
  }

  return {
    oauth: manifest.auth.oauth,
    oauthService,
    scopes: manifest.auth.scopes ?? [],
  };
}

function resolveBusinessAvailableServices(registry: AdapterRegistry, platform: string): string[] {
  const oauthConfig = resolveBusinessOauthConfig(registry, platform);
  if (!oauthConfig) {
    return [];
  }

  return [oauthConfig.oauthService];
}

function checkBusinessAccess(
  c: Context,
  ownerId: string,
  businessOwnerId: string,
): Response | null {
  if (!isAdmin(c) && businessOwnerId !== ownerId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  return null;
}

async function createUniqueBusinessId(name: string): Promise<string> {
  const base = toSlug(name) || "business";
  const existing = await getBusinessById(base);
  if (!existing) {
    return base;
  }

  let candidate = `${base}-${randomSuffix()}`;
  while (await getBusinessById(candidate)) {
    candidate = `${base}-${randomSuffix()}`;
  }

  return candidate;
}

async function handleBusinessConnect(
  c: Context,
  registry: AdapterRegistry,
): Promise<Response> {
  const ownerId = resolveOwnerId(c);
  const id = c.req.param("id");
  const business = await getBusinessById(id);

  if (!business || business.status === "deleted") {
    return c.json({ error: "Business not found" }, 404);
  }

  const accessError = checkBusinessAccess(c, ownerId, business.ownerId);
  if (accessError) {
    return accessError;
  }

  const oauthConfig = resolveBusinessOauthConfig(registry, business.platform);
  if (!oauthConfig) {
    return c.json({ error: "Business platform does not support OAuth" }, 400);
  }

  const requestedService = normalizeService(c.req.param("service"));
  if (requestedService !== oauthConfig.oauthService) {
    return c.json(
      {
        error: `Invalid service '${requestedService}' for business platform '${business.platform}'`,
      },
      400,
    );
  }

  const clientCredentials = await getAppCredentials(oauthConfig.oauthService);
  if (!clientCredentials) {
    const displayName = toServiceTitle(oauthConfig.oauthService);
    return c.json(
      {
        error: `OAuth credentials for ${displayName} are not configured. Ask the admin to set up OAuth app credentials.`,
      },
      404,
    );
  }

  await cleanExpiredStates();
  const state = await createState(business.ownerId, oauthConfig.oauthService);
  const requestIp = clientIp(c.req.raw.headers);
  await logConnectionInitiated(business.ownerId, oauthConfig.oauthService, requestIp);
  const redirectUri = `${getBaseUrl()}/connect/${oauthConfig.oauthService}/callback`;

  const params = new URLSearchParams({
    client_id: clientCredentials.clientId,
    state,
    response_type: "code",
    redirect_uri: redirectUri,
    ...(oauthConfig.oauth.extraAuthParams ?? {}),
  });

  if (oauthConfig.scopes.length > 0) {
    params.set("scope", oauthConfig.scopes.join(" "));
  }

  return c.redirect(`${oauthConfig.oauth.authorizationUrl}?${params.toString()}`, 302);
}

export function createBusinessRoutes(registry: AdapterRegistry): Hono {
  const businessApp = new Hono();
  businessApp.use("*", apiKeyAuthMiddleware);

  businessApp.post("/", async (c) => {
    const parsedBody = await parseJsonBody(c);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const parsed = createBusinessSchema.safeParse(parsedBody.data);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsed.error),
        },
        400,
      );
    }

    const ownerId = resolveOwnerId(c);
    const name = parsed.data.name.trim();
    const platform = parsed.data.platform.trim().toLowerCase();
    const slugId = await createUniqueBusinessId(name);

    try {
      const created = await createBusiness({
        id: slugId,
        ownerId,
        name,
        platform,
        location: parsed.data.location,
        description: parsed.data.description,
        category: parsed.data.category,
        preferences: parsed.data.preferences,
      });

      return c.json(created);
    } catch (error) {
      // Handle rare race where another request inserts the same slug between check and insert.
      if (isUniqueViolation(error)) {
        const created = await createBusiness({
          id: `${toSlug(name) || "business"}-${randomSuffix()}`,
          ownerId,
          name,
          platform,
          location: parsed.data.location,
          description: parsed.data.description,
          category: parsed.data.category,
          preferences: parsed.data.preferences,
        });

        return c.json(created);
      }

      throw error;
    }
  });

  businessApp.get("/", async (c) => {
    const ownerId = resolveOwnerId(c);
    const includeAll = c.req.query("all") === "true";

    if (includeAll && isAdmin(c)) {
      const rows = await listAllBusinesses();
      return c.json(rows);
    }

    const rows = await listBusinessesByOwner(ownerId);
    return c.json(rows);
  });

  businessApp.get("/:id/connection-status", async (c) => {
    const ownerId = resolveOwnerId(c);
    const id = c.req.param("id");
    const business = await getBusinessById(id);

    if (!business || business.status === "deleted") {
      return c.json({ error: "Business not found" }, 404);
    }

    const accessError = checkBusinessAccess(c, ownerId, business.ownerId);
    if (accessError) {
      return accessError;
    }

    const availableServices = resolveBusinessAvailableServices(registry, business.platform);
    const primaryService = availableServices[0];
    if (!primaryService) {
      return c.json({ connected: false, service: "", availableServices });
    }

    const connected = await hasCredential(business.ownerId, primaryService);
    return c.json({
      connected,
      service: primaryService,
      availableServices,
    });
  });

  businessApp.get("/:id/activity", async (c) => {
    const ownerId = resolveOwnerId(c);
    const business = await getBusinessById(c.req.param("id"));

    if (!business || business.status === "deleted") {
      return c.json({ error: "Business not found" }, 404);
    }

    const accessError = checkBusinessAccess(c, ownerId, business.ownerId);
    if (accessError) {
      return accessError;
    }

    const limit = normalizeActivityLimit(c.req.query("limit"));
    const beforeParam = c.req.query("before");
    const before = parseBeforeCursor(beforeParam);
    if (beforeParam !== undefined && before === null) {
      return c.json({ error: "Invalid before cursor" }, 400);
    }

    const result = await getUserAuditActivityByActions({
      userId: business.ownerId,
      actions: BUSINESS_ACTIVITY_ACTIONS,
      limit,
      before: before ?? undefined,
    });

    return c.json({
      businessId: business.id,
      entries: result.entries.map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        action: entry.action,
        service: entry.serviceId,
        metadata: entry.metadata ?? null,
      })),
      has_more: result.hasMore,
    });
  });

  businessApp.get("/:id/connect/:service", async (c) => {
    return handleBusinessConnect(c, registry);
  });

  businessApp.post("/:id/connect/:service", async (c) => {
    return handleBusinessConnect(c, registry);
  });

  businessApp.get("/:id/connections", requireScope("admin"), async (c) => {
    const business = await getBusinessById(c.req.param("id"));
    if (!business || business.status === "deleted") {
      return c.json({ error: "Business not found" }, 404);
    }

    const availableServices = resolveBusinessAvailableServices(registry, business.platform);
    const relevantServiceSet = new Set(availableServices);
    const connections = await listConnections(business.ownerId);
    const filteredConnections =
      relevantServiceSet.size === 0
        ? []
        : connections.filter((connection) => relevantServiceSet.has(normalizeService(connection.serviceId)));

    return c.json({
      businessId: business.id,
      ownerId: business.ownerId,
      platform: business.platform,
      availableServices,
      connections: filteredConnections.map((connection) => ({
        service: connection.serviceId,
        authType: connection.authType,
        scopes: parseScopes(connection.scopes),
        expiresAt: connection.expiresAt,
        lastUsedAt: connection.lastUsedAt,
        createdAt: connection.createdAt,
      })),
    });
  });

  businessApp.delete("/:id/connections/:service", requireScope("admin"), async (c) => {
    const business = await getBusinessById(c.req.param("id"));
    if (!business || business.status === "deleted") {
      return c.json({ error: "Business not found" }, 404);
    }

    const service = normalizeService(c.req.param("service"));
    if (!(await hasCredential(business.ownerId, service))) {
      return c.json({ error: "No connection found for service" }, 404);
    }

    await deleteCredential(business.ownerId, service);
    await logCredentialRevokedByAdmin(
      business.ownerId,
      service,
      c.get("userId") ?? c.get("apiKeyId") ?? "admin",
    );

    return c.json({
      message: "Connection disconnected",
      service,
      businessId: business.id,
    });
  });

  businessApp.get("/:id", async (c) => {
    const ownerId = resolveOwnerId(c);
    const business = await getBusinessById(c.req.param("id"));

    if (!business || business.status === "deleted") {
      return c.json({ error: "Business not found" }, 404);
    }

    const accessError = checkBusinessAccess(c, ownerId, business.ownerId);
    if (accessError) {
      return accessError;
    }

    return c.json(business);
  });

  businessApp.put("/:id", async (c) => {
    const ownerId = resolveOwnerId(c);
    const id = c.req.param("id");
    const business = await getBusinessById(id);

    if (!business || business.status === "deleted") {
      return c.json({ error: "Business not found" }, 404);
    }

    const accessError = checkBusinessAccess(c, ownerId, business.ownerId);
    if (accessError) {
      return accessError;
    }

    const parsedBody = await parseJsonBody(c);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }

    const parsed = updateBusinessSchema.safeParse(parsedBody.data);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request",
          details: z.treeifyError(parsed.error),
        },
        400,
      );
    }

    if (parsed.data.platform !== undefined) {
      return c.json({ error: "platform cannot be changed" }, 400);
    }

    try {
      const updated = await updateBusiness(id, {
        name: parsed.data.name,
        location: parsed.data.location,
        description: parsed.data.description,
        category: parsed.data.category,
        preferences: parsed.data.preferences,
      });

      if (!updated || updated.status === "deleted") {
        return c.json({ error: "Business not found" }, 404);
      }

      return c.json(updated);
    } catch (error) {
      if (error instanceof Error && error.message === "name is required") {
        return c.json({ error: "name cannot be empty" }, 400);
      }

      throw error;
    }
  });

  businessApp.delete("/:id", async (c) => {
    const ownerId = resolveOwnerId(c);
    const id = c.req.param("id");
    const business = await getBusinessById(id);

    if (!business || business.status === "deleted") {
      return c.json({ error: "Business not found" }, 404);
    }

    const accessError = checkBusinessAccess(c, ownerId, business.ownerId);
    if (accessError) {
      return accessError;
    }

    await deleteBusiness(id);
    return c.json({ status: "deleted" });
  });

  return businessApp;
}
