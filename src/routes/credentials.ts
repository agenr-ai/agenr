import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { apiKeyAuthMiddleware } from "../middleware/auth";
import { parseJsonBody } from "../utils/json-body";
import { isValidServiceIdentifier } from "../utils/validation";
import { deleteCredential, hasCredential, listConnections, storeCredential } from "../vault/credential-store";
import { getServiceAuditActivity } from "../vault/audit-queries";
import { logCredentialDeleted, logCredentialStored } from "../vault/audit";
import type { CredentialPayload } from "../vault/types";

const manualAuthTypeSchema = z.enum(["api_key", "cookie", "basic", "client_credentials"]);
const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 200;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const createCredentialSchema = z
  .object({
    auth_type: manualAuthTypeSchema,
    api_key: z.string().trim().min(1).optional(),
    cookie_name: z.string().trim().min(1).optional(),
    cookie_value: z.string().trim().min(1).optional(),
    username: z.string().trim().min(1).optional(),
    password: z.string().trim().min(1).optional(),
    client_id: z.string().trim().min(1).optional(),
    client_secret: z.string().trim().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.auth_type === "api_key" && !value.api_key) {
      context.addIssue({
        path: ["api_key"],
        code: z.ZodIssueCode.custom,
        message: "api_key is required for auth_type=api_key",
      });
    }

    if (value.auth_type === "cookie") {
      if (!value.cookie_name) {
        context.addIssue({
          path: ["cookie_name"],
          code: z.ZodIssueCode.custom,
          message: "cookie_name is required for auth_type=cookie",
        });
      }
      if (!value.cookie_value) {
        context.addIssue({
          path: ["cookie_value"],
          code: z.ZodIssueCode.custom,
          message: "cookie_value is required for auth_type=cookie",
        });
      }
    }

    if (value.auth_type === "basic") {
      if (!value.username) {
        context.addIssue({
          path: ["username"],
          code: z.ZodIssueCode.custom,
          message: "username is required for auth_type=basic",
        });
      }
      if (!value.password) {
        context.addIssue({
          path: ["password"],
          code: z.ZodIssueCode.custom,
          message: "password is required for auth_type=basic",
        });
      }
    }

    if (value.auth_type === "client_credentials") {
      if (!value.client_id) {
        context.addIssue({
          path: ["client_id"],
          code: z.ZodIssueCode.custom,
          message: "client_id is required for auth_type=client_credentials",
        });
      }
      if (!value.client_secret) {
        context.addIssue({
          path: ["client_secret"],
          code: z.ZodIssueCode.custom,
          message: "client_secret is required for auth_type=client_credentials",
        });
      }
    }
  });

function resolveUserId(c: Context): string {
  return c.get("userId") ?? c.get("apiKeyId") ?? "admin";
}

function normalizeService(service: string): string {
  return service.trim().toLowerCase();
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

function connectionStatus(expiresAt: string | null): "connected" | "expired" {
  if (!expiresAt) {
    return "connected";
  }

  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) {
    return "connected";
  }

  return expiry <= Date.now() ? "expired" : "connected";
}

function toCredentialPayload(
  authType: z.infer<typeof manualAuthTypeSchema>,
  body: z.infer<typeof createCredentialSchema>,
): CredentialPayload {
  if (authType === "api_key") {
    return { api_key: body.api_key };
  }
  if (authType === "cookie") {
    return { cookie_name: body.cookie_name, cookie_value: body.cookie_value };
  }
  if (authType === "client_credentials") {
    return { client_id: body.client_id, client_secret: body.client_secret };
  }

  return { username: body.username, password: body.password };
}

export const credentialsApp = new Hono();

credentialsApp.use("*", apiKeyAuthMiddleware);

credentialsApp.get("/", async (c) => {
  const userId = resolveUserId(c);
  const connections = await listConnections(userId);

  return c.json(
    connections.map((connection) => ({
      service: connection.serviceId,
      auth_type: connection.authType,
      connected_at: connection.createdAt,
      last_used_at: connection.lastUsedAt,
      expires_at: connection.expiresAt,
      status: connectionStatus(connection.expiresAt),
    })),
  );
});

credentialsApp.get("/:service/activity", async (c) => {
  const userId = resolveUserId(c);
  const service = normalizeService(c.req.param("service"));
  if (!isValidServiceIdentifier(service)) {
    return c.json({ error: "Invalid service identifier" }, 400);
  }

  const limit = normalizeActivityLimit(c.req.query("limit"));
  const beforeParam = c.req.query("before");
  const before = parseBeforeCursor(beforeParam);
  if (beforeParam !== undefined && before === null) {
    return c.json({ error: "Invalid before cursor" }, 400);
  }

  const result = await getServiceAuditActivity({
    userId,
    serviceId: service,
    limit,
    before: before ?? undefined,
  });

  return c.json({
    service,
    entries: result.entries.map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      action: entry.action,
      execution_id: entry.executionId ?? null,
      metadata: entry.metadata ?? null,
    })),
    has_more: result.hasMore,
  });
});

credentialsApp.post("/:service", async (c) => {
  const parsedBody = await parseJsonBody(c);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const parsed = createCredentialSchema.safeParse(parsedBody.data);
  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid request",
        details: z.treeifyError(parsed.error),
      },
      400,
    );
  }

  const userId = resolveUserId(c);
  const service = normalizeService(c.req.param("service"));
  if (!isValidServiceIdentifier(service)) {
    return c.json({ error: "Invalid service identifier" }, 400);
  }
  const authType = parsed.data.auth_type;

  await storeCredential(userId, service, authType, toCredentialPayload(authType, parsed.data));
  await logCredentialStored(userId, service, clientIp(c.req.raw.headers));

  return c.json({ status: "connected", service });
});

credentialsApp.delete("/:service", async (c) => {
  const userId = resolveUserId(c);
  const service = normalizeService(c.req.param("service"));
  if (!isValidServiceIdentifier(service)) {
    return c.json({ error: "Invalid service identifier" }, 400);
  }

  if (!(await hasCredential(userId, service))) {
    return c.json({ error: "Credential not found" }, 404);
  }

  await deleteCredential(userId, service);
  await logCredentialDeleted(userId, service, clientIp(c.req.raw.headers));

  return c.json({ status: "disconnected", service });
});
