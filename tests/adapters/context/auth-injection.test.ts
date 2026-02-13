import { afterEach, describe, expect, test } from "bun:test";

import { AdapterContext, type AuthCredential } from "../../../src/adapters/context";
import type { AdapterManifest } from "../../../src/adapters/manifest";

const originalFetch = globalThis.fetch;

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetchRecorder(): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  return calls;
}

function createManifest(
  strategy: AdapterManifest["auth"]["strategy"],
  authOverrides: Partial<AdapterManifest["auth"]> = {},
): AdapterManifest {
  const type =
    strategy === "none" ? "none" : strategy === "client-credentials" ? "client_credentials" : "api_key";

  return {
    platform: "stripe",
    auth: {
      type,
      strategy,
      ...authOverrides,
    },
    authenticatedDomains: ["api.stripe.com"],
    allowedDomains: [],
  };
}

function createContext(
  manifest: AdapterManifest,
  resolveCredential: (options?: { force?: boolean }) => Promise<AuthCredential | null>,
): AdapterContext {
  return new AdapterContext({
    platform: manifest.platform,
    userId: "user-1",
    executionId: "exec-1",
    manifest,
    resolveCredential,
  });
}

describe("AdapterContext auth injection", () => {
  test("bearer strategy injects Authorization header", async () => {
    const calls = installFetchRecorder();
    const ctx = createContext(createManifest("bearer", { type: "oauth2" }), async () => ({
      token: "tok_123",
    }));

    await ctx.fetch("https://api.stripe.com/v1/charges");

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok_123");
  });

  test("api-key-header strategy injects X-Api-Key by default", async () => {
    const calls = installFetchRecorder();
    const ctx = createContext(createManifest("api-key-header", { type: "api_key" }), async () => ({
      apiKey: "key_123",
    }));

    await ctx.fetch("https://api.stripe.com/v1/customers");

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("X-Api-Key")).toBe("key_123");
  });

  test("api-key-header with custom headerName uses that header", async () => {
    const calls = installFetchRecorder();
    const ctx = createContext(
      createManifest("api-key-header", { type: "api_key", headerName: "X-Secret-Key" }),
      async () => ({ apiKey: "secret_123" }),
    );

    await ctx.fetch("https://api.stripe.com/v1/customers");

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("X-Secret-Key")).toBe("secret_123");
  });

  test("basic strategy injects base64-encoded Authorization", async () => {
    const calls = installFetchRecorder();
    const ctx = createContext(createManifest("basic", { type: "basic" }), async () => ({
      username: "alice",
      password: "hunter2",
    }));

    await ctx.fetch("https://api.stripe.com/v1/payouts");

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe(`Basic ${btoa("alice:hunter2")}`);
  });

  test("cookie strategy injects Cookie header", async () => {
    const calls = installFetchRecorder();
    const ctx = createContext(
      createManifest("cookie", { type: "cookie", cookieName: "session_id" }),
      async () => ({ cookieValue: "cookie_abc" }),
    );

    await ctx.fetch("https://api.stripe.com/v1/sessions");

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Cookie")).toBe("session_id=cookie_abc");
  });

  test("custom strategy injects custom header", async () => {
    const calls = installFetchRecorder();
    const ctx = createContext(
      createManifest("custom", { type: "api_key", headerName: "X-Custom-Auth" }),
      async () => ({ headerValue: "custom_abc" }),
    );

    await ctx.fetch("https://api.stripe.com/v1/events");

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("X-Custom-Auth")).toBe("custom_abc");
  });

  test("none strategy adds no auth headers", async () => {
    const calls = installFetchRecorder();
    let resolveCalled = false;
    const ctx = createContext(createManifest("none", { type: "none" }), async () => {
      resolveCalled = true;
      return { token: "unused" };
    });

    await ctx.fetch("https://api.stripe.com/v1/products", {
      headers: { "X-Test": "1" },
    });

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-Api-Key")).toBeNull();
    expect(resolveCalled).toBe(false);
  });

  test("client-credentials strategy adds no auth headers", async () => {
    const calls = installFetchRecorder();
    let resolveCalled = false;
    const ctx = createContext(
      createManifest("client-credentials", { type: "client_credentials" }),
      async () => {
        resolveCalled = true;
        return { clientId: "cid", clientSecret: "secret" };
      },
    );

    await ctx.fetch("https://api.stripe.com/v1/products", {
      headers: { "X-Test": "1" },
    });

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-Api-Key")).toBeNull();
    expect(resolveCalled).toBe(false);
  });

  test("missing credential throws error for non-none strategies", async () => {
    const calls = installFetchRecorder();
    const ctx = createContext(createManifest("bearer", { type: "oauth2" }), async () => null);

    await expect(ctx.fetch("https://api.stripe.com/v1/charges")).rejects.toThrow(
      "No credential available for stripe",
    );
    expect(calls).toHaveLength(0);
  });
});
