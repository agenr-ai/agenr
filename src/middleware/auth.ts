import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client";
import { resolveApiKey, touchApiKey } from "../db/api-keys";
import { touchSession, validateSession } from "../db/sessions";
import { getUserById } from "../db/users";
import { internalServerError } from "../utils/http-error";
import { logger } from "../utils/logger";

const SESSION_COOKIE_NAME = "agenr_session";
const SESSION_SCOPES = ["discover", "query", "execute", "generate"] as const;

function isAdminEmail(email: string): boolean {
  const admins = process.env.AGENR_ADMIN_EMAILS?.split(",").map(e => e.trim().toLowerCase()) ?? [];
  return admins.includes(email.toLowerCase());
}

function configuredApiKey(): string | null {
  const value = process.env.AGENR_API_KEY;
  if (!value) return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function allowUnauthBootstrap(): boolean {
  const env = process.env.NODE_ENV ?? "development";
  if (env === "production" || env === "staging") return false;
  return process.env.AGENR_ALLOW_UNAUTH_BOOTSTRAP === "1";
}

function trimHeaderValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractPresentedKey(
  authorizationHeader: string | undefined,
  xApiKeyHeader: string | undefined,
): string | null {
  const authorization = trimHeaderValue(authorizationHeader);
  if (authorization) {
    const [scheme, token] = authorization.split(/\s+/, 2);
    if (scheme?.toLowerCase() === "bearer") {
      return trimHeaderValue(token);
    }
  }

  return trimHeaderValue(xApiKeyHeader);
}

function setAdminContext(c: Context): void {
  c.set("userId", undefined);
  c.set("apiKeyId", undefined);
  c.set("apiKeyTier", "admin");
  c.set("apiKeyScopes", ["*"]);
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

async function hasAnyApiKeys(): Promise<boolean> {
  const db = getDb();
  const result = await db.execute("SELECT COUNT(*) AS count FROM api_keys");
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return false;
  }

  const count = readNumericValue(row["count"]);
  if (count === null) {
    throw new Error("Unable to parse api_keys count");
  }

  return count > 0;
}

export const apiKeyAuthMiddleware = createMiddleware(async (c, next) => {
  if (c.req.method === "OPTIONS") {
    await next();
    return;
  }

  const adminKey = configuredApiKey();
  const presentedKey = extractPresentedKey(
    c.req.header("authorization"),
    c.req.header("x-api-key"),
  );

  if (adminKey && presentedKey && adminKey.length === presentedKey.length && crypto.timingSafeEqual(Buffer.from(adminKey), Buffer.from(presentedKey))) {
    setAdminContext(c);
    await next();
    return;
  }

  if (presentedKey) {
    try {
      const resolvedKey = await resolveApiKey(presentedKey);
      if (resolvedKey) {
        c.set("userId", resolvedKey.userId ?? resolvedKey.id);
        c.set("apiKeyId", resolvedKey.id);
        c.set("apiKeyTier", resolvedKey.tier);
        c.set("apiKeyScopes", resolvedKey.scopes);

        void touchApiKey(resolvedKey.id).catch((error) => {
          logger.warn("auth_api_key_touch_failed", {
            apiKeyId: resolvedKey.id,
            error,
          });
        });

        await next();
        return;
      }
    } catch (error) {
      logger.error("auth_api_key_resolution_failed", { error });
      return internalServerError(c);
    }
  }

  const sessionId = getCookie(c, SESSION_COOKIE_NAME) ?? undefined;
  const sessionCandidate = sessionId ?? presentedKey ?? undefined;
  if (sessionCandidate) {
    try {
      const session = await validateSession(sessionCandidate);
      if (session) {
        const sessionUser = await getUserById(session.userId);
        const admin = sessionUser?.email && isAdminEmail(sessionUser.email);

        c.set("userId", session.userId);
        c.set("apiKeyId", session.userId);
        c.set("apiKeyTier", admin ? "admin" : "paid");
        c.set("apiKeyScopes", admin ? ["*"] : [...SESSION_SCOPES]);

        void touchSession(sessionCandidate).catch((error) => {
          logger.warn("auth_session_touch_failed", {
            sessionId: session.id,
            error,
          });
        });

        await next();
        return;
      }
    } catch (error) {
      logger.error("auth_session_resolution_failed", { error });
      return internalServerError(c);
    }
  }

  if (c.req.method === "GET") {
    const queryToken = c.req.query("session_token");
    if (queryToken) {
      try {
        const session = await validateSession(queryToken);
        if (session) {
          const sessionUser = await getUserById(session.userId);
          const admin = sessionUser?.email && isAdminEmail(sessionUser.email);

          c.set("userId", session.userId);
          c.set("apiKeyId", session.userId);
          c.set("apiKeyTier", admin ? "admin" : "paid");
          c.set("apiKeyScopes", admin ? ["*"] : [...SESSION_SCOPES]);

          void touchSession(queryToken).catch((error) => {
            logger.warn("auth_session_touch_failed", {
              sessionId: session.id,
              error,
            });
          });

          await next();
          return;
        }
      } catch (error) {
        logger.error("auth_session_resolution_failed", { error });
        return internalServerError(c);
      }
    }
  }

  if (!adminKey && allowUnauthBootstrap()) {
    try {
      if (!(await hasAnyApiKeys())) {
        setAdminContext(c);
        await next();
        return;
      }
    } catch (error) {
      logger.error("auth_api_key_availability_check_failed", { error });
      return internalServerError(c);
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});

export function requireScope(scope: string) {
  return createMiddleware(async (c, next) => {
    const scopes = c.get("apiKeyScopes");
    if (Array.isArray(scopes) && (scopes.includes("*") || scopes.includes(scope))) {
      await next();
      return;
    }

    return c.json({ error: "Forbidden", message: `Missing required scope: ${scope}` }, 403);
  });
}
