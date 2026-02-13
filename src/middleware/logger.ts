import { createMiddleware } from "hono/factory";

interface HttpRequestLogEntry {
  level: "info" | "warn" | "error";
  event: "http_request";
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
  apiKeyId: string | null;
  tier: string | null;
  ip: string;
  userAgent: string;
  timestamp: string;
}

function shouldSkipRequestLog(method: string, path: string): boolean {
  return method === "OPTIONS" || (method === "GET" && path === "/health");
}

function readClientIp(xForwardedFor: string | undefined): string {
  if (!xForwardedFor) {
    return "unknown";
  }

  const first = xForwardedFor.split(",", 1)[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

function levelFromStatus(status: number): "info" | "warn" | "error" {
  if (status >= 500) {
    return "error";
  }

  if (status >= 400) {
    return "warn";
  }

  return "info";
}

export const requestLoggerMiddleware = createMiddleware(async (c, next) => {
  const startMs = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  const skipped = shouldSkipRequestLog(method, path);
  let thrownError: unknown = null;

  try {
    await next();
  } catch (error) {
    thrownError = error;
    throw error;
  } finally {
    if (skipped) {
      return;
    }

    const status = thrownError ? 500 : c.res.status;
    const logEntry: HttpRequestLogEntry = {
      level: levelFromStatus(status),
      event: "http_request",
      method,
      path,
      status,
      durationMs: Date.now() - startMs,
      requestId: c.get("requestId"),
      apiKeyId: c.get("apiKeyId") ?? null,
      tier: c.get("apiKeyTier") ?? null,
      ip: readClientIp(c.req.header("x-forwarded-for")),
      userAgent: c.req.header("user-agent")?.trim() || "unknown",
      timestamp: new Date().toISOString(),
    };

    console.log(JSON.stringify(logEntry));
  }
});
