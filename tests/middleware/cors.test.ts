import { describe, expect, test } from "vitest";
import { Hono } from "hono";

import {
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  CORS_EXPOSE_HEADERS,
  createCorsExposeHeadersMiddleware,
  createCorsMiddleware,
  createPreflightOriginGuard,
  resolveCorsOrigins,
} from "../../src/utils/cors";

function createCorsTestApp(rawOrigins: string | undefined): Hono {
  const app = new Hono();
  const corsOrigins = resolveCorsOrigins(rawOrigins);

  app.use("*", createPreflightOriginGuard(corsOrigins));
  app.use("*", createCorsMiddleware(corsOrigins));
  app.use("*", createCorsExposeHeadersMiddleware(corsOrigins));
  app.get("/health", (c) => c.json({ status: "ok" }));

  return app;
}

describe("cors origin handling", () => {
  test("allowed preflight origin returns CORS headers", async () => {
    const app = createCorsTestApp("https://allowed.example");

    const response = await app.request("/health", {
      method: "OPTIONS",
      headers: {
        origin: "https://allowed.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "Content-Type, X-API-Key",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.example");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(CORS_ALLOW_METHODS.join(","));
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(CORS_ALLOW_HEADERS.join(","));
  });

  test("disallowed preflight origin returns no CORS headers", async () => {
    const app = createCorsTestApp("https://allowed.example");

    const response = await app.request("/health", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "Content-Type, X-API-Key",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect(response.headers.get("Access-Control-Expose-Headers")).toBeNull();
  });

  test("request without origin returns no CORS headers", async () => {
    const app = createCorsTestApp("*");

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();
    expect(response.headers.get("Access-Control-Expose-Headers")).toBeNull();
  });

  test("allowed non-preflight origin receives expose headers", async () => {
    const app = createCorsTestApp("https://allowed.example");

    const response = await app.request("/health", {
      headers: {
        origin: "https://allowed.example",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.example");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe(CORS_EXPOSE_HEADERS.join(","));
    const exposedHeaders = response.headers
      .get("Access-Control-Expose-Headers")
      ?.split(",")
      .map((header) => header.trim()) ?? [];
    expect(exposedHeaders).toContain("X-Request-Id");
  });
});
