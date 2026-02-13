import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

export const CORS_ALLOW_METHODS = ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"] as const;
export const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-API-Key",
  "Idempotency-Key",
  "X-Confirmation-Token",
] as const;
export const CORS_EXPOSE_HEADERS = [
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
  "X-Request-Id",
] as const;

export function resolveCorsOrigins(rawOrigins: string | undefined): string[] | "*" {
  if (!rawOrigins?.trim()) {
    console.warn("[cors] AGENR_CORS_ORIGINS is not set — rejecting all cross-origin requests");
    return [];
  }

  const origins = rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins;
}

export function resolveAllowedOrigin(
  requestOrigin: string,
  corsOrigins: string[] | "*",
): string | null {
  if (!requestOrigin) {
    return null;
  }

  if (corsOrigins === "*") {
    return requestOrigin;
  }

  return corsOrigins.includes(requestOrigin) ? requestOrigin : null;
}

export function createPreflightOriginGuard(corsOrigins: string[] | "*"): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "OPTIONS") {
      await next();
      return;
    }

    const requestOrigin = c.req.header("origin") ?? "";
    if (!requestOrigin) {
      await next();
      return;
    }

    if (resolveAllowedOrigin(requestOrigin, corsOrigins)) {
      await next();
      return;
    }

    return new Response(null, { status: 204, statusText: "No Content" });
  };
}

export function createCorsMiddleware(corsOrigins: string[] | "*"): MiddlewareHandler {
  return cors({
    origin: (requestOrigin) => resolveAllowedOrigin(requestOrigin, corsOrigins) ?? undefined,
    allowMethods: (requestOrigin) =>
      resolveAllowedOrigin(requestOrigin, corsOrigins) ? [...CORS_ALLOW_METHODS] : [],
    allowHeaders: [...CORS_ALLOW_HEADERS],
    credentials: true,
  });
}

export function createCorsExposeHeadersMiddleware(corsOrigins: string[] | "*"): MiddlewareHandler {
  return async (c, next) => {
    await next();

    const requestOrigin = c.req.header("origin") ?? "";
    if (resolveAllowedOrigin(requestOrigin, corsOrigins)) {
      c.header("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS.join(","));
    }
  };
}
