import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";

import { getDb, setDb } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { storeAppCredential } from "../../src/vault/app-credential-store";
import { hasCredential, retrieveCredential, storeCredential } from "../../src/vault/credential-store";
import { refreshIfNeeded } from "../../src/vault/token-refresh";

const originalFetch = globalThis.fetch;

let testDb: Client | null = null;

beforeEach(async () => {
  testDb = createClient({ url: ":memory:" });
  setDb(testDb);
  await migrate();
  await storeAppCredential("stripe", {
    clientId: "ca_test_123",
    clientSecret: "sk_test_123",
  });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;

  if (testDb) {
    await testDb.close();
  }
  setDb(null);
  testDb = null;
});

describe("token refresh", () => {
  test("refresh is skipped for non-oauth credentials", async () => {
    await storeCredential("user-a", "toast", "api_key", { api_key: "toast-key" });
    let called = false;
    globalThis.fetch = (async (): Promise<Response> => {
      called = true;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await refreshIfNeeded("user-a", "toast", null);

    expect(called).toBe(false);
  });

  test("refresh is skipped when token expiry is not near", async () => {
    await storeCredential("user-a", "stripe", "oauth2", {
      access_token: "access-old",
      refresh_token: "refresh-old",
      expires_in: 3600,
    });
    let called = false;
    globalThis.fetch = (async (): Promise<Response> => {
      called = true;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await refreshIfNeeded("user-a", "stripe", {
      tokenUrl: "https://connect.stripe.com/oauth/token",
      tokenContentType: "form",
    });

    expect(called).toBe(false);
  });

  test("force refresh updates token even when not near expiry", async () => {
    await storeCredential("user-force", "stripe", "oauth2", {
      access_token: "access-old",
      refresh_token: "refresh-old",
      token_type: "bearer",
      expires_in: 3600,
    });
    let called = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      called += 1;
      const body = typeof init?.body === "string" ? new URLSearchParams(init.body) : new URLSearchParams();
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-old");

      return new Response(
        JSON.stringify({
          access_token: "access-forced",
          refresh_token: "refresh-forced",
          token_type: "bearer",
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await refreshIfNeeded(
      "user-force",
      "stripe",
      {
        tokenUrl: "https://connect.stripe.com/oauth/token",
        tokenContentType: "form",
      },
      true,
    );

    expect(called).toBe(1);
    const refreshed = await retrieveCredential("user-force", "stripe");
    expect(refreshed.access_token).toBe("access-forced");
    expect(refreshed.refresh_token).toBe("refresh-forced");
    expect(refreshed.expires_in).toBe(7200);
  });

  test("force refresh still skips non-oauth credentials", async () => {
    await storeCredential("user-force", "toast", "api_key", { api_key: "toast-key" });
    let called = false;
    globalThis.fetch = (async (): Promise<Response> => {
      called = true;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await refreshIfNeeded(
      "user-force",
      "toast",
      {
        tokenUrl: "https://example.com/oauth/token",
        tokenContentType: "form",
      },
      true,
    );

    expect(called).toBe(false);
  });

  test("refresh updates stored oauth tokens when near expiry", async () => {
    await storeCredential(
      "user-b",
      "stripe",
      "oauth2",
      {
        access_token: "access-old",
        refresh_token: "refresh-old",
        token_type: "bearer",
        expires_in: 1,
      },
      ["read_write"],
    );
    let called = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      called += 1;
      const body = typeof init?.body === "string" ? new URLSearchParams(init.body) : new URLSearchParams();
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-old");

      return new Response(
        JSON.stringify({
          access_token: "access-new",
          refresh_token: "refresh-new",
          token_type: "bearer",
          expires_in: 7200,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    await refreshIfNeeded("user-b", "stripe", {
      tokenUrl: "https://connect.stripe.com/oauth/token",
      tokenContentType: "form",
    });

    expect(called).toBe(1);
    const refreshed = await retrieveCredential("user-b", "stripe");
    expect(refreshed.access_token).toBe("access-new");
    expect(refreshed.refresh_token).toBe("refresh-new");
    expect(refreshed.expires_in).toBe(7200);

    const auditResult = await getDb().execute({
      sql: `SELECT COUNT(*) AS count
        FROM credential_audit_log
        WHERE user_id = ? AND service_id = ? AND action = ?`,
      args: ["user-b", "stripe", "credential_rotated"],
    });
    const row = auditResult.rows[0] as Record<string, unknown> | undefined;
    const count = typeof row?.["count"] === "number" ? row["count"] : Number(row?.["count"] ?? 0);
    expect(count).toBe(1);
  });

  test("refresh failure keeps existing credential", async () => {
    await storeCredential("user-c", "stripe", "oauth2", {
      access_token: "access-old",
      refresh_token: "refresh-old",
      token_type: "bearer",
      expires_in: 1,
    });
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response("bad gateway", { status: 502 });
    }) as typeof fetch;

    await refreshIfNeeded("user-c", "stripe", {
      tokenUrl: "https://connect.stripe.com/oauth/token",
      tokenContentType: "form",
    });

    expect(await hasCredential("user-c", "stripe")).toBe(true);
    const credential = await retrieveCredential("user-c", "stripe");
    expect(credential.access_token).toBe("access-old");
    expect(credential.refresh_token).toBe("refresh-old");
  });
});
