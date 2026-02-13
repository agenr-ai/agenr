import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { requestIdMiddleware } from "../../src/middleware/request-id";

function createTestApp(): Hono {
  const app = new Hono();
  app.use("*", requestIdMiddleware);
  app.get("/test", (c) => {
    return c.json({
      requestId: c.get("requestId"),
    });
  });

  return app;
}

describe("request-id middleware", () => {
  test("sets X-Request-Id header on response", async () => {
    const app = createTestApp();
    const response = await app.request("/test");

    const requestId = response.headers.get("X-Request-Id");
    expect(typeof requestId).toBe("string");
    expect(requestId).not.toBe("");
  });

  test("preserves incoming X-Request-Id", async () => {
    const app = createTestApp();
    const incomingRequestId = "proxy-request-id-123";

    const response = await app.request("/test", {
      headers: {
        "X-Request-Id": incomingRequestId,
      },
    });

    expect(response.headers.get("X-Request-Id")).toBe(incomingRequestId);
    const body = await response.json();
    expect(body.requestId).toBe(incomingRequestId);
  });

  test("generates uuid when incoming X-Request-Id is missing", async () => {
    const app = createTestApp();
    const response = await app.request("/test");
    const requestId = response.headers.get("X-Request-Id");

    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const body = await response.json();
    expect(body.requestId).toBe(requestId);
  });
});
