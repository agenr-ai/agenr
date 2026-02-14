import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";

import { authApp } from "../../src/routes/auth";

let originalNodeEnv: string | undefined;

function createTestApp(): Hono {
  const app = new Hono();
  app.route("/auth", authApp);
  return app;
}

beforeEach(() => {
  originalNodeEnv = process.env.NODE_ENV;
});

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe("auth session cookie policy", () => {
  test("logout cookie is localhost-compatible outside production", async () => {
    delete process.env.NODE_ENV;
    const app = createTestApp();

    const response = await app.request("/auth/logout", { method: "POST" });
    expect(response.status).toBe(200);

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
  });

  test("logout cookie is secure in production", async () => {
    process.env.NODE_ENV = "production";
    const app = createTestApp();

    const response = await app.request("/auth/logout", { method: "POST" });
    expect(response.status).toBe(200);

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
  });
});
