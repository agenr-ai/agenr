import { afterEach, describe, expect, test } from "vitest";

import {
  AdapterContext,
  type AdapterContextOptions,
  type AuthCredential,
} from "../../../src/adapters/context";
import { DomainNotAllowedError } from "../../../src/adapters/domain-allowlist";
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
  abortSignal?: AbortSignal,
): AdapterContext {
  const options: AdapterContextOptions = {
    platform: manifest.platform,
    userId: "user-123",
    executionId: "exec-123",
    manifest,
    abortSignal,
    resolveCredential,
  };

  return new AdapterContext(options);
}

describe("AdapterContext", () => {
  test("ctx.fetch calls resolveCredential and injects auth", async () => {
    const calls = installFetchRecorder();
    let resolveCalls = 0;
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["api.stripe.com"],
        allowedDomains: [],
      },
      async () => {
        resolveCalls += 1;
        return { token: "tok_123" };
      },
    );

    await ctx.fetch("https://api.stripe.com/v1/charges");

    expect(resolveCalls).toBe(1);
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok_123");
  });

  test("ctx.fetch rejects disallowed domains before resolving credential", async () => {
    installFetchRecorder();
    let resolveCalls = 0;
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["api.stripe.com"],
        allowedDomains: [],
      },
      async () => {
        resolveCalls += 1;
        return { token: "tok_123" };
      },
    );

    await expect(ctx.fetch("https://evil.example.com/path")).rejects.toBeInstanceOf(
      DomainNotAllowedError,
    );
    expect(resolveCalls).toBe(0);
  });

  test("credential is resolved lazily and not on construction", () => {
    let resolveCalls = 0;
    createContext(
      {
        platform: "stripe",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["api.stripe.com"],
        allowedDomains: [],
      },
      async () => {
        resolveCalls += 1;
        return { token: "tok_123" };
      },
    );

    expect(resolveCalls).toBe(0);
  });

  test("credential is cached across multiple fetch calls", async () => {
    const calls = installFetchRecorder();
    let resolveCalls = 0;
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["api.stripe.com"],
        allowedDomains: [],
      },
      async () => {
        resolveCalls += 1;
        return { token: "tok_123" };
      },
    );

    await ctx.fetch("https://api.stripe.com/v1/customers");
    await ctx.fetch("https://api.stripe.com/v1/charges");

    expect(resolveCalls).toBe(1);
    expect(calls).toHaveLength(2);
  });

  test("ctx.getCredential resolves once and returns cached credential", async () => {
    let resolveCalls = 0;
    const ctx = createContext(
      {
        platform: "toast",
        auth: { type: "client_credentials", strategy: "client-credentials" },
        authenticatedDomains: ["ws-api.toasttab.com"],
        allowedDomains: [],
      },
      async () => {
        resolveCalls += 1;
        return { clientId: "cid-123", clientSecret: "csec-123" };
      },
    );

    const first = await ctx.getCredential();
    const second = await ctx.getCredential();

    expect(resolveCalls).toBe(1);
    expect(first).toEqual({ clientId: "cid-123", clientSecret: "csec-123" });
    expect(second).toEqual({ clientId: "cid-123", clientSecret: "csec-123" });
  });

  test("ctx.getCredential returns null when no credential is available", async () => {
    let resolveCalls = 0;
    const ctx = createContext(
      {
        platform: "toast",
        auth: { type: "client_credentials", strategy: "client-credentials" },
        authenticatedDomains: ["ws-api.toasttab.com"],
        allowedDomains: [],
      },
      async () => {
        resolveCalls += 1;
        return null;
      },
    );

    const credential = await ctx.getCredential();
    const second = await ctx.getCredential();

    expect(resolveCalls).toBe(1);
    expect(credential).toBeNull();
    expect(second).toBeNull();
  });

  test("ctx.fetch passes through request body, method, and non-auth headers", async () => {
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

    const body = JSON.stringify({ amount: 1000, currency: "usd" });
    await ctx.fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "X-Trace-Id": "trace-123",
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(body);

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Trace-Id")).toBe("trace-123");
    expect(headers.get("Authorization")).toBe("Bearer tok_123");
  });

  test("ctx.fetch retries once on 401 with refreshed credentials", async () => {
    const calls = installFetchResponder(async (_input, _init, fetchCalls) => {
      const status = fetchCalls && fetchCalls.length === 1 ? 401 : 200;
      return new Response("ok", { status });
    });
    const resolveCalls: Array<{ force?: boolean }> = [];
    const ctx = createContext(
      {
        platform: "example",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["example.com"],
        allowedDomains: [],
      },
      async (options) => {
        resolveCalls.push({ force: options?.force });
        return { token: options?.force ? "fresh-token" : "stale-token" };
      },
    );

    const response = await ctx.fetch("https://example.com/v1/charges");

    expect(response.status).toBe(200);
    expect(resolveCalls).toEqual([{ force: undefined }, { force: true }]);
    expect(calls).toHaveLength(2);
    const firstHeaders = new Headers(calls[0]?.init?.headers);
    const secondHeaders = new Headers(calls[1]?.init?.headers);
    expect(firstHeaders.get("Authorization")).toBe("Bearer stale-token");
    expect(secondHeaders.get("Authorization")).toBe("Bearer fresh-token");
  });

  test("ctx.fetch applies context abort signal to outbound fetch", async () => {
    const calls = installFetchResponder((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Operation aborted", "AbortError"));
          },
          { once: true },
        );
      });
    });
    const abortSignal = AbortSignal.timeout(10);
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "none", strategy: "none" },
        authenticatedDomains: [],
        allowedDomains: ["api.stripe.com"],
      },
      async () => null,
      abortSignal,
    );

    await expect(ctx.fetch("https://api.stripe.com/v1/charges")).rejects.toThrow();
    expect(calls).toHaveLength(1);
    const forwardedSignal = calls[0]?.init?.signal as AbortSignal | undefined;
    expect(forwardedSignal).toBeDefined();
    expect(forwardedSignal?.aborted).toBe(true);
  });

  test("ctx.fetch does not retry 401 for none strategy", async () => {
    const calls = installFetchResponder(async () => new Response("unauthorized", { status: 401 }));
    let resolveCalls = 0;
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "none", strategy: "none" },
        authenticatedDomains: [],
        allowedDomains: ["api.stripe.com"],
      },
      async () => {
        resolveCalls += 1;
        return { token: "unused" };
      },
    );

    const response = await ctx.fetch("https://api.stripe.com/v1/charges");

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(resolveCalls).toBe(0);
  });

  test("ctx.fetch does not retry 401 for client-credentials strategy", async () => {
    const calls = installFetchResponder(async () => new Response("unauthorized", { status: 401 }));
    let resolveCalls = 0;
    const ctx = createContext(
      {
        platform: "toast",
        auth: { type: "client_credentials", strategy: "client-credentials" },
        authenticatedDomains: ["ws-api.toasttab.com"],
        allowedDomains: [],
      },
      async () => {
        resolveCalls += 1;
        return { clientId: "cid", clientSecret: "secret" };
      },
    );

    const response = await ctx.fetch("https://ws-api.toasttab.com/config/v2");

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(resolveCalls).toBe(0);
  });

  test("ctx.fetch does not retry non-401 responses", async () => {
    const calls = installFetchResponder(async () => new Response("forbidden", { status: 403 }));
    let resolveCalls = 0;
    const ctx = createContext(
      {
        platform: "stripe",
        auth: { type: "oauth2", strategy: "bearer" },
        authenticatedDomains: ["api.stripe.com"],
        allowedDomains: [],
      },
      async () => {
        resolveCalls += 1;
        return { token: "tok_123" };
      },
    );

    const response = await ctx.fetch("https://api.stripe.com/v1/charges");

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(1);
    expect(resolveCalls).toBe(1);
  });
});
