import { afterEach, describe, expect, test } from "vitest";

import { AdapterContext, type AuthCredential } from "../../../src/adapters/context";
import { DomainNotAllowedError } from "../../../src/adapters/domain-allowlist";
import { defineManifest, type AdapterManifest } from "../../../src/adapters/manifest";

const originalFetch = globalThis.fetch;

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetchRecorder(status = 200): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return new Response("ok", { status });
  }) as typeof fetch;
  return calls;
}

function installFetchResponder(
  responder: (input: RequestInfo | URL, init?: RequestInit, calls?: FetchCall[]) => Promise<Response> | Response,
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return responder(input, init, calls);
  }) as typeof fetch;
  return calls;
}

function createContext(
  manifest: AdapterManifest,
  resolveCredential: (options?: { force?: boolean }) => Promise<AuthCredential | null>,
): AdapterContext {
  return new AdapterContext({
    platform: manifest.platform ?? "stripe",
    userId: "user-1",
    executionId: "exec-1",
    manifest,
    resolveCredential,
  });
}

describe("AdapterContext domain scoping", () => {
  test("authenticated domain receives auth headers", async () => {
    const calls = installFetchRecorder();
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["api.stripe.com"],
        allowedDomains: [],
      },
      async () => ({ token: "tok_123" }),
    );

    await ctx.fetch("https://api.stripe.com/v1/charges");

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok_123");
  });

  test("allowed unauthenticated domain does not receive auth headers", async () => {
    const calls = installFetchRecorder();
    let resolveCalls = 0;
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["api.stripe.com"],
        allowedDomains: ["cdn.stripe.com"],
      },
      async () => {
        resolveCalls += 1;
        return { token: "tok_123" };
      },
    );

    await ctx.fetch("https://cdn.stripe.com/assets/logo.png");

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(resolveCalls).toBe(0);
  });

  test("unlisted domain throws DomainNotAllowedError", async () => {
    installFetchRecorder();
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["api.stripe.com"],
        allowedDomains: ["cdn.stripe.com"],
      },
      async () => ({ token: "tok_123" }),
    );

    await expect(ctx.fetch("https://evil.com/exfil")).rejects.toBeInstanceOf(DomainNotAllowedError);
  });

  test("wildcard in authenticatedDomains matches subdomains", async () => {
    const calls = installFetchRecorder();
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["*.stripe.com"],
        allowedDomains: [],
      },
      async () => ({ token: "tok_123" }),
    );

    await ctx.fetch("https://api.stripe.com/v1/charges");

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok_123");
  });

  test("wildcard in allowedDomains matches without auth", async () => {
    const calls = installFetchRecorder();
    let resolveCalls = 0;
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["api.stripe.com"],
        allowedDomains: ["*.cdn.example.com"],
      },
      async () => {
        resolveCalls += 1;
        return { token: "tok_123" };
      },
    );

    await ctx.fetch("https://us.cdn.example.com/file.jpg");

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(resolveCalls).toBe(0);
  });

  test("401 retry does not trigger for allowedDomains-only request", async () => {
    const calls = installFetchResponder(async () => new Response("unauthorized", { status: 401 }));
    let resolveCalls = 0;
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["api.stripe.com"],
        allowedDomains: ["cdn.stripe.com"],
      },
      async () => {
        resolveCalls += 1;
        return { token: "tok_123" };
      },
    );

    const response = await ctx.fetch("https://cdn.stripe.com/something");

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(resolveCalls).toBe(0);
  });

  test("401 retry still works for authenticatedDomains request", async () => {
    const calls = installFetchResponder(async (_input, _init, fetchCalls) => {
      const status = fetchCalls && fetchCalls.length === 1 ? 401 : 200;
      return new Response("ok", { status });
    });
    const resolveCalls: Array<{ force?: boolean }> = [];
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["api.stripe.com"],
        allowedDomains: ["cdn.stripe.com"],
      },
      async (options) => {
        resolveCalls.push({ force: options?.force });
        return { token: options?.force ? "fresh-token" : "stale-token" };
      },
    );

    const response = await ctx.fetch("https://api.stripe.com/v1/charges");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(resolveCalls).toEqual([{ force: undefined }, { force: true }]);
  });

  test("defineManifest validates no overlap between domain lists", () => {
    expect(() =>
      defineManifest({
        platform: "example",
        auth: { type: "none", strategy: "none" },
        authenticatedDomains: ["api.x.com"],
        allowedDomains: ["api.x.com"],
      }),
    ).toThrow("cannot appear in both authenticatedDomains and allowedDomains");
  });

  test("defineManifest throws when auth strategy requires authenticated domains", () => {
    expect(() =>
      defineManifest({
        platform: "example",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: [],
        allowedDomains: [],
      }),
    ).toThrow("must declare at least one authenticatedDomain");
  });
});
