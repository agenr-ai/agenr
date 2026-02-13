import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";

const DEFAULT_MAX = 100;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

interface RateLimitState {
  keyTimestamps: Map<string, number[]>;
  cleanupIntervalId: ReturnType<typeof setInterval>;
}

export type KeyResolver = (c: Context) => string | null;

export interface RateLimitOptions {
  max?: number;
  windowMs?: number;
  cleanupIntervalMs?: number;
  keyResolver?: KeyResolver;
}

const rateLimitStates = new Set<RateLimitState>();

function parsePositiveInteger(
  rawValue: string | number | undefined,
  fallback: number,
): number {
  if (typeof rawValue === "number") {
    return Number.isInteger(rawValue) && rawValue > 0 ? rawValue : fallback;
  }

  if (typeof rawValue === "string" && rawValue.trim().length > 0) {
    const parsed = Number(rawValue);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  return fallback;
}

function trimHeaderValue(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function ipKeyResolver(c: Context): string {
  const flyClientIp = c.req.header("fly-client-ip");
  const xForwardedFor = c.req.header("x-forwarded-for");

  const canonicalFlyIp = trimHeaderValue(flyClientIp);
  if (canonicalFlyIp) {
    return `ip:${canonicalFlyIp}`;
  }

  const forwardedFor = trimHeaderValue(xForwardedFor);
  const firstForwarded = forwardedFor?.split(",", 1)[0]?.trim() ?? "";
  if (firstForwarded.length > 0) {
    return `ip:${firstForwarded}`;
  }

  return "ip:unknown";
}

function pruneExpiredTimestamps(timestamps: number[], cutoffMs: number): number[] {
  let startIndex = 0;
  while (startIndex < timestamps.length && timestamps[startIndex] <= cutoffMs) {
    startIndex += 1;
  }

  if (startIndex === 0) {
    return timestamps;
  }

  return timestamps.slice(startIndex);
}

function setRateLimitHeaders(
  headers: Headers,
  limit: number,
  remaining: number,
  resetUnixSeconds: number,
): void {
  headers.set("X-RateLimit-Limit", String(limit));
  headers.set("X-RateLimit-Remaining", String(Math.max(0, remaining)));
  headers.set("X-RateLimit-Reset", String(resetUnixSeconds));
}

function cleanupExpiredEntries(keyTimestamps: Map<string, number[]>, nowMs: number, windowMs: number): void {
  const cutoffMs = nowMs - windowMs;
  for (const [key, timestamps] of keyTimestamps.entries()) {
    const activeTimestamps = pruneExpiredTimestamps(timestamps, cutoffMs);
    if (activeTimestamps.length === 0) {
      keyTimestamps.delete(key);
      continue;
    }
    keyTimestamps.set(key, activeTimestamps);
  }
}

export function createRateLimitMiddleware(options: RateLimitOptions = {}): MiddlewareHandler {
  const max = parsePositiveInteger(
    options.max,
    parsePositiveInteger(process.env.AGENR_RATE_LIMIT_MAX, DEFAULT_MAX),
  );
  const windowMs = parsePositiveInteger(
    options.windowMs,
    parsePositiveInteger(process.env.AGENR_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS),
  );
  const cleanupIntervalMs = parsePositiveInteger(options.cleanupIntervalMs, DEFAULT_CLEANUP_INTERVAL_MS);
  const resolveKey = options.keyResolver ?? ipKeyResolver;
  const keyTimestamps = new Map<string, number[]>();

  const cleanupIntervalId = setInterval(() => {
    cleanupExpiredEntries(keyTimestamps, Date.now(), windowMs);
  }, cleanupIntervalMs);

  rateLimitStates.add({ keyTimestamps, cleanupIntervalId });

  return createMiddleware(async (c, next) => {
    const nowMs = Date.now();

    if (c.req.method === "OPTIONS" || (c.req.method === "GET" && c.req.path === "/health")) {
      const resetUnixSeconds = Math.ceil((nowMs + windowMs) / 1000);
      await next();
      setRateLimitHeaders(c.res.headers, max, max, resetUnixSeconds);
      return;
    }

    const key = resolveKey(c);
    if (key === null) {
      await next();
      return;
    }

    const cutoffMs = nowMs - windowMs;
    const existingTimestamps = keyTimestamps.get(key) ?? [];
    const activeTimestamps = pruneExpiredTimestamps(existingTimestamps, cutoffMs);

    if (activeTimestamps.length >= max) {
      const oldestTimestamp = activeTimestamps[0] ?? nowMs;
      const resetMs = oldestTimestamp + windowMs;
      const resetUnixSeconds = Math.ceil(resetMs / 1000);
      const retryAfterSeconds = Math.max(1, Math.ceil((resetMs - nowMs) / 1000));

      keyTimestamps.set(key, activeTimestamps);

      const response = c.json(
        {
          error: "Rate limit exceeded",
          retryAfter: retryAfterSeconds,
        },
        429,
      );
      setRateLimitHeaders(response.headers, max, 0, resetUnixSeconds);
      return response;
    }

    activeTimestamps.push(nowMs);
    keyTimestamps.set(key, activeTimestamps);

    const oldestTimestamp = activeTimestamps[0] ?? nowMs;
    const resetMs = oldestTimestamp + windowMs;
    const resetUnixSeconds = Math.ceil(resetMs / 1000);
    const remaining = max - activeTimestamps.length;

    await next();
    setRateLimitHeaders(c.res.headers, max, remaining, resetUnixSeconds);
  });
}

export const rateLimitMiddleware = createRateLimitMiddleware();

/** Per-API-key rate limiter. Returns null to skip for non-keyed requests. */
export const DEMO_KEY_RATE_LIMIT = 30;
export const FREE_TIER_RATE_LIMIT = 60;
export const PAID_TIER_RATE_LIMIT = 100;

function resolveApiKeyLimit(tier: string | undefined, keyId: string | undefined): number {
  if (keyId === "demo-key-001") return DEMO_KEY_RATE_LIMIT;
  if (tier === "free") return FREE_TIER_RATE_LIMIT;
  return PAID_TIER_RATE_LIMIT;
}

export function createApiKeyRateLimitMiddleware(options: { windowMs?: number; cleanupIntervalMs?: number } = {}): MiddlewareHandler {
  const windowMs = parsePositiveInteger(options.windowMs, DEFAULT_WINDOW_MS);
  const cleanupIntervalMs = parsePositiveInteger(options.cleanupIntervalMs, DEFAULT_CLEANUP_INTERVAL_MS);
  const keyTimestamps = new Map<string, number[]>();

  const cleanupIntervalId = setInterval(() => {
    cleanupExpiredEntries(keyTimestamps, Date.now(), windowMs);
  }, cleanupIntervalMs);

  rateLimitStates.add({ keyTimestamps, cleanupIntervalId });

  return createMiddleware(async (c, next) => {
    const keyId = c.get("apiKeyId") as string | undefined;
    if (!keyId) {
      await next();
      return;
    }

    const tier = c.get("apiKeyTier") as string | undefined;
    const max = resolveApiKeyLimit(tier, keyId);
    const nowMs = Date.now();
    const key = `key:${keyId}`;

    if (c.req.method === "OPTIONS" || (c.req.method === "GET" && c.req.path === "/health")) {
      await next();
      return;
    }

    const cutoffMs = nowMs - windowMs;
    const existingTimestamps = keyTimestamps.get(key) ?? [];
    const activeTimestamps = pruneExpiredTimestamps(existingTimestamps, cutoffMs);

    if (activeTimestamps.length >= max) {
      const oldestTimestamp = activeTimestamps[0] ?? nowMs;
      const resetMs = oldestTimestamp + windowMs;
      const resetUnixSeconds = Math.ceil(resetMs / 1000);
      const retryAfterSeconds = Math.max(1, Math.ceil((resetMs - nowMs) / 1000));

      keyTimestamps.set(key, activeTimestamps);

      const response = c.json(
        {
          error: "Rate limit exceeded",
          retryAfter: retryAfterSeconds,
        },
        429,
      );
      setRateLimitHeaders(response.headers, max, 0, resetUnixSeconds);
      return response;
    }

    activeTimestamps.push(nowMs);
    keyTimestamps.set(key, activeTimestamps);

    const oldestTimestamp = activeTimestamps[0] ?? nowMs;
    const resetMs = oldestTimestamp + windowMs;
    const resetUnixSeconds = Math.ceil(resetMs / 1000);
    const remaining = max - activeTimestamps.length;

    await next();
    setRateLimitHeaders(c.res.headers, max, remaining, resetUnixSeconds);
  });
}

export const apiKeyRateLimitMiddleware = createApiKeyRateLimitMiddleware();

export function resetRateLimitState(): void {
  for (const state of rateLimitStates.values()) {
    clearInterval(state.cleanupIntervalId);
    state.keyTimestamps.clear();
  }
  rateLimitStates.clear();
}
