import { afterEach, describe, expect, test } from "vitest";
import { Hono } from "hono";

import {
  createApiKeyRateLimitMiddleware,
  createRateLimitMiddleware,
  resetRateLimitState,
  type RateLimitOptions,
} from "../../src/middleware/rate-limit";

function createTestApp(options: RateLimitOptions = {}): Hono {
  const app = new Hono();
  app.use("*", createRateLimitMiddleware(options));
  app.get("/test", (c) => c.json({ ok: true }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.options("/test", (c) => c.body(null, 204));
  return app;
}

afterEach(() => {
  resetRateLimitState();
});

describe("rate-limit middleware", () => {
  test("requests under the limit succeed and include rate-limit headers", async () => {
    const app = createTestApp({ max: 3, windowMs: 60_000, cleanupIntervalMs: 5_000 });

    const first = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.1" },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Limit")).toBe("3");
    expect(first.headers.get("X-RateLimit-Remaining")).toBe("2");
    expect(Number(first.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(0);

    const second = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.1" },
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("X-RateLimit-Limit")).toBe("3");
    expect(second.headers.get("X-RateLimit-Remaining")).toBe("1");
    expect(Number(second.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(0);
  });

  test("requests over the limit return 429 with retryAfter", async () => {
    const app = createTestApp({ max: 2, windowMs: 60_000, cleanupIntervalMs: 5_000 });

    await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.1" },
    });
    await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.1" },
    });
    const blocked = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.1" },
    });

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(blocked.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(blocked.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(0);

    const body = await blocked.json();
    expect(body.error).toBe("Rate limit exceeded");
    expect(typeof body.retryAfter).toBe("number");
    expect(body.retryAfter).toBeGreaterThanOrEqual(1);
  });

  test("different source IPs have independent counters", async () => {
    const app = createTestApp({ max: 1, windowMs: 60_000, cleanupIntervalMs: 5_000 });

    const firstIp = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.1" },
    });
    expect(firstIp.status).toBe(200);

    const secondIp = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.2" },
    });
    expect(secondIp.status).toBe(200);

    const blockedFirstIp = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.1" },
    });
    expect(blockedFirstIp.status).toBe(429);
  });

  test("unauthenticated requests with rotated auth headers still share one IP bucket", async () => {
    const app = createTestApp({ max: 1, windowMs: 60_000, cleanupIntervalMs: 5_000 });

    const first = await app.request("/test", {
      headers: {
        "fly-client-ip": "10.0.0.3",
        authorization: "Bearer invalid-token-a",
      },
    });
    expect(first.status).toBe(200);

    const blocked = await app.request("/test", {
      headers: {
        "fly-client-ip": "10.0.0.3",
        authorization: "Bearer invalid-token-b",
        "x-api-key": "also-invalid",
      },
    });
    expect(blocked.status).toBe(429);
  });

  test("x-forwarded-for fallback is used when Fly-Client-IP is absent", async () => {
    const app = createTestApp({ max: 1, windowMs: 60_000, cleanupIntervalMs: 5_000 });

    const first = await app.request("/test", {
      headers: { "x-forwarded-for": "1.2.3.4, 9.9.9.9" },
    });
    expect(first.status).toBe(200);

    const blocked = await app.request("/test", {
      headers: { "x-forwarded-for": "1.2.3.4, 8.8.8.8" },
    });
    expect(blocked.status).toBe(429);

    const differentIp = await app.request("/test", {
      headers: { "x-forwarded-for": "5.6.7.8" },
    });
    expect(differentIp.status).toBe(200);
  });

  test("GET /health is not rate limited", async () => {
    const app = createTestApp({ max: 1, windowMs: 60_000, cleanupIntervalMs: 5_000 });

    for (let i = 0; i < 3; i += 1) {
      const health = await app.request("/health", {
        headers: { "fly-client-ip": "10.0.0.4" },
      });
      expect(health.status).toBe(200);
      expect(health.headers.get("X-RateLimit-Limit")).toBe("1");
      expect(health.headers.get("X-RateLimit-Remaining")).toBe("1");
    }

    const testRequest = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.4" },
    });
    expect(testRequest.status).toBe(200);
    expect(testRequest.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  test("OPTIONS requests are not rate limited", async () => {
    const app = createTestApp({ max: 1, windowMs: 60_000, cleanupIntervalMs: 5_000 });

    for (let i = 0; i < 3; i += 1) {
      const preflight = await app.request("/test", {
        method: "OPTIONS",
        headers: { "fly-client-ip": "10.0.0.5" },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("X-RateLimit-Limit")).toBe("1");
      expect(preflight.headers.get("X-RateLimit-Remaining")).toBe("1");
    }

    const testRequest = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.5" },
    });
    expect(testRequest.status).toBe(200);
    expect(testRequest.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  test("counter resets after the window expires", async () => {
    const app = createTestApp({ max: 1, windowMs: 100, cleanupIntervalMs: 20 });

    const first = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.6" },
    });
    expect(first.status).toBe(200);

    const blocked = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.6" },
    });
    expect(blocked.status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 130));

    const afterWindow = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.6" },
    });
    expect(afterWindow.status).toBe(200);
    expect(afterWindow.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  test("resetRateLimitState clears all state", async () => {
    const app = createTestApp({ max: 1, windowMs: 60_000, cleanupIntervalMs: 5_000 });

    const first = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.7" },
    });
    expect(first.status).toBe(200);

    const blocked = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.7" },
    });
    expect(blocked.status).toBe(429);

    resetRateLimitState();

    const afterReset = await app.request("/test", {
      headers: { "fly-client-ip": "10.0.0.7" },
    });
    expect(afterReset.status).toBe(200);
    expect(afterReset.headers.get("X-RateLimit-Remaining")).toBe("0");
  });
});

describe("API key rate limiting", () => {
  test("demo key is limited to 30 req/min", async () => {
    const app = new Hono();
    // Simulate auth setting context
    app.use("*", async (c, next) => {
      c.set("apiKeyId", "demo-key-001");
      c.set("apiKeyTier", "free");
      await next();
    });
    app.use("*", createApiKeyRateLimitMiddleware({ windowMs: 60_000, cleanupIntervalMs: 5_000 }));
    app.get("/test", (c) => c.json({ ok: true }));

    // Send 30 requests — all should succeed
    for (let i = 0; i < 30; i++) {
      const res = await app.request("/test");
      expect(res.status).toBe(200);
    }

    // 31st should be blocked
    const blocked = await app.request("/test");
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error).toBe("Rate limit exceeded");
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe("30");
  });

  test("free tier key gets 60 req/min", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("apiKeyId", "some-free-key");
      c.set("apiKeyTier", "free");
      await next();
    });
    app.use("*", createApiKeyRateLimitMiddleware({ windowMs: 60_000, cleanupIntervalMs: 5_000 }));
    app.get("/test", (c) => c.json({ ok: true }));

    for (let i = 0; i < 60; i++) {
      const res = await app.request("/test");
      expect(res.status).toBe(200);
    }

    const blocked = await app.request("/test");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe("60");
  });

  test("paid tier key gets 100 req/min", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("apiKeyId", "some-paid-key");
      c.set("apiKeyTier", "paid");
      await next();
    });
    app.use("*", createApiKeyRateLimitMiddleware({ windowMs: 60_000, cleanupIntervalMs: 5_000 }));
    app.get("/test", (c) => c.json({ ok: true }));

    for (let i = 0; i < 100; i++) {
      const res = await app.request("/test");
      expect(res.status).toBe(200);
    }

    const blocked = await app.request("/test");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe("100");
  });

  test("requests without API key skip per-key limiting", async () => {
    const app = new Hono();
    // No auth context set
    app.use("*", createApiKeyRateLimitMiddleware({ windowMs: 60_000, cleanupIntervalMs: 5_000 }));
    app.get("/test", (c) => c.json({ ok: true }));

    // Should never hit limit since no key
    for (let i = 0; i < 150; i++) {
      const res = await app.request("/test");
      expect(res.status).toBe(200);
    }
  });

  test("different API keys have independent counters", async () => {
    const app = new Hono();
    let currentKeyId = "key-a";
    app.use("*", async (c, next) => {
      c.set("apiKeyId", currentKeyId);
      c.set("apiKeyTier", "free");
      await next();
    });
    app.use("*", createApiKeyRateLimitMiddleware({ windowMs: 60_000, cleanupIntervalMs: 5_000 }));
    app.get("/test", (c) => c.json({ ok: true }));

    // Exhaust key-a
    for (let i = 0; i < 60; i++) {
      await app.request("/test");
    }
    const blockedA = await app.request("/test");
    expect(blockedA.status).toBe(429);

    // key-b should still work
    currentKeyId = "key-b";
    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });
});
