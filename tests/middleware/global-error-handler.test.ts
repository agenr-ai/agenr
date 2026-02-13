import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { requestIdMiddleware } from "../../src/middleware/request-id";

describe("global error handler", () => {
  test("unhandled throws return sanitized 500 payload with requestId", async () => {
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use("*", requestIdMiddleware);
    app.onError((err, c) => {
      const requestId = c.get("requestId") || "unknown";
      console.error(`[${requestId}] Unhandled error:`, err.message);
      return c.json({ error: "Internal server error", requestId }, 500);
    });
    app.get("/boom", () => {
      throw new Error("database failure at /tmp/secrets.txt");
    });

    const response = await app.request("/boom");
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe("Internal server error");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);

    const raw = JSON.stringify(body);
    expect(raw.includes("database failure")).toBe(false);
    expect(raw.includes("/tmp/secrets.txt")).toBe(false);
  });
});
